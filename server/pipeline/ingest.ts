// Web ingestion: fetch a resource about a location, extract structured POIs +
// a summary with the configured LLM, and store it in the knowledge base. The
// backend (unlike a browser) can fetch arbitrary sites, so this is where "study
// new resources on the web" happens.

import { getLLM } from '../llm/adapter.ts';
import { store, type KbSource } from '../store.ts';

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

/**
 * Automatically discover a resource for a location. Uses Wikipedia's REST API as
 * a reliable default "new resource" feed; extend with more sources (news, blogs,
 * search APIs) here.
 */
export async function ingestLocationAuto(location: string): Promise<KbSource | null> {
  const llm = getLLM();
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(location)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PocketPlanet/1.0 (travel guide ingestion)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
    const text = data.extract ?? '';
    if (!text) return null;
    const src: KbSource = {
      id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      location,
      url: data.content_urls?.desktop?.page ?? url,
      title: data.title ?? location,
      fetchedAt: Date.now(),
      summary: await llm.summarizeLocation(location, text),
      pois: await llm.extractPOIs(location, text),
      provider: llm.name,
    };
    await store.addSource(src);
    return src;
  } catch {
    return null;
  }
}

/** Re-study every tracked location (used by the scheduler). */
export async function ingestAllTracked(): Promise<number> {
  const tracked = await store.getTracked();
  let count = 0;
  for (const loc of tracked) {
    const src = await ingestLocationAuto(loc);
    if (src) count++;
  }
  return count;
}
