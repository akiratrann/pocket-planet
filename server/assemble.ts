// RAG-style guide assembly: base guidebook data (Wikivoyage) + learned knowledge
// (ingested web sources) + learned adjustments (feedback + self-tuning).

import { getGuide } from '../src/data/wikivoyage.ts';
import { applyLearning, OVERRIDE_CAP } from '../src/core/learning.ts';
import { normalizeName } from '../src/data/ranking.ts';
import type { Destination, Guide, GuideMeta } from '../src/types.ts';
import { getLLM } from './llm/adapter.ts';
import { store } from './store.ts';
import { resolveImages, guideScope } from './pipeline/images.ts';
import { buildOpinions } from './pipeline/opinions.ts';
import { discoverPOIs } from './pipeline/discover.ts';
import { ingestDiscussions } from './pipeline/ingest.ts';
import { ingestLonelyPlanet, LP_PROVIDER } from './pipeline/lonelyplanet.ts';
import { ingestYouTube, YOUTUBE_PROVIDER } from './pipeline/youtube.ts';
import { localizeNames, localizeTitle } from './pipeline/localize.ts';
import { guideLanguages } from './pipeline/lang.ts';
import { resolveQueryPlaces, type OtherPlace } from './pipeline/places.ts';
import { featuresOf } from './pipeline/train.ts';
import type { KbSource, TrainExample } from './store.ts';

export type GuideResponse = Guide & {
  meta: GuideMeta & {
    /**
     * Places the query named that this guide is NOT about. "Kyoto, Osaka" builds
     * the Kyoto guide and reports Osaka here, so the UI can offer it instead of
     * the query half-vanishing.
     */
    otherPlaces?: OtherPlace[];
  };
};

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
//
// Reported to the client in `meta.scoring` rather than restated in the UI: the
// Learn tab explains how the score is calculated, and a hand-copied table there
// would quietly become a lie the first time one of these numbers changed.
export const BUZZ_WEIGHT: Record<string, number> = {
  [LP_PROVIDER]: 8,
  Reddit: 5,
  [YOUTUBE_PROVIDER]: 4,
  'Travel Stack Exchange': 2,
};
/** Ceiling on the total mention boost for a single place. */
export const BUZZ_CAP = 24;
/** Weight used for a mention source with no entry in BUZZ_WEIGHT. */
const BUZZ_WEIGHT_DEFAULT = 2;
// Transport hubs dominate logistics chatter — never buzz-boost them.
const TRANSPORT_RE = /\b(station|airport|terminal|bus stop|interchange|metro|subway|railway)\b/i;

/**
 * A name written entirely in Latin letters, digits and punctuation has word
 * boundaries. One written in Chinese, Japanese or Thai does not — those scripts
 * have no spaces — so a boundary guard there would simply never match.
 */
const LATIN_NAME = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;

/**
 * Match a place name as a whole word. The counts are shown to readers, and a
 * bare `indexOf` inflated them badly: every "Bar" scored a hit inside "Barbecue"
 * and every "Hoi An" inside "Hoi An Ancient Town"'s neighbours. JavaScript's
 * `\b` is ASCII-only — useless for "Bảo tàng" or "Cao lầu" — so the boundary is
 * spelled out as "not touching another letter or digit".
 */
function mentionMatcher(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return LATIN_NAME.test(name)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu')
    : new RegExp(escaped, 'gi');
}

/** What the mention scan found, for one guide. */
interface BuzzResult {
  /** normalizedName -> capped weighted boost handed to the ranker. */
  buzz: Record<string, number>;
  /** normalizedName -> provider -> RAW number of times the text names the place. */
  mentions: Record<string, Record<string, number>>;
}

/**
 * Community "buzz": how often each place is named across real discussion threads
 * and editorial articles, weighted by platform. Boosts recommendations toward
 * what travellers actually talk about. Purely count-based over real text — no
 * sentiment is read and none is invented.
 *
 * The per-provider counts are kept rather than collapsed, because "mentioned 12
 * times on Reddit" is something a reader can check and reason about, whereas the
 * single weighted number it used to become is only meaningful to the ranker.
 */
function computeBuzz(destinations: Destination[], sources: KbSource[]): BuzzResult {
  const disc = sources.filter((s) => MENTION_PROVIDERS.has(s.provider) && s.summary);
  if (!disc.length) return { buzz: {}, mentions: {} };
  const corpora = disc.map((s) => ({
    text: s.summary,
    provider: s.provider,
    w: BUZZ_WEIGHT[s.provider] ?? BUZZ_WEIGHT_DEFAULT,
  }));
  const buzz: Record<string, number> = {};
  const mentions: Record<string, Record<string, number>> = {};
  for (const d of destinations) {
    const name = d.name.trim();
    // Short names are too collision-prone to trust, and transport hubs dominate
    // logistics chatter without being recommendations.
    if (name.length < 4 || TRANSPORT_RE.test(d.name)) continue;
    const re = mentionMatcher(name);
    let weighted = 0;
    const perProvider: Record<string, number> = {};
    for (const { text, provider, w } of corpora) {
      const hits = text.match(re)?.length ?? 0;
      if (!hits) continue;
      perProvider[provider] = (perProvider[provider] ?? 0) + hits;
      weighted += hits * w;
    }
    if (weighted > 0) {
      const key = normalizeName(d.name);
      buzz[key] = Math.min(BUZZ_CAP, weighted);
      mentions[key] = perProvider;
    }
  }
  return { buzz, mentions };
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

// Words that name a KIND of place rather than a particular one, so sharing one
// is no evidence that two listings are the same place. The venue nouns matter as
// much as the landscape ones: "Aoyagi House" and "Odano Samurai House" are two
// different samurai residences a street apart, and they were being fused.
const GENERIC_TOKENS = new Set([
  'waterfall', 'falls', 'village', 'cave', 'mountain', 'peak', 'lake', 'river', 'park',
  'reserve', 'nature', 'national', 'temple', 'market', 'bridge', 'valley', 'the', 'and',
  'thac', 'hang', 'nui', 'song', 'ban', 'chua', 'den', 'khu', 'vuon', 'quoc', 'gia',
  'house', 'residence', 'museum', 'hotel', 'hostel', 'shrine', 'castle', 'garden',
  'hall', 'tower', 'centre', 'center', 'station', 'school', 'bank', 'office',
  'street', 'road', 'city', 'town', 'beach', 'island', 'ruins', 'palace', 'shop',
  'store', 'restaurant', 'cafe', 'festival', 'dance', 'monument', 'memorial',
  'guesthouse', 'ryokan', 'villa', 'gallery', 'statue', 'pagoda', 'onsen', 'stadium',
]);

/**
 * The kind of thing each generic noun names. Sharing a distinctive token is not
 * enough on its own when the two listings are plainly different kinds of thing:
 * "Dakigaeri Valley" and "Dakigaeri Shrine" sit 150 m apart and share
 * "dakigaeri", but one is a gorge and the other is the shrine at its mouth.
 * "Ishiguro House" and "Ishiguro Samurai Residence" are 4 m apart and share
 * "ishiguro", and a house IS a residence — so that pair is one place listed
 * twice. Distance and tokens cannot tell those two situations apart; the kind
 * noun can.
 */
const KIND_OF_TOKEN: Record<string, string> = {
  waterfall: 'water', falls: 'water', thac: 'water', river: 'water', song: 'water', lake: 'water',
  mountain: 'terrain', peak: 'terrain', nui: 'terrain', valley: 'terrain', cave: 'terrain',
  hang: 'terrain', island: 'terrain', beach: 'terrain',
  temple: 'worship', shrine: 'worship', chua: 'worship', den: 'worship', pagoda: 'worship',
  house: 'dwelling', residence: 'dwelling', palace: 'dwelling', villa: 'dwelling',
  hotel: 'lodging', hostel: 'lodging', guesthouse: 'lodging', ryokan: 'lodging', onsen: 'lodging',
  museum: 'exhibit', gallery: 'exhibit',
  school: 'civic', bank: 'civic', office: 'civic', station: 'civic', hall: 'civic',
  market: 'commerce', shop: 'commerce', store: 'commerce', restaurant: 'commerce', cafe: 'commerce',
  park: 'greenspace', garden: 'greenspace', reserve: 'greenspace',
  castle: 'fort', ruins: 'fort',
  festival: 'event', dance: 'event',
  monument: 'landmark', memorial: 'landmark', statue: 'landmark', tower: 'landmark',
  bridge: 'structure', stadium: 'structure',
};

/** Which kinds of thing a name claims to be. Empty when it says nothing. */
function kindsOf(name: string): Set<string> {
  const out = new Set<string>();
  for (const w of name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)) {
    const kind = KIND_OF_TOKEN[w];
    if (kind) out.add(kind);
  }
  return out;
}

/** A valley is not a shrine. Silence on either side is not a disagreement. */
function kindsConflict(a: string, b: string): boolean {
  const ka = kindsOf(a);
  const kb = kindsOf(b);
  if (!ka.size || !kb.size) return false;
  for (const k of ka) if (kb.has(k)) return false;
  return true;
}

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

/**
 * Tokens naming the guide's own place. Inside a guide to Kakunodate every third
 * article is "…Kakunodate", so the town's name distinguishes nothing — and
 * counting it as agreement is how a listing for the town festival was fused with
 * the Hotel Folkloro Kakunodate.
 */
function guideStopTokens(title: string): Set<string> {
  return new Set(title.split('/').flatMap((part) => tokens(part)));
}

/** Two POIs further apart than this are neighbours, not the same place. */
const SAME_PLACE_KM = 0.25;
/** Shortest folded name allowed to identify a place by being contained in another. */
const CONTAINMENT_MIN = 8;

/**
 * Are two destinations the same real-world place (cross-language aware)?
 *
 * The rule is deliberately asymmetric about what counts as evidence. Geography
 * can only ever VETO a match, never make one: in a compact old town POIs sit
 * well inside 250 m of each other, so proximity on its own fused a guesthouse
 * with the high school behind it, a samurai house with the art museum down the
 * road, and a valley with the shrine inside it. Each of those handed the base
 * listing the WRONG Wikidata id, and the localization pass then renamed the
 * listing to match — which is how a traveller searching Kakunodate was shown a
 * high school and a post office where the guesthouse and the lion dance should
 * have been.
 *
 * Names are the only positive evidence. A shared distinctive token is the
 * weakest form of it, so it additionally requires that the two names do not
 * claim to be different KINDS of thing — that is the one signal separating
 * "Ishiguro House"/"Ishiguro Samurai Residence" (4 m apart, one place listed
 * twice) from "Dakigaeri Valley"/"Dakigaeri Shrine" (150 m apart, a gorge and
 * the shrine at its mouth). Distance cannot separate them and neither can the
 * shared token; only "a house is a residence, a valley is not a shrine" can.
 *
 * Returns a strength score rather than a boolean so the caller can pick a stub's
 * BEST candidate instead of whichever one happened to be discovered first.
 * 0 means "not the same place".
 */
function matchStrength(a: Destination, b: Destination, stop: Set<string>): number {
  if (a.wikidata && b.wikidata) return a.wikidata === b.wikidata ? 100 : 0;

  const bothGeo = a.lat != null && a.lon != null && b.lat != null && b.lon != null;
  if (bothGeo && distKm([a.lat!, a.lon!], [b.lat!, b.lon!]) > SAME_PLACE_KM) return 0;

  const fa = foldName(a.name);
  const fb = foldName(b.name);
  if (!fa || !fb) return 0;
  if (fa === fb) return 90;
  // "Hieu Waterfall" vs "Hieu Waterfall (Thac Hieu)" — one place, spelled longer.
  // Not, however, when the shorter name is just the town's: "Kakunodate" sits
  // inside "Festival of Kakunodate" without being it.
  const [shorter, longer] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (shorter.length >= CONTAINMENT_MIN && longer.includes(shorter) && !stop.has(shorter)) {
    return 70;
  }

  // A house is not a shrine, however close together and whatever they share.
  if (kindsConflict(a.name, b.name)) return 0;

  const ta = tokens(a.name).filter((t) => !stop.has(t));
  const tb = new Set(tokens(b.name).filter((t) => !stop.has(t)));
  const shared = ta.filter((t) => tb.has(t)).length;
  if (!shared) return 0;
  // Agreeing on a distinctive name AND on being feet apart is the strongest
  // evidence short of an identical name; agreeing on the name alone is what
  // rescues a coordinate-less stub.
  return (bothGeo ? 50 : 30) + shared;
}

/**
 * Merge discovered POIs into the base guide. When a discovered place matches an
 * existing (often thin, coordinate-less) Wikivoyage stub, we ENRICH the stub with
 * the discovered coordinates / Wikidata id / description (keeping its—usually
 * English—name) instead of adding a duplicate. Genuinely new places are appended.
 *
 * Each discovered POI takes its BEST match rather than the first one that
 * qualifies. Taking the first made the result depend on the order the discovery
 * pass happened to return things: a weakly-matching POI could claim a stub and
 * leave the genuinely-matching one to be appended as a duplicate.
 */
function mergeDiscovered(
  base: Destination[],
  discovered: Destination[],
  stop: Set<string>,
): { merged: Destination[]; added: Destination[] } {
  const merged = base.map((d) => ({ ...d }));
  const added: Destination[] = [];
  for (const c of discovered) {
    let hit: Destination | undefined;
    let best = 0;
    for (const cand of [...merged, ...added]) {
      const score = matchStrength(cand, c, stop);
      if (score > best) {
        best = score;
        hit = cand;
      }
    }
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

// ---------------------------------------------------------------------------
// Relevance: is this somewhere a traveller would actually go?
//
// Filling out a thin guide from the local-language Wikipedia pulls in whatever
// the town has articles about, and in a dense edition that is every school,
// post office and clinic within 10 km. Reading their names cannot settle it —
// the names arrive in the local language, and a keyword list per language is a
// game you lose — so the verdict comes from Wikidata's `instance of` (P31),
// which these articles all carry and which means the same thing in every
// edition. It also survives the localization pass, which rewrites names.
//
// Losing a real attraction would be the worse failure, so a place is dropped
// only when nothing argues for it: any visitable class among its P31s pardons it
// (Tōfuku-ji is a Buddhist temple AND an educational institution, and stays a
// temple), and so does carrying a heritage designation (P1435) at all.
// ---------------------------------------------------------------------------

/** Classes that are never somewhere you go to look at something. */
const NOT_VISITABLE_P31 = new Set<string>([
  // Education. Universities are deliberately absent — campuses are visited.
  'Q3914', // school
  'Q9842', // primary school
  'Q149566', // middle school
  'Q159334', // secondary school
  'Q9826', // high school
  'Q56351315', // Japanese high school
  'Q5358913', // elementary school in Japan
  'Q55521176', // lower secondary school in Japan
  'Q43271061', // school for special needs education in Japan
  'Q11396122', // school annex
  'Q1195942', // kindergarten
  // Administration and public services.
  'Q35054', // post office
  'Q327333', // government agency
  'Q1160920', // municipal administration building
  'Q861951', // police station
  'Q1195944', // fire station
  // Health.
  'Q16917', // hospital
  'Q4260475', // medical facility
  'Q4287745', // medical organisation
  // Money.
  'Q22687', // bank
  'Q806718', // bank branch
  // Utilities and generic infrastructure.
  'Q159719', // power station
  'Q15911738', // hydroelectric power station
  'Q12323', // dam
  'Q205495', // filling station
  'Q1358919', // sewage treatment plant
  'Q13402009', // wastewater treatment plant
  // Administrative geography that no longer exists. The article gives it away in
  // the past tense ("…にあった村" — "was a village in…"), which is exactly the
  // sort of thing a per-language regex keeps missing and P31 states outright.
  'Q19953632', // former administrative territorial entity
  'Q18663566', // dissolved municipality of Japan
]);

/**
 * Classes that make a place worth visiting, used purely as a VETO: an item
 * carrying any of these is kept even when it also carries something above.
 */
const VISITABLE_P31 = new Set<string>([
  // Explicitly touristic.
  'Q570116', 'Q2319498', 'Q1414598',
  // Museums and galleries.
  'Q33506', 'Q207694', 'Q17431399', 'Q16735822', 'Q1575307', 'Q28737012', 'Q2772772',
  // Religious buildings.
  'Q5393308', 'Q44539', 'Q845945', 'Q16970', 'Q2977', 'Q32815', 'Q44613', 'Q34627',
  'Q133215', 'Q11424161',
  // Fortifications, palaces, archaeology.
  'Q23413', 'Q92026', 'Q16560', 'Q57821', 'Q839954', 'Q109607', 'Q1785071',
  // Historic fabric.
  'Q5773747', 'Q11545899', 'Q15243209', 'Q35112127',
  // Green and natural.
  'Q22698', 'Q22746', 'Q1107656', 'Q15835', 'Q179049', 'Q473972', 'Q46169',
  'Q34038', 'Q35509', 'Q8502', 'Q23397', 'Q40080', 'Q124714', 'Q655311', 'Q1510380',
  // Monuments and memorials.
  'Q4989906', 'Q5003624', 'Q575759',
  // Commerce travellers seek out.
  'Q132510', 'Q330284', 'Q28142754', 'Q11315',
  // Culture and entertainment.
  'Q24354', 'Q41253', 'Q43501', 'Q2416723', 'Q2281788',
]);

interface WdClaimsResp {
  entities?: Record<
    string,
    { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }>> }
  >;
}

/** Wikidata classes (P31) and whether the item bears any heritage designation. */
async function wikidataRelevance(
  qids: string[],
): Promise<Map<string, { p31: string[]; heritage: boolean }>> {
  const out = new Map<string, { p31: string[]; heritage: boolean }>();
  // Batched 45 at a time and strictly sequential. This runs on every cold guide
  // build and Wikimedia throttles bursts; server/upstream.ts caps concurrency and
  // retries, and adding a parallel fan-out here would work against it.
  for (let i = 0; i < qids.length; i += 45) {
    const url =
      'https://www.wikidata.org/w/api.php?' +
      new URLSearchParams({
        action: 'wbgetentities',
        ids: qids.slice(i, i + 45).join('|'),
        props: 'claims',
        format: 'json',
        formatversion: '2',
        origin: '*',
      }).toString();
    let data: WdClaimsResp | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) data = (await res.json()) as WdClaimsResp;
    } catch {
      /* best-effort: with no answer we simply keep everything */
    }
    for (const [qid, ent] of Object.entries(data?.entities ?? {})) {
      const p31 = (ent.claims?.P31 ?? [])
        .map((c) => c.mainsnak?.datavalue?.value?.id)
        .filter((x): x is string => Boolean(x));
      out.set(qid, { p31, heritage: Boolean(ent.claims?.P1435?.length) });
    }
  }
  return out;
}

/**
 * Remove the places no traveller should be offered. Deliberately applied to the
 * WHOLE guide rather than only the discovered part, so a Wikivoyage listing and
 * a Wikipedia article are judged by one rule.
 */
async function dropIrrelevant(destinations: Destination[]): Promise<Destination[]> {
  const qids = [...new Set(destinations.map((d) => d.wikidata).filter((x): x is string => Boolean(x)))];
  if (!qids.length) return destinations;
  const info = await wikidataRelevance(qids);
  return destinations.filter((d) => {
    const rel = d.wikidata ? info.get(d.wikidata) : undefined;
    if (!rel) return true; // no answer is not evidence against a place
    if (rel.heritage) return true;
    if (rel.p31.some((id) => VISITABLE_P31.has(id))) return true;
    return !rel.p31.some((id) => NOT_VISITABLE_P31.has(id));
  });
}

export async function assembleGuide(query: string, lang = 'en'): Promise<GuideResponse> {
  // A query can name more than one destination, and only one guide can be built.
  // Resolving up front means the extra places are reported rather than lost.
  const { primary, others } = await resolveQueryPlaces(query);
  const base = await getGuide(primary);

  // "Study the web in every language": English Wikivoyage is thin for most of the
  // world, so when a guide is sparse we discover extra grounded POIs from the
  // LOCAL-language Wikipedia (geosearch by coordinates) and merge them in. This
  // fills out places like a Vietnamese nature reserve that English barely covers.
  const langs = await guideLanguages(base.center);
  let discovered: Destination[] = [];
  if (base.destinations.length < THIN_GUIDE) {
    const { merged, added } = mergeDiscovered(
      base.destinations,
      await discoverPOIs(base, langs),
      guideStopTokens(base.title),
    );
    base.destinations = merged;
    discovered = added; // only the genuinely-new POIs need category pinning
  }

  // Judge relevance once the Wikidata ids are settled, and before anything is
  // ranked, photographed or written about — everything downstream then works on
  // places that are actually worth showing.
  base.destinations = await dropIrrelevant(base.destinations);
  const kept = new Set(base.destinations);
  discovered = discovered.filter((d) => kept.has(d));

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
  const { buzz, mentions } = computeBuzz(base.destinations, sources);
  const enriched = applyLearning(base, learnedForRequest, extras, buzz);

  // Hang the mention breakdown on the places themselves so the UI can show WHY
  // something ranks where it does. Done here, before localization renames them:
  // a name-keyed map would stop matching the moment a reader asked for the guide
  // in another language.
  for (const d of enriched.destinations) {
    const counts = mentions[normalizeName(d.name)];
    if (!counts) continue;
    d.mentions = counts;
    d.mentionScore = buzz[normalizeName(d.name)];
  }

  // Fetch real photos — searching the local-language Wikipedia too (multilingual),
  // which covers many places English sources miss.
  await resolveImages(enriched.destinations, langs, guideScope(base));

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

  const meta: GuideResponse['meta'] = {
    provider: getLLM().name,
    otherPlaces: others.length ? others : undefined,
    learnedVersion: learned.version,
    feedbackApplied,
    ingestedPois: extras.length,
    // The real numbers this guide was scored with — the learned weights, not
    // the compiled-in defaults, which after 24 training passes are no longer
    // the same thing.
    scoring: {
      weights: { ...learned.weights },
      mentionWeights: { ...BUZZ_WEIGHT },
      mentionCap: BUZZ_CAP,
      feedbackCap: OVERRIDE_CAP,
    },
    sources: sources.map((s) => ({
      title: s.title,
      url: s.url,
      // The publisher is known here; without it the client was reduced to
      // guessing it back out of the URL host.
      provider: s.provider,
      fetchedAt: s.fetchedAt,
      poiCount: s.pois.length,
    })),
    opinions,
  };

  return { ...enriched, meta };
}
