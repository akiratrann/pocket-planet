// Real place photos from high-quality, no-key sources.
//
// Goal: give each place a small gallery of accurate photos — a few good ones,
// not zero and not a hundred. Sources, best-first:
//   1. Image already on the Wikivoyage listing.
//   2. Wikidata P18 ("image") — the canonical photo(s) of that exact entity.
//   3. The place's Wikimedia Commons category (via Wikidata P373) — a rich set
//      of real photos of the exact place; this is what lifts most places from
//      1 photo to several.
//   4. Wikipedia page image — accurate when the place has its own article.
//   5. A Commons file search on the place + location name, for the many real,
//      well-photographed places that have no encyclopedia article at all.
//   6. Commons files geotagged AT the place, when the photographer and the
//      guidebook used different words for it.
// Results are cached on disk so repeat loads are instant.

import type { CategoryId, Destination, Guide } from '../../src/types.ts';
import { store } from '../store.ts';

const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const IMG_WIDTH = 800;

/** Aim for this many photos per place; stop calling extra sources once reached. */
const TARGET_PER_PLACE = 3;
/** Never keep more than this many per place. */
const MAX_PER_PLACE = 5;
/** Resolve at most this many (top-ranked) places per guide, to stay fast. */
const MAX_RESOLVE = 400;
/** Extra Wikipedia *searches* for still-missing top places (one request each). */
const SEARCH_CAP = 60;
/** Per-language geosearch-by-coordinate lookups for still-missing places. */
const GEO_CAP = 90;
/** Commons file searches for places still with no photo at all (one request each). */
const COMMONS_CAP = 80;

/**
 * Cache generation. Every key carries it, so tightening the matching rules
 * abandons the verdicts reached under the looser ones instead of re-serving
 * them — a photo cached when a bare surname was enough to match must not
 * outlive the rule that let it in. Entries from older generations are pruned.
 */
const RULES = 'v4';
/** Parallelism for the per-category Commons calls (kept low to avoid throttling). */
const CONCURRENCY = 4;

// Wikimedia's UA policy asks for an app name, version and a contact URL.
const USER_AGENT = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Filenames that are almost never a real photo of the place. */
const JUNK_FILE = /(\.svg|\.pdf|\.ogg|\.oga|\.ogv|\.webm|\.mid|\.wav)$|\.svg\.|locator|location map|\bmap\b|\bplan\b|logo|icon|flag of|coat of arms|\bseal\b|blason|wappen|diagram|floorplan|panorama.*sphere|qr[ _]code/i;

function commonsThumb(file: string): string {
  const clean = file.replace(/^(File|Image):/i, '').trim();
  return `${COMMONS_FILEPATH}${encodeURIComponent(clean)}?width=${IMG_WIDTH}`;
}

/**
 * A Wikipedia page image, unless the article's chosen representative isn't a
 * photo at all. Articles about organisations lead with a logo and articles about
 * regions with a locator map, and those were reaching guides unfiltered — a
 * search for the "TP Bank" listing in Hoi An came back with a bank's logo.
 */
function pageThumb(source?: string): string | undefined {
  if (!source) return undefined;
  const file = decodeURIComponent(source.split('/').pop() ?? '');
  return JUNK_FILE.test(file) ? undefined : source;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Generic words that don't identify a specific place (used to find the
// "distinctive" part of a name when verifying a fuzzy search match).
const GENERIC_WORDS = new Set([
  'silver', 'gold', 'mine', 'mines', 'temple', 'shrine', 'museum', 'park',
  'garden', 'gardens', 'hall', 'castle', 'onsen', 'hot', 'spring', 'springs',
  'city', 'town', 'village', 'prefecture', 'former', 'old', 'great', 'grand',
  'national', 'historic', 'historical', 'site', 'ruins', 'station', 'river',
  'mountain', 'mount', 'lake', 'falls', 'waterfall', 'beach', 'house', 'center',
  'centre', 'memorial', 'art', 'history', 'the', 'of', 'and',
]);

/**
 * Scripts that don't separate words with spaces, so a "word" has to be taken as
 * the whole run of characters rather than something split out of it.
 */
const UNSPACED_SCRIPT = /[㐀-䶿一-鿿぀-ゟ゠-ヿ가-힯]+/g;

/**
 * Lowercase, strip diacritics, keep alnum tokens. Parentheticals are dropped
 * unless `keepParenthetical` — see fileMatchesName for why that matters.
 *
 * Folding to Latin alone silently erases any name not written in Latin script:
 * the `[^a-z0-9]` pass deletes every character of 回顧の滝, leaving no tokens at
 * all — and a name with no tokens can never be verified against anything, so
 * every name-checked source was permanently unreachable for Japanese-, Chinese-
 * and Korean-named listings, even where Commons holds a file named for them
 * character-for-character. Runs of those scripts are kept as tokens of their own.
 */
function foldTokens(s: string, keepParenthetical = false): string[] {
  const src = keepParenthetical ? s : s.replace(/\([^)]*\)/g, ' ');
  const unspaced = (src.match(UNSPACED_SCRIPT) ?? []).filter((t) => t.length >= 2);
  const latin = src
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 3);
  return [...unspaced, ...latin];
}

/** True when a token is a run of unspaced script rather than a Latin word. */
function isUnspaced(token: string): boolean {
  UNSPACED_SCRIPT.lastIndex = 0; // the regex is /g — reset before a .test()
  return UNSPACED_SCRIPT.test(token);
}

/**
 * Is `token` present among a file's tokens? A Latin token has to match a whole
 * word. An unspaced-script token has no word boundaries to anchor on — Commons
 * files 回顧の滝 both on its own and run together with its neighbours — so for
 * those, occurring inside a token counts as present.
 */
function hasToken(fileTokens: Set<string>, token: string): boolean {
  if (fileTokens.has(token)) return true;
  if (!isUnspaced(token)) return false;
  for (const f of fileTokens) if (f.includes(token)) return true;
  return false;
}

/** The tokens of `name` that actually pin down which place it is. */
function distinctiveTokens(name: string): string[] {
  return foldTokens(name).filter((t) => !GENERIC_WORDS.has(t));
}

/**
 * True when `title` is confidently the same place as `name`: every *distinctive*
 * token of the name appears in the title (so "Yamagata (city)" is NOT accepted
 * for "Bunshōkan", but "Chidōkan (Tsuruoka)" is accepted for "Chidokan").
 */
function titleMatchesName(name: string, title: string): boolean {
  const distinctive = distinctiveTokens(name);
  if (!distinctive.length) return false; // nothing specific to verify against
  const titleSet = new Set(foldTokens(title));
  return distinctive.every((t) => hasToken(titleSet, t));
}

/**
 * The same check for a Commons filename. Parentheses in an article title hold a
 * disambiguator we want ignored, but in a filename they usually hold the upload
 * id or the name in local script — the only photos of "Quang Trieu Assembly Hall"
 * are filed as "…Cantonese Assembly Hall (Quảng Trịeu) (31654239032).jpg", where
 * stripping parentheticals would discard the very tokens that prove the match.
 */
function fileMatchesName(name: string, fileTitle: string): boolean {
  const distinctive = distinctiveTokens(name);
  if (!distinctive.length) return false;
  const fileSet = new Set(foldTokens(fileStem(fileTitle), true));
  return distinctive.every((t) => hasToken(fileSet, t));
}

/** A Commons file title with the namespace and extension stripped. */
function fileStem(fileTitle: string): string {
  return fileTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Where a guide is, and how far from it a match may plausibly sit. Used to check
 * listings that carry no coordinates of their own — most of the badly wrong
 * photos were those, matched to an article on a bare surname.
 */
export interface PlaceScope {
  /** The guide's location name, which also disambiguates Commons searches. */
  name: string;
  lat?: number;
  lon?: number;
  radiusKm: number;
}

/** Floor for the scope radius, so a city guide still tolerates day-trip POIs. */
const SCOPE_MIN_KM = 300;

/** Build the scope of a guide: its centre, and a radius that covers its extent. */
export function guideScope(g: Guide): PlaceScope {
  const [lon, lat] = g.center;
  let radiusKm = SCOPE_MIN_KM;
  if (g.bbox) {
    const [minLon, minLat, maxLon, maxLat] = g.bbox;
    radiusKm = Math.max(radiusKm, haversineKm(minLat, minLon, maxLat, maxLon) / 2 + 50);
  }
  return { name: g.title, lat, lon, radiusKm };
}

/**
 * Does an article plausibly describe THIS listing? Wikipedia's search will answer
 * "Aoyagi House" (a samurai residence) with the politician Hitoshi Aoyagi and
 * "Shiraiwa" (a village) with the figure skater Yuna Shiraiwa — a surname is a
 * place name too, and the name alone cannot tell them apart. Position can: the
 * article has to be somewhere, and somewhere near the listing, or near the guide
 * when the listing itself is unplaced. A person's article is nowhere at all.
 */
function articleFitsPlace(info: WpInfo | undefined, d: Destination, scope: PlaceScope): boolean {
  if (!info) return false;
  const own = d.lat != null && d.lon != null;
  const lat = own ? d.lat! : scope.lat;
  const lon = own ? d.lon! : scope.lon;
  if (lat == null || lon == null) return true; // nothing to check against
  if (info.lat == null || info.lon == null) return false;
  return haversineKm(lat, lon, info.lat, info.lon) <= (own ? MATCH_MAX_KM : scope.radiusKm);
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** De-dupe by the underlying file (ignoring the width query), keep order. */
function dedupeImages(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    const key = u.split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * Fetch JSON from a Wikimedia API, tolerating rate limiting. When throttled the
 * API replies with a 429 or a non-JSON "you are making too many requests" body,
 * so we retry with exponential backoff instead of silently dropping the batch.
 */
async function getJson(url: string, attempt = 0): Promise<any> {
  const MAX_ATTEMPTS = 5;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(400 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw e;
  }
  const text = await res.text();
  const retriable = res.status === 429 || res.status >= 500;
  if (retriable && attempt < MAX_ATTEMPTS) {
    await sleep(400 * 2 ** attempt);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON body (usually a throttle notice) — back off and retry.
    if (attempt < MAX_ATTEMPTS) {
      await sleep(400 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw new Error('non-JSON response');
  }
}

/** Run async workers over items with bounded concurrency. */
async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx]);
      } catch {
        /* skip one bad item */
      }
    }
  });
  await Promise.all(runners);
}

interface WdInfo {
  images: string[]; // from P18
  category?: string; // Commons category from P373
}

/** Wikidata "instance of" values that are definitely not somewhere you can go. */
const NON_PLACE_INSTANCE = new Set([
  'Q5', // human
  'Q95074', // fictional character
  'Q16334295', // group of humans
  'Q4830453', // business
  'Q783794', // company
  'Q43229', // organization
]);

/**
 * Batch-resolve Wikidata claims: P18 photos + P373 Commons category.
 *
 * Only for entities that are a PLACE. A name lookup can land on a person who
 * shares the name (Japanese surnames are place names too), and their portrait
 * would then be presented as the sight. Having coordinates (P625) is what every
 * real destination has and no person does, so that is the test.
 */
async function fetchWikidataInfo(ids: string[]): Promise<Record<string, WdInfo>> {
  const out: Record<string, WdInfo> = {};
  for (const group of chunk(ids, 45)) {
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      `&props=claims&ids=${group.join('|')}`;
    try {
      const data = await getJson(url);
      const entities = data.entities ?? {};
      for (const id of Object.keys(entities)) {
        const claims = entities[id]?.claims ?? {};
        if (!claims.P625) continue; // not a place
        const instances: string[] = (claims.P31 ?? [])
          .map((c: any) => c?.mainsnak?.datavalue?.value?.id)
          .filter((v: unknown): v is string => typeof v === 'string');
        if (instances.some((i) => NON_PLACE_INSTANCE.has(i))) continue;
        const p18: string[] = (claims.P18 ?? [])
          .map((c: any) => c?.mainsnak?.datavalue?.value)
          .filter((v: unknown): v is string => typeof v === 'string' && !!v)
          .map(commonsThumb);
        const category: string | undefined = claims.P373?.[0]?.mainsnak?.datavalue?.value;
        out[id] = { images: p18, category: typeof category === 'string' ? category : undefined };
      }
    } catch {
      /* skip this batch on error */
    }
  }
  return out;
}

/**
 * The usable photo on a Commons file page, or null when the file isn't a real
 * photo of anything (a map, a logo, a PDF, an icon-sized thumbnail).
 */
function usablePhoto(page: any): { url: string; area: number } | null {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const mime: string = info.mime ?? '';
  if (!mime.startsWith('image/') || mime.includes('svg')) return null;
  if (JUNK_FILE.test(page.title ?? '')) return null;
  const w = Number(info.width) || 0;
  const h = Number(info.height) || 0;
  if (w < 400 || h < 300) return null; // skip thumbnails/icons
  const url: string | undefined = info.thumburl || info.url;
  return url ? { url, area: w * h } : null;
}

/** List real photos in a Commons category (best-effort), newest-safe order. */
async function fetchCommonsCategory(category: string, limit: number): Promise<string[]> {
  const cat = category.replace(/^Category:/i, '').trim();
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
    '&generator=categorymembers&gcmtype=file&gcmlimit=40' +
    `&gcmtitle=${encodeURIComponent('Category:' + cat)}` +
    `&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=${IMG_WIDTH}`;
  const data = await getJson(url);
  const pages: any[] = Object.values(data?.query?.pages ?? {});
  const photos = pages.map(usablePhoto).filter((p): p is { url: string; area: number } => !!p);
  // Prefer larger images (a decent proxy for "hero-worthy").
  photos.sort((a, b) => b.area - a.area);
  return photos.slice(0, limit).map((p) => p.url);
}

/** How far a photo or article may sit from the place it claims to show. */
const MATCH_MAX_KM = 25;

/**
 * The categories an encyclopedia actually photographs. Wikipedia and Commons hold
 * monuments, museums, temples and beaches; they hold nothing about a particular
 * tailor's shop or noodle bar. Asking after one of those returns only
 * coincidence — the listing "Thành Nam Quán" (a Hoi An restaurant) matches a
 * 19th-century photograph of a pagoda in Nam Định on common Vietnamese words
 * alone, and the nearest article to a Hoi An restaurant is a museum down the
 * street. Both fuzzy lookups are therefore restricted to these categories: no
 * upside outside them, and a wrong photo is worse than none.
 *
 * Opening this up to `sleep` and `activities` was tried and measured, and it is
 * not safe. It does find real photos — of 21 listings it reached, 13 were right
 * ("Capella Hanoi", "Melia Hanoi Hotel", "Riad Papillon"). But the other 8 were
 * badly wrong: Marrakesh's "Hotel Atlas" got a hotel in *Berlin*, its "Hotel
 * Cecil" a London hotel demolished in 1930, its "Moroccan House Hotel" the
 * Moroccan parliament, and Hanoi's "Lotte Hotel" the shops in the mall below it.
 * A business is named for a brand or a common noun rather than for a building,
 * and no filename test separated the 13 from the 8. So the door stays shut.
 */
const PHOTOGRAPHED_CATEGORIES = new Set<CategoryId>(['sights', 'culture', 'nature']);

/** Distinctive tokens minus the ones that only say which city we are in. */
function localTokens(name: string, place: string): string[] {
  const placeTokens = new Set(foldTokens(place));
  return distinctiveTokens(name).filter((t) => !placeTokens.has(t));
}

/** How many of a place's own name tokens a nearby photo must carry to be trusted. */
const GEO_NAME_TOKENS = 2;
const COMMONS_GEO_RADIUS_M = 250;
/**
 * A one-token name has to prove itself with that single token, so the token
 * itself must be substantial. "Himekannon" identifies a place; "Tan" (from "Old
 * House of Tan Ky", whose second word is too short to survive folding) would
 * match half the files in the block.
 */
const LONE_TOKEN_MIN_LEN = 5;

/**
 * How many of the name's tokens a nearby file has to carry: all of them for a
 * short name, GEO_NAME_TOKENS for a longer one.
 *
 * Demanding two tokens outright meant a place whose name reduces to ONE token
 * was skipped entirely — no evidence could ever satisfy the rule, so Kakunodate's
 * "Himekannon" went without a photo while a file named for it sat 25 m away.
 * Requiring *every* token of such a name is the same standard, not a weaker one.
 * It stays a high bar for longer names, which is what stops a photo of "Trần Nhân
 * Tông Street" attaching itself to "Hanoi Train Street" on the word "street"
 * alone, and "Lake Tazawako" to the "Tazawako Floating Sign" on the lake's name.
 */
function geoTokensRequired(needed: string[]): number {
  if (needed.length >= GEO_NAME_TOKENS) return GEO_NAME_TOKENS;
  return needed.length;
}

/**
 * Photos taken AT a place: found on Commons by coordinate, confirmed by name.
 *
 * Position on its own is worthless — the files nearest Hoi An's "Old house of
 * Phung Hung" are all of the Japanese Covered Bridge twelve metres away — so a
 * candidate has to carry the place's own name as well (see geoTokensRequired for
 * how much of it, which depends on how much name there is). Tokens that
 * merely name the city don't count towards that, or "Hanoi Train Street" happily
 * accepts a photo of a different street in Hanoi. Together the two signals are
 * strong: "Hội An, Trieu Chau Assembly Hall" 19 m from the "Trieu Chau Meeting
 * Hall" listing is unambiguously it, whichever word the guidebook chose for
 * hội quán, while the bridge next door carries none of the name and is dropped.
 */
async function geosearchCommonsPhotos(
  name: string,
  place: string,
  lat: number,
  lon: number,
): Promise<string[]> {
  const needed = localTokens(name, place);
  const required = geoTokensRequired(needed);
  if (!required) return []; // nothing specific enough to confirm with
  // A name that rests on one token needs that token to be a real word.
  if (required === 1 && !isUnspaced(needed[0]) && needed[0].length < LONE_TOKEN_MIN_LEN) return [];
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
    `&generator=geosearch&ggsnamespace=6&ggslimit=30&ggsradius=${COMMONS_GEO_RADIUS_M}` +
    `&ggscoord=${lat}%7C${lon}` +
    `&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=${IMG_WIDTH}`;
  let data: any;
  try {
    data = await getJson(url);
  } catch {
    return [];
  }
  // Nearest first.
  const pages: any[] = (data?.query?.pages ?? [])
    .slice()
    .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));

  const out: string[] = [];
  for (const p of pages) {
    const fileTokens = new Set(foldTokens(fileStem(String(p.title ?? '')), true));
    if (needed.filter((t) => hasToken(fileTokens, t)).length < required) continue;
    const photo = usablePhoto(p);
    if (photo) out.push(photo.url);
    if (out.length >= MAX_PER_PLACE) break;
  }
  return out;
}

/**
 * Terms a Commons full-text search chokes on. Its search is conjunctive, so a
 * stray "&" or a "(South)" is one more term every file must satisfy — and the
 * usual result is zero hits: "Lý Thái Tổ Statue & Park Hanoi" matched nothing at
 * all while the statue's photos sat on Commons under obvious names.
 */
function searchTerms(s: string): string {
  return s.replace(/\([^)]*\)/g, ' ').replace(/[&/|+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The part of a guide's title that names the place. Wikivoyage titles a city
 * article by its path ("Semboku/Kakunodate"), and pushing the whole path into a
 * search demands the files mention the parent region too — "Odano House
 * Semboku/Kakunodate" found nothing, "Odano House Kakunodate" found the house.
 */
function placeTerm(place: string): string {
  return searchTerms(place.split('/').pop() ?? place);
}

/**
 * Search Commons directly for photos of a place. This is the only source that
 * reaches places with no encyclopedia article and no Wikidata item at all — Hoi
 * An's assembly halls and merchant houses are thoroughly photographed on Commons
 * but appear in no Wikipedia we scrape.
 *
 * Two queries, because they fail in opposite directions. Adding the location
 * pins the search down but throws away most real matches (Commons wants every
 * term to hit, and a photographer who wrote "Kakunodate" did not also write
 * "Semboku"); the name on its own finds them but will just as happily return the
 * same name somewhere else on earth. So they are trusted differently:
 *
 *  - Located query: the search engine has already matched the location against
 *    the file's text, so a filename carrying the name's distinctive tokens is
 *    enough — this is the long-standing rule, and it is what most current photos
 *    came in on ("Old House of Tan Ky", "Teradaya", "Togetsukyō Bridge", whose
 *    filenames never mention the city).
 *  - Name-only query: nothing has vouched for the location, so the file must do
 *    it itself — either geotagged at the place, or naming the place in the
 *    filename. Without that, this query is exactly the hole the old code fell
 *    through: "Central Market" matching *Central Market north Austin*, "Night
 *    Market" matching *Shilin Night Market*. Both are name matches; neither is
 *    within a continent of the guide, and neither says "Hoi An" anywhere.
 *
 * A geotagged file that disagrees with the coordinates is always dropped.
 */
async function searchCommonsPhotos(
  name: string,
  place: string,
  scope: PlaceScope,
  lat?: number,
  lon?: number,
): Promise<string[]> {
  const runQuery = async (query: string): Promise<any[]> => {
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
      '&generator=search&gsrnamespace=6&gsrlimit=12' +
      `&gsrsearch=${encodeURIComponent(query)}` +
      `&prop=imageinfo|coordinates&iiprop=url|mime|size&iiurlwidth=${IMG_WIDTH}`;
    try {
      const data = await getJson(url);
      // Keep the search engine's relevance order; `pages` comes back unordered.
      return (data?.query?.pages ?? [])
        .slice()
        .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    } catch {
      return [];
    }
  };

  const terms = searchTerms(name);
  if (!terms) return [];

  // Does the filename itself say which town this is?
  const placeTokens = distinctiveTokens(placeTerm(place));
  const namesThePlace = (title: string): boolean => {
    if (!placeTokens.length) return false;
    const fileTokens = new Set(foldTokens(fileStem(title), true));
    return placeTokens.some((t) => hasToken(fileTokens, t));
  };

  const out: string[] = [];
  const seen = new Set<string>();
  // The located query runs first and the name-only one only if it left us short,
  // so the common case costs the same one request it always did.
  for (const [query, vouched] of [
    [`${terms} ${placeTerm(place)}`, true],
    [terms, false],
  ] as Array<[string, boolean]>) {
    if (out.length >= MAX_PER_PLACE) break;
    const pages = await runQuery(query);
    for (const p of pages) {
      const title = String(p.title ?? '');
      if (seen.has(title)) continue;
      if (!fileMatchesName(name, title)) continue;

      const co = p.coordinates?.[0];
      const geotagged = co?.lat != null && co?.lon != null;
      // Where the file has to have been taken: at the listing when it has its
      // own coordinates, otherwise anywhere within the guide's extent.
      const fromLat = lat ?? scope.lat;
      const fromLon = lon ?? scope.lon;
      const maxKm = lat != null ? MATCH_MAX_KM : scope.radiusKm;
      const near =
        geotagged && fromLat != null && fromLon != null
          ? haversineKm(fromLat, fromLon, co.lat, co.lon) <= maxKm
          : null;
      if (near === false) continue; // same name, photographed somewhere else entirely
      if (!vouched && near !== true && !namesThePlace(title)) continue;

      const photo = usablePhoto(p);
      if (photo) {
        seen.add(title);
        out.push(photo.url);
      }
      if (out.length >= MAX_PER_PLACE) return out;
    }
  }
  return out;
}

interface WpInfo {
  thumb?: string;
  qid?: string; // linked Wikidata entity, used to harvest a Commons gallery
  lat?: number;
  lon?: number; // article coordinates, when it has any — used to verify the match
}

/**
 * Batch-resolve, per title: the Wikipedia page image AND the linked Wikidata id
 * (so name-only listings can still get a full Commons gallery). Keyed by normName.
 * `lang` picks which Wikipedia (e.g. "ja" for Japanese), enabling multilingual scraping.
 */
async function fetchWikipediaInfo(
  titles: string[],
  lang = 'en',
): Promise<Record<string, WpInfo>> {
  const out: Record<string, WpInfo> = {};
  for (const group of chunk(titles, 45)) {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*` +
      `&prop=pageimages|pageprops|coordinates&ppprop=wikibase_item&piprop=thumbnail&pithumbsize=${IMG_WIDTH}&redirects=1` +
      `&titles=${group.map((t) => encodeURIComponent(t)).join('|')}`;
    try {
      const data = await getJson(url);
      const q = data.query ?? {};
      const alias: Record<string, string> = {};
      for (const n of q.normalized ?? []) alias[n.from] = n.to;
      for (const r of q.redirects ?? []) alias[r.from] = r.to;
      const resolve = (t: string): string => {
        let cur = t;
        const seen = new Set<string>();
        while (alias[cur] && !seen.has(cur)) {
          seen.add(cur);
          cur = alias[cur];
        }
        return cur;
      };
      const byTitle: Record<string, WpInfo> = {};
      for (const p of q.pages ?? []) {
        const co = p.coordinates?.[0];
        byTitle[p.title] = {
          thumb: pageThumb(p.thumbnail?.source),
          qid: p.pageprops?.wikibase_item,
          lat: co?.lat,
          lon: co?.lon,
        };
      }
      for (const requested of group) {
        const info = byTitle[resolve(requested)];
        if (info && (info.thumb || info.qid)) out[normName(requested)] = info;
      }
    } catch {
      /* skip this batch on error */
    }
  }
  return out;
}

interface SearchHit {
  title: string;
  thumb?: string;
  qid?: string;
  lat?: number;
  lon?: number;
}

/**
 * Full-text search Wikipedia for a place whose exact title we don't know, and
 * return the best *verified* match: the title must contain the name's distinctive
 * tokens and sit within ~25 km of it. This recovers photos for places listed
 * under a slightly different article title, without the false positives a naive
 * "take the top hit" search would produce.
 */
async function searchWikipediaImage(
  name: string,
  scope: PlaceScope,
  lat?: number,
  lon?: number,
): Promise<SearchHit | null> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
    '&generator=search&gsrlimit=5' +
    `&gsrsearch=${encodeURIComponent(name)}` +
    '&prop=pageimages|coordinates|pageprops&ppprop=wikibase_item' +
    `&piprop=thumbnail&pithumbsize=${IMG_WIDTH}`;
  let data: any;
  try {
    data = await getJson(url);
  } catch {
    return null;
  }
  const pages: any[] = (data?.query?.pages ?? []).slice().sort(
    (a: any, b: any) => (a.index ?? 0) - (b.index ?? 0),
  );

  // Collect every candidate that both name-matches and passes the coord check,
  // then prefer the one that actually carries a photo (and verified location).
  // This avoids picking a photo-less disambiguation page over the real article
  // (e.g. "Chidōkan" vs "Chidōkan (Tsuruoka)").
  let best: SearchHit | null = null;
  let bestScore = -1;
  // Check against the listing's own position, or the guide's when it has none.
  const own = lat != null && lon != null;
  const fromLat = own ? lat : scope.lat;
  const fromLon = own ? lon : scope.lon;
  const maxKm = own ? MATCH_MAX_KM : scope.radiusKm;
  for (const p of pages) {
    if (!titleMatchesName(name, p.title ?? '')) continue;
    const co = p.coordinates?.[0];
    const hasCoord = co?.lat != null && co?.lon != null;
    // An article we can't place is not evidence of anything. Without this the
    // search answers a listing with whatever shares its name: "Morning Market"
    // in Hoi An got en.wikipedia's "Morning market" (an Indonesian one), and
    // "Aoyagi House" got the politician Hitoshi Aoyagi.
    if (fromLat != null && !hasCoord) continue;
    const near =
      fromLat != null && fromLon != null && hasCoord
        ? haversineKm(fromLat, fromLon, co.lat, co.lon)
        : null;
    if (near != null && near > maxKm) continue; // same name, wrong place

    const thumb = pageThumb(p.thumbnail?.source);
    const qid: string | undefined = p.pageprops?.wikibase_item;
    if (!thumb && !qid) continue;

    // Prefer a real photo, then a location-verified match, then a Wikidata link.
    const score = (thumb ? 4 : 0) + (near != null ? 2 : 0) + (qid ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { title: p.title, thumb, qid, lat: co?.lat, lon: co?.lon };
      if (thumb && near != null) break; // ideal match — stop early
    }
  }
  return best;
}

// Geosearch "type" values that denote a large area rather than a specific POI.
const ADMIN_GEO_TYPES = new Set(['country', 'state', 'adm1st', 'adm2nd', 'adm3rd', 'city']);
const GEO_RADIUS_M = 300;
// This match is made on position alone — there is no name to check it against,
// which is the point (it finds 大日坊 for "Dainichibo"). So "near" has to mean
// the same building, not the same block: at 170 m it was handing Hanoi's Lý Thái
// Tổ statue the tower down the road and Kakunodate's Tatsuko statue a shrine on
// the same lakeshore.
//
// 70 m was still the same block. Measured over every listing this phase resolved:
// the right answers came in at 0, 1, 5, 6 and 17 m — a listing and its article
// are describing one building, and both coordinates ultimately come from the same
// survey — while the wrong ones sat at 37 m (Hoi An's "Chinese Assembly Hall",
// given the Museum of Trade Ceramics down the street) and 61 m (the Tatsuko
// statue, still getting 漢槎宮). There is clear air between the two groups, so the
// cut goes in it.
const GEO_MAX_DIST_M = 25;

interface GeoHit {
  title: string;
  /** Metres from the queried coordinate — used to settle competing claims. */
  dist: number;
}

/**
 * Find the Wikipedia article sitting essentially ON a coordinate, in a given
 * language. This matches by *location*, not name — so it works across scripts
 * (finds 大日坊 for "Dainichibo") and returns the exact POI (closest hit),
 * skipping enclosing admin areas like the city.
 */
async function geosearchTitle(lat: number, lon: number, lang: string): Promise<GeoHit | null> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*` +
    `&list=geosearch&gsprop=type&gslimit=8&gsradius=${GEO_RADIUS_M}` +
    `&gscoord=${lat}%7C${lon}`;
  let data: any;
  try {
    data = await getJson(url);
  } catch {
    return null;
  }
  const list: any[] = data?.query?.geosearch ?? []; // sorted by distance ascending
  for (const g of list) {
    if (typeof g.dist === 'number' && g.dist > GEO_MAX_DIST_M) break;
    if (ADMIN_GEO_TYPES.has(String(g.type ?? '').toLowerCase())) continue;
    return { title: g.title as string, dist: Number(g.dist) || 0 };
  }
  return null;
}

const wdKey = (id: string) => `wd:${RULES}:${id}`;

/**
 * For a set of Wikidata ids, resolve a gallery (P18 + Commons category) for any
 * that aren't cached yet, and write the result (array or null) into `cache`.
 * Returns true if it wrote anything.
 */
async function resolveWdGalleries(
  ids: string[],
  cache: Record<string, string[] | null>,
): Promise<boolean> {
  const uncached = [...new Set(ids)].filter((id) => !(wdKey(id) in cache));
  if (!uncached.length) return false;

  const info = await fetchWikidataInfo(uncached);
  const catJobs = uncached
    .map((id) => info[id])
    .filter((i): i is WdInfo => !!i?.category && i.images.length < MAX_PER_PLACE);
  await pool(catJobs, async (i) => {
    const extra = await fetchCommonsCategory(i.category!, MAX_PER_PLACE);
    i.images = dedupeImages([...i.images, ...extra]);
  });
  for (const id of uncached) {
    const imgs = dedupeImages(info[id]?.images ?? []).slice(0, MAX_PER_PLACE);
    cache[wdKey(id)] = imgs.length ? imgs : null;
  }
  return true;
}

/**
 * Fill in a small photo gallery (`images` + primary `image`) for destinations.
 * Best-first sources: Wikivoyage → Wikidata P18 → the place's Commons category →
 * Wikipedia page image (which also recovers a Wikidata id so name-only listings
 * still get a full Commons gallery) → a Commons file search by name → a Commons
 * file search by coordinate. Results are cached on disk.
 * Mutates + returns the destinations.
 *
 * `scope` says where the guide is: its name disambiguates the Commons searches,
 * and its position vets matches for listings that carry no coordinates.
 */
export async function resolveImages(
  destinations: Destination[],
  langs: string[] = [],
  scope: PlaceScope = { name: '', radiusKm: SCOPE_MIN_KM },
): Promise<Destination[]> {
  const place = scope.name;
  const cache = await store.getImageCache();
  let cacheDirty = false;
  for (const key of Object.keys(cache)) {
    if (!key.includes(`:${RULES}:`)) {
      delete cache[key];
      cacheDirty = true;
    }
  }
  const coordKey = (d: Destination) => `${d.lat!.toFixed(4)},${d.lon!.toFixed(4)}`;
  // Two cities can each list a "White Rose", so a name alone is not a cache key —
  // it would serve one of them the other's photo. Anything georeferenced is keyed
  // by position as well.
  const nameKey = (d: Destination) =>
    d.lat != null && d.lon != null
      ? `nm:${RULES}:${coordKey(d)}:${normName(d.name)}`
      : `nm:${RULES}:${normName(d.name)}`;

  // Seed each place with whatever photo Wikivoyage already gave us.
  const gallery = new Map<Destination, string[]>();
  const targets = destinations
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESOLVE);
  for (const d of targets) gallery.set(d, d.image ? [d.image] : []);

  const need = (d: Destination) => (gallery.get(d)?.length ?? 0) < TARGET_PER_PLACE;
  const addTo = (d: Destination, imgs: string[]) =>
    gallery.set(d, dedupeImages([...(gallery.get(d) ?? []), ...imgs]));

  // ---- 1) Wikidata (P18 + Commons) for places that carry a Wikidata id ----
  const wdIds = targets.filter((d) => d.wikidata && need(d)).map((d) => d.wikidata!);
  cacheDirty = (await resolveWdGalleries(wdIds, cache)) || cacheDirty;
  for (const d of targets) {
    if (!d.wikidata) continue;
    const cached = cache[wdKey(d.wikidata)];
    if (cached && cached.length) addTo(d, cached);
  }

  // ---- 2) Wikipedia (page image + linked Wikidata id) for places still short ----
  // An article title matching a listing name is strong evidence, not proof: a
  // listing is often named after something famous that has its own article and
  // its own photo. Hoi An's "White Rose" restaurant was illustrated with the
  // Munich memorial to the White Rose resistance group, its "Night Market" with
  // Shilin in Taipei. So the article has to agree on position too.
  const nmToDest = new Map<string, Destination[]>();
  const needTitles: string[] = [];
  for (const d of targets.filter(need)) {
    if (nameKey(d) in cache) {
      const cached = cache[nameKey(d)];
      if (cached && cached.length) addTo(d, cached);
      continue;
    }
    const key = normName(d.name);
    nmToDest.set(key, [...(nmToDest.get(key) ?? []), d]);
    if (!needTitles.includes(d.name)) needTitles.push(d.name);
  }

  if (needTitles.length) {
    const info = await fetchWikipediaInfo(needTitles);

    // Harvest a Commons gallery for every Wikidata id we just discovered.
    const discoveredQids = Object.values(info)
      .map((i) => i.qid)
      .filter((q): q is string => !!q);
    cacheDirty = (await resolveWdGalleries(discoveredQids, cache)) || cacheDirty;

    for (const [key, dests] of nmToDest) {
      const i = info[key];
      const wdImgs = i?.qid ? cache[wdKey(i.qid)] ?? [] : [];
      // Page image first (it's the article's chosen representative), then Commons.
      const imgs = dedupeImages([...(i?.thumb ? [i.thumb] : []), ...(wdImgs ?? [])]).slice(
        0,
        MAX_PER_PLACE,
      );
      for (const d of dests) {
        const keep = imgs.length > 0 && articleFitsPlace(i, d, scope);
        cache[nameKey(d)] = keep ? imgs : null;
        cacheDirty = true;
        if (keep) addTo(d, imgs);
      }
    }
  }

  // ---- 3) Verified Wikipedia search for still-missing top places ----
  // Catches places listed under a slightly different article title (macrons,
  // "(Tsuruoka)" suffixes, English vs local names). Cached under "sr:" so we
  // never repeat a search, even when phase 2 already cached a null exact match.
  const searchKey = (d: Destination) =>
    d.lat != null && d.lon != null
      ? `sr:${RULES}:${coordKey(d)}:${normName(d.name)}`
      : `sr:${RULES}:${normName(d.name)}`;
  const searchTargets = targets
    .filter((d) => (gallery.get(d)?.length ?? 0) < TARGET_PER_PLACE)
    .filter((d) => !(searchKey(d) in cache))
    .slice(0, SEARCH_CAP);

  if (searchTargets.length) {
    const discovered: string[] = []; // Wikidata ids to expand into galleries
    const hits = new Map<Destination, SearchHit>();
    await pool(searchTargets, async (d) => {
      const hit = await searchWikipediaImage(d.name, scope, d.lat, d.lon);
      if (hit) {
        hits.set(d, hit);
        if (hit.qid) discovered.push(hit.qid);
      }
    });
    cacheDirty = (await resolveWdGalleries(discovered, cache)) || cacheDirty;

    for (const d of searchTargets) {
      const hit = hits.get(d);
      const wdImgs = hit?.qid ? cache[wdKey(hit.qid)] ?? [] : [];
      const imgs = dedupeImages([...(hit?.thumb ? [hit.thumb] : []), ...(wdImgs ?? [])]).slice(
        0,
        MAX_PER_PLACE,
      );
      cache[searchKey(d)] = imgs.length ? imgs : null;
      cacheDirty = true;
    }
  }

  // Apply search results (covers both this run and cached prior runs).
  for (const d of targets) {
    const cached = cache[searchKey(d)];
    if (cached && cached.length) addTo(d, cached);
  }

  // ---- 4) Multilingual geosearch: match still-missing places by COORDINATE in
  //         the local-language Wikipedia (finds articles English lacks, across
  //         scripts — e.g. 大日坊 for "Dainichibo"). Cached under "gs:<lang>:".
  const geoKey = (lang: string, d: Destination) => `gs:${RULES}:${lang}:${coordKey(d)}`;
  for (const lang of langs) {
    const geoTargets = targets
      .filter((d) => PHOTOGRAPHED_CATEGORIES.has(d.category))
      .filter((d) => d.lat != null && d.lon != null)
      .filter((d) => (gallery.get(d)?.length ?? 0) < TARGET_PER_PLACE)
      .filter((d) => !(geoKey(lang, d) in cache))
      .slice(0, GEO_CAP);
    if (!geoTargets.length) continue;

    const hitOf = new Map<Destination, GeoHit>();
    await pool(geoTargets, async (d) => {
      const hit = await geosearchTitle(d.lat!, d.lon!, lang);
      if (hit) hitOf.set(d, hit);
    });

    // An article is about ONE place, so at most one listing can be it. In a dense
    // old town dozens of listings sit within the search radius of the same
    // landmark, and every one of them was being given its photo — eleven Hoi An
    // entries, restaurants included, all showed the Museum of Trade Ceramics.
    // The nearest listing keeps the article; the rest are simply near it.
    const claimant = new Map<string, Destination>();
    for (const [d, hit] of hitOf) {
      const held = claimant.get(hit.title);
      if (!held || hit.dist < hitOf.get(held)!.dist) claimant.set(hit.title, d);
    }

    const titles = [...claimant.keys()];
    const info = titles.length ? await fetchWikipediaInfo(titles, lang) : {};
    const discovered = Object.values(info)
      .map((i) => i.qid)
      .filter((q): q is string => !!q);
    cacheDirty = (await resolveWdGalleries(discovered, cache)) || cacheDirty;

    for (const d of geoTargets) {
      const hit = hitOf.get(d);
      const i = hit && claimant.get(hit.title) === d ? info[normName(hit.title)] : undefined;
      const wdImgs = i?.qid ? cache[wdKey(i.qid)] ?? [] : [];
      const imgs = dedupeImages([...(i?.thumb ? [i.thumb] : []), ...(wdImgs ?? [])]).slice(
        0,
        MAX_PER_PLACE,
      );
      cache[geoKey(lang, d)] = imgs.length ? imgs : null;
      cacheDirty = true;
    }
  }

  // Apply geosearch results (this run + cached prior runs).
  for (const d of targets) {
    if (d.lat == null || d.lon == null) continue;
    if (!PHOTOGRAPHED_CATEGORIES.has(d.category)) continue;
    for (const lang of langs) {
      const cached = cache[geoKey(lang, d)];
      if (cached && cached.length) addTo(d, cached);
    }
  }

  // ---- 5) Commons file search for places that STILL have no photo at all ----
  // Every source above is gated on the place existing as an encyclopedia entity
  // — a Wikidata item, an article, or an article near its coordinates. Plenty of
  // genuine, heavily-photographed sights clear none of those bars (Hoi An's old
  // merchant houses and assembly halls), and they were the camera placeholders.
  // Commons itself has their photos, so ask Commons directly. Restricted to
  // places with nothing, since this ranks below every source above.
  const commonsKey = (d: Destination) => `cs:${RULES}:${normName(place)}:${normName(d.name)}`;
  if (place) {
    const commonsTargets = targets
      .filter((d) => PHOTOGRAPHED_CATEGORIES.has(d.category))
      .filter((d) => !gallery.get(d)?.length)
      .filter((d) => !(commonsKey(d) in cache))
      .slice(0, COMMONS_CAP);

    if (commonsTargets.length) {
      await pool(commonsTargets, async (d) => {
        const imgs = await searchCommonsPhotos(d.name, place, scope, d.lat, d.lon);
        cache[commonsKey(d)] = imgs.length ? imgs : null;
        cacheDirty = true;
      });
    }

    // Apply (this run + cached prior runs). Re-checking the category here means
    // a narrowing of the rule also retires entries cached under the old one.
    for (const d of targets) {
      if (!PHOTOGRAPHED_CATEGORIES.has(d.category)) continue;
      const cached = cache[commonsKey(d)];
      if (cached && cached.length) addTo(d, cached);
    }

    // ---- 6) Commons BY COORDINATE, for the ones the name search missed ----
    // A guidebook and a photographer rarely choose the same words: Wikivoyage
    // lists a "Phuc Kien Meeting Hall", Commons files it under "Fujian Assembly
    // Hall (Hội quán Phúc Kiến)". Searching the text finds neither for the other,
    // but standing in the same spot does — and the shared name tokens confirm it.
    const geoCommonsKey = (d: Destination) => `cg:${RULES}:${coordKey(d)}:${normName(d.name)}`;
    const nearbyTargets = targets
      .filter((d) => PHOTOGRAPHED_CATEGORIES.has(d.category))
      .filter((d) => d.lat != null && d.lon != null)
      .filter((d) => !gallery.get(d)?.length)
      .filter((d) => !(geoCommonsKey(d) in cache))
      .slice(0, COMMONS_CAP);

    if (nearbyTargets.length) {
      await pool(nearbyTargets, async (d) => {
        const imgs = await geosearchCommonsPhotos(d.name, place, d.lat!, d.lon!);
        cache[geoCommonsKey(d)] = imgs.length ? imgs : null;
        cacheDirty = true;
      });
    }

    for (const d of targets) {
      if (d.lat == null || d.lon == null) continue;
      if (!PHOTOGRAPHED_CATEGORIES.has(d.category)) continue;
      const cached = cache[geoCommonsKey(d)];
      if (cached && cached.length) addTo(d, cached);
    }
  }

  // ---- Finalize: write galleries back onto the destinations ----
  for (const d of targets) {
    const imgs = dedupeImages(gallery.get(d) ?? []).slice(0, MAX_PER_PLACE);
    if (imgs.length) {
      d.images = imgs;
      d.image = imgs[0];
    }
  }

  if (cacheDirty) await store.saveImageCache();
  return destinations;
}
