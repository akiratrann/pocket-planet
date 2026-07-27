import type { AdviceSection, Destination, Guide } from '../types';
import { classifyCategory } from './categories';
import { geocode } from './geocode';
import { rankDestinations } from './ranking';
import {
  cleanWikitext,
  findTemplates,
  parseCoord,
  splitSections,
  type ParsedTemplate,
} from './wikitext';

const API = 'https://en.wikivoyage.org/w/api.php';

// ---------------------------------------------------------------------------
// HTML entities.
//
// Wikivoyage editors write prices and prose with raw HTML entities
// (`price=&yen;300`, `&mdash;`, `&#8364;`). MediaWiki resolves them when it
// renders a page, but we consume wikitext directly, so they reached the UI
// verbatim ("&yen;300" instead of "¥300"). Decoding belongs here, at the parse
// boundary, so every consumer of a Destination/advice section benefits.
// ---------------------------------------------------------------------------

// Accented Latin letters follow a regular naming scheme (&eacute; / &Eacute;),
// so the uppercase half of the table is derived instead of typed out twice.
const ACCENTED: Record<string, string> = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í',
  icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', thorn: 'þ', yuml: 'ÿ', scaron: 'š', zcaron: 'ž', oelig: 'œ',
};

const ENTITIES: Record<string, string> = {
  // Structural — these must stay literal text; see decodeEntities().
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // Spaces.
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  // Punctuation.
  ndash: '–', mdash: '—', horbar: '―', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', dagger: '†', Dagger: '‡',
  sect: '§', para: '¶', iexcl: '¡', iquest: '¿',
  // Currency — the reason this table exists.
  yen: '¥', euro: '€', pound: '£', cent: '¢', curren: '¤',
  // Maths / units, common in prices, hours and elevations.
  deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', frac12: '½',
  frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ',
  permil: '‰', prime: '′', Prime: '″', ne: '≠', le: '≤', ge: '≥', asymp: '≈',
  // Symbols / arrows.
  copy: '©', reg: '®', trade: '™', larr: '←', rarr: '→', harr: '↔', uarr: '↑', darr: '↓',
  ...ACCENTED,
};
for (const [name, char] of Object.entries(ACCENTED)) {
  ENTITIES[name[0].toUpperCase() + name.slice(1)] = char.toUpperCase();
}

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,30});/g;

/**
 * Decode HTML character references in text that is rendered as TEXT, never as
 * markup (React escapes it on the way out). Deliberately a SINGLE pass: decoding
 * repeatedly would turn a literal "&amp;lt;script&gt;" into a tag and hand an
 * XSS primitive to any future consumer that did use innerHTML.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const code = Number.parseInt(body.slice(body[1] === 'x' || body[1] === 'X' ? 2 : 1), body[1] === 'x' || body[1] === 'X' ? 16 : 10);
      // Reject anything that isn't a real, printable scalar value: NUL and other
      // C0 controls, lone surrogates, and out-of-range code points.
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? match; // unknown name → leave the source text alone
  });
}

/** Wikitext → display text, with character references resolved. */
function cleanText(input?: string): string {
  // Decode AFTER cleanWikitext has stripped tags: doing it first would let an
  // escaped "&lt;b&gt;" become a real tag that the stripper then eats, silently
  // deleting the words around it.
  return decodeEntities(cleanWikitext(input ?? ''));
}

/** Wikivoyage POI listing template names. */
const LISTING_NAMES = new Set([
  'see',
  'do',
  'buy',
  'eat',
  'drink',
  'sleep',
  'listing',
  'marker',
  'vcard',
]);

async function api<T>(params: Record<string, string>): Promise<T> {
  const url =
    API +
    '?' +
    new URLSearchParams({
      format: 'json',
      formatversion: '2',
      origin: '*',
      ...params,
    }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikivoyage API error ${res.status}`);
  return (await res.json()) as T;
}

/** Resolve a free-text place query to the best Wikivoyage article title. */
export async function findArticleTitle(query: string): Promise<string | null> {
  const data = await api<{
    query?: { search?: Array<{ title: string }> };
  }>({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    srnamespace: '0',
  });
  const hits = data.query?.search ?? [];
  if (!hits.length) return null;
  // Prefer an exact (case-insensitive) title match, else the top hit.
  const exact = hits.find((h) => h.title.toLowerCase() === query.trim().toLowerCase());
  return (exact ?? hits[0]).title;
}

async function fetchWikitext(title: string): Promise<{ wikitext: string; resolvedTitle: string }> {
  const data = await api<{
    parse?: { wikitext?: string; title?: string };
    error?: { info: string };
  }>({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    redirects: '1',
  });
  if (!data.parse?.wikitext) {
    throw new Error(data.error?.info ?? `No article found for "${title}"`);
  }
  return { wikitext: data.parse.wikitext, resolvedTitle: data.parse.title ?? title };
}

/**
 * Fetch the wikitext of many articles in a single API request (MediaWiki lets us
 * pass up to 50 titles at once). This keeps child aggregation fast and avoids the
 * rate limiting we'd hit firing a dozen parallel requests.
 */
async function fetchManyWikitext(
  titles: string[],
): Promise<Array<{ title: string; wikitext: string }>> {
  if (!titles.length) return [];
  const data = await api<{
    query?: {
      pages?: Array<{
        title: string;
        missing?: boolean;
        revisions?: Array<{ slots?: { main?: { content?: string } } }>;
      }>;
    };
  }>({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    redirects: '1',
    titles: titles.join('|'),
  });
  const out: Array<{ title: string; wikitext: string }> = [];
  for (const page of data.query?.pages ?? []) {
    const content = page.revisions?.[0]?.slots?.main?.content;
    if (content) out.push({ title: page.title, wikitext: content });
  }
  return out;
}

const IMAGE_BASE = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

function buildImageUrl(file?: string): string | undefined {
  if (!file) return undefined;
  const clean = file.replace(/^(File|Image):/i, '').trim();
  if (!clean) return undefined;
  return `${IMAGE_BASE}${encodeURIComponent(clean)}?width=480`;
}

// Marker "types" that are navigational (region/city map pins), not real POIs.
const NAV_TYPES = new Set(['city', 'region', 'vicinity', 'country', 'continent', 'other', 'go']);

function toDestination(tpl: ParsedTemplate, index: number): Destination | null {
  const p = tpl.params;
  const name = cleanText(p.name ?? p['1']).trim();
  if (!name) return null;

  const wvType = (tpl.name === 'listing' || tpl.name === 'marker' || tpl.name === 'vcard'
    ? (p.type ?? 'see')
    : tpl.name
  ).toLowerCase();

  if (NAV_TYPES.has(wvType)) return null; // skip navigational markers

  const description = cleanText(p.content ?? p.description);
  const category = classifyCategory(wvType, name, description);

  return {
    id: `${wvType}-${index}-${name.slice(0, 24)}`.replace(/\s+/g, '_'),
    name,
    category,
    wvType,
    lat: parseCoord(p.lat ?? p.latitude),
    lon: parseCoord(p.long ?? p.lon ?? p.longitude),
    description: description || undefined,
    address: cleanText(p.address) || undefined,
    url: (p.url ?? p.website ?? '').trim() || undefined,
    phone: cleanText(p.phone) || undefined,
    hours: cleanText(p.hours) || undefined,
    price: cleanText(p.price) || undefined,
    wikidata: (p.wikidata ?? '').trim() || undefined,
    image: buildImageUrl(p.image),
    score: 0,
    rank: 0,
    order: index,
    reasons: [],
  };
}

const ADVICE_SECTIONS: Array<{ keys: string[]; title: string; icon: string }> = [
  { keys: ['understand'], title: 'Understand', icon: '🧭' },
  { keys: ['climate', 'when to go', 'weather'], title: 'When to go', icon: '🌤️' },
  { keys: ['get in', 'by plane'], title: 'Getting there', icon: '✈️' },
  { keys: ['get around', 'getaround'], title: 'Getting around', icon: '🚉' },
  { keys: ['talk', 'language'], title: 'Language', icon: '💬' },
  { keys: ['stay safe', 'safety'], title: 'Stay safe', icon: '🛡️' },
  { keys: ['stay healthy', 'health'], title: 'Stay healthy', icon: '⚕️' },
  { keys: ['respect', 'etiquette'], title: 'Respect & etiquette', icon: '🙏' },
  { keys: ['connect', 'internet'], title: 'Connect', icon: '📶' },
];

function buildAdvice(sections: Record<string, string>): AdviceSection[] {
  const out: AdviceSection[] = [];
  for (const spec of ADVICE_SECTIONS) {
    const key = spec.keys.find((k) => sections[k]);
    if (!key) continue;
    const body = cleanText(sections[key]);
    if (body.length < 40) continue; // skip near-empty sections
    out.push({ id: spec.title.toLowerCase().replace(/\s+/g, '-'), title: spec.title, icon: spec.icon, body });
  }
  return out;
}

/**
 * Pull the parent region from Wikivoyage's breadcrumb template
 * (e.g. `{{IsPartOf|Tohoku}}`), used to drill up a level as you zoom out.
 */
function extractParent(wikitext: string): string | undefined {
  const m = wikitext.match(/\{\{\s*(?:is\s*part\s*of|isin|partoftopic)\s*\|\s*([^}|]+?)\s*\}\}/i);
  const name = m?.[1]?.trim();
  if (!name || name.includes(':')) return undefined;
  return name;
}

/** Pull the "Go next" / region child links for scope drill-down. */
function extractRelated(sections: Record<string, string>): string[] {
  const src = sections['go next'] ?? sections['regions'] ?? sections['cities'] ?? '';
  const links = [...src.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    if (l.includes(':')) continue; // skip File:/Category: etc.
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= 12) break;
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Frame the map on the bulk of the POIs, trimming outliers (a single mis-parsed
 * or far-flung listing shouldn't zoom the whole map out to an ocean).
 */
export function computeExtent(destinations: Destination[]): {
  center: [number, number];
  bbox?: [number, number, number, number];
} {
  const pts = destinations.filter((d) => d.lat != null && d.lon != null);
  if (!pts.length) return { center: [0, 20] };

  const lons = pts.map((d) => d.lon!).sort((a, b) => a - b);
  const lats = pts.map((d) => d.lat!).sort((a, b) => a - b);

  // Use 3rd–97th percentile bounds to ignore stray points.
  const q = pts.length >= 12 ? 0.03 : 0;
  const minLon = percentile(lons, q);
  const maxLon = percentile(lons, 1 - q);
  const minLat = percentile(lats, q);
  const maxLat = percentile(lats, 1 - q);

  return {
    center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
    bbox: [minLon, minLat, maxLon, maxLat],
  };
}

// Sections that contain listings which are NOT travel POIs (embassies, transport
// nodes, admin/nav). Skipping them stops junk like foreign countries (embassy
// listings) showing up under "Sights".
const NON_POI_SECTIONS = new Set([
  'understand',
  'history',
  'climate',
  'get in',
  'get around',
  'getin',
  'getaround',
  'by plane',
  'by train',
  'by car',
  'by bus',
  'by boat',
  'talk',
  'connect',
  'contact',
  'cope',
  'embassies',
  'consulates',
  'stay safe',
  'stay healthy',
  'respect',
  'work',
  'learn',
  'go next',
  'nearby',
  'see also',
  'references',
  'external links',
  // Child-navigation sections (handled separately via extractChildren).
  'cities',
  'regions',
  'other destinations',
  'districts',
  'towns',
  'villages',
  'islands',
  'boroughs',
  'neighbourhoods',
  'neighborhoods',
  'destinations',
]);

/** Parse every POI listing out of a single article's wikitext (section-aware). */
function parseListings(wikitext: string): Destination[] {
  const { sections } = splitSections(wikitext);
  const out: Destination[] = [];
  let order = 0;

  const collect = (body: string) => {
    for (const tpl of findTemplates(body)) {
      if (!LISTING_NAMES.has(tpl.name)) continue;
      const d = toDestination(tpl, order);
      if (d) {
        out.push(d);
        order++;
      }
    }
  };

  let sawAllowedSection = false;
  for (const [title, body] of Object.entries(sections)) {
    if (NON_POI_SECTIONS.has(title)) continue;
    sawAllowedSection = true;
    collect(body);
  }

  // Fallback for stub articles that lack standard sections.
  if (!sawAllowedSection && out.length === 0) collect(wikitext);

  return out;
}

// Order matters: cities/districts hold real POIs, so prefer them over regions
// (which are just another overview layer we'd have to drill through).
const CHILD_SECTION_KEYS = [
  'districts',
  'cities',
  'towns',
  'other destinations',
  'boroughs',
  'neighbourhoods',
  'neighborhoods',
  'villages',
  'islands',
  'destinations',
  'regions',
];

/**
 * Wikivoyage splits large places hierarchically: countries → cities, and huge
 * cities → district subpages (e.g. "Kyoto/Higashiyama"). When an article is an
 * overview, discover its child articles so we can aggregate their POIs and give
 * comprehensive coverage regardless of scope.
 */
function extractChildren(
  title: string,
  wikitext: string,
  sections: Record<string, string>,
): string[] {
  const children: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const clean = t.trim();
    if (!clean || clean.includes(':') || seen.has(clean)) return;
    seen.add(clean);
    children.push(clean);
  };

  // 1. Subpage districts of a huge city (e.g. "Kyoto/Higashiyama").
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subRe = new RegExp('\\[\\[(' + esc + '\\/[^\\]|#]+)', 'g');
  for (const m of wikitext.matchAll(subRe)) add(m[1]);

  // 2. Child cities/regions of a country or region.
  if (children.length === 0) {
    for (const key of CHILD_SECTION_KEYS) {
      const src = sections[key];
      if (!src) continue;
      for (const m of src.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)) {
        add(m[1]);
      }
    }
  }

  return children;
}

const MAX_CHILDREN = 14;
/** A level-1 child yielding fewer than this is itself an overview → drill deeper. */
const SPARSE_CHILD = 6;
const MAX_GRANDCHILDREN = 18;

/** Remove duplicate POIs that appear in both a parent overview and a child article. */
function dedupe(destinations: Destination[]): Destination[] {
  const seen = new Set<string>();
  const out: Destination[] = [];
  for (const d of destinations) {
    const name = d.name.trim().toLowerCase();
    // Same name at the same spot (~100m) is the same place; same name in different
    // cities (different coords) is kept separate.
    const key =
      d.lat != null && d.lon != null
        ? `${name}@${d.lat.toFixed(2)},${d.lon.toFixed(2)}`
        : `name:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Fetch and assemble a full travel guide for a place query. */
export async function getGuide(query: string): Promise<Guide> {
  const initialTitle = (await findArticleTitle(query)) ?? query;
  const { wikitext, resolvedTitle } = await fetchWikitext(initialTitle);
  const title = resolvedTitle;

  const { intro, sections } = splitSections(wikitext);
  let destinations = parseListings(wikitext);

  // Aggregate children for overview articles (countries, regions, huge cities).
  // The parent article of a country/region only carries a handful of highlight
  // pins, so we pull in its children — and, for children that are themselves
  // overviews (a region, or a huge city like Lisbon whose POIs live in district
  // subpages), we drill one more level. Both levels use a single batched request.
  const childTitles = extractChildren(title, wikitext, sections).slice(0, MAX_CHILDREN);
  if (childTitles.length) {
    const children = await fetchManyWikitext(childTitles);
    const grandchildTitles: string[] = [];
    for (const child of children) {
      const listings = parseListings(child.wikitext);
      destinations.push(...listings);
      if (listings.length < SPARSE_CHILD) {
        const { sections: childSections } = splitSections(child.wikitext);
        const grand = extractChildren(child.title, child.wikitext, childSections);
        grandchildTitles.push(...grand);
      }
    }
    const uniqueGrand = [...new Set(grandchildTitles)]
      .filter((t) => t !== title && !childTitles.includes(t))
      .slice(0, MAX_GRANDCHILDREN);
    if (uniqueGrand.length) {
      const grandchildren = await fetchManyWikitext(uniqueGrand);
      for (const gc of grandchildren) {
        destinations.push(...parseListings(gc.wikitext));
      }
    }
  }

  destinations = dedupe(destinations);

  // Re-key ids + order after merging so they are globally unique.
  destinations = destinations.map((d, i) => ({
    ...d,
    order: i,
    id: `${d.wvType}-${i}-${d.name.slice(0, 20)}`.replace(/\s+/g, '_'),
  }));

  const ranked = rankDestinations(destinations);
  let { center, bbox } = computeExtent(ranked);

  // Fall back to geocoding when the guide lacks coordinates (e.g. thin articles).
  if (!bbox) {
    const geo = await geocode(title);
    if (geo) {
      center = [geo.lon, geo.lat];
      bbox = geo.bbox;
    }
  }

  return {
    title,
    intro: cleanText(intro),
    advice: buildAdvice(sections),
    destinations: ranked,
    center,
    bbox,
    related: extractRelated(sections),
    parent: extractParent(wikitext),
    attribution: 'Travel content from Wikivoyage, CC BY-SA 3.0',
    sourceUrl: `https://en.wikivoyage.org/wiki/${encodeURIComponent(title)}`,
  };
}
