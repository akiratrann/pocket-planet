// Multilingual POI discovery — "study the web in every language".
//
// English Wikivoyage is thin for most of the world (a nature reserve in Vietnam
// might have 2 listings). The real, dense data lives in the LOCAL-language
// Wikipedia. This module discovers georeferenced places around a guide by
// running `list=geosearch` against each relevant language edition of Wikipedia,
// then classifies + filters the hits using Wikidata `instance of` (P31) plus
// language-aware heuristics so we keep genuine attractions (waterfalls, caves,
// temples) and drop administrative units (communes, districts) and infrastructure.
//
// Everything here is grounded in real articles — nothing is invented.

import type { CategoryId, Destination, Guide } from '../../src/types.ts';

const UA = 'PocketPlanet/1.0 (https://github.com/akiratrann/pocket-planet)';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

// ---------------------------------------------------------------------------
// Low-level fetch with polite retry/backoff (Wikimedia throttles hard batches).
// ---------------------------------------------------------------------------
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

function wpUrl(lang: string, params: Record<string, string>): string {
  return (
    `https://${lang}.wikipedia.org/w/api.php?` +
    new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params }).toString()
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------
// Wikipedia: geosearch + article details.
// ---------------------------------------------------------------------------
interface GeoHit {
  title: string;
  lat: number;
  lon: number;
}

interface GeoSearchResp {
  query?: { geosearch?: Array<{ title: string; lat: number; lon: number }> };
}

async function geosearch(lang: string, lat: number, lon: number, radius: number, limit: number): Promise<GeoHit[]> {
  const data = await getJson<GeoSearchResp>(
    wpUrl(lang, {
      action: 'query',
      list: 'geosearch',
      gscoord: `${lat}|${lon}`,
      gsradius: String(radius),
      gslimit: String(limit),
    }),
  );
  return (data?.query?.geosearch ?? []).map((x) => ({ title: x.title, lat: x.lat, lon: x.lon }));
}

interface DetailResp {
  query?: {
    pages?: Array<{ title: string; extract?: string; pageprops?: { wikibase_item?: string } }>;
  };
}

/** First few sentences + Wikidata id for each title (batched). */
async function details(lang: string, titles: string[]): Promise<Map<string, { extract: string; qid?: string }>> {
  const out = new Map<string, { extract: string; qid?: string }>();
  for (const part of chunk(titles, 45)) {
    const data = await getJson<DetailResp>(
      wpUrl(lang, {
        action: 'query',
        prop: 'extracts|pageprops',
        exintro: '1',
        explaintext: '1',
        exsentences: '3',
        ppprop: 'wikibase_item',
        titles: part.join('|'),
      }),
    );
    for (const p of data?.query?.pages ?? []) {
      out.set(p.title, { extract: (p.extract ?? '').trim(), qid: p.pageprops?.wikibase_item });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikidata: instance-of (P31) classes + English label (batched).
// ---------------------------------------------------------------------------
interface WdResp {
  entities?: Record<
    string,
    {
      labels?: { en?: { value?: string } };
      claims?: { P31?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> };
    }
  >;
}

async function wikidataInfo(qids: string[]): Promise<Map<string, { p31: string[]; labelEn?: string }>> {
  const out = new Map<string, { p31: string[]; labelEn?: string }>();
  for (const part of chunk(qids, 45)) {
    const data = await getJson<WdResp>(
      `${WIKIDATA}?` +
        new URLSearchParams({
          action: 'wbgetentities',
          ids: part.join('|'),
          props: 'claims|labels',
          languages: 'en',
          format: 'json',
          formatversion: '2',
          origin: '*',
        }).toString(),
    );
    for (const [qid, ent] of Object.entries(data?.entities ?? {})) {
      const p31 = (ent.claims?.P31 ?? [])
        .map((c) => c.mainsnak?.datavalue?.value?.id)
        .filter((x): x is string => Boolean(x));
      out.set(qid, { p31, labelEn: ent.labels?.en?.value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification + filtering.
// ---------------------------------------------------------------------------

// Wikidata classes that are never travel POIs on their own → drop.
const SKIP_P31 = new Set<string>([
  'Q2389082', // commune of Vietnam
  'Q15911738', // hydroelectric power station
  'Q159719', // power station
  'Q12323', // dam
  'Q55488', // railway station
  'Q928830', // metro station
  'Q1248784', // airport / international airport
  'Q205495', // filling (petrol) station
  'Q3257686', // locality (too generic / admin)
  // Civic buildings a traveller never visits. Geosearch surfaces these in force
  // in dense local-language editions (a town of 12k has articles for every
  // school), and they are the worst offenders for untranslatable names: a
  // municipal junior high school has no label or article in any other language,
  // so it can never be presented in the reader's language.
  'Q3914', // school
  'Q9842', // primary school
  'Q149566', // middle school
  'Q159334', // secondary school
  'Q5358913', // elementary school in Japan
  'Q55521176', // lower secondary school in Japan
  'Q43271061', // school for special needs education in Japan
  'Q11396122', // school annex
  'Q16917', // hospital
  'Q4260475', // medical facility
  'Q861951', // police station
  'Q35054', // post office
  'Q1195942', // fire station
  // A municipal ball field is civic sports infrastructure, not a sight: nobody
  // travels to it, and like the schools above it exists in exactly one language,
  // so it is guaranteed to reach the reader as an untranslatable wall of text.
  // (Stadiums people DO visit — Koshien, the Olympic venues — are tagged as
  // stadium/arena classes, not as this plain municipal venue class.)
  'Q595452', // baseball venue
  // Abolished administrative units. ADMIN_RE drops these when the article says
  // "is a village"; a dissolved one says "WAS a village", so it needs the class.
  'Q18663566', // dissolved municipality of Japan
]);

// Wikidata class → our category (language-agnostic, so it works in any edition).
const P31_CATEGORY: Record<string, CategoryId> = {
  // Nature & outdoors
  Q179049: 'nature', // nature reserve
  Q473972: 'nature', // protected area
  Q46169: 'nature', // *national park is often tagged differently; kept broad below via keywords
  Q34038: 'nature', // waterfall
  Q35509: 'nature', // cave
  Q8502: 'nature', // mountain
  Q54050: 'nature', // hill
  Q46831: 'nature', // mountain range
  Q23397: 'nature', // lake
  Q4022: 'nature', // river
  Q40080: 'nature', // beach
  Q22698: 'nature', // park
  Q22746: 'nature', // urban park
  Q1107656: 'nature', // garden
  Q4421: 'nature', // forest
  Q39816: 'nature', // valley
  Q23442: 'nature', // island
  Q124714: 'nature', // hot spring
  // Museums & culture
  Q33506: 'culture', // museum
  Q207694: 'culture', // art museum
  Q16970: 'culture', // church building
  Q2977: 'culture', // cathedral
  Q32815: 'culture', // mosque
  Q44539: 'culture', // temple
  Q133215: 'culture', // Buddhist temple
  Q44613: 'culture', // monastery
  Q23413: 'culture', // castle
  Q16560: 'culture', // palace
  Q839954: 'culture', // archaeological site
  Q24354: 'culture', // theater
  Q57821: 'culture', // fortification
  // Shopping
  Q132510: 'shopping', // market
  Q330284: 'shopping', // marketplace
  Q11315: 'shopping', // shopping mall
  // Food / nightlife
  Q11707: 'food', // restaurant
  Q30022: 'nightlife', // café
  // Sights (landmarks / monuments)
  Q4989906: 'sights', // monument
  Q2319498: 'sights', // landmark
  Q570116: 'sights', // tourist attraction
};

// Keyword fallback (multilingual) when Wikidata has no useful class.
// NOTE: JavaScript's \b is ASCII-only, so it must NOT be placed around accented /
// non-Latin tokens (e.g. \bnúi\b never matches). Latin-only words may keep \b.
const KEYWORDS: Array<[RegExp, CategoryId]> = [
  [/waterfall|thác|滝|cascada|cascade|wasserfall|cachoeira|водопад|น้ำตก/iu, 'nature'],
  [/\bcaves?\b|hang |động|grotto|grotte|höhle|cueva|洞窟|ถ้ำ/iu, 'nature'],
  [/mountain|\bmount\b|\bpeak\b|núi|đỉnh|montaña|montagne|\bberg\b|山|гора|ภูเขา/iu, 'nature'],
  [/national park|nature reserve|khu bảo tồn|vườn quốc gia|reserva natural|réserve naturelle|nationalpark|공원|公園|อุทยาน/iu, 'nature'],
  [/\blake\b|hồ |sông|\blago\b|\blac\b|\briver\b|湖|озеро|ทะเลสาบ/iu, 'nature'],
  [/beach|bãi biển|playa|plage|strand|海岸|해변|ชายหาด/iu, 'nature'],
  [/museum|bảo tàng|museo|musée|博物館|박물관|музей|พิพิธภัณฑ์/iu, 'culture'],
  [/temple|pagoda|chùa|đền|shrine|寺|神社|사원|templo|วัด/iu, 'culture'],
  [/church|cathedral|nhà thờ|iglesia|église|kirche|教会|성당|โบสถ์/iu, 'culture'],
  [/mosque|thánh đường hồi giáo|mezquita|mosquée|モスク|มัสยิด/iu, 'culture'],
  [/castle|citadel|fortress|thành cổ|lâu đài|castillo|château|schloss|城|성/iu, 'culture'],
  [/market|chợ |mercado|marché|markt|市場|ตลาด/iu, 'shopping'],
  [/palace|cung điện|palacio|palais|宮|궁/iu, 'sights'],
];

// Language-aware "this is an administrative unit" detector, run on the article's
// first sentence. We deliberately keep village/hamlet (rural destinations) but
// drop communes/wards/districts/provinces/cities that are just admin geography.
const ADMIN_RE: Record<string, RegExp> = {
  en: /\bis (?:a|an|the)\b[^.]*\b(commune|ward|district|province|prefecture|county|municipality|sub-?district|arrondissement|canton|region|state|department|administrative (?:unit|division|region|entity|area)|borough|township|rural district|urban district|metropolitan area)\b/i,
  // Vietnamese admin phrasing. No \b (ASCII-only) around accented terms; bound
  // with whitespace/punctuation instead so "là một xã" is reliably detected.
  vi: /(?:^|[\s(])là (?:một |thành phố |)?(?:xã|phường|thị trấn|thị xã|huyện|thành phố|tỉnh|quận|đặc khu|đơn vị hành chính)(?=[\s.,;)]|$)/i,
  es: /\bes (?:un|una|el|la)\b[^.]*\b(municipio|provincia|distrito|comuna|departamento|región|ciudad|localidad|barrio|entidad|cantón)\b/i,
  fr: /\best une?\b[^.]*\b(commune|ville|région|département|arrondissement|canton|quartier|préfecture|municipalité)\b/i,
  de: /\bist eine?\b[^.]*\b(Gemeinde|Stadt|Landkreis|Bezirk|Ortsteil|Region|Provinz|Kanton|Verwaltungs)\b/i,
  pt: /\bé uma?\b[^.]*\b(município|cidade|distrito|freguesia|região|bairro|comuna|departamento)\b/i,
  it: /\bè un(?:a| )\b[^.]*\b(comune|città|frazione|provincia|regione|quartiere|circoscrizione)\b/i,
  zh: /是.{0,12}?(市|区|區|縣|县|镇|鎮|乡|鄉|村|省|自治区|行政区)/,
  ru: /(город|село|посёлок|деревня|район|область|муниципалитет|край|округ)/i,
  // Japanese articles about abolished units use the past tense ("…にあった村" —
  // "was a village in…"), which the present-tense form alone never matched.
  ja: /(市|区|町|村|郡|都道府県|県|府)(?:である|であった|だった)|にあった(?:村|町|市|区|郡)/,
};

function isAdminUnit(extract: string, lang: string): boolean {
  if (!extract) return false;
  const re = ADMIN_RE[lang];
  if (re && re.test(extract)) return true;
  // Always also check English (some local articles include an English gloss).
  return ADMIN_RE.en.test(extract);
}

/** Returns a category, or null if the hit should be dropped. */
function classify(p31: string[], name: string, extract: string): CategoryId | null {
  for (const id of p31) if (SKIP_P31.has(id)) return null;
  for (const id of p31) if (P31_CATEGORY[id]) return P31_CATEGORY[id];
  const text = `${name} ${extract}`;
  for (const [re, cat] of KEYWORDS) if (re.test(text)) return cat;
  return 'sights'; // grounded, georeferenced place with no clear type → a sight
}

// ---------------------------------------------------------------------------
// OpenStreetMap (Overpass) — dense, multilingual POI coverage for exactly the
// rural/nature places Wikipedia is thin on (viewpoints, waterfalls, homestays,
// markets…). Names come localized (name) plus name:en when available.
// ---------------------------------------------------------------------------
const OVERPASS = 'https://overpass-api.de/api/interpreter';

interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function osmCategory(t: Record<string, string>): CategoryId | null {
  const { tourism, natural, historic, leisure, amenity, shop, waterway, place } = t;
  if (waterway === 'waterfall' || natural === 'waterfall') return 'nature';
  if (natural) return 'nature'; // peak / spring / beach / cave_entrance / cliff / valley
  if (place && /village|hamlet/.test(place)) return 'nature'; // rural villages ARE the destination
  if (leisure && /park|nature_reserve|garden/.test(leisure)) return 'nature';
  if (tourism === 'viewpoint' || tourism === 'zoo' || tourism === 'aquarium' || tourism === 'picnic_site')
    return 'nature';
  if (tourism === 'museum' || tourism === 'gallery' || tourism === 'artwork') return 'culture';
  if (tourism === 'theme_park' || tourism === 'trail_riding') return 'activities';
  if (historic) return /castle|fort|ruins|monument|memorial|archaeolog|temple|monastery|shrine/.test(historic) ? 'culture' : 'sights';
  // Places to stay — homestays/guesthouses are the backbone of rural travel.
  if (tourism && /hotel|guest_house|hostel|chalet|apartment|motel|resort|camp_site|caravan_site|alpine_hut|homestay/.test(tourism))
    return 'sleep';
  if (amenity === 'marketplace' || shop) return 'shopping';
  if (amenity === 'restaurant' || amenity === 'cafe' || amenity === 'fast_food' || amenity === 'food_court')
    return 'food';
  if (amenity === 'bar' || amenity === 'pub' || amenity === 'nightclub') return 'nightlife';
  if (tourism === 'attraction') return 'sights';
  return null;
}

// Multiple mirrors — the main instance 504s under load, so we fail over.
const OVERPASS_ENDPOINTS = [
  OVERPASS,
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// OSM names too generic to be a useful place card on their own (folded form).
const GENERIC_OSM = new Set([
  'homestay', 'hotel', 'guesthouse', 'nhanghi', 'nahnghi', 'motel', 'hostel', 'resort',
  'viewpoint', 'attraction', 'restaurant', 'cafe', 'bar', 'pub', 'camping', 'bungalow',
  'villa', 'lodge', 'ecolodge', 'homestaynhanghi', 'wc', 'toilets', 'parking',
]);

async function overpassQuery(q: string): Promise<OverpassEl[]> {
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { elements?: OverpassEl[] };
        if (data.elements?.length) return data.elements;
      }
    } catch {
      /* try the next mirror */
    }
  }
  return [];
}

interface WdSitelinks {
  entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }>;
}

/**
 * Wikidata ids for articles of one Wikipedia edition, keyed by article title.
 * Asking Wikidata (rather than the edition's own pageprops) both resolves the
 * title and hands back the id in a single batched call per language.
 */
async function qidsForArticles(lang: string, titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Guards the `sites`/`sitefilter` interpolation: editions are plain codes.
  if (!/^[a-z]{2,3}$/.test(lang) || !titles.length) return out;
  const site = `${lang}wiki`;
  for (const part of chunk(titles, 45)) {
    const data = await getJson<WdSitelinks>(
      `${WIKIDATA}?` +
        new URLSearchParams({
          action: 'wbgetentities',
          sites: site,
          titles: part.join('|'),
          props: 'sitelinks',
          sitefilter: site,
          format: 'json',
          formatversion: '2',
          origin: '*',
        }).toString(),
    );
    for (const [qid, ent] of Object.entries(data?.entities ?? {})) {
      // Titles Wikidata knows nothing about come back as a "-1" pseudo-entity.
      if (!/^Q\d+$/.test(qid)) continue;
      const title = ent.sitelinks?.[site]?.title;
      if (title) out.set(title, qid);
    }
  }
  return out;
}

/**
 * Give OSM POIs a Wikidata id from their `wikipedia` tag ("ja:抱返神社").
 *
 * Localization is keyed entirely off the Wikidata id — that is what carries a
 * place's name and article into the reader's language. A POI mapped with only a
 * `wikipedia` tag (common: mappers add the article link long before anyone adds
 * the `wikidata` one) was reaching the reader stuck in whatever language it was
 * mapped in, even though the link to fix that was sitting in its tags. Costs one
 * batched request per language, and only when such a POI actually exists.
 */
async function linkOsmToWikidata(pending: Array<[Destination, string]>): Promise<void> {
  const byLang = new Map<string, Map<string, Destination[]>>();
  for (const [dest, tag] of pending) {
    const m = /^\s*([a-z]{2,3})\s*:\s*(.+?)\s*$/.exec(tag);
    if (!m) continue;
    const [, lang, raw] = m;
    const title = raw.replace(/_/g, ' '); // MediaWiki treats "_" as a space
    const titles = byLang.get(lang) ?? new Map<string, Destination[]>();
    byLang.set(lang, titles);
    const group = titles.get(title) ?? [];
    group.push(dest);
    titles.set(title, group);
  }
  for (const [lang, titles] of byLang) {
    const qids = await qidsForArticles(lang, [...titles.keys()]);
    for (const [title, group] of titles) {
      const qid = qids.get(title);
      if (qid) for (const d of group) d.wikidata ??= qid;
    }
  }
}

async function fetchOverpass(lat: number, lon: number, radius: number): Promise<Destination[]> {
  const wide = `(around:${radius},${lat},${lon})`;
  // Food/nightlife explode element counts in any town, which 504s the whole
  // query — bound them to a tighter radius so the request stays fast + reliable.
  const near = `(around:${Math.min(radius, 7000)},${lat},${lon})`;
  const q =
    `[out:json][timeout:30];(` +
    `node["tourism"~"attraction|viewpoint|museum|zoo|aquarium|artwork|gallery|theme_park|picnic_site"]${wide};` +
    `way["tourism"~"attraction|viewpoint|museum|theme_park"]${wide};` +
    `node["tourism"~"hotel|guest_house|hostel|chalet|apartment|motel|resort|camp_site|alpine_hut"]${wide};` +
    `node["natural"~"waterfall|peak|cave_entrance|spring|beach|cliff|arch|hot_spring"]${wide};` +
    `node["waterway"="waterfall"]${wide};` +
    `node["historic"]${wide};way["historic"]${wide};` +
    `node["leisure"~"park|nature_reserve|garden"]${wide};` +
    `node["amenity"="marketplace"]${wide};` +
    `node["amenity"~"restaurant|cafe|bar|pub"]${near};` +
    `);out center tags 250;`;
  const elements = await overpassQuery(q);
  const out: Destination[] = [];
  // POIs carrying a `wikipedia` tag but no `wikidata` one, resolved in one batch
  // below so each still has a route into the reader's language.
  const pendingWikipedia: Array<[Destination, string]> = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    // `name:en` is the display default, not a claim that English is special:
    // it is by far the best-populated non-local name tag in OSM, and anything
    // that ends up with a Wikidata id is relabelled into the ACTUAL reader's
    // language afterwards by localizeNames — which is why the tag resolution
    // below matters more than which fallback name we start from.
    const raw = t['name:en'] || t.name;
    if (!raw) continue;
    // OSM names are free-form; title-case ones that are entirely lowercase.
    const name = raw === raw.toLowerCase() ? raw.replace(/\b[a-z]/g, (m) => m.toUpperCase()) : raw;
    if (name.trim().length < 3 || GENERIC_OSM.has(localFold(name))) continue;
    const cat = osmCategory(t);
    if (!cat) continue;
    const plat = el.lat ?? el.center?.lat;
    const plon = el.lon ?? el.center?.lon;
    if (plat == null || plon == null) continue;
    // Let keyword cues refine a generic "attraction" (e.g. an attraction named
    // "…Waterfall" is nature).
    let category = cat;
    if (cat === 'sights') {
      for (const [re, kc] of KEYWORDS) if (re.test(name)) { category = kc; break; }
    }
    const dest: Destination = {
      id: `osm-${el.type}-${el.id}`,
      name,
      category,
      wvType: category === 'nature' ? 'do' : 'see',
      lat: plat,
      lon: plon,
      description: t.description || t['description:en'] || undefined,
      url: t.website || t['contact:website'] || undefined,
      wikidata: t.wikidata || undefined,
      score: 0,
      rank: 0,
      order: 0,
      reasons: ['Discovered via OpenStreetMap'],
    };
    if (!dest.wikidata && t.wikipedia) pendingWikipedia.push([dest, t.wikipedia]);
    out.push(dest);
  }
  await linkOsmToWikidata(pendingWikipedia);
  return out;
}

// ---------------------------------------------------------------------------
// Provenance.
//
// A discovered POI's text is written in the language of the Wikipedia edition it
// came from, which is usually NOT the language the reader asked for. The id
// carries that language so the localization pass can tell "this description is
// already in the reader's language" from "this description happens to share a
// script with it" (Vietnamese prose in an English guide looks Latin either way).
// ---------------------------------------------------------------------------
function discoveredId(lang: string, title: string): string {
  return `disc-${lang}-${title}`.replace(/\s+/g, '_').slice(0, 60);
}

/** Wikipedia language a discovered POI's name/description came from, if known. */
export function sourceLangOf(id: string): string | null {
  return /^disc-([a-z]{2,3})-/.exec(id)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
const RADIUS_M = 10000; // geosearch hard cap
const MAX_SEEDS = 12;
const MAX_PER_LANG = 80;
const MAX_RESULTS = 90;

/**
 * Discover extra POIs around a guide from local-language Wikipedia (+ English).
 * Seeds geosearch from the guide center and its existing POIs, so we cover a
 * spread-out area (e.g. a nature reserve) rather than a single point.
 */
export async function discoverPOIs(guide: Guide, langs: string[]): Promise<Destination[]> {
  const searchLangs = [...new Set([...langs, 'en'])];

  const seeds: Array<[number, number]> = [];
  const [clon, clat] = guide.center;
  if (Number.isFinite(clat) && Number.isFinite(clon)) seeds.push([clat, clon]);
  for (const d of guide.destinations) {
    if (d.lat != null && d.lon != null) seeds.push([d.lat, d.lon]);
    if (seeds.length >= MAX_SEEDS) break;
  }
  if (!seeds.length) return [];

  // 1) Gather unique georeferenced titles per language.
  const perLang = new Map<string, Map<string, GeoHit>>();
  for (const lang of searchLangs) {
    const m = new Map<string, GeoHit>();
    for (const [lat, lon] of seeds) {
      for (const h of await geosearch(lang, lat, lon, RADIUS_M, 20)) {
        if (!m.has(h.title)) m.set(h.title, h);
      }
      if (m.size >= MAX_PER_LANG) break;
    }
    if (m.size) perLang.set(lang, m);
  }

  // 2) Fetch article details (extract + Wikidata id), collect all QIDs.
  const langItems: Array<{ lang: string; items: Array<GeoHit & { extract: string; qid?: string }> }> = [];
  const allQids = new Set<string>();
  for (const [lang, m] of perLang) {
    const det = await details(lang, [...m.keys()]);
    const items = [...m.values()].map((h) => ({
      ...h,
      extract: det.get(h.title)?.extract ?? '',
      qid: det.get(h.title)?.qid,
    }));
    for (const it of items) if (it.qid) allQids.add(it.qid);
    langItems.push({ lang, items });
  }

  // 3) Resolve Wikidata classes once for everything.
  const wd = await wikidataInfo([...allQids]);

  // 4) Build destinations, filtering admin/infra and de-duping by Wikidata id.
  const results: Destination[] = [];
  const seenQid = new Set<string>();
  for (const { lang, items } of langItems) {
    for (const it of items) {
      if (it.qid && seenQid.has(it.qid)) continue;
      const info = it.qid ? wd.get(it.qid) : undefined;
      const p31 = info?.p31 ?? [];
      if (p31.some((id) => SKIP_P31.has(id))) continue;
      if (isAdminUnit(it.extract, lang)) continue;
      const name = info?.labelEn && /[A-Za-z]/.test(info.labelEn) ? info.labelEn : it.title;
      const cat = classify(p31, name, it.extract);
      if (!cat) continue;
      if (it.qid) seenQid.add(it.qid);
      results.push({
        id: discoveredId(lang, it.title),
        name,
        category: cat,
        wvType: cat === 'nature' ? 'do' : 'see',
        lat: it.lat,
        lon: it.lon,
        description: it.extract || undefined,
        wikidata: it.qid,
        score: 0,
        rank: 0,
        order: results.length,
        reasons: ['Discovered via local-language Wikipedia'],
      });
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length >= MAX_RESULTS) break;
  }

  // 5) Add OpenStreetMap POIs (best-effort), de-duped against the Wikipedia hits.
  const osm = await fetchOverpass(clat, clon, 18000);
  for (const o of osm) {
    if (results.length >= MAX_RESULTS) break;
    const of = localFold(o.name);
    const dup = results.some((r) => {
      if (o.wikidata && r.wikidata === o.wikidata) return true;
      const rf = localFold(r.name);
      if (rf === of) return true;
      // Same place written differently ("Hieu Waterfall" vs "Hieu Waterfall
      // (Thac Hieu)"): one folded name contains the other, and they're close by.
      const close =
        r.lat != null && r.lon != null && o.lat != null && o.lon != null &&
        haversineKm(r.lat, r.lon, o.lat, o.lon) < 1.2;
      if (close && rf.length >= 6 && of.length >= 6 && (rf.includes(of) || of.includes(rf))) return true;
      // Very co-located points are the same POI regardless of name.
      return (
        r.lat != null && r.lon != null && o.lat != null && o.lon != null &&
        haversineKm(r.lat, r.lon, o.lat, o.lon) < 0.15
      );
    });
    if (!dup) results.push(o);
  }

  return results;
}

function localFold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
