// YouTube ingestion — "study the videos travellers actually watch".
//
// No API key: we fetch YouTube's search results page and read the embedded
// `ytInitialData`, pulling video TITLES + description snippets. Creators title
// videos with the exact places worth seeing ("Chợ Phiên Phố Đoàn", "Pu Luong
// Retreat", "Hieu Waterfall"), so this text both grounds the chat/opinions and
// feeds the "buzz" ranking signal (a place named across many videos is popular).
//
// We query in English AND the destination's local language(s), because the best
// coverage for somewhere like Pù Luông is in Vietnamese.

import { store, type KbSource } from '../store.ts';

export const YOUTUBE_PROVIDER = 'YouTube';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_VIDEOS_PER_QUERY = 12;
const MAX_CHARS = 6000;

// Local-language query hints so we surface the richest regional content.
const QUERY_HINTS: Record<string, string[]> = {
  en: ['things to do', 'travel guide'],
  vi: ['du lịch', 'địa điểm đẹp', 'ăn gì chơi gì'],
  ja: ['観光', 'おすすめ'],
  ko: ['여행', '가볼만한곳'],
  zh: ['旅游', '必去景点'],
  th: ['เที่ยว', 'ที่เที่ยว'],
  es: ['qué ver', 'turismo'],
  fr: ['que faire', 'tourisme'],
  de: ['sehenswürdigkeiten'],
  pt: ['o que fazer', 'turismo'],
  it: ['cosa vedere'],
  ru: ['достопримечательности'],
  id: ['wisata', 'tempat wisata'],
};

/** Decode a raw JSON string body (handles \uXXXX, \n, \" …). */
function decode(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\u[0-9a-fA-F]{4}/g, '').replace(/\\"/g, '"').replace(/\\n/g, ' ');
  }
}

interface Vid {
  title: string;
  snippet: string;
}

/** Parse video titles + description snippets out of a results page. */
function parseVideos(html: string, limit: number): Vid[] {
  const out: Vid[] = [];
  const seen = new Set<string>();
  const chunks = html.split('"videoRenderer"');
  for (let i = 1; i < chunks.length && out.length < limit; i++) {
    const c = chunks[i].slice(0, 4000);
    const tm = c.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*?)"/);
    if (!tm) continue;
    const title = decode(tm[1]).trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const sm =
      c.match(/"detailedMetadataSnippets":\[\{"snippetText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*?)"/) ||
      c.match(/"descriptionSnippet":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*?)"/);
    out.push({ title, snippet: sm ? decode(sm[1]).trim() : '' });
  }
  return out;
}

async function searchYouTube(query: string, hl: string): Promise<Vid[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=${hl}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': hl } });
    if (!res.ok) return [];
    return parseVideos(await res.text(), MAX_VIDEOS_PER_QUERY);
  } catch {
    return [];
  }
}

/**
 * Study YouTube for a location across English + local language(s) and store the
 * collected video titles/snippets as a single knowledge source.
 */
export async function ingestYouTube(location: string, langs: string[] = []): Promise<KbSource | null> {
  const searchLangs = [...new Set(['en', ...langs])].slice(0, 3);
  const videos: Vid[] = [];
  const seen = new Set<string>();
  for (const lang of searchLangs) {
    const hints = QUERY_HINTS[lang] ?? [''];
    for (const hint of hints.slice(0, 2)) {
      const q = hint ? `${location} ${hint}` : location;
      for (const v of await searchYouTube(q, lang)) {
        if (seen.has(v.title)) continue;
        seen.add(v.title);
        videos.push(v);
      }
    }
  }
  if (!videos.length) return null;

  // Build a compact corpus: "Title — snippet" per video (real creator text).
  let text = '';
  for (const v of videos) {
    const line = v.snippet ? `${v.title} — ${v.snippet}` : v.title;
    if ((text + line).length > MAX_CHARS) break;
    text += (text ? '\n' : '') + line;
  }

  const src: KbSource = {
    id: `yt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    location,
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(location + ' travel')}`,
    title: `YouTube travel videos (${videos.length}) — ${location}`,
    fetchedAt: Date.now(),
    summary: text,
    pois: [],
    provider: YOUTUBE_PROVIDER,
  };
  await store.addSource(src);
  return src;
}
