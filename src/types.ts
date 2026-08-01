// Core domain types for the travel assistant.

export type CategoryId =
  | 'sights'
  | 'culture'
  | 'nature'
  | 'food'
  | 'nightlife'
  | 'shopping'
  | 'activities'
  | 'sleep';

export interface Category {
  id: CategoryId;
  label: string;
  icon: string; // emoji marker glyph
  color: string; // hex used for map pins + accents
  /** Wikivoyage listing "types" that map onto this app category. */
  wvTypes: string[];
  blurb: string;
}

export interface Destination {
  id: string;
  name: string;
  category: CategoryId;
  /** Original Wikivoyage listing type (see/do/eat/drink/buy/sleep). */
  wvType: string;
  lat?: number;
  lon?: number;
  description?: string;
  address?: string;
  url?: string;
  phone?: string;
  hours?: string;
  price?: string;
  wikidata?: string;
  /** Primary photo (first of `images` when present). */
  image?: string;
  /** A small gallery of real photos of this place (best first, typically 1-5). */
  images?: string[];
  /** Recommendation score, normalized 0..100 across the guide. */
  score: number;
  /** 1-based rank within its category (1 = most recommended). */
  rank: number;
  /** Original position in the source article. */
  order: number;
  /** Human-readable (English) reasons the item scored the way it did. */
  reasons: string[];
  /**
   * The same reasons as stable codes (`reason_*`, see src/data/ranking.ts), in
   * the same order. The UI translates these; `reasons` is the fallback for a
   * guide assembled before codes existed, and the text non-UI consumers read.
   */
  reasonCodes?: string[];
  /**
   * How many times each source provider's text names this place, e.g.
   * `{ "Lonely Planet": 3, "Reddit": 12 }`. These are literal name matches over
   * real source summaries: evidence that a place is TALKED ABOUT, not that
   * anyone recommended it. Present it as "mentioned 12 times", never as
   * "recommended by".
   */
  mentions?: Record<string, number>;
  /**
   * This place's name and/or description were machine-translated, because no
   * Wikipedia edition or Wikidata label covered it in the reader's language.
   * Surfaced to the reader: a translation is not an editor's own sentence, and
   * they should know which text to double-check.
   */
  translated?: boolean;
  /**
   * The boost those mentions actually contributed to `score`. Kept separate from
   * `mentions` because providers are weighted differently (a Lonely Planet
   * mention counts for four Stack Exchange ones), so folding the weighting into
   * the counts would make "12 mentions" mean a different thing per source.
   */
  mentionScore?: number;
}

export interface AdviceSection {
  id: string;
  title: string;
  icon: string;
  body: string;
}

/** A single traveller opinion, quoted/derived from a real source (never invented). */
export interface Opinion {
  text: string;
  /** Where this point came from, e.g. "Wikivoyage" or an ingested source title. */
  source: string;
  url?: string;
  /** The specific place the opinion is about, when it maps to one. */
  place?: string;
}

/** Summary of what travellers say about a location, split into pros and cons. */
export interface LocationOpinions {
  positives: Opinion[];
  negatives: Opinion[];
  /** Plain-language note on how these were derived (for transparency). */
  basis: string;
  /** Sources the summary was built from. */
  sources: Array<{ title: string; url?: string }>;
}

/**
 * The parts of the scoring model that live on the server, reported with the
 * guide so the Learn tab can describe the numbers the ranker ACTUALLY used
 * instead of a second copy of them that can drift.
 */
export interface ScoringMeta {
  /** Ranking weights in force for this guide (learned, not the defaults). */
  weights: Record<string, number>;
  /** Publisher -> points added per time that publisher's text names a place. */
  mentionWeights: Record<string, number>;
  /** Ceiling on the total mention boost one place can receive. */
  mentionCap: number;
  /** Ceiling on how far one traveller correction can move a place, either way. */
  feedbackCap: number;
}

export interface GuideMeta {
  provider: string;
  learnedVersion: number;
  feedbackApplied: number;
  sources: Array<{
    title: string;
    url: string;
    /** Publisher the source came from ("Lonely Planet", "Reddit", "YouTube"…). */
    provider: string;
    fetchedAt: number;
    poiCount: number;
  }>;
  ingestedPois: number;
  /** What travellers say (positive + negative), grounded in real sources. */
  opinions?: LocationOpinions;
  /** How this guide was scored (for the Learn tab's methodology section). */
  scoring?: ScoringMeta;
}

export interface Guide {
  title: string;
  intro: string;
  advice: AdviceSection[];
  destinations: Destination[];
  /** [lon, lat] map center. */
  center: [number, number];
  /** [minLon, minLat, maxLon, maxLat] */
  bbox?: [number, number, number, number];
  attribution: string;
  sourceUrl: string;
  /** Sub-regions / child destinations (for country/region scope drill-down). */
  related: string[];
  /**
   * The region this place sits inside, from Wikivoyage's `{{IsPartOf}}`
   * breadcrumb (Nakatsugawa → "Gifu (prefecture)"). ONE level up, not a full
   * chain — walking to the root would cost a Wikivoyage fetch per ancestor.
   *
   * This is editorial hierarchy, which is the right answer for "where is this?"
   * and the wrong answer for "what am I looking at?" — map scope is resolved
   * from the viewport instead (see scopeForSpanKm in src/data/geocode.ts),
   * because Kyoto's breadcrumb parent is Kansai when a country-sized viewport
   * means Japan.
   */
  parent?: string;
  /** Present when assembled by the backend brain (RAG + learning). */
  meta?: GuideMeta;
}
