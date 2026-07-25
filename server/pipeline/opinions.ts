// Build a grounded "what travellers say" summary for a location.
//
// Hard rule: never invent opinions. Every bullet is derived from REAL text we
// actually have — the Wikivoyage guide (intro, advice, place descriptions) and
// any ingested web sources — attributed back to where it came from. When no
// opinionated text exists, we return an empty summary rather than hallucinating.

import type { Guide, LocationOpinions, Opinion } from '../../src/types.ts';
import type { KbSource } from '../store.ts';
import { getLLM } from '../llm/adapter.ts';

interface Segment {
  source: string;
  url?: string;
  text: string;
}

const PER_SIDE_CAP = 6;

// Logistics / admin chatter that isn't a traveller "opinion" about what to see,
// even when it contains a sentiment word ("excellent railway", "expensive parking").
const LOGISTICS =
  /\b(shinkansen|railway|railroad|train|subway|metro|\bjr\b|\bbus(es)?\b|\bpass(es)?\b|parking|taxi|airport|ferry|dialect|visa|\batm\b|wi-?fi|sim card|rainy season|highway|\bfare(s)?\b|timetable|ticketing|check[- ]?in|itinerary)\b/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Build the real text corpus for the location, tagged by source. */
function buildSegments(guide: Guide, sources: KbSource[]): Segment[] {
  const segments: Segment[] = [];

  // 1) The Wikivoyage guide: place descriptions carry the real "this is stunning /
  //    this is crowded" opinions, so lead with those (ranked best-first), then the
  //    intro. Transport/admin advice sections are intentionally left out.
  const wvParts: string[] = [];
  const ranked = [...guide.destinations].sort((a, b) => b.score - a.score);
  for (const d of ranked) {
    if (d.description) wvParts.push(`${d.name} — ${d.description}`);
  }
  if (guide.intro) wvParts.push(guide.intro);
  if (wvParts.length) {
    segments.push({
      source: guide.attribution || 'Wikivoyage',
      url: guide.sourceUrl,
      text: wvParts.join('\n'),
    });
  }

  // 2) Each ingested web source (other platforms).
  for (const s of sources) {
    const parts: string[] = [];
    if (s.summary) parts.push(s.summary);
    for (const p of s.pois) if (p.description) parts.push(`${p.name} — ${p.description}`);
    if (parts.length) segments.push({ source: s.title || s.url, url: s.url, text: parts.join('\n') });
  }

  return segments;
}

/** Merge opinions from all segments, de-duplicate, and cap each side. */
function collate(
  results: Array<{ segment: Segment; positives: string[]; negatives: string[] }>,
  side: 'positives' | 'negatives',
): Opinion[] {
  const out: Opinion[] = [];
  const seen = new Set<string>();
  for (const { segment, [side]: items } of results) {
    for (const text of items) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (LOGISTICS.test(trimmed)) continue; // keep it about places, not transport
      const key = normalize(trimmed).slice(0, 80);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ text: trimmed, source: segment.source, url: segment.url });
      if (out.length >= PER_SIDE_CAP) return out;
    }
  }
  return out;
}

/**
 * Assemble a grounded pros/cons opinion summary for a location. Returns
 * `undefined` when there's simply no opinionated source text to work from.
 */
export async function buildOpinions(
  guide: Guide,
  sources: KbSource[],
): Promise<LocationOpinions | undefined> {
  const segments = buildSegments(guide, sources);
  if (!segments.length) return undefined;

  const llm = getLLM();
  const results = await Promise.all(
    segments.map(async (segment) => {
      const { positives, negatives } = await llm.extractOpinions(guide.title, segment.text);
      return { segment, positives, negatives };
    }),
  );

  const positives = collate(results, 'positives');
  const negatives = collate(results, 'negatives');
  if (!positives.length && !negatives.length) return undefined;

  const sourceList = segments.map((s) => ({ title: s.source, url: s.url }));
  const basis =
    llm.name === 'heuristic'
      ? `Key points travellers mention, pulled from ${segments.length} source(s). Each line is quoted from real content, not generated.`
      : `Summarized by ${llm.name} strictly from ${segments.length} real source(s); nothing is invented.`;

  return { positives, negatives, basis, sources: sourceList };
}
