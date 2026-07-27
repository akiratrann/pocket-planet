// Place-name localization — "as good as Google Maps".
//
// Google Maps shows place labels in the viewer's language using multilingual
// open data. We do the same: every destination we surface has (or can be linked
// to) a Wikidata item, and Wikidata carries human-curated labels in hundreds of
// languages. Given the user's language preference we swap each place's display
// name for its label in that language, falling back gracefully to the original
// when no translation exists. Nothing is machine-translated or invented.

import type { Destination } from '../../src/types.ts';

const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const UA = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

async function getJson<T>(url: string, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return null;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

interface WdLabels {
  entities?: Record<string, { labels?: Record<string, { value?: string }> }>;
}

/**
 * Rewrite destination names into `lang` using Wikidata labels, where available.
 * Only places with a Wikidata id can be localized; others keep their source name
 * (which is already the local or English name).
 */
export async function localizeNames(destinations: Destination[], lang: string): Promise<void> {
  const qids = [...new Set(destinations.map((d) => d.wikidata).filter((x): x is string => Boolean(x)))];
  if (!qids.length) return;

  const label = new Map<string, string>();
  for (const part of chunk(qids, 45)) {
    const data = await getJson<WdLabels>(
      `${WIKIDATA}?` +
        new URLSearchParams({
          action: 'wbgetentities',
          ids: part.join('|'),
          props: 'labels',
          languages: lang === 'en' ? 'en' : `${lang}|en`,
          format: 'json',
          formatversion: '2',
          origin: '*',
        }).toString(),
    );
    for (const [qid, ent] of Object.entries(data?.entities ?? {})) {
      const val = ent.labels?.[lang]?.value ?? (lang === 'en' ? ent.labels?.en?.value : undefined);
      if (val) label.set(qid, val);
    }
  }

  for (const d of destinations) {
    if (d.wikidata) {
      const l = label.get(d.wikidata);
      if (l) d.name = l;
    }
  }
}

interface WdSearch {
  search?: Array<{ id: string; label?: string }>;
}

/**
 * Localize the guide's headline place name (e.g. "Kyoto" → "京都"). Conservative:
 * we only translate when a Wikidata item's English label exactly matches the
 * title, so we never mislabel an ambiguous query.
 */
export async function localizeTitle(title: string, lang: string): Promise<string | null> {
  if (lang === 'en') return null;
  const search = await getJson<WdSearch>(
    `${WIKIDATA}?` +
      new URLSearchParams({
        action: 'wbsearchentities',
        search: title,
        language: 'en',
        uselang: 'en',
        type: 'item',
        limit: '5',
        format: 'json',
        origin: '*',
      }).toString(),
  );
  const hit = (search?.search ?? []).find((h) => h.label?.toLowerCase() === title.trim().toLowerCase());
  if (!hit) return null;
  const data = await getJson<WdLabels>(
    `${WIKIDATA}?` +
      new URLSearchParams({
        action: 'wbgetentities',
        ids: hit.id,
        props: 'labels',
        languages: lang,
        format: 'json',
        formatversion: '2',
        origin: '*',
      }).toString(),
  );
  return data?.entities?.[hit.id]?.labels?.[lang]?.value ?? null;
}
