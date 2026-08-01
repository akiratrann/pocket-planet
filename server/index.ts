// Pocket Planet backend — the "brain" that learns.
//
// Serves RAG-assembled guides, records feedback (relearning from your input),
// ingests web resources on demand + on a schedule, and periodically self-tunes.

// Must stay first: applies .env before any other module reads process.env.
import './load-env.ts';
import { installUpstreamFetch } from './upstream.ts';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import cron from 'node-cron';
import { assembleGuide } from './assemble.ts';
import { personalizeGuide } from './personalize.ts';
import { store } from './store.ts';
import { applyFeedback, type Feedback, type FeedbackKind } from '../src/core/learning.ts';
import { ingestUrl, ingestLocationAuto, ingestAllTracked } from './pipeline/ingest.ts';
import { isBlockedAddress, pinnedRequest, URL_REFUSED } from './net-guard.ts';
import { runTuning } from './pipeline/tuning.ts';
import { runTraining } from './pipeline/train.ts';
import { answerTravelQuestion, type ChatRequest } from './pipeline/chat.ts';
import { routeBetween, haversineKm } from './pipeline/routing.ts';
import { getTravelOptions } from './pipeline/travel-links.ts';
import { cachedGuide } from './pipeline/guide-cache.ts';
import { getLLM } from './llm/adapter.ts';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, signToken, userIdFromAuthHeader } from './auth.ts';
import type { User, UserData } from './store.ts';

// Identify + rate-limit ourselves to Wikimedia before any scraping starts.
installUpstreamFetch();

const app = Fastify({
  logger: { level: 'warn' },
  // On Fly every request arrives from the edge proxy, so the socket address is
  // the proxy's for all of them. Without this `req.ip` is one shared value and
  // the per-IP rate limits below would throttle the entire world as a single
  // client. `1` = trust exactly one hop, i.e. the address Fly's proxy appended;
  // trusting *all* hops would let a caller forge X-Forwarded-For and shed the
  // limit. Locally there is no proxy header, so this is a no-op.
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
});

// CORS used to be `origin: true`, which reflects whatever Origin is offered —
// i.e. any website a user visits could call this API from their browser. The
// only browsers that need cross-origin access are the Vite dev server and the
// deployed app itself, so name them.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ??
    'https://pocket-planet.fly.dev,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
);

await app.register(cors, {
  origin(origin, cb) {
    // No Origin header: same-origin navigations, curl, native apps. These are
    // not what CORS defends against, and refusing them would break the PWA
    // (which is served from this very origin).
    if (!origin) return cb(null, true);
    cb(null, ALLOWED_ORIGINS.has(origin.replace(/\/$/, '')));
  },
});

// Nothing was rate limited, so /api/auth/login could be guessed at line speed
// and every endpoint was a free amplifier. Limits are per client IP.
await app.register(rateLimit, {
  global: true,
  max: Number(process.env.RATE_LIMIT_MAX ?? 300),
  timeWindow: '1 minute',
  // Static PWA assets are served from this same origin; a cold load pulls
  // dozens of them and they cost nothing to serve. Only meter the API.
  allowList: (req) => !(req.raw.url ?? '').startsWith('/api'),
  // statusCode is required here — without it the plugin's error serialises as a
  // generic 500 and clients can't tell "slow down" from "the server broke".
  // `error` matches the shape every other endpoint returns.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: `Too many requests — try again in ${Math.ceil(ctx.ttl / 1000)}s`,
  }),
});

// Credential endpoints get their own, far tighter budget: online password
// guessing needs thousands of attempts to be worth anything, and no honest user
// signs in ten times in a quarter of an hour.
const AUTH_RATE_LIMIT = {
  rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10), timeWindow: '15 minutes' },
};

// Guide payloads are ~330KB of JSON and were being sent uncompressed, which is
// most of the wait on a slow or distant connection. gzip/brotli takes that to
// roughly a tenth. Threshold skips tiny responses where framing costs more than
// it saves.
await app.register(compress, { global: true, threshold: 1024 });

app.get('/api/health', async () => ({
  ok: true,
  provider: getLLM().name,
  learned: (await store.getLearned()).version,
}));

app.get<{ Querystring: { q?: string; lang?: string } }>('/api/guide', async (req, reply) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: 'Missing query parameter q' });
  // Accept only a simple language code (e.g. "en", "ja", "pt").
  const lang = /^[a-z]{2,3}$/.test(req.query.lang ?? '') ? req.query.lang! : 'en';
  try {
    const { value, status, ageMs } = await cachedGuide(
      `${q.toLowerCase()}::${lang}`,
      () => assembleGuide(q, lang),
    );
    // Let the browser reuse it too, and allow serving stale while revalidating.
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    reply.header('X-Guide-Cache', status);
    reply.header('Age', Math.round(ageMs / 1000).toString());
    return value;
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// --- Authorisation for state-mutating endpoints ----------------------------
//
// Reads (/api/guide, /api/learned, /api/sources, /api/train/status…) stay open:
// they're the product. Everything that WRITES shared state did too, which meant
// any anonymous visitor could make the server fetch a URL of their choosing
// (SSRF) and splice the result into the guide everyone sees, or retrain the
// global ranking model. Writes now need an account, and the two endpoints that
// move the GLOBAL model need an operator.
//
// Admin is an env allow-list rather than a flag on the user record because the
// user store's shape is owned elsewhere, and because "who may retrain the model
// everyone sees" is a deployment decision, not user data — it should be
// grantable/revocable without a data migration. Unset ADMIN_EMAILS means NOBODY
// is an admin: failing closed is the right default for a public deployment, and
// the scheduled cron pass still keeps the model fresh without any human.
//   ADMIN_EMAILS=ops@example.com,someone@example.org
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

const isAdmin = (u: User): boolean => ADMIN_EMAILS.has(u.email.toLowerCase());

/**
 * Resolve the caller from the existing bearer-token scheme, or answer 401.
 * Returns null once the reply has been sent, so handlers do `if (!u) return reply;`.
 */
async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const uid = userIdFromAuthHeader(req.headers.authorization);
  const user = uid ? await store.getUserById(uid) : undefined;
  if (!user) {
    reply.code(401).send({ error: 'Sign in to use this feature' });
    return null;
  }
  return user;
}

/** As `requireUser`, but also demands membership of the ADMIN_EMAILS allow-list. */
async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (!isAdmin(user)) {
    // 403, not 401: the credentials are fine, the permission isn't — retrying
    // with a different token is the wrong advice to give a client here.
    reply.code(403).send({ error: 'Only an administrator can change the global ranking model' });
    return null;
  }
  return user;
}

// What the signed-in (or anonymous) caller is allowed to do. The UI reads this
// so it can hide controls it knows will be refused, instead of offering buttons
// that 401. Purely advisory — every endpoint re-checks for itself.
app.get('/api/capabilities', async (req) => {
  const uid = userIdFromAuthHeader(req.headers.authorization);
  const user = uid ? await store.getUserById(uid) : undefined;
  return {
    authenticated: !!user,
    canIngest: !!user,
    canFeedback: !!user,
    canTrain: !!user && isAdmin(user),
  };
});

// A signed-in caller's own view of one guide: a shortlist drawn from the places
// they have saved. Requires an account by nature — there is nothing to
// personalize from without one — and reads only that account's own data.
app.get<{ Querystring: { q?: string; lang?: string } }>('/api/personal', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  const q = (req.query.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: 'Missing query parameter q' });
  const lang = /^[a-z]{2,3}$/.test(req.query.lang ?? '') ? req.query.lang! : 'en';
  try {
    // Same cache key as /api/guide, so this reuses the guide the reader is
    // already looking at instead of assembling a second copy of it.
    const { value } = await cachedGuide(`${q.toLowerCase()}::${lang}`, () => assembleGuide(q, lang));
    return personalizeGuide(user, value);
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// --- SSRF hardening for /api/ingest ----------------------------------------
//
// `/api/ingest` asks the SERVER to fetch a caller-supplied URL, so the URL is
// hostile input even from a signed-in user: the server sits inside the
// deployment's network and can reach things the caller cannot — the cloud
// metadata service (169.254.169.254 hands out instance credentials), sibling
// services on loopback, the private VPC. Deny-list the addresses that are only
// reachable from the inside, and judge the RESOLVED address, because
// `http://localhost/` and an attacker-controlled name with an A record of
// 127.0.0.1 are the same attack wearing different hats. The block-list and the
// pinned dialler both live in ./net-guard.ts so the vetting here and the fetch
// in the ingester cannot drift apart.
/** Parse + vet one URL. Throws with a caller-safe message; never leaks internals. */
/** A vetted URL together with the exact address it was vetted at. */
export interface VettedTarget {
  url: string;
  address: string;
}

/**
 * Parse + vet one URL. Throws with a caller-safe message; never leaks internals.
 *
 * Returns the address alongside the URL because the caller must dial *that*
 * address rather than resolve the name a second time — see net-guard.ts.
 */
async function vetUrl(raw: string): Promise<{ u: URL; address: string }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  // file:, data:, gopher:, ftp: … all let the fetcher read things that aren't
  // "a web page about a place".
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(URL_REFUSED);
  // `http://public.example@127.0.0.1/` reads as a public host to a human.
  if (u.username || u.password) throw new Error(URL_REFUSED);

  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  // WHATWG already normalised decimal/hex/octal IPv4 forms (http://2130706433/
  // becomes 127.0.0.1) before we get here.
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(URL_REFUSED);
    return { u, address: host };
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }
  // ALL answers must be public: a name with both a public and a loopback record
  // is a rebinding attempt, and pinning only commits us to the one we pick.
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error(URL_REFUSED);
  }
  return { u, address: addrs[0].address };
}

const MAX_REDIRECTS = 5;

/**
 * Vet the URL *and every hop it redirects through*, returning the final URL and
 * the address it was vetted at. Without this the address checks are trivially
 * bypassed: an attacker points us at their own public host, which 302s to
 * http://169.254.169.254/… and a redirect-following fetch walks right into it.
 *
 * Every request — the redirect probes here and the ingester's body fetch — is
 * dialled at the address that hop was vetted at, so a DNS record that flips
 * between the check and the fetch has nothing left to poison.
 */
async function resolveIngestTarget(raw: string): Promise<VettedTarget> {
  let { u: current, address } = await vetUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Awaited<ReturnType<typeof pinnedRequest>>;
    try {
      res = await pinnedRequest(current.href, address);
    } catch (e) {
      // A refusal is the guard talking and must reach the caller verbatim;
      // anything else is an ordinary network failure.
      if ((e as Error).message === URL_REFUSED) throw e;
      throw new Error(`Could not fetch ${current.href}.`);
    }
    if (!res.location) return { url: current.href, address };
    ({ u: current, address } = await vetUrl(new URL(res.location, current).href));
  }
  throw new Error('Too many redirects.');
}

interface FeedbackBody {
  location: string;
  name?: string;
  kind: FeedbackKind;
  weight?: number;
  category?: Feedback['category'];
  note?: string;
}

// Feedback is folded straight into the GLOBAL learned state that ranks places
// for every visitor, so an open endpoint here is a model-poisoning primitive.
// Any account is enough — an account makes the write attributable and rate-able.
app.post<{ Body: FeedbackBody }>('/api/feedback', async (req, reply) => {
  if (!(await requireUser(req, reply))) return reply;
  const b = req.body;
  if (!b?.location || !b?.kind) {
    return reply.code(400).send({ error: 'location and kind are required' });
  }
  const fb: Feedback = {
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    location: b.location,
    name: b.name ?? '',
    kind: b.kind,
    weight: b.weight,
    category: b.category,
    note: b.note,
    ts: Date.now(),
  };
  await store.addFeedback(fb);
  const next = applyFeedback(await store.getLearned(), fb);
  await store.setLearned(next);
  return { ok: true, learnedVersion: next.version };
});

app.get('/api/learned', async () => store.getLearned());

app.get<{ Querystring: { location?: string } }>('/api/sources', async (req) =>
  store.getSources(req.query.location),
);

// Ingestion makes the server fetch a URL and merges what it finds into the
// guide EVERY visitor sees, so it needs both an account and URL vetting.
app.post<{ Body: { location: string; url?: string } }>('/api/ingest', async (req, reply) => {
  if (!(await requireUser(req, reply))) return reply;
  const { location, url } = req.body ?? {};
  if (!location) return reply.code(400).send({ error: 'location is required' });

  // Vet BEFORE tracking, so a rejected URL doesn't leave the location queued
  // for the scheduler as a side effect.
  let target: VettedTarget | undefined;
  if (url) {
    try {
      target = await resolveIngestTarget(url);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  }

  await store.track(location);
  try {
    const src = target
      ? await ingestUrl(location, target.url, target.address)
      : await ingestLocationAuto(location);
    if (!src) return reply.code(502).send({ error: 'Nothing could be ingested for that location' });
    return { ok: true, source: { title: src.title, url: src.url, poiCount: src.pois.length, provider: src.provider } };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// Adds a location to the set the scheduler re-ingests forever, so it's a
// write to shared state (and an amplification lever) like the rest.
app.post<{ Body: { location: string } }>('/api/track', async (req, reply) => {
  if (!(await requireUser(req, reply))) return reply;
  const { location } = req.body ?? {};
  if (!location) return reply.code(400).send({ error: 'location is required' });
  await store.track(location);
  return { ok: true };
});

// Travel chat — grounded in the app's real data for the place being viewed.
app.post<{ Body: ChatRequest }>('/api/chat', async (req, reply) => {
  const b = req.body;
  if (!b?.message || !b.message.trim()) {
    return reply.code(400).send({ error: 'message is required' });
  }
  try {
    return await answerTravelQuestion(b);
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// --- Getting around & getting there ----------------------------------------

// Point-to-point directions between two places in a guide.
app.get<{
  Querystring: { from?: string; to?: string; mode?: string };
}>('/api/route', async (req, reply) => {
  const parse = (s?: string): { lat: number; lon: number } | null => {
    const [lat, lon] = (s ?? '').split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };
  const from = parse(req.query.from);
  const to = parse(req.query.to);
  if (!from || !to) {
    return reply.code(400).send({ error: 'from and to are required as "lat,lon"' });
  }
  const mode = (['walking', 'cycling', 'driving'] as const).find((m) => m === req.query.mode)
    ?? 'walking';

  const route = await routeBetween(from, to, mode);
  if (route) return route;

  // Router unavailable: return the straight-line distance so the UI can still
  // say something useful instead of showing an error.
  return reply.code(200).send({
    mode,
    distanceKm: haversineKm(from, to),
    durationSec: 0,
    geometry: [],
    steps: [],
    approximate: true,
  });
});

// Real, bookable ways to reach the destination city (deep links to operators).
app.get<{
  Querystring: { from?: string; to?: string; date?: string };
}>('/api/travel-options', async (req, reply) => {
  const from = (req.query.from ?? '').trim();
  const to = (req.query.to ?? '').trim();
  if (!from || !to) return reply.code(400).send({ error: 'from and to are required' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : undefined;
  return getTravelOptions({ from, to, date });
});

// Tuning and training rewrite the ranking weights used for EVERY location and
// EVERY visitor. One signed-up account shouldn't be able to reshape what the
// whole product recommends, so these two are the admin-only pair.
app.post('/api/tune', async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return reply;
  return runTuning();
});

// Train the ranking model on recorded feature/reward examples (+ keyword mining).
app.post('/api/train', async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return reply;
  return runTraining();
});

// Training status: how much signal we've gathered + the last training pass.
app.get('/api/train/status', async () => ({
  examples: (await store.getTraining()).length,
  last: await store.getLastTraining(),
  learnedVersion: (await store.getLearned()).version,
}));

// --- Accounts & personalization -------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name });
const emptyData = (): UserData => ({ pinned: [], itineraries: [], updatedAt: 0 });

app.post<{ Body: { email?: string; password?: string; name?: string } }>(
  '/api/auth/signup',
  { config: AUTH_RATE_LIMIT },
  async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password ?? '';
    const name = (req.body?.name ?? '').trim() || email.split('@')[0];
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'A valid email is required' });
    if (password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
    if (await store.getUserByEmail(email)) return reply.code(409).send({ error: 'An account with that email already exists' });
    const user: User = {
      id: randomUUID(),
      email,
      name,
      pass: await hashPassword(password),
      createdAt: Date.now(),
      data: emptyData(),
    };
    await store.createUser(user);
    return { token: signToken(user.id), user: publicUser(user), data: user.data };
  },
);

app.post<{ Body: { email?: string; password?: string } }>(
  '/api/auth/login',
  { config: AUTH_RATE_LIMIT },
  async (req, reply) => {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password ?? '';
    const user = await store.getUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.pass))) {
      return reply.code(401).send({ error: 'Incorrect email or password' });
    }
    return { token: signToken(user.id), user: publicUser(user), data: user.data };
  },
);

app.get('/api/auth/me', async (req, reply) => {
  const uid = userIdFromAuthHeader(req.headers.authorization);
  const user = uid ? await store.getUserById(uid) : undefined;
  if (!user) return reply.code(401).send({ error: 'Not authenticated' });
  return { user: publicUser(user), data: user.data };
});

app.put<{ Body: { pinned?: unknown[]; itineraries?: unknown[] } }>('/api/user/data', async (req, reply) => {
  const uid = userIdFromAuthHeader(req.headers.authorization);
  if (!uid) return reply.code(401).send({ error: 'Not authenticated' });
  const data: UserData = {
    pinned: Array.isArray(req.body?.pinned) ? req.body!.pinned : [],
    itineraries: Array.isArray(req.body?.itineraries) ? req.body!.itineraries : [],
    updatedAt: Date.now(),
  };
  const ok = await store.setUserData(uid, data);
  if (!ok) return reply.code(401).send({ error: 'Not authenticated' });
  return { ok: true, updatedAt: data.updatedAt };
});

// --- Scheduled self-improvement -------------------------------------------
if (process.env.DISABLE_CRON !== '1') {
  // Study tracked locations for new material (default: daily 03:00).
  cron.schedule(process.env.INGEST_CRON ?? '0 3 * * *', async () => {
    const n = await ingestAllTracked();
    app.log.warn(`[cron] re-ingested ${n} tracked location(s)`);
  });
  // Train the ranking model from accumulated examples + feedback (default: every
  // 6 hours). This folds real usage signal into the global ranking weights.
  cron.schedule(process.env.TUNE_CRON ?? '0 */6 * * *', async () => {
    await runTraining();
  });
}

// --- Serve the production PWA build (single origin) ------------------------
// When `dist/` exists (i.e. after `npm run build`), the backend serves the
// built app itself, so the whole thing runs on ONE origin with real prod
// assets + service worker. In dev this block is skipped (Vite serves the app).
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (existsSync(join(distDir, 'index.html'))) {
  // `index: false` stops @fastify/static from claiming `GET /` to auto-serve
  // index.html — we own that route below and point it at the landing page.
  await app.register(fastifyStatic, {
    root: distDir,
    wildcard: false,
    index: false,
  });

  // Two front doors on one origin:
  //   /      → landing.html, the marketing page (copied in by the Vite build)
  //   /app   → the React PWA (client-side routing lives under here)
  const hasLanding = existsSync(join(distDir, 'landing.html'));

  app.get('/', (_req, reply) =>
    reply.sendFile(hasLanding ? 'landing.html' : 'index.html'),
  );
  app.get('/app', (_req, reply) => reply.sendFile('index.html'));

  // SPA fallback: unmatched GETs return the app shell so deep links into /app
  // work on a cold load. API paths still 404 as JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (req.method !== 'GET' || url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
  console.log(
    `[server] serving production build from dist/${hasLanding ? ' (landing at /, app at /app)' : ''}`,
  );
}

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[server] Pocket Planet on http://localhost:${port} (llm: ${getLLM().name})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
