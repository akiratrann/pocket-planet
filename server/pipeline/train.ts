// In-app model training.
//
// The recommender's "model" is the set of ranking WEIGHTS + keyword cues in the
// learned state. Self-tuning (tuning.ts) only mines keywords from feedback; it
// never learns which SIGNALS actually predict a great place. This module closes
// that loop: as the app is used it records, for every place shown, a feature
// vector plus the real-world "reward" it earned (community buzz + traveller
// feedback). Here we fit a small logistic-regression model over those examples
// and fold the learned feature importances back into the global ranking weights.
//
// No external ML dependency — it's a from-scratch, standardized-feature logistic
// regression with L2 and class-balanced sampling, which is plenty for ~10
// features and thousands of examples, and keeps the app self-contained.

import type { Destination } from '../../src/types.ts';
import {
  DEFAULT_PROMINENCE_KEYWORDS,
  RANKING_WEIGHTS,
  type RankingWeights,
} from '../../src/data/ranking.ts';
import { getLLM } from '../llm/adapter.ts';
import { store, type TrainExample, type TrainingSummary } from '../store.ts';

// Feature vector layout. Each entry maps 1:1 to a tunable ranking weight, so a
// learned importance translates directly into a weight update.
export const FEATURES: Array<keyof RankingWeights> = [
  'hasCoordinates',
  'hasWikidata',
  'hasImage',
  'hasUrl',
  'hasHours',
  'hasPrice',
  'hasAddress',
  'descriptionLengthMax', // fed by description-length fraction
  'earlyOrderBonus', // fed by editorial-order recency
  'notableKeywordBonus', // fed by prominence-keyword match
];

const PROMINENCE_RE = new RegExp(
  '\\b(' +
    DEFAULT_PROMINENCE_KEYWORDS.map((k) =>
      k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ -]'),
    ).join('|') +
    ')\\b',
  'i',
);

/** Extract the training feature vector for a destination (values in 0..1). */
export function featuresOf(d: Destination): number[] {
  const descLen = d.description?.length ?? 0;
  return [
    d.lat != null && d.lon != null ? 1 : 0,
    d.wikidata ? 1 : 0,
    d.image ? 1 : 0,
    d.url ? 1 : 0,
    d.hours ? 1 : 0,
    d.price ? 1 : 0,
    d.address ? 1 : 0,
    Math.min(1, descLen / RANKING_WEIGHTS.descriptionLengthChars),
    1 / (1 + (d.order ?? 0)),
    d.description && PROMINENCE_RE.test(d.description) ? 1 : 0,
  ];
}

// --- Training hyper-parameters -------------------------------------------------
const MIN_EXAMPLES = 40; // below this we can't learn stable weights
const MIN_POSITIVES = 5;
const ITERS = 500;
const LR = 0.3;
const L2 = 0.01;
const NEG_RATIO = 3; // negatives kept per positive (class balancing)
const POINT_SCALE = 18; // standardized coef → ranking points
const WEIGHT_MIN = 0;
const WEIGHT_MAX = 60;

function mergeKeywords(current: string[], additions?: string[]): string[] {
  if (!additions?.length) return current;
  const set = new Set(current.map((k) => k.toLowerCase()));
  for (const a of additions) {
    const k = a.trim().toLowerCase();
    if (k) set.add(k);
  }
  return [...set];
}

// Deterministic PRNG so training is reproducible run-to-run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fit {
  coef: number[]; // standardized-space coefficients
  accuracy: number;
  positives: number;
  used: number;
}

/** Class-balanced logistic regression over standardized features. */
function fitLogistic(examples: TrainExample[]): Fit | null {
  const pos = examples.filter((e) => e.reward > 0);
  const neg = examples.filter((e) => e.reward <= 0);
  if (examples.length < MIN_EXAMPLES || pos.length < MIN_POSITIVES) return null;

  // Balance classes: keep all positives, sample up to NEG_RATIO× negatives.
  const rng = mulberry32(1234567);
  const shuffledNeg = [...neg].sort(() => rng() - 0.5).slice(0, pos.length * NEG_RATIO);
  const data = [...pos, ...shuffledNeg];
  const X = data.map((e) => e.f);
  const y = data.map((e) => (e.reward > 0 ? 1 : 0));
  const n = X.length;
  const dim = FEATURES.length;

  // Standardize each feature column.
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const row of X) for (let j = 0; j < dim; j++) mean[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < dim; j++) std[j] += (row[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < dim; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));

  // Gradient descent on logistic loss with L2.
  const w = new Array(dim).fill(0);
  let b = 0;
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < ITERS; it++) {
    const gw = new Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < dim; j++) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < dim; j++) gw[j] += (err * Z[i][j]) / n;
      gb += err / n;
    }
    for (let j = 0; j < dim; j++) w[j] -= LR * (gw[j] + L2 * w[j]);
    b -= LR * gb;
  }

  // Training accuracy at 0.5.
  let correct = 0;
  for (let i = 0; i < n; i++) {
    let z = b;
    for (let j = 0; j < dim; j++) z += w[j] * Z[i][j];
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === y[i]) correct++;
  }

  return { coef: w, accuracy: correct / n, positives: pos.length, used: n };
}

/**
 * Train the ranking model on recorded examples and fold the result into the
 * global learned state. Always also runs keyword mining (feedback → cues).
 */
export async function runTraining(): Promise<TrainingSummary> {
  const llm = getLLM();
  const state = await store.getLearned();
  const feedback = await store.getFeedback();
  const examples = await store.getTraining();

  // 1) Keyword cues from feedback (works even with zero training examples).
  const proposal = await llm.proposeTuning(feedback, state);
  const cultureKeywords = mergeKeywords(state.cultureKeywords, proposal.cultureKeywords);
  const natureKeywords = mergeKeywords(state.natureKeywords, proposal.natureKeywords);
  const prominenceKeywords = mergeKeywords(state.prominenceKeywords, proposal.prominenceKeywords);
  const keywordsAdded =
    cultureKeywords.length -
    state.cultureKeywords.length +
    (natureKeywords.length - state.natureKeywords.length) +
    (prominenceKeywords.length - state.prominenceKeywords.length);

  // 2) Train ranking weights from real feature/reward examples.
  const fit = fitLogistic(examples);
  let weights = state.weights;
  const weightChanges: string[] = [];
  let accuracy: number | null = null;

  if (fit && fit.accuracy >= 0.6) {
    accuracy = fit.accuracy;
    // Trust the fit more as evidence accumulates (capped blend).
    const alpha = Math.min(0.5, fit.positives / 60);
    const next: RankingWeights = { ...weights };
    FEATURES.forEach((key, j) => {
      const learnedPts = Math.max(0, fit.coef[j]) * POINT_SCALE; // only reward predictive signals
      const blended = Math.round(
        Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, (1 - alpha) * next[key] + alpha * learnedPts)),
      );
      if (Math.abs(blended - next[key]) >= 2) {
        weightChanges.push(`${key} ${next[key]}→${blended}`);
      }
      next[key] = blended;
    });
    weights = next;
  } else if (fit) {
    accuracy = fit.accuracy; // fit ran but too weak to trust
  }

  // 3) Persist the trained model (bump version so guides re-rank).
  const version = state.version + 1;
  await store.setLearned({
    ...state,
    weights,
    cultureKeywords,
    natureKeywords,
    prominenceKeywords,
    version,
    updatedAt: Date.now(),
  });

  const positives = examples.filter((e) => e.reward > 0).length;
  const rationale = buildRationale({
    examples: examples.length,
    positives,
    fit,
    weightChanges,
    keywordsAdded,
    proposalRationale: proposal.rationale,
  });

  const summary: TrainingSummary = {
    at: Date.now(),
    examples: examples.length,
    positives,
    accuracy,
    weightChanges,
    keywordsAdded,
    rationale,
    version,
  };
  await store.setLastTraining(summary);
  console.log(`[train] v${version}: ${rationale}`);
  return summary;
}

function buildRationale(args: {
  examples: number;
  positives: number;
  fit: Fit | null;
  weightChanges: string[];
  keywordsAdded: number;
  proposalRationale: string;
}): string {
  const parts: string[] = [];
  if (args.fit && args.fit.accuracy >= 0.6 && args.weightChanges.length) {
    parts.push(
      `Trained on ${args.examples} examples (${args.positives} recommended) — ` +
        `${Math.round(args.fit.accuracy * 100)}% fit. Adjusted ${args.weightChanges.length} ranking weight(s): ` +
        args.weightChanges.join(', ') +
        '.',
    );
  } else if (args.fit && args.fit.accuracy >= 0.6) {
    parts.push(
      `Trained on ${args.examples} examples (${Math.round(args.fit.accuracy * 100)}% fit); ` +
        'current weights already match the data.',
    );
  } else {
    parts.push(
      `Not enough recommendation signal yet (${args.examples} examples, ${args.positives} recommended). ` +
        'Explore more places and give feedback — the ranking model trains itself as data accumulates.',
    );
  }
  if (args.keywordsAdded > 0) {
    parts.push(`Learned ${args.keywordsAdded} new classification/prominence cue(s).`);
  }
  if (args.proposalRationale && !/no confident|no changes/i.test(args.proposalRationale)) {
    parts.push(args.proposalRationale);
  }
  return parts.join(' ');
}
