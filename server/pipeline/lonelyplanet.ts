// Lonely Planet integration.
//
// LP's live site is a client-rendered SPA, so destination/attraction hubs can't
// be scraped server-side — BUT their editorial ARTICLES (/articles/<slug>) are
// fully server-rendered and rich (e.g. "15 of the best things to do in Kyoto").
// We discover the relevant articles for a place by probing well-known slug
// patterns, keep the ones that really exist, and store their cleaned body as a
// knowledge source. That text then grounds the chat + traveller opinions, and a
// place being *named in an LP article* becomes an authoritative ranking signal.

import { store, type KbSource } from '../store.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const LP_PROVIDER = 'Lonely Planet';

// Slug templates that commonly exist for cities/regions/countries. Non-existent
// ones return a real 404 and are simply skipped.
const ARTICLE_TEMPLATES = [
  'best-things-to-do-in-{s}',
  'best-places-to-visit-in-{s}',
  'things-to-know-before-traveling-to-{s}',
  'best-time-to-visit-{s}',
  'where-to-stay-in-{s}',
  'best-restaurants-in-{s}',
  'best-neighborhoods-in-{s}',
];

const MAX_ARTICLES = 4; // be polite; the top few cover the highlights
const MIN_BODY_CHARS = 1500; // guard against soft-404 / stub pages
const MAX_BODY_CHARS = 6000; // enough to ground chat + mine opinions

function lpSlug(location: string): string {
  return location
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8211;|&ndash;/g, '–');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Pull the readable article body: headings (h2/h3) + paragraphs in document
 * order. This naturally drops nav/menu/footer (which are links/list items), so
 * we get the real editorial content without a full HTML parser.
 */
function extractArticle(html: string): { title: string; body: string } {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(h1?.[1] ?? titleTag?.[1] ?? 'Lonely Planet');

  // Narrow to the article region so we skip the nav mega-menu (promo blurbs) and
  // the footer/newsletter. Content lives between <main>/<h1> and <footer>.
  const startIdx = Math.max(html.search(/<main\b/i), 0) || Math.max(html.search(/<h1\b/i), 0);
  const footerIdx = html.slice(startIdx).search(/<footer\b|<\/main>/i);
  const region = html.slice(startIdx, footerIdx > 0 ? startIdx + footerIdx : undefined);

  const blocks: string[] = [];
  const re = /<(h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text) continue;
    if (tag === 'p') {
      if (text.length < 40) continue; // skip captions / boilerplate
      blocks.push(text);
    } else {
      // Heading — keep as a section marker (often "1. Visit Kinkaku-ji…").
      if (text.length <= 120) blocks.push(`\n${text}`);
    }
    if (blocks.join(' ').length > MAX_BODY_CHARS) break;
  }
  return { title, body: blocks.join('\n').slice(0, MAX_BODY_CHARS).trim() };
}

async function fetchArticle(url: string): Promise<{ title: string; body: string } | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return null; // real 404 for non-existent slugs
    const html = await res.text();
    const { title, body } = extractArticle(html);
    if (body.length < MIN_BODY_CHARS) return null;
    if (/page not found/i.test(title)) return null;
    return { title, body };
  } catch {
    return null;
  }
}

/**
 * Discover + store Lonely Planet articles for a location. Returns the sources
 * saved (may be empty when LP has no article for the place / slug differs).
 */
export async function ingestLonelyPlanet(location: string): Promise<KbSource[]> {
  const slug = lpSlug(location);
  if (!slug) return [];
  const saved: KbSource[] = [];
  for (const tpl of ARTICLE_TEMPLATES) {
    if (saved.length >= MAX_ARTICLES) break;
    const url = `https://www.lonelyplanet.com/articles/${tpl.replace('{s}', slug)}`;
    const art = await fetchArticle(url);
    if (!art) continue;
    const src: KbSource = {
      id: `lp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      location,
      url,
      title: `${art.title} — Lonely Planet`,
      fetchedAt: Date.now(),
      summary: art.body, // real LP editorial text → grounds chat + opinions
      pois: [],
      provider: LP_PROVIDER,
    };
    await store.addSource(src);
    saved.push(src);
  }
  return saved;
}
