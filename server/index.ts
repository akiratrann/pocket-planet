// Pocket Planet backend — the "brain" that learns.
//
// Serves RAG-assembled guides, records feedback (relearning from your input),
// ingests web resources on demand + on a schedule, and periodically self-tunes.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { assembleGuide } from './assemble.ts';
import { store } from './store.ts';
import { applyFeedback, type Feedback, type FeedbackKind } from '../src/core/learning.ts';
import { ingestUrl, ingestLocationAuto, ingestAllTracked } from './pipeline/ingest.ts';
import { runTuning } from './pipeline/tuning.ts';
import { getLLM } from './llm/adapter.ts';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({
  ok: true,
  provider: getLLM().name,
  learned: (await store.getLearned()).version,
}));

app.get<{ Querystring: { q?: string } }>('/api/guide', async (req, reply) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: 'Missing query parameter q' });
  try {
    return await assembleGuide(q);
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

app.post('/api/tune', async () => runTuning());

// --- Scheduled self-improvement -------------------------------------------
if (process.env.DISABLE_CRON !== '1') {
  // Study tracked locations for new material (default: daily 03:00).
  cron.schedule(process.env.INGEST_CRON ?? '0 3 * * *', async () => {
    const n = await ingestAllTracked();
    app.log.warn(`[cron] re-ingested ${n} tracked location(s)`);
  });
  // Self-tune from accumulated feedback (default: every 6 hours).
  cron.schedule(process.env.TUNE_CRON ?? '0 */6 * * *', async () => {
    await runTuning();
  });
}

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[server] Pocket Planet API on http://localhost:${port} (llm: ${getLLM().name})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
