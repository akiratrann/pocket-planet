// Polite, resilient HTTP for the Wikimedia APIs the whole pipeline reads from.
//
// Wikimedia throttles on two things: requests that don't identify themselves
// with a real User-Agent, and bursts from a single IP. Guide assembly does both
// — `src/data/wikivoyage.ts` issues bare `fetch(url)` calls with no UA and no
// retry, and assembly fans several scrapers out concurrently — which is what
// made every uncached guide fail with "Wikivoyage API error 429".
//
// The fix lives here rather than at each call site because the worst offender
// (the Wikivoyage client) is shared with the browser bundle, where a UA header
// is neither settable nor needed. So we wrap global fetch once, in the server
// process only: Wikimedia requests get a contact UA, a cap on how many are in
// flight, and jittered retries on 429/5xx (honouring Retry-After). Every other
// request — LLM APIs, Reddit, routing — passes straight through untouched.

// Wikimedia's UA policy asks for an app name, version and a contact URL.
const USER_AGENT = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikivoyage|wikidata|wikimedia|wikibooks)\.org$/i;

/** Wikimedia asks for serialised, not parallel, API access; a few is tolerated. */
const MAX_IN_FLIGHT = 6;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 20_000;
/** Cap on how long a Retry-After is allowed to stall a request. */
const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Taken off `fetch` itself so the wrapper keeps typechecking whether the DOM lib
// or Node's own definitions are in scope.
type FetchInput = Parameters<typeof fetch>[0];

// --- Shared throttle gate ---------------------------------------------------
// One 429 means the *IP* is over budget, so backing off only the request that
// saw it just lets the rest of the herd keep hammering. Every Wikimedia request
// waits out a cooldown set by whoever was throttled last.
let cooldownUntil = 0;

let inFlight = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight over
  else inFlight--;
}

async function awaitCooldown(): Promise<void> {
  for (let left = cooldownUntil - Date.now(); left > 0; left = cooldownUntil - Date.now()) {
    await sleep(Math.min(left, MAX_RETRY_AFTER_MS));
  }
}

/** Full jitter: spreads a throttled burst out instead of re-synchronising it. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling * (0.5 + Math.random() * 0.5);
}

/** Retry-After is either delta-seconds or an HTTP date. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isWikimedia(input: FetchInput): boolean {
  try {
    return WIKIMEDIA_HOST.test(new URL(urlOf(input)).hostname);
  } catch {
    return false;
  }
}

/** Stamp our contact UA on, without overriding a call site that set its own. */
function withUserAgent(input: FetchInput, init?: RequestInit): RequestInit {
  const headers = new Headers(
    init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
  );
  if (!headers.has('user-agent')) headers.set('User-Agent', USER_AGENT);
  // Browsers refuse to set User-Agent, so Wikimedia reads this one instead;
  // sending both means the same identity whichever the edge honours.
  if (!headers.has('api-user-agent')) headers.set('Api-User-Agent', USER_AGENT);
  return { ...init, headers };
}

/**
 * Install the wrapper on globalThis.fetch. Idempotent, and safe to call before
 * anything else: only the server process ever runs it.
 */
export function installUpstreamFetch(): void {
  const native = globalThis.fetch;
  if ((native as { __politeWikimedia?: boolean }).__politeWikimedia) return;

  const polite = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    if (!isWikimedia(input)) return native(input, init);

    // A retry re-sends the request, so only methods we can safely replay are
    // eligible; everything Wikimedia-bound here is a GET anyway.
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const replayable = method === 'GET' || method === 'HEAD';
    const patched = withUserAgent(input, init);

    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        await awaitCooldown();
        let res: Response;
        try {
          res = await native(input, patched);
        } catch (err) {
          if (!replayable || attempt >= MAX_ATTEMPTS - 1) throw err;
          await sleep(backoffMs(attempt));
          continue;
        }
        const throttled = res.status === 429 || res.status >= 500;
        if (!throttled || !replayable || attempt >= MAX_ATTEMPTS - 1) return res;

        const wait = retryAfterMs(res) ?? backoffMs(attempt);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        await res.body?.cancel().catch(() => {}); // don't leak the socket
        await sleep(wait);
      }
    } finally {
      release();
    }
  };

  Object.defineProperty(polite, '__politeWikimedia', { value: true });
  globalThis.fetch = polite as typeof fetch;
}
