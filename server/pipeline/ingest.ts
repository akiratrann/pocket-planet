// Web ingestion: fetch a resource about a location, extract structured POIs +
// a summary with the configured LLM, and store it in the knowledge base. The
// backend (unlike a browser) can fetch arbitrary sites, so this is where "study
// new resources on the web" happens.

import { getLLM } from '../llm/adapter.ts';
import { store, type KbSource } from '../store.ts';
import { guideLanguages } from './lang.ts';
import { fetchDiscussions } from './discussions.ts';
import { ingestLonelyPlanet } from './lonelyplanet.ts';
import { ingestYouTube } from './youtube.ts';

const UA = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';

interface WikiSummary {
  title?: string;
  extract?: string;
  coordinates?: { lat: number; lon: number };
  content_urls?: { desktop?: { page?: string } };
}

/** Fetch a Wikipedia REST summary in a given language (works for any language). */
async function restSummary(lang: string, title: string): Promise<WikiSummary | null> {
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return null;
    return (await res.json()) as WikiSummary;
  } catch {
    return null;
  }
}

/** Wikidata id for a Wikipedia article title (bridges to other languages). */
async function wikidataIdForTitle(lang: string, title: string): Promise<string | null> {
  try {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*` +
      `&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      query?: { pages?: Array<{ pageprops?: { wikibase_item?: string } }> };
    };
    return data.query?.pages?.[0]?.pageprops?.wikibase_item ?? null;
  } catch {
    return null;
  }
}

/** Local-language article titles for a Wikidata entity, via its sitelinks. */
async function sitelinkTitles(qid: string, langs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      `&props=sitelinks&ids=${qid}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }>;
    };
    const links = data.entities?.[qid]?.sitelinks ?? {};
    for (const lang of langs) {
      const t = links[`${lang}wiki`]?.title;
      if (t) out[lang] = t;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromHtml(html: string, fallback: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : fallback;
}

async function fetchText(url: string): Promise<{ text: string; title: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PocketPlanet/1.0 (travel guide ingestion)' },
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const html = await res.text();
  return { text: stripHtml(html), title: titleFromHtml(html, url) };
}

/** Ingest a single explicit URL for a location. */
export async function ingestUrl(location: string, url: string): Promise<KbSource> {
  const llm = getLLM();
  const { text, title } = await fetchText(url);
  const [summary, pois] = await Promise.all([
    llm.summarizeLocation(location, text),
    llm.extractPOIs(location, text),
  ]);
  const src: KbSource = {
    id: `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    location,
    url,
    title,
    fetchedAt: Date.now(),
    summary,
    pois,
    provider: llm.name,
  };
  await store.addSource(src);
  return src;
}

async function saveSummaryAsSource(
  location: string,
  lang: string,
  data: WikiSummary,
): Promise<KbSource | null> {
  const text = data.extract ?? '';
  if (!text) return null;
  const llm = getLLM();
  const src: KbSource = {
    id: `auto-${lang}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    location,
    url: data.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(data.title ?? location)}`,
    title: `${data.title ?? location} (${lang}.wikipedia)`,
    fetchedAt: Date.now(),
    summary: await llm.summarizeLocation(location, text),
    pois: await llm.extractPOIs(location, text),
    provider: llm.name,
  };
  await store.addSource(src);
  return src;
}

/**
 * Automatically discover resources for a location — in English AND its local
 * language(s). The local-language Wikipedia usually has far more detail, so this
 * is how we "study new resources on the web in any language". Bridges English →
 * other languages via the Wikidata entity's sitelinks.
 */
export async function ingestLocationAuto(location: string): Promise<KbSource | null> {
  const en = await restSummary('en', location);
  const primary = en ? await saveSummaryAsSource(location, 'en', en) : null;

  // Which languages are local to this place?
  const coords = en?.coordinates;
  const langs = coords ? await guideLanguages([coords.lon, coords.lat]) : [];
  if (!langs.length) return primary;

  // Find the Wikidata entity, then the local-language article titles.
  const qid = en?.title ? await wikidataIdForTitle('en', en.title) : null;
  if (!qid) return primary;
  const titles = await sitelinkTitles(qid, langs);

  for (const [lang, title] of Object.entries(titles)) {
    const summary = await restSummary(lang, title);
    if (summary) await saveSummaryAsSource(location, lang, summary);
  }

  return primary;
}

/**
 * Study community discussion platforms (Reddit, Travel Stack Exchange…) for a
 * location and store each thread as a source. The raw thread text (question +
 * top answers/comments) is kept so the opinion miner can quote real travellers,
 * and so the ranking "buzz" signal can see which places people actually mention.
 */
export async function ingestDiscussions(location: string): Promise<KbSource[]> {
  const threads = await fetchDiscussions(location);
  const saved: KbSource[] = [];
  for (const th of threads) {
    const src: KbSource = {
      id: `disc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      location,
      url: th.url,
      title: `${th.title} — ${th.platform}`,
      fetchedAt: Date.now(),
      // Keep the real discussion text as the "summary" so opinions/buzz work off
      // actual traveller words (not an LLM paraphrase).
      summary: th.text,
      pois: [],
      provider: th.platform,
    };
    await store.addSource(src);
    saved.push(src);
  }
  return saved;
}

/** Re-study every tracked location (used by the scheduler). */
export async function ingestAllTracked(): Promise<number> {
  const tracked = await store.getTracked();
  let count = 0;
  for (const loc of tracked) {
    const src = await ingestLocationAuto(loc);
    await ingestDiscussions(loc); // refresh community discussion each cycle
    await ingestLonelyPlanet(loc).catch(() => []); // refresh Lonely Planet articles
    await ingestYouTube(loc).catch(() => null); // refresh YouTube travel videos
    if (src) count++;
  }
  return count;
}
