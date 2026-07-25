// Real place photos from high-quality, no-key sources.
//
// Priority per place:
//   1. Image already on the Wikivoyage listing.
//   2. Wikidata P18 ("image") — the canonical photo of that exact entity (accurate).
//   3. Wikipedia page image — accurate when the place has its own article.
// Results are cached on disk so repeat loads are instant.

import type { Destination } from '../../src/types.ts';
import { store } from '../store.ts';

const COMMONS = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const IMG_WIDTH = 640;

/** Resolve at most this many (top-ranked) missing images per guide, to stay fast. */
const MAX_RESOLVE = 200;

function commonsThumb(file: string): string {
  const clean = file.replace(/^(File|Image):/i, '').trim();
  return `${COMMONS}${encodeURIComponent(clean)}?width=${IMG_WIDTH}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PocketPlanet/1.0 (travel guide app)' },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/** Batch-resolve Wikidata P18 images. Returns { Qid: thumbUrl }. */
async function fetchWikidataImages(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const group of chunk(ids, 45)) {
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      `&props=claims&ids=${group.join('|')}`;
    try {
      const data = await getJson(url);
      const entities = data.entities ?? {};
      for (const id of Object.keys(entities)) {
        const file = entities[id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (typeof file === 'string' && file) out[id] = commonsThumb(file);
      }
    } catch {
      /* skip this batch on error */
    }
  }
  return out;
}

/** Batch-resolve Wikipedia page thumbnails by title. Returns { normTitle: thumbUrl }. */
async function fetchWikipediaImages(titles: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const group of chunk(titles, 45)) {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*' +
      `&prop=pageimages&piprop=thumbnail&pithumbsize=${IMG_WIDTH}&redirects=1` +
      `&titles=${group.map((t) => encodeURIComponent(t)).join('|')}`;
    try {
      const data = await getJson(url);
      const q = data.query ?? {};
      // Follow title normalization + redirects back to the requested titles.
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
      const thumbByTitle: Record<string, string> = {};
      for (const p of q.pages ?? []) {
        if (p.thumbnail?.source) thumbByTitle[p.title] = p.thumbnail.source;
      }
      for (const requested of group) {
        const finalTitle = resolve(requested);
        const thumb = thumbByTitle[finalTitle];
        if (thumb) out[normName(requested)] = thumb;
      }
    } catch {
      /* skip this batch on error */
    }
  }
  return out;
}

/**
 * Fill in `image` for destinations that lack one, using Wikidata then Wikipedia,
 * with a persistent cache. Mutates + returns the destinations.
 */
export async function resolveImages(destinations: Destination[]): Promise<Destination[]> {
  const cache = await store.getImageCache();
  let cacheDirty = false;

  const targets = destinations
    .filter((d) => !d.image)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESOLVE);

  const needWikidata: string[] = [];
  const needTitle: string[] = [];
  const wikidataToDest = new Map<string, Destination[]>();
  const titleToDest = new Map<string, Destination[]>();

  for (const d of targets) {
    const wdKey = d.wikidata ? `wd:${d.wikidata}` : null;
    const nmKey = `nm:${normName(d.name)}`;

    // Serve from cache when we've looked this up before.
    if (wdKey && wdKey in cache) {
      if (cache[wdKey]) d.image = cache[wdKey]!;
      else if (nmKey in cache) {
        if (cache[nmKey]) d.image = cache[nmKey]!;
      } else {
        titleToDest.set(normName(d.name), [...(titleToDest.get(normName(d.name)) ?? []), d]);
        needTitle.push(d.name);
      }
      continue;
    }
    if (!wdKey && nmKey in cache) {
      if (cache[nmKey]) d.image = cache[nmKey]!;
      continue;
    }

    if (d.wikidata) {
      wikidataToDest.set(d.wikidata, [...(wikidataToDest.get(d.wikidata) ?? []), d]);
      needWikidata.push(d.wikidata);
    } else {
      titleToDest.set(normName(d.name), [...(titleToDest.get(normName(d.name)) ?? []), d]);
      needTitle.push(d.name);
    }
  }

  // 1) Wikidata
  if (needWikidata.length) {
    const found = await fetchWikidataImages([...new Set(needWikidata)]);
    for (const id of new Set(needWikidata)) {
      const url = found[id];
      cache[`wd:${id}`] = url ?? null;
      cacheDirty = true;
      if (url) {
        for (const d of wikidataToDest.get(id) ?? []) d.image = url;
      } else {
        // No Wikidata photo → try the name instead.
        for (const d of wikidataToDest.get(id) ?? []) {
          titleToDest.set(normName(d.name), [...(titleToDest.get(normName(d.name)) ?? []), d]);
          needTitle.push(d.name);
        }
      }
    }
  }

  // 2) Wikipedia page images
  if (needTitle.length) {
    const found = await fetchWikipediaImages([...new Set(needTitle)]);
    for (const name of new Set(needTitle)) {
      const key = normName(name);
      const url = found[key];
      cache[`nm:${key}`] = url ?? null;
      cacheDirty = true;
      if (url) for (const d of titleToDest.get(key) ?? []) if (!d.image) d.image = url;
    }
  }

  if (cacheDirty) await store.saveImageCache();
  return destinations;
}
