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
// Results are cached on disk so repeat loads are instant.

import type { Destination } from '../../src/types.ts';
import { store } from '../store.ts';

const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const IMG_WIDTH = 800;

/** Aim for this many photos per place; stop calling extra sources once reached. */
const TARGET_PER_PLACE = 3;
/** Never keep more than this many per place. */
const MAX_PER_PLACE = 5;
/** Resolve at most this many (top-ranked) places per guide, to stay fast. */
const MAX_RESOLVE = 400;
/** Parallelism for the per-category Commons calls (kept low to avoid throttling). */
const CONCURRENCY = 4;

// Wikimedia's UA policy asks for an app name, version and a contact URL.
const USER_AGENT = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Filenames that are almost never a real photo of the place. */
const JUNK_FILE = /(\.svg|\.pdf|\.ogg|\.oga|\.ogv|\.webm|\.mid|\.wav)$|locator|location map|\bmap\b|\bplan\b|logo|icon|flag of|coat of arms|\bseal\b|blason|wappen|diagram|floorplan|panorama.*sphere|qr[ _]code/i;

function commonsThumb(file: string): string {
  const clean = file.replace(/^(File|Image):/i, '').trim();
  return `${COMMONS_FILEPATH}${encodeURIComponent(clean)}?width=${IMG_WIDTH}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
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

/** Batch-resolve Wikidata claims: P18 photos + P373 Commons category. */
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
  const photos: Array<{ url: string; area: number }> = [];
  for (const p of pages) {
    const title: string = p.title ?? '';
    const info = p.imageinfo?.[0];
    if (!info) continue;
    const mime: string = info.mime ?? '';
    if (!mime.startsWith('image/') || mime.includes('svg')) continue;
    if (JUNK_FILE.test(title)) continue;
    const w = Number(info.width) || 0;
    const h = Number(info.height) || 0;
    if (w < 400 || h < 300) continue; // skip thumbnails/icons
    const url: string | undefined = info.thumburl || info.url;
    if (url) photos.push({ url, area: w * h });
  }
  // Prefer larger images (a decent proxy for "hero-worthy").
  photos.sort((a, b) => b.area - a.area);
  return photos.slice(0, limit).map((p) => p.url);
}

interface WpInfo {
  thumb?: string;
  qid?: string; // linked Wikidata entity, used to harvest a Commons gallery
}

/**
 * Batch-resolve, per title: the Wikipedia page image AND the linked Wikidata id
 * (so name-only listings can still get a full Commons gallery). Keyed by normName.
 */
async function fetchWikipediaInfo(titles: string[]): Promise<Record<string, WpInfo>> {
  const out: Record<string, WpInfo> = {};
  for (const group of chunk(titles, 45)) {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
      `&prop=pageimages|pageprops&ppprop=wikibase_item&piprop=thumbnail&pithumbsize=${IMG_WIDTH}&redirects=1` +
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
        byTitle[p.title] = {
          thumb: p.thumbnail?.source,
          qid: p.pageprops?.wikibase_item,
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

/**
 * For a set of Wikidata ids, resolve a gallery (P18 + Commons category) for any
 * that aren't cached yet, and write the result (array or null) into `cache`.
 * Returns true if it wrote anything.
 */
async function resolveWdGalleries(
  ids: string[],
  cache: Record<string, string[] | null>,
): Promise<boolean> {
  const uncached = [...new Set(ids)].filter((id) => !(`wd:${id}` in cache));
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
    cache[`wd:${id}`] = imgs.length ? imgs : null;
  }
  return true;
}

/**
 * Fill in a small photo gallery (`images` + primary `image`) for destinations.
 * Best-first sources: Wikivoyage → Wikidata P18 → the place's Commons category →
 * Wikipedia page image (which also recovers a Wikidata id so name-only listings
 * still get a full Commons gallery). Results are cached on disk.
 * Mutates + returns the destinations.
 */
export async function resolveImages(destinations: Destination[]): Promise<Destination[]> {
  const cache = await store.getImageCache();
  let cacheDirty = false;

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
    const cached = cache[`wd:${d.wikidata}`];
    if (cached && cached.length) addTo(d, cached);
  }

  // ---- 2) Wikipedia (page image + linked Wikidata id) for places still short ----
  const nmToDest = new Map<string, Destination[]>();
  const needTitles: string[] = [];
  for (const d of targets.filter(need)) {
    const key = normName(d.name);
    if (`nm:${key}` in cache) {
      const cached = cache[`nm:${key}`];
      if (cached && cached.length) addTo(d, cached);
      continue;
    }
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
      const wdImgs = i?.qid ? cache[`wd:${i.qid}`] ?? [] : [];
      // Page image first (it's the article's chosen representative), then Commons.
      const imgs = dedupeImages([...(i?.thumb ? [i.thumb] : []), ...(wdImgs ?? [])]).slice(
        0,
        MAX_PER_PLACE,
      );
      cache[`nm:${key}`] = imgs.length ? imgs : null;
      cacheDirty = true;
      if (imgs.length) for (const d of dests) addTo(d, imgs);
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
