// Polite, resilient HTTP for the Wikimedia APIs the whole pipeline reads from.
//
// Wikimedia throttles on two things: requests that don't identify themselves
// with a real User-Agent, and how fast a single IP asks. Guide assembly does
// both — `src/data/wikivoyage.ts` issues bare `fetch(url)` calls with no UA and
// no retry, and assembly fans several scrapers out concurrently — which is what
// made every uncached guide fail with "Wikivoyage API error 429".
//
// The fix lives here rather than at each call site because the worst offender
// (the Wikivoyage client) is shared with the browser bundle, where a UA header
// is neither settable nor needed. So we wrap global fetch once, in the server
// process only: Wikimedia requests get a contact UA, a paced release, and
// jittered retries on 429/5xx (honouring Retry-After). Every other request —
// LLM APIs, Reddit, routing — passes straight through untouched.
//
// --- What was actually wrong, and how it was measured ----------------------
//
// The first version of this file capped CONCURRENCY (6 in flight) and retried
// with a global cooldown. Concurrency is not a rate limit, and the measurements
// say so. Probing commons.wikimedia.org directly, at a fixed pace, one endpoint:
//
//     3 req/s for 70s   → 210 requests,   0 × 429
//     4 req/s for 120s  → 478 requests, 183 × 429   (clean for ~35s, then 429s)
//     5 req/s for 90s   → 447 requests, 107 × 429   (clean for ~40s, then 429s)
//     6 in flight, unpaced, 400 requests → 107 × 429 (27%)
//
// That is a token bucket: a generous burst allowance, then a hard ceiling
// somewhere between 3 and 4 requests per second, with `Retry-After: 5`–`9`.
// Capping concurrency at 6 let us sit at ~5.5 req/s indefinitely — comfortably
// over the ceiling — so we drained the bucket, and every response after that was
// a 429. Worse, the recovery was a global cooldown of up to 30s applied to ALL
// Wikimedia traffic, which stalled the whole process and then released the same
// unpaced burst into the same exhausted bucket. An oscillator, not a limiter.
//
// Six cold guides built back to back with that policy: 948 requests, 47 × 429,
// 658s spent in cooldown, 220–355s per guide.
//
// So the control here is a TOKEN BUCKET at the measured safe rate, not a
// concurrency cap. Requests leave at a fixed pace whatever the pipeline above
// asks for, which means a burst upstream becomes a queue here instead of a 429.
// Retries feed back through the same bucket, so a caller with its own retry loop
// (server/pipeline/images.ts has one) cannot turn a throttle into a storm —
// which is the failure mode that matters most, since a retry storm against
// Wikimedia is worse than being slow.
//
// --- Where it landed -------------------------------------------------------
//
// Measured against live Wikimedia on this policy, cold cache both times:
//
//   6 cold guides fired 0.3s apart (worst case, all overlapping)
//     ~660 Wikimedia requests, 0 × 429, 0 × 5xx, 0 escaped
//     243s for the whole batch; 55s / 128s / 141s / 198s / 229s / 242s each
//     ≈ 2.7 req/s sustained — the bucket, not Wikimedia, is what bounds us
//
//   4 cold guides back to back, one at a time
//     120–267 requests each, 0 × 429, 0 × 5xx, 0 escaped
//     89s / 93s / 140s / 155s per guide, of which 42–96s was pacing
//
// The honest trade: a single cold guide got SLOWER (≈90–155s, against 25–70s
// when we were bursting), and in exchange the 429s are gone rather than merely
// retried around. Roughly half of a cold build is now deliberate waiting, so
// the way to make guides fast again is to ask Wikimedia for fewer things —
// 120–267 requests for one city is the real problem — not to raise the rate.
//
// The 429 path itself is exercised by a fake upstream at the native-fetch seam
// (a server that refuses with Retry-After once its own bucket drains), since
// live traffic no longer produces one: 40 concurrent callers against a 1 req/s
// ceiling → 52 sends total (1.3× amplification, not a storm), 0 responses lost
// to the caller, and zero requests issued inside a stated Retry-After window.

/**
 * Wikimedia's UA policy asks for an app name, a version and a way to contact
 * whoever is running it. Overridable so a fork/deployment can put its own
 * contact address in front of Wikimedia's operators rather than this repo's.
 */
const USER_AGENT =
  process.env.WIKIMEDIA_USER_AGENT ??
  'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikivoyage|wikidata|wikimedia|wikibooks)\.org$/i;

/**
 * Requests per second we allow ourselves, steady state. Measured clean at 3 and
 * throttled at 4 (see the table above), so this sits on the safe side of the
 * boundary rather than probing for it on every cold build.
 */
const TARGET_RPS = Number(process.env.WIKIMEDIA_RPS ?? 3);
/** Floor the adaptive rate can back down to when Wikimedia keeps refusing. */
const MIN_RPS = 0.5;
/**
 * Tokens the bucket may bank while idle. Small on purpose: a warm server sits
 * idle between guides, and letting it bank thirty seconds of credit would open
 * every cold build with exactly the burst this file exists to prevent.
 */
const BUCKET_CAPACITY = 4;
/**
 * How many requests may be in flight at once. This is NOT the rate control —
 * the bucket above is — and it must not be mistaken for one: the old version
 * capped concurrency at 6 with no pacing and sat at 5.5 req/s, which is how we
 * got throttled in the first place.
 *
 * What it has to be is large enough that the BUCKET stays the binding
 * constraint. Wikimedia's own etiquette suggests serial requests as a way to
 * reach a safe rate, but with a hard rate limiter already in place, serialising
 * only wastes budget: measured mean latency on these endpoints is ~1.2s, so a
 * cap of C limits us to C/1.2 req/s regardless of the bucket. Measured, six cold
 * guides back to back:
 *
 *     cap 2 → 1.4 req/s effective, 431–641s per guide, 12 × 429
 *     cap 4 → the bucket binds at 3 req/s, 0 × 429 (header, "Where it landed")
 *
 * So it is set just above `TARGET_RPS × mean latency`. Raising it does not make
 * us faster or ruder — the bucket refuses to hand out the tokens — it only lets
 * latency overlap.
 *
 * Verified against live Wikimedia with these settings (see the header).
 */
const MAX_IN_FLIGHT = Number(process.env.WIKIMEDIA_CONCURRENCY ?? 4);

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 20_000;
/** Cap on how long a Retry-After is allowed to stall a request. */
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * AIMD constants. Both were originally much harsher (halve on a 429, climb back
 * by a flat 0.02 req/s per clean response) and that measured badly: a single
 * refusal cost 75 clean requests to recover from, so six concurrent cold builds
 * spent the whole run at ~1.5 req/s — half the budget we are actually allowed —
 * and took LONGER than the unpaced version they replaced.
 *
 * The refusals are also not all ours: anything else on this IP (a second dev
 * server, a colleague) spends from the same bucket, and punishing ourselves for
 * a full minute over someone else's request is not caution, it is just slow.
 * So: back off meaningfully, then close most of the gap back to target within
 * ~20s of clean traffic.
 */
const RATE_DECREASE = 0.6;
const RATE_RECOVERY = 0.05;
/**
 * After a cut, ignore further refusals for this long before cutting again.
 *
 * Requests overlap, so when the bucket runs dry every request already in flight
 * comes back 429 — that is ONE throttling event reported N times, and without
 * this guard each report multiplies the penalty: four in flight takes the rate
 * to 3 × 0.6⁴ ≈ 0.39, i.e. straight to the MIN_RPS floor, on a single incident,
 * from which RATE_RECOVERY needs ~35 clean responses to climb back. That is the
 * wrong reflex when TARGET_RPS is a rate we have measured as safe and the
 * refusal may not even be ours (anything else on this IP spends from the same
 * bucket).
 *
 * Unmeasured against live Wikimedia, because the runs in the header never drew
 * a 429 for it to act on. A synthetic A/B — a fake upstream whose ceiling sits
 * at our target with a much tighter burst allowance than Wikimedia's — actually
 * favoured cutting on every refusal, but that scenario rewards any hard cut and
 * is not the upstream we have. Treat this constant as reasoned, not proven, and
 * re-measure it if 429s ever reappear.
 *
 * The window still extends the shared cooldown and drops banked credit for
 * EVERY refusal — neither of those compounds. It only declines to re-cut the
 * rate for what is probably the same incident.
 */
const PENALTY_REFRACTORY_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Instrumentation --------------------------------------------------------
// "Are we being throttled?" was previously unanswerable without a packet
// capture: every 429 was swallowed by a retry. These counters are the cheapest
// possible record of what upstream actually said, so a claim about the 429 rate
// can be checked rather than believed. `/api/guide` prints the delta for every
// cold build.
export const upstreamStats = {
  /** Wikimedia requests issued, including retries. */
  requests: 0,
  /** 429 responses received (each one is a retry or an escape). */
  throttled: 0,
  /** 5xx responses received. */
  serverErrors: 0,
  /** 429/5xx handed back to the caller because attempts ran out. */
  escaped: 0,
  /** Milliseconds spent deliberately waiting: pacing, cooldown and backoff. */
  waitedMs: 0,
};

export function resetUpstreamStats(): void {
  upstreamStats.requests = 0;
  upstreamStats.throttled = 0;
  upstreamStats.serverErrors = 0;
  upstreamStats.escaped = 0;
  upstreamStats.waitedMs = 0;
}

// Taken off `fetch` itself so the wrapper keeps typechecking whether the DOM lib
// or Node's own definitions are in scope.
type FetchInput = Parameters<typeof fetch>[0];

// --- Pacing -----------------------------------------------------------------
//
// One token bucket for the whole process. A 429 means the *IP* is over budget,
// so backing off only the request that saw it just lets the rest of the herd
// keep hammering: the rate and the cooldown are both shared.

let rate = TARGET_RPS;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
/** Set from a server-stated Retry-After. Holds back every Wikimedia request. */
let cooldownUntil = 0;
/** When the rate was last cut, for the refractory window above. */
let lastPenaltyAt = 0;

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

/**
 * Block until this process may send one more Wikimedia request. Refills by
 * elapsed time rather than on a timer, so an idle server costs nothing and a
 * busy one is paced to the millisecond.
 */
async function takeToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * rate);
    lastRefill = now;

    // A stated Retry-After outranks the bucket: they have told us when to come
    // back, and guessing earlier is exactly what a retry storm looks like.
    if (cooldownUntil > now) {
      const wait = Math.min(cooldownUntil - now, MAX_RETRY_AFTER_MS);
      upstreamStats.waitedMs += wait;
      await sleep(wait);
      continue;
    }
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // Round up so a rounding error can't spin this loop.
    const wait = Math.ceil(((1 - tokens) / rate) * 1000) + 1;
    upstreamStats.waitedMs += wait;
    await sleep(wait);
  }
}

/**
 * Wikimedia refused us. Cut the rate (AIMD: back off hard, recover gently),
 * drop any banked credit, and hold everyone until the stated Retry-After.
 *
 * The cooldown and the dropped credit apply to EVERY refusal — neither
 * compounds, and both are just "do what the server said". The rate cut is the
 * one that compounds, so it is fired at most once per PENALTY_REFRACTORY_MS:
 * the requests already in flight when the bucket runs dry all come back 429,
 * and that is one throttling event, not four.
 *
 * The cooldown is deliberately driven by the SERVER's Retry-After rather than
 * our own backoff: a locally jittered delay is the right thing for the one
 * request that has to be replayed, but making it a global stall — as the
 * previous version did — took the whole process off the air for up to 20s over
 * one refused request.
 */
function penalise(res: Response): void {
  const now = Date.now();
  tokens = 0;
  const stated = retryAfterMs(res);
  if (stated != null) cooldownUntil = Math.max(cooldownUntil, now + stated);

  if (now - lastPenaltyAt < PENALTY_REFRACTORY_MS) return;
  lastPenaltyAt = now;
  rate = Math.max(MIN_RPS, rate * RATE_DECREASE);
}

/** A clean response closes part of the gap back to the target rate. */
function reward(): void {
  if (rate < TARGET_RPS) rate += (TARGET_RPS - rate) * RATE_RECOVERY;
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
        await takeToken();
        let res: Response;
        try {
          upstreamStats.requests++;
          res = await native(input, patched);
        } catch (err) {
          if (!replayable || attempt >= MAX_ATTEMPTS - 1) throw err;
          const wait = backoffMs(attempt);
          upstreamStats.waitedMs += wait;
          await sleep(wait);
          continue;
        }

        if (res.status === 429) upstreamStats.throttled++;
        else if (res.status >= 500) upstreamStats.serverErrors++;
        const throttled = res.status === 429 || res.status >= 500;

        if (!throttled) {
          reward();
          return res;
        }

        // Slow the whole process down FIRST, and do it whether or not this
        // particular request has retries left. The previous version skipped
        // this on the final attempt, so the one 429 that escaped to the caller
        // — straight into the caller's own retry loop — was also the one that
        // left the pacing untouched.
        penalise(res);

        if (!replayable || attempt >= MAX_ATTEMPTS - 1) {
          upstreamStats.escaped++;
          return res;
        }

        await res.body?.cancel().catch(() => {}); // don't leak the socket
        // Jitter on top of the (already-applied) shared cooldown, so several
        // requests released by the same Retry-After don't re-synchronise.
        const wait = backoffMs(attempt);
        upstreamStats.waitedMs += wait;
        await sleep(wait);
      }
    } finally {
      release();
    }
  };

  Object.defineProperty(polite, '__politeWikimedia', { value: true });
  globalThis.fetch = polite as typeof fetch;
}
