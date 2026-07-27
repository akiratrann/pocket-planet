// Pocket Planet backend — the "brain" that learns.
//
// Serves RAG-assembled guides, records feedback (relearning from your input),
// ingests web resources on demand + on a schedule, and periodically self-tunes.

// Must stay first: applies .env before any other module reads process.env.
import './load-env.ts';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import cron from 'node-cron';
import { assembleGuide } from './assemble.ts';
import { store } from './store.ts';
import { applyFeedback, type Feedback, type FeedbackKind } from '../src/core/learning.ts';
import { ingestUrl, ingestLocationAuto, ingestAllTracked } from './pipeline/ingest.ts';
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

// Load local .env for development (Node built-in — no dependency). Runs before
// any env is read (getLLM is lazy). Deployed environments inject real env vars,
// so a missing file here is expected and harmless.
try {
  process.loadEnvFile();
} catch {
  /* no .env file present */
}

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

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

interface FeedbackBody {
  location: string;
  name?: string;
  kind: FeedbackKind;
  weight?: number;
  category?: Feedback['category'];
  note?: string;
}

app.post<{ Body: FeedbackBody }>('/api/feedback', async (req, reply) => {
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

app.post<{ Body: { location: string; url?: string } }>('/api/ingest', async (req, reply) => {
  const { location, url } = req.body ?? {};
  if (!location) return reply.code(400).send({ error: 'location is required' });
  await store.track(location);
  try {
    const src = url ? await ingestUrl(location, url) : await ingestLocationAuto(location);
    if (!src) return reply.code(502).send({ error: 'Nothing could be ingested for that location' });
    return { ok: true, source: { title: src.title, url: src.url, poiCount: src.pois.length, provider: src.provider } };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

app.post<{ Body: { location: string } }>('/api/track', async (req, reply) => {
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

app.post('/api/tune', async () => runTuning());

// Train the ranking model on recorded feature/reward examples (+ keyword mining).
app.post('/api/train', async () => runTraining());

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
      pass: hashPassword(password),
      createdAt: Date.now(),
      data: emptyData(),
    };
    await store.createUser(user);
    return { token: signToken(user.id), user: publicUser(user), data: user.data };
  },
);

app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
  const email = (req.body?.email ?? '').trim().toLowerCase();
  const password = req.body?.password ?? '';
  const user = await store.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.pass)) {
    return reply.code(401).send({ error: 'Incorrect email or password' });
  }
  return { token: signToken(user.id), user: publicUser(user), data: user.data };
});

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
