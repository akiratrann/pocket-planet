// Working out which place(s) a free-text query actually names.
//
// The query used to go straight to Wikivoyage's search, which returns exactly one
// article — so "Kyoto, Osaka" produced an Osaka guide and dropped Kyoto without
// a word, and "Paris, France" produced a guide to the whole of France.
//
// A comma means two different things and they have to be told apart. In
// "Kyoto, Osaka" it separates two destinations; in "Paris, France" (or
// "Washington, D.C.") it introduces a qualifier naming the same one place. Three
// checks sort them out:
//   1. If the whole query IS an article title, it names one place. ("Washington, D.C.")
//   2. Otherwise each fragment is resolved on its own; fragments that resolve to
//      nothing, or all to the same article, mean there was only ever one place.
//   3. What remains is filtered by geography: a fragment whose area CONTAINS the
//      first one is a qualifier, not a second destination. ("France" around Paris)
// Whatever survives all three is a genuinely separate place, and is reported
// rather than quietly discarded.

import { findArticleTitle } from '../../src/data/wikivoyage.ts';
import { geocode } from '../../src/data/geocode.ts';

/** A place the query named that the returned guide is not about. */
export interface OtherPlace {
  /** Wikivoyage article title — usable as-is as a follow-up `q`. */
  title: string;
  /** The fragment of the original query it came from. */
  query: string;
}

export interface ResolvedQuery {
  /** What to build the guide for: an article title, or the query untouched. */
  primary: string;
  others: OtherPlace[];
}

// Deliberately narrow. A separator has to be unambiguous punctuation or a
// spaced-out conjunction, because a false split would change which place a
// single-destination query resolves to.
const SEPARATOR = /\s*(?:[,;]|\s\+\s|\s&\s|\sand\s)\s*/i;
/** Beyond a handful, the query is prose rather than a list of destinations. */
const MAX_PARTS = 4;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Is `bbox` big enough, and placed such, that [lon, lat] sits inside it? */
function contains(bbox: [number, number, number, number], lon: number, lat: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/**
 * Resolve a query into the place to build a guide for, plus any other places it
 * named. Single-place queries — the overwhelming majority — are returned
 * untouched without a single extra request.
 */
export async function resolveQueryPlaces(query: string): Promise<ResolvedQuery> {
  const q = query.trim();
  const parts = q.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { primary: q, others: [] };

  // 1. The comma may belong to the name itself.
  const whole = await findArticleTitle(q);
  if (whole && norm(whole) === norm(q)) return { primary: whole, others: [] };

  // 2. Resolve the fragments independently.
  const resolved = await Promise.all(
    parts.slice(0, MAX_PARTS).map(async (part) => ({
      query: part,
      title: await findArticleTitle(part).catch(() => null),
    })),
  );
  const seen = new Set<string>();
  const places: OtherPlace[] = [];
  for (const r of resolved) {
    if (!r.title || seen.has(norm(r.title))) continue;
    seen.add(norm(r.title));
    places.push({ title: r.title, query: r.query });
  }
  // Nothing gained by splitting — fall back to what the query did before.
  if (places.length < 2) return { primary: whole ?? q, others: [] };

  // 3. Drop the fragments that merely say where the first one is.
  const primary = places[0];
  const home = await geocode(primary.title).catch(() => null);
  const others: OtherPlace[] = [];
  for (const p of places.slice(1)) {
    const area = home ? await geocode(p.title).catch(() => null) : null;
    // Unresolvable either way: keep it. Reporting a place that turns out to be a
    // qualifier is untidy; dropping a real destination is the bug being fixed.
    if (area?.bbox && home && contains(area.bbox, home.lon, home.lat)) continue;
    others.push(p);
  }

  return { primary: primary.title, others };
}
