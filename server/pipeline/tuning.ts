// Periodic self-tuning: review accumulated feedback and let the LLM propose
// GLOBAL improvements (new classification cues, prominence words, weight tweaks),
// then fold them into the learned state so every location benefits.

import { getLLM, type TuningProposal } from '../llm/adapter.ts';
import { store } from '../store.ts';
import type { RankingWeights } from '../../src/data/ranking.ts';

function mergeKeywords(current: string[], additions?: string[]): string[] {
  if (!additions?.length) return current;
  const set = new Set(current.map((k) => k.toLowerCase()));
  for (const a of additions) {
    const k = a.trim().toLowerCase();
    if (k) set.add(k);
  }
  return [...set];
}

function applyWeightDeltas(weights: RankingWeights, deltas?: Partial<RankingWeights>): RankingWeights {
  if (!deltas) return weights;
  const next = { ...weights };
  for (const [key, delta] of Object.entries(deltas)) {
    const k = key as keyof RankingWeights;
    if (typeof next[k] === 'number' && typeof delta === 'number') {
      // Clamp each weight to a sane range so tuning can't run away.
      next[k] = Math.max(0, Math.min(60, next[k] + delta));
    }
  }
  return next;
}

export async function runTuning(): Promise<TuningProposal & { version: number }> {
  const llm = getLLM();
  const feedback = await store.getFeedback();
  const state = await store.getLearned();

  const proposal = await llm.proposeTuning(feedback, state);

  const next = {
    ...state,
    cultureKeywords: mergeKeywords(state.cultureKeywords, proposal.cultureKeywords),
    natureKeywords: mergeKeywords(state.natureKeywords, proposal.natureKeywords),
    prominenceKeywords: mergeKeywords(state.prominenceKeywords, proposal.prominenceKeywords),
    weights: applyWeightDeltas(state.weights, proposal.weightDeltas),
    version: state.version + 1,
    updatedAt: Date.now(),
  };
  await store.setLearned(next);

  console.log(`[tuning] v${next.version}: ${proposal.rationale}`);
  return { ...proposal, version: next.version };
}
