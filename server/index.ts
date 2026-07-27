// Pocket Planet backend — the "brain" that learns.
//
// Serves RAG-assembled guides, records feedback (relearning from your input),
// ingests web resources on demand + on a schedule, and periodically self-tunes.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import { assembleGuide } from './assemble.ts';
import { store } from './store.ts';
import { applyFeedback, type Feedback, type FeedbackKind } from '../src/core/learning.ts';
import { ingestUrl, ingestLocationAuto, ingestAllTracked } from './pipeline/ingest.ts';
import { runTuning } from './pipeline/tuning.ts';
import { runTraining } from './pipeline/train.ts';
import { answerTravelQuestion, type ChatRequest } from './pipeline/chat.ts';
import { getLLM } from './llm/adapter.ts';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

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
    return await assembleGuide(q, lang);
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

app.post('/api/tune', async () => runTuning());

// Train the ranking model on recorded feature/reward examples (+ keyword mining).
app.post('/api/train', async () => runTraining());

// Training status: how much signal we've gathered + the last training pass.
app.get('/api/train/status', async () => ({
  examples: (await store.getTraining()).length,
  last: await store.getLastTraining(),
  learnedVersion: (await store.getLearned()).version,
}));

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
  await app.register(fastifyStatic, { root: distDir, wildcard: false });
  // SPA fallback: any unmatched GET (that isn't an API call) returns index.html.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (req.method !== 'GET' || url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
  console.log('[server] serving production build from dist/');
}

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[server] Pocket Planet on http://localhost:${port} (llm: ${getLLM().name})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
