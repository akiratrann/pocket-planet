// Shared "learning" model used by both the app and the backend.
//
// Everything the system learns — from your feedback and from web ingestion + the
// periodic self-tuning job — is captured in a single LearnedState. Applying it to
// a freshly fetched guide re-classifies, re-ranks and enriches it. Because it's
// pure data + pure functions, targeted feedback on one place generalizes to every
// place the same rules touch.

import type { AdviceSection, CategoryId, Destination, Guide } from '../types';
import { classifyCategory } from '../data/categories';
import {
  RANKING_WEIGHTS,
  normalizeName,
  rankDestinations,
  type RankingWeights,
} from '../data/ranking';
import { computeExtent } from '../data/wikivoyage';

export type FeedbackKind = 'promote' | 'demote' | 'recategorize' | 'note' | 'rate';

export interface Feedback {
  id: string;
  /** The place being explored (guide title / query). */
  location: string;
  /** Destination name, or '' for location-level feedback. */
  name: string;
  kind: FeedbackKind;
  /** Magnitude for promote/demote/rate (rate uses -100..100). */
  weight?: number;
  /** Target category for a recategorize. */
  category?: CategoryId;
  /** Free text for a note (also used as an ingestion signal). */
  note?: string;
  ts: number;
}

export interface LearnedState {
  version: number;
  updatedAt: number;
  weights: RankingWeights;
  /** normalizedName -> additive score nudge. */
  overrides: Record<string, number>;
  /** normalizedName -> forced category. */
  categoryOverrides: Record<string, CategoryId>;
  prominenceKeywords: string[];
  cultureKeywords: string[];
  natureKeywords: string[];
  /** locationKey -> learned traveller notes. */
  notesByLocation: Record<string, string[]>;
}

export function emptyLearnedState(): LearnedState {
  return {
    version: 1,
    updatedAt: Date.now(),
    weights: { ...RANKING_WEIGHTS },
    overrides: {},
    categoryOverrides: {},
    prominenceKeywords: [],
    cultureKeywords: [],
    natureKeywords: [],
    notesByLocation: {},
  };
}

export function locationKey(s: string): string {
  return s.trim().toLowerCase();
}

/** How far one place can be moved by traveller feedback, in either direction.
 *  Exported so the Learn tab can quote the real ceiling. */
export const OVERRIDE_CAP = 70;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Fold a single piece of feedback into the learned state. This is the immediate
 * "relearn as you input" step; the periodic self-tuning job later generalizes
 * patterns across many feedback items.
 */
export function applyFeedback(state: LearnedState, fb: Feedback): LearnedState {
  const next: LearnedState = {
    ...state,
    overrides: { ...state.overrides },
    categoryOverrides: { ...state.categoryOverrides },
    notesByLocation: { ...state.notesByLocation },
    updatedAt: Date.now(),
    version: state.version + 1,
  };
  const key = normalizeName(fb.name);

  switch (fb.kind) {
    case 'promote':
      next.overrides[key] = clamp((next.overrides[key] ?? 0) + (fb.weight ?? 25), -OVERRIDE_CAP, OVERRIDE_CAP);
      break;
    case 'demote':
      next.overrides[key] = clamp((next.overrides[key] ?? 0) - (fb.weight ?? 25), -OVERRIDE_CAP, OVERRIDE_CAP);
      break;
    case 'rate': {
      // Map a -100..100 rating onto an override nudge.
      const delta = ((fb.weight ?? 0) / 100) * OVERRIDE_CAP;
      next.overrides[key] = clamp(delta, -OVERRIDE_CAP, OVERRIDE_CAP);
      break;
    }
    case 'recategorize':
      if (fb.category) next.categoryOverrides[key] = fb.category;
      break;
    case 'note':
    case undefined as never:
    default:
      break;
  }

  if (fb.note && fb.note.trim()) {
    const lk = locationKey(fb.location);
    const notes = next.notesByLocation[lk] ? [...next.notesByLocation[lk]] : [];
    notes.push(fb.note.trim());
    next.notesByLocation[lk] = notes.slice(-20);
  }

  return next;
}

/**
 * Apply learned state (and any extra destinations from web ingestion) to a raw
 * Wikivoyage guide: merge, re-classify, re-rank, and enrich advice.
 */
export function applyLearning(
  guide: Guide,
  state: LearnedState,
  extras: Destination[] = [],
  /** Per-request community "buzz" boosts (normalizedName -> points), from real
   *  online discussions. Not part of persistent learned state. */
  buzz: Record<string, number> = {},
): Guide {
  const merged = [...guide.destinations, ...extras];

  // Re-classify with learned cues, then honour explicit category overrides.
  const reclassified = merged.map((d) => {
    const learnedCat = classifyCategory(d.wvType, d.name, d.description ?? '', {
      cultureKeywords: state.cultureKeywords,
      natureKeywords: state.natureKeywords,
    });
    const override = state.categoryOverrides[normalizeName(d.name)];
    return { ...d, category: override ?? learnedCat };
  });

  const ranked = rankDestinations(reclassified, {
    weights: state.weights,
    overrides: state.overrides,
    prominenceKeywords: state.prominenceKeywords,
    buzz,
  });

  const { center, bbox } = computeExtent(ranked);

  // Enrich advice with learned traveller notes.
  const notes = state.notesByLocation[locationKey(guide.title)] ?? [];
  const advice: AdviceSection[] = [...guide.advice];
  if (notes.length) {
    advice.unshift({
      id: 'traveller-notes',
      title: 'Traveller notes (learned)',
      icon: '📝',
      body: notes.map((n) => `• ${n}`).join('\n'),
    });
  }

  return {
    ...guide,
    destinations: ranked,
    advice,
    center: bbox ? center : guide.center,
    bbox: bbox ?? guide.bbox,
  };
}
