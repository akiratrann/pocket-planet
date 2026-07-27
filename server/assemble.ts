// RAG-style guide assembly: base guidebook data (Wikivoyage) + learned knowledge
// (ingested web sources) + learned adjustments (feedback + self-tuning).

import { getGuide } from '../src/data/wikivoyage.ts';
import { applyLearning } from '../src/core/learning.ts';
import { normalizeName } from '../src/data/ranking.ts';
import type { Destination, Guide, GuideMeta } from '../src/types.ts';
import { getLLM } from './llm/adapter.ts';
import { store } from './store.ts';
import { resolveImages } from './pipeline/images.ts';
import { buildOpinions } from './pipeline/opinions.ts';
import { discoverPOIs } from './pipeline/discover.ts';
import { ingestDiscussions } from './pipeline/ingest.ts';
import { ingestLonelyPlanet, LP_PROVIDER } from './pipeline/lonelyplanet.ts';
import { ingestYouTube, YOUTUBE_PROVIDER } from './pipeline/youtube.ts';
import { localizeNames, localizeTitle } from './pipeline/localize.ts';
import { guideLanguages } from './pipeline/lang.ts';
import { featuresOf } from './pipeline/train.ts';
import type { KbSource, TrainExample } from './store.ts';

export type GuideResponse = Guide & { meta: GuideMeta };

// Below this many POIs a guide is "thin" (usually an English Wikivoyage stub),
// so we go discover more from local-language Wikipedia.
const THIN_GUIDE = 20;

// Sources whose text feeds the "mention" ranking signal (a place named here is
// something travellers/editors actually recommend). Includes community platforms
// and Lonely Planet's editorial articles.
const DISCUSSION_PROVIDERS = new Set(['Reddit', 'Travel Stack Exchange']);
const MENTION_PROVIDERS = new Set([
  'Reddit',
  'Travel Stack Exchange',
  LP_PROVIDER,
  YOUTUBE_PROVIDER,
]);
// Refresh live-fetched sources at most this often (discussions + LP + YouTube).
const DISCUSSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per-source mention weight: Lonely Planet is authoritative editorial; Reddit +
// YouTube are recommendation-rich; SE Travel skews to logistics (counts less).
const BUZZ_WEIGHT: Record<string, number> = {
  [LP_PROVIDER]: 8,
  Reddit: 5,
  [YOUTUBE_PROVIDER]: 4,
  'Travel Stack Exchange': 2,
};
// Transport hubs dominate logistics chatter — never buzz-boost them.
const TRANSPORT_RE = /\b(station|airport|terminal|bus stop|interchange|metro|subway|railway)\b/i;

/**
 * Community "buzz": how often each place is mentioned across real discussion
 * threads, weighted by platform. Boosts recommendations toward what travellers
 * actually talk about. Purely count-based over real text — no sentiment invented.
 */
function computeBuzz(destinations: Destination[], sources: KbSource[]): Record<string, number> {
  const disc = sources.filter((s) => MENTION_PROVIDERS.has(s.provider) && s.summary);
  if (!disc.length) return {};
  const corpora = disc.map((s) => ({ text: s.summary.toLowerCase(), w: BUZZ_WEIGHT[s.provider] ?? 2 }));
  const buzz: Record<string, number> = {};
  for (const d of destinations) {
    const name = d.name.trim().toLowerCase();
    if (name.length < 4 || TRANSPORT_RE.test(d.name)) continue;
    let weighted = 0;
    for (const { text, w } of corpora) {
      let idx = text.indexOf(name);
      while (idx !== -1) {
        weighted += w;
        idx = text.indexOf(name, idx + name.length);
      }
    }
    if (weighted > 0) buzz[normalizeName(d.name)] = Math.min(24, weighted);
  }
  return buzz;
}

function foldName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function distKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Words too generic to be distinctive when matching names across languages.
const GENERIC_TOKENS = new Set([
  'waterfall', 'falls', 'village', 'cave', 'mountain', 'peak', 'lake', 'river', 'park',
  'reserve', 'nature', 'national', 'temple', 'market', 'bridge', 'valley', 'the', 'and',
  'thac', 'hang', 'nui', 'song', 'ban', 'chua', 'den', 'khu', 'vuon', 'quoc', 'gia',
]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

/** Are two destinations the same real-world place (cross-language aware)? */
function samePlace(a: Destination, b: Destination): boolean {
  if (a.wikidata && b.wikidata) return a.wikidata === b.wikidata;
  // When BOTH are georeferenced, trust geography: only merge if essentially
  // co-located. This keeps distinct nearby attractions (a cave vs its village)
  // separate rather than collapsing them on a shared name token.
  if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
    return distKm([a.lat, a.lon], [b.lat, b.lon]) < 0.25;
  }
  // One side is a coordinate-less stub (typical thin Wikivoyage listing): match
  // by name so we can enrich it with the discovered coordinates.
  if (foldName(a.name) === foldName(b.name)) return true;
  const ta = tokens(a.name);
  const tb = new Set(tokens(b.name));
  return ta.some((t) => tb.has(t)); // shares a distinctive proper-noun token
}

/**
 * Merge discovered POIs into the base guide. When a discovered place matches an
 * existing (often thin, coordinate-less) Wikivoyage stub, we ENRICH the stub with
 * the discovered coordinates / Wikidata id / description (keeping its—usually
 * English—name) instead of adding a duplicate. Genuinely new places are appended.
 */
function mergeDiscovered(
  base: Destination[],
  discovered: Destination[],
): { merged: Destination[]; added: Destination[] } {
  const merged = base.map((d) => ({ ...d }));
  const added: Destination[] = [];
  for (const c of discovered) {
    const hit = merged.find((b) => samePlace(b, c)) ?? added.find((a) => samePlace(a, c));
    if (hit) {
      hit.lat ??= c.lat;
      hit.lon ??= c.lon;
      hit.wikidata ??= c.wikidata;
      hit.url ??= c.url;
      if (!hit.description || hit.description.length < 40) hit.description = c.description ?? hit.description;
      continue;
    }
    added.push(c);
  }
  return { merged: [...merged, ...added], added };
}

export async function assembleGuide(query: string, lang = 'en'): Promise<GuideResponse> {
  const base = await getGuide(query);

  // "Study the web in every language": English Wikivoyage is thin for most of the
  // world, so when a guide is sparse we discover extra grounded POIs from the
  // LOCAL-language Wikipedia (geosearch by coordinates) and merge them in. This
  // fills out places like a Vietnamese nature reserve that English barely covers.
  const langs = await guideLanguages(base.center);
  let discovered: Destination[] = [];
  if (base.destinations.length < THIN_GUIDE) {
    const { merged, added } = mergeDiscovered(base.destinations, await discoverPOIs(base, langs));
    base.destinations = merged;
    discovered = added; // only the genuinely-new POIs need category pinning
  }

  // Enroll this place in the self-improving loop: viewing it means the scheduler
  // will keep re-studying it (web + discussions) and self-tuning over time.
  await store.track(base.title);

  // Pull ingested knowledge for this location (match on both the query and the
  // resolved article title so sources line up regardless of which was used).
  const sourcesByTitle = await store.getSources(base.title);
  const sourcesByQuery = query.toLowerCase() === base.title.toLowerCase() ? [] : await store.getSources(query);
  let sources = [...sourcesByTitle, ...sourcesByQuery];

  // Study community discussions (Reddit, Travel Stack Exchange…), Lonely Planet
  // editorial, and YouTube travel videos — each skipped when we already hold a
  // fresh copy. All three are best-effort: a failure must never block the guide.
  //
  // These run CONCURRENTLY. They were sequential, and since each is a round of
  // network scraping, a cold guide paid all three end to end — a measured 53s
  // for a new city. Nothing here is order-dependent: every freshness check reads
  // the `sources` set as it stood before any of them ran, and none consumes
  // another's output, so the only thing serialising them was the awaits.
  const isFresh = (pred: (s: (typeof sources)[number]) => boolean) =>
    sources.some((s) => pred(s) && Date.now() - s.fetchedAt < DISCUSSION_TTL_MS);

  const discussionFresh = isFresh((s) => DISCUSSION_PROVIDERS.has(s.provider));
  const lpFresh = isFresh((s) => s.provider === LP_PROVIDER);
  const ytFresh = isFresh((s) => s.provider === YOUTUBE_PROVIDER);

  const [discussionAdded, lpAdded, ytAdded] = await Promise.all([
    discussionFresh ? Promise.resolve([]) : ingestDiscussions(base.title).catch(() => []),
    lpFresh ? Promise.resolve([]) : ingestLonelyPlanet(base.title).catch(() => []),
    ytFresh ? Promise.resolve(null) : ingestYouTube(base.title, langs).catch(() => null),
  ]);

  sources = [
    ...sources,
    ...discussionAdded,
    ...lpAdded,
    ...(ytAdded ? [ytAdded] : []),
  ];

  const extras = sources.flatMap((s) => s.pois);

  const learned = await store.getLearned();
  // Discovered POIs already carry a category decided from Wikidata/keywords in
  // their own language; the English keyword classifier can't re-derive it, so we
  // pin those categories via per-request overrides (real learned overrides win).
  const learnedForRequest = discovered.length
    ? { ...learned, categoryOverrides: { ...learned.categoryOverrides } }
    : learned;
  for (const d of discovered) {
    const k = normalizeName(d.name);
    if (!(k in learnedForRequest.categoryOverrides)) learnedForRequest.categoryOverrides[k] = d.category;
  }
  // Community buzz from real discussion threads → boosts recommended places.
  const buzz = computeBuzz(base.destinations, sources);
  const enriched = applyLearning(base, learnedForRequest, extras, buzz);

  // Fetch real photos — searching the local-language Wikipedia too (multilingual),
  // which covers many places English sources miss.
  await resolveImages(enriched.destinations, langs);

  // Record training examples: each place's feature vector + the real "reward" it
  // earned (community buzz + traveller feedback). The trainer later fits the
  // ranking model to this signal. Done before localization so reward keys match.
  const examples: TrainExample[] = enriched.destinations.map((d) => {
    const k = normalizeName(d.name);
    return {
      loc: base.title,
      name: d.name,
      f: featuresOf(d),
      reward: (buzz[k] ?? 0) + (learned.overrides[k] ?? 0),
      ts: Date.now(),
    };
  });
  void store.addTrainingExamples(examples).catch(() => {});

  // Summarize what travellers say (grounded in real sources; never invented).
  const opinions = await buildOpinions(enriched, sources);

  // Localize place names + the headline to the user's language (Google-Maps-style
  // label translation via Wikidata). Done last so ranking/opinion matching used
  // the original names.
  await localizeNames(enriched.destinations, lang);
  const localizedTitle = await localizeTitle(base.title, lang);
  if (localizedTitle) enriched.title = localizedTitle;

  const feedback = await store.getFeedback();
  const feedbackApplied = feedback.filter(
    (f) => f.location.toLowerCase() === base.title.toLowerCase(),
  ).length;

  const meta: GuideMeta = {
    provider: getLLM().name,
    learnedVersion: learned.version,
    feedbackApplied,
    ingestedPois: extras.length,
    sources: sources.map((s) => ({
      title: s.title,
      url: s.url,
      fetchedAt: s.fetchedAt,
      poiCount: s.pois.length,
    })),
    opinions,
  };

  return { ...enriched, meta };
}
