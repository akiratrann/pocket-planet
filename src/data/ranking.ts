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
  /** Penalty when the NAME says the place is civic/utility, not an attraction. */
  civicNamePenalty: number;
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
  // Large enough to sink a civic building below every real sight in its
  // category, small enough that it is a demotion and not a deletion.
  civicNamePenalty: 45,
};

// ---------------------------------------------------------------------------
// Civic / utility names.
//
// The authoritative relevance check is structured (Wikidata `instance of`, and
// which subsection of the article a listing came from) and runs before ranking.
// This is the LAST resort for the places that carry no structured data at all,
// so it only ever DEMOTES: a keyword can be wrong, and burying a real attraction
// is recoverable in a way that deleting it is not.
//
// Matched against the NAME only. Descriptions mention hospitals and schools as
// landmarks all the time ("opposite the city hospital"), and penalising that
// would hit the temple across the road instead of the hospital.
//
// Known limits: it is a fixed list in a handful of languages, so it says nothing
// about the thousands of others; and any place whose own name contains one of
// these words is demoted regardless of what it really is — which is why
// ATTRACTION_RE below pardons the museum housed in an old post office.
// ---------------------------------------------------------------------------
const CIVIC_NAME_PATTERNS = [
  // Education.
  'elementary school', 'primary school', 'middle school', 'junior high school',
  'high school', 'secondary school', 'special needs school', 'kindergarten',
  'nursery school', 'driving school',
  // Administration and public services.
  'post office', 'city hall', 'town hall', 'village office', 'ward office',
  'municipal office', 'prefectural office', 'city office', 'police station',
  'police box', 'fire station', 'tax office', 'employment office',
  // Health. Deliberately NOT a bare "hospital": historic ones are among the
  // great sights of Europe (Barcelona's Hospital de Sant Pau is a UNESCO site),
  // and a working hospital that has a Wikipedia article is already caught
  // upstream by its Wikidata class, which is the check that can tell them apart.
  'general hospital', 'city hospital', 'central hospital', 'regional hospital',
  'district hospital', 'university hospital', 'psychiatric hospital',
  'clinic', 'health centre', 'health center', 'medical centre', 'medical center',
  // Money.
  'atm',
  // Utilities and generic infrastructure.
  'water treatment', 'sewage', 'power plant', 'power station', 'substation',
  'landfill', 'incinerator', 'car park', 'parking lot', 'petrol station',
  'gas station', 'filling station',
];

// Non-Latin and accented equivalents. JavaScript's \b is ASCII-only, so these
// must be matched WITHOUT word boundaries (see the Latin/non-Latin split below).
const CIVIC_NAME_PATTERNS_INTL = [
  // Japanese: elementary / middle / high / special-needs school, post office,
  // city + town hall, police + fire station, hospital, clinic.
  '小学校', '中学校', '高等学校', '支援学校', '幼稚園', '郵便局', '市役所', '町役場',
  '区役所', '警察署', '交番', '消防署', '病院', '診療所', '浄水場',
  // Chinese.
  '小学', '中学', '派出所', '医院', '邮局', '郵局',
  // Korean.
  '초등학교', '중학교', '고등학교', '우체국', '경찰서', '병원',
  // Vietnamese.
  'ngân hàng', 'bưu điện', 'trường tiểu học', 'trường trung học', 'bệnh viện',
  'trạm y tế', 'ủy ban nhân dân',
  // Thai.
  'โรงเรียน', 'โรงพยาบาล',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CIVIC_RE = new RegExp(
  '\\b(' + CIVIC_NAME_PATTERNS.map(escapeRe).map((k) => k.replace(/\s+/g, '[ -]')).join('|') + ')\\b',
  'i',
);
const CIVIC_RE_INTL = new RegExp('(' + CIVIC_NAME_PATTERNS_INTL.map(escapeRe).join('|') + ')', 'i');

// A civic word inside an attraction's name is usually part of its story, not its
// function: the museum in the former post office, the memorial at the old
// hospital. Any of these pardons the match outright.
const ATTRACTION_RE =
  /\b(museum|gallery|memorial|monument|shrine|temple|cathedral|basilica|church|mosque|synagogue|castle|palace|fort|fortress|ruins?|park|garden|beach|waterfall|onsen|spa|market|bazaar|theatre|theater|gallery|heritage|historic|historical|national\s+treasure)\b/i;

/** Does the NAME say this is a civic/utility building rather than a sight? */
export function looksCivic(name: string): boolean {
  if (ATTRACTION_RE.test(name)) return false;
  return CIVIC_RE.test(name) || CIVIC_RE_INTL.test(name);
}

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
  /** normalizedName -> boost from how often the place is recommended in real
   *  online discussions (Reddit, Travel Stack Exchange…). Grounded in mentions. */
  buzz?: Record<string, number>;
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

// ---------------------------------------------------------------------------
// Reasons.
//
// The ranker runs on the SERVER, where the reader's language isn't its concern,
// so every reason it emits is produced twice: a stable machine code and the
// English sentence. The code is what the UI translates (see `reason_*` in
// src/i18n.ts) and what other code should match on; the English text is what
// non-UI consumers read (the chat prompt, logs) and the UI's fallback when a
// guide was assembled before codes existed.
//
// Wording note: the mention signal counts how often a place is NAMED in the
// sources we read. That is evidence it gets talked about — not that anybody
// recommended it, and not a rating — so the sentence says "mentioned".
// ---------------------------------------------------------------------------
export const REASON = {
  wikidata: 'reason_wikidata',
  photo: 'reason_photo',
  described: 'reason_described',
  highlight: 'reason_highlight',
  feedbackUp: 'reason_feedback_up',
  feedbackDown: 'reason_feedback_down',
  mentioned: 'reason_mentioned',
  civic: 'reason_civic',
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

/** English text for each reason code (the server-side / fallback rendering). */
export const REASON_TEXT: Record<ReasonCode, string> = {
  [REASON.wikidata]: 'Recognised place (Wikidata entry)',
  [REASON.photo]: 'Has a photo',
  [REASON.described]: 'Richly described',
  [REASON.highlight]: 'Described as a highlight',
  [REASON.feedbackUp]: 'Boosted by traveller feedback',
  [REASON.feedbackDown]: 'Down-weighted by traveller feedback',
  [REASON.mentioned]: 'Mentioned by name in travel discussions and editorial articles',
  [REASON.civic]: 'Not a visitable attraction (civic or utility building)',
};

/** The reason that is about OUTSIDE sources rather than about the listing. */
export const EXTERNAL_REASONS: ReadonlySet<string> = new Set<string>([REASON.mentioned]);

interface ScoredRaw {
  raw: number;
  reasons: string[];
  codes: string[];
}

function rawScore(
  d: Destination,
  orderInCategory: number,
  w: RankingWeights,
  prominenceRe: RegExp,
  overrides: Record<string, number>,
  buzz: Record<string, number>,
): ScoredRaw {
  let score = w.base;
  const codes: string[] = [];
  const add = (code: ReasonCode) => {
    codes.push(code);
  };

  if (d.lat != null && d.lon != null) {
    score += w.hasCoordinates;
  }
  if (d.wikidata) {
    score += w.hasWikidata;
    add(REASON.wikidata);
  }
  if (d.image) {
    score += w.hasImage;
    add(REASON.photo);
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
      add(REASON.described);
    }
  }

  // Editor priority: earlier listings within a category get a decaying bonus.
  const orderBonus = w.earlyOrderBonus / (1 + orderInCategory * 0.35);
  score += orderBonus;

  const matches = d.description ? d.description.match(prominenceRe) : null;
  if (matches && matches.length) {
    const bonus = Math.min(w.notableKeywordCap, matches.length * w.notableKeywordBonus);
    score += bonus;
    add(REASON.highlight);
  }

  const override = overrides[normalizeName(d.name)];
  if (override) {
    score += override;
    add(override > 0 ? REASON.feedbackUp : REASON.feedbackDown);
  }

  const buzzBoost = buzz[normalizeName(d.name)];
  if (buzzBoost) {
    score += buzzBoost;
    // Counting how often a place is NAMED is not the same as anyone endorsing
    // it, and this line used to say "Recommended in trusted travel sources",
    // which asserted an endorsement the data cannot support.
    add(REASON.mentioned);
  }

  // Applied last so it outweighs the signals that put civic buildings high in
  // the first place: they have Wikidata entries and well-written articles, which
  // is exactly what the rest of this function rewards.
  if (looksCivic(d.name)) {
    // Weights are persisted to disk and reloaded, so a state saved before this
    // one existed has no value for it — fall back rather than score NaN.
    score -= Number.isFinite(w.civicNamePenalty) ? w.civicNamePenalty : RANKING_WEIGHTS.civicNamePenalty;
    add(REASON.civic);
  }

  return {
    raw: Math.max(0, score),
    codes,
    reasons: codes.map((c) => REASON_TEXT[c as ReasonCode] ?? c),
  };
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
  const buzz = learning.buzz ?? {};
  const prominenceRe = buildProminenceRegex(learning.prominenceKeywords);

  // Track order within each category to reward editorial priority.
  const seenPerCategory: Record<string, number> = {};
  const scored = destinations.map((d) => {
    const orderInCategory = seenPerCategory[d.category] ?? 0;
    seenPerCategory[d.category] = orderInCategory + 1;
    const { raw, reasons, codes } = rawScore(d, orderInCategory, weights, prominenceRe, overrides, buzz);
    return { d, raw, reasons, codes };
  });

  const max = Math.max(1, ...scored.map((s) => s.raw));

  const withScores: Destination[] = scored.map(({ d, raw, reasons, codes }) => ({
    ...d,
    score: Math.round((raw / max) * 100),
    reasons,
    reasonCodes: codes,
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
