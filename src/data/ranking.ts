import type { CategoryId, Destination } from '../types';

/**
 * Recommendation engine.
 *
 * Wikivoyage doesn't carry star ratings, so "how much we recommend it" is derived
 * from signals that correlate with a place being notable and well-documented:
 * how completely it's described, whether it's a recognised entity (Wikidata),
 * whether editors bothered to add a website/photo, textual cues of prominence,
 * and where it sits in the article.
 *
 * Every weight lives in RANKING_WEIGHTS so the whole worldwide catalogue can be
 * re-tuned from one place. When you give feedback on specific locations, we adjust
 * these weights (or the keyword lists) and every other location benefits.
 */
export interface RankingWeights {
  base: number;
  hasCoordinates: number;
  hasWikidata: number;
  hasImage: number;
  hasUrl: number;
  hasHours: number;
  hasPrice: number;
  hasAddress: number;
  /** Points for a rich description, scaled by length up to this cap. */
  descriptionLengthMax: number;
  descriptionLengthChars: number;
  /** Bonus for appearing near the top of its section (editor priority). */
  earlyOrderBonus: number;
  /** Bonus per matched "prominence" keyword (UNESCO, iconic, must-see...). */
  notableKeywordBonus: number;
  notableKeywordCap: number;
}

export const RANKING_WEIGHTS: RankingWeights = {
  base: 10,
  hasCoordinates: 6,
  hasWikidata: 14,
  hasImage: 10,
  hasUrl: 6,
  hasHours: 3,
  hasPrice: 3,
  hasAddress: 4,
  descriptionLengthMax: 22,
  descriptionLengthChars: 320,
  earlyOrderBonus: 10,
  notableKeywordBonus: 5,
  notableKeywordCap: 20,
};

export const DEFAULT_PROMINENCE_KEYWORDS = [
  'unesco',
  'world heritage',
  'world-famous',
  'world famous',
  'iconic',
  'must-see',
  'must see',
  'must-visit',
  'must visit',
  'most famous',
  'best-known',
  'best known',
  'renowned',
  'landmark',
  'the largest',
  'the oldest',
  'the tallest',
  'the biggest',
  'the highest',
  'symbol of',
  'national treasure',
  'masterpiece',
  'spectacular',
  'breathtaking',
  'not to be missed',
  'one of the',
  'highlight',
];

function buildProminenceRegex(extra: string[] = []): RegExp {
  const all = [...DEFAULT_PROMINENCE_KEYWORDS, ...extra].map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[ -]'),
  );
  return new RegExp('\\b(' + all.join('|') + ')\\b', 'gi');
}

/**
 * Learned adjustments applied at ranking time. These come from the feedback +
 * self-tuning loops, so targeted input ("in Kyoto, X should rank higher") and
 * global tuning both flow through here without changing the base model.
 */
export interface RankingLearning {
  weights?: RankingWeights;
  /** normalizedName -> additive score nudge (positive promotes, negative demotes). */
  overrides?: Record<string, number>;
  /** Extra "highlight" cues discovered by self-tuning. */
  prominenceKeywords?: string[];
}

/**
 * Manual per-place overrides collected from user feedback. Keyed by a normalized
 * destination name. Kept for backwards-compat; the backend passes a live map via
 * RankingLearning instead.
 */
export const FEEDBACK_OVERRIDES: Record<string, number> = {};

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface ScoredRaw {
  raw: number;
  reasons: string[];
}

function rawScore(
  d: Destination,
  orderInCategory: number,
  w: RankingWeights,
  prominenceRe: RegExp,
  overrides: Record<string, number>,
): ScoredRaw {
  let score = w.base;
  const reasons: string[] = [];

  if (d.lat != null && d.lon != null) {
    score += w.hasCoordinates;
  }
  if (d.wikidata) {
    score += w.hasWikidata;
    reasons.push('Recognised place (Wikidata entry)');
  }
  if (d.image) {
    score += w.hasImage;
    reasons.push('Has a photo');
  }
  if (d.url) score += w.hasUrl;
  if (d.hours) score += w.hasHours;
  if (d.price) score += w.hasPrice;
  if (d.address) score += w.hasAddress;

  const descLen = d.description?.length ?? 0;
  if (descLen > 0) {
    const frac = Math.min(1, descLen / w.descriptionLengthChars);
    const pts = frac * w.descriptionLengthMax;
    score += pts;
    if (descLen > w.descriptionLengthChars * 0.6) {
      reasons.push('Richly described');
    }
  }

  // Editor priority: earlier listings within a category get a decaying bonus.
  const orderBonus = w.earlyOrderBonus / (1 + orderInCategory * 0.35);
  score += orderBonus;

  const matches = d.description ? d.description.match(prominenceRe) : null;
  if (matches && matches.length) {
    const bonus = Math.min(w.notableKeywordCap, matches.length * w.notableKeywordBonus);
    score += bonus;
    reasons.push('Described as a highlight');
  }

  const override = overrides[normalizeName(d.name)];
  if (override) {
    score += override;
    reasons.push(override > 0 ? 'Boosted by traveller feedback' : 'Down-weighted by traveller feedback');
  }

  return { raw: Math.max(0, score), reasons };
}

/**
 * Score, normalize (0..100) and rank destinations. Ranking is computed per
 * category so each list reads as "most → least recommended".
 */
export function rankDestinations(
  destinations: Destination[],
  learning: RankingLearning = {},
): Destination[] {
  const weights = learning.weights ?? RANKING_WEIGHTS;
  const overrides = learning.overrides ?? FEEDBACK_OVERRIDES;
  const prominenceRe = buildProminenceRegex(learning.prominenceKeywords);

  // Track order within each category to reward editorial priority.
  const seenPerCategory: Record<string, number> = {};
  const scored = destinations.map((d) => {
    const orderInCategory = seenPerCategory[d.category] ?? 0;
    seenPerCategory[d.category] = orderInCategory + 1;
    const { raw, reasons } = rawScore(d, orderInCategory, weights, prominenceRe, overrides);
    return { d, raw, reasons };
  });

  const max = Math.max(1, ...scored.map((s) => s.raw));

  const withScores: Destination[] = scored.map(({ d, raw, reasons }) => ({
    ...d,
    score: Math.round((raw / max) * 100),
    reasons,
  }));

  // Assign per-category rank.
  const byCategory = new Map<CategoryId, Destination[]>();
  for (const d of withScores) {
    const arr = byCategory.get(d.category) ?? [];
    arr.push(d);
    byCategory.set(d.category, arr);
  }
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => b.score - a.score || a.order - b.order);
    arr.forEach((d, i) => {
      d.rank = i + 1;
    });
  }

  return withScores;
}
