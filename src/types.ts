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
  /** Human-readable reasons the item scored the way it did (for transparency + tuning). */
  reasons: string[];
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

export interface GuideMeta {
  provider: string;
  learnedVersion: number;
  feedbackApplied: number;
  sources: Array<{ title: string; url: string; fetchedAt: number; poiCount: number }>;
  ingestedPois: number;
  /** What travellers say (positive + negative), grounded in real sources. */
  opinions?: LocationOpinions;
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
  /** Present when assembled by the backend brain (RAG + learning). */
  meta?: GuideMeta;
}
