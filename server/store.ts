// Simple JSON-file persistence for the backend "brain": learned state, the
// feedback log, the ingested knowledge base, and the list of tracked locations.
// Swappable for SQLite/Postgres later without touching callers.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyLearnedState,
  type Feedback,
  type LearnedState,
} from '../src/core/learning.ts';
import type { Destination } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '.data');

/** A single ingested web resource for a location, plus what we extracted from it. */
export interface KbSource {
  id: string;
  location: string;
  url: string;
  title: string;
  fetchedAt: number;
  summary: string;
  pois: Destination[];
  provider: string; // which LLM (or 'heuristic') did the extraction
}

/**
 * One training example: a place's feature vector plus the real-world "reward"
 * it earned (community buzz + traveller feedback). Recorded as the app is used,
 * so the ranking model can be trained on genuine signal.
 */
export interface TrainExample {
  loc: string;
  name: string;
  f: number[]; // feature vector (see server/pipeline/train.ts FEATURES)
  reward: number;
  ts: number;
}

/** Summary of the most recent training pass (for display in the Learn tab). */
export interface TrainingSummary {
  at: number;
  examples: number;
  positives: number;
  accuracy: number | null;
  weightChanges: string[];
  keywordsAdded: number;
  rationale: string;
  version: number;
}

const TRAIN_LOG_CAP = 5000;

interface Db {
  learned: LearnedState;
  feedback: Feedback[];
  sources: KbSource[];
  tracked: string[]; // locations to periodically re-ingest
  /**
   * Resolved place photos, keyed by "wd:Q123" or "nm:place name".
   * An array holds the gallery (best first); null = looked up, none found.
   */
  images: Record<string, string[] | null>;
  /** Recorded training examples + the last training pass summary. */
  training: TrainExample[];
  lastTraining: TrainingSummary | null;
}

const files = {
  learned: join(DATA_DIR, 'learned.json'),
  feedback: join(DATA_DIR, 'feedback.json'),
  sources: join(DATA_DIR, 'sources.json'),
  tracked: join(DATA_DIR, 'tracked.json'),
  images: join(DATA_DIR, 'images.json'),
  training: join(DATA_DIR, 'training.json'),
  lastTraining: join(DATA_DIR, 'last-training.json'),
};

let cache: Db | null = null;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function ensureLoaded(): Promise<Db> {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  cache = {
    learned: await readJson<LearnedState>(files.learned, emptyLearnedState()),
    feedback: await readJson<Feedback[]>(files.feedback, []),
    sources: await readJson<KbSource[]>(files.sources, []),
    tracked: await readJson<string[]>(files.tracked, []),
    images: migrateImageCache(await readJson<Record<string, unknown>>(files.images, {})),
    training: await readJson<TrainExample[]>(files.training, []),
    lastTraining: await readJson<TrainingSummary | null>(files.lastTraining, null),
  };
  return cache;
}

/** Accept the legacy `string | null` cache format and lift it to `string[] | null`. */
function migrateImageCache(raw: Record<string, unknown>): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    else if (typeof v === 'string') out[k] = [v];
    else out[k] = null;
  }
  return out;
}

async function persist(key: keyof typeof files): Promise<void> {
  const db = await ensureLoaded();
  await writeFile(files[key], JSON.stringify(db[key], null, 2), 'utf8');
}

export const store = {
  async getLearned(): Promise<LearnedState> {
    return (await ensureLoaded()).learned;
  },
  async setLearned(state: LearnedState): Promise<void> {
    (await ensureLoaded()).learned = state;
    await persist('learned');
  },
  async getFeedback(): Promise<Feedback[]> {
    return (await ensureLoaded()).feedback;
  },
  async addFeedback(fb: Feedback): Promise<void> {
    (await ensureLoaded()).feedback.push(fb);
    await persist('feedback');
  },
  async getSources(location?: string): Promise<KbSource[]> {
    const all = (await ensureLoaded()).sources;
    if (!location) return all;
    const key = location.trim().toLowerCase();
    return all.filter((s) => s.location.trim().toLowerCase() === key);
  },
  async addSource(src: KbSource): Promise<void> {
    const db = await ensureLoaded();
    // Replace an existing source for the same URL+location (re-ingestion refresh).
    db.sources = db.sources.filter(
      (s) => !(s.url === src.url && s.location.toLowerCase() === src.location.toLowerCase()),
    );
    db.sources.push(src);
    await persist('sources');
  },
  async getTracked(): Promise<string[]> {
    return (await ensureLoaded()).tracked;
  },
  async track(location: string): Promise<void> {
    const db = await ensureLoaded();
    const key = location.trim();
    if (!db.tracked.some((t) => t.toLowerCase() === key.toLowerCase())) {
      db.tracked.push(key);
      await persist('tracked');
    }
  },
  async getImageCache(): Promise<Record<string, string[] | null>> {
    return (await ensureLoaded()).images;
  },
  async saveImageCache(): Promise<void> {
    await persist('images');
  },

  async getTraining(): Promise<TrainExample[]> {
    return (await ensureLoaded()).training;
  },
  /** Append examples, replacing any prior example for the same place (keep latest). */
  async addTrainingExamples(examples: TrainExample[]): Promise<void> {
    if (!examples.length) return;
    const db = await ensureLoaded();
    const key = (e: TrainExample) => `${e.loc.toLowerCase()}|${e.name.toLowerCase()}`;
    const incoming = new Set(examples.map(key));
    db.training = db.training.filter((e) => !incoming.has(key(e)));
    db.training.push(...examples);
    if (db.training.length > TRAIN_LOG_CAP) db.training = db.training.slice(-TRAIN_LOG_CAP);
    await persist('training');
  },
  async getLastTraining(): Promise<TrainingSummary | null> {
    return (await ensureLoaded()).lastTraining;
  },
  async setLastTraining(summary: TrainingSummary): Promise<void> {
    (await ensureLoaded()).lastTraining = summary;
    await persist('lastTraining');
  },
};
