// Geocoding via OpenStreetMap Nominatim (free, CORS-enabled, worldwide).
// Used as a fallback for map framing when a guide has few/no coordinates.

// Nominatim requires an identifying User-Agent. Browsers set their own and ignore
// this header; Node (server-side / scripts) needs it or requests are rejected.
const GEO_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'PocketPlanet/1.0 (travel guide app)',
};

export interface GeoResult {
  lat: number;
  lon: number;
  displayName: string;
  bbox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

export interface ReverseResult {
  /** Best place name for the current zoom scope (city / region / country). */
  name: string;
  scope: 'city' | 'region' | 'country';
}

function nominatimZoom(mapZoom: number): number {
  if (mapZoom < 4) return 3; // country
  if (mapZoom < 6) return 5; // state
  if (mapZoom < 9) return 8; // county / region
  if (mapZoom < 12) return 10; // city
  return 13; // suburb
}

/**
 * Reverse-geocode the map center into a place name whose *scope follows the zoom*:
 * zoomed out → a country, mid → a region, zoomed in → a city/town. This is what
 * lets you roam the whole world and have the right guide load for wherever you are.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
  mapZoom: number,
  lang = 'en',
): Promise<ReverseResult | null> {
  const nz = nominatimZoom(mapZoom);
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1' +
    `&lat=${lat}&lon=${lon}&zoom=${nz}&accept-language=${encodeURIComponent(lang)}`;
  try {
    const res = await fetch(url, { headers: GEO_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      address?: Record<string, string>;
      name?: string;
    };
    const a = data.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb;
    const region = a.state ?? a.region ?? a.province ?? a.county;
    const country = a.country;

    if (nz <= 3 && country) return { name: country, scope: 'country' };
    if (nz <= 5) {
      if (region) return { name: region, scope: 'region' };
      if (country) return { name: country, scope: 'country' };
    }
    // City-ish scopes: prefer the most specific inhabited place.
    if (city) return { name: city, scope: 'city' };
    if (region) return { name: region, scope: 'region' };
    if (country) return { name: country, scope: 'country' };
    return data.name ? { name: data.name, scope: 'city' } : null;
  } catch {
    return null;
  }
}

/** Reverse-geocode to an ISO 3166-1 alpha-2 country code (lowercase), e.g. "jp". */
export async function reverseCountryCode(lat: number, lon: number): Promise<string | null> {
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=3' +
    `&lat=${lat}&lon=${lon}`;
  try {
    const res = await fetch(url, { headers: GEO_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: { country_code?: string } };
    const cc = data.address?.country_code;
    return cc ? cc.toLowerCase() : null;
  } catch {
    return null;
  }
}

interface NominatimPlace {
  place_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
  addresstype?: string;
  boundingbox?: [string, string, string, string]; // [south, north, west, east]
}

/**
 * Nominatim asks for at most 1 request/second from any one client. The search
 * box can outrun that on its own (debounce + a fallback lookup), so every call
 * queues behind the previous one instead of trusting the UI to behave.
 */
const NOMINATIM_MIN_GAP_MS = 1100;
let nominatimGate: Promise<void> = Promise.resolve();
let lastNominatimAt = 0;

function throttleNominatim(): Promise<void> {
  const turn = nominatimGate.then(async () => {
    const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - lastNominatimAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNominatimAt = Date.now();
  });
  nominatimGate = turn.catch(() => undefined);
  return turn;
}

/** One place to talk to Nominatim's /search, so callers only differ by limit. */
async function nominatimSearch(
  query: string,
  opts: { limit?: number; lang?: string; signal?: AbortSignal } = {},
): Promise<NominatimPlace[]> {
  const { limit = 1, lang, signal } = opts;
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&dedupe=1' +
    `&limit=${limit}&q=${encodeURIComponent(query)}`;
  await throttleNominatim();
  if (signal?.aborted) return [];
  // Ask for names in the UI language. Without this Nominatim answers in the
  // local script — an English user searching "Kyoto Station" got back
  // 京都駅前, 塩小路通… as the label for the place they'd just typed.
  const res = await fetch(url, {
    headers: lang ? { ...GEO_HEADERS, 'Accept-Language': lang } : GEO_HEADERS,
    signal,
  });
  if (!res.ok) return [];
  return (await res.json()) as NominatimPlace[];
}

function bboxFromNominatim(r: NominatimPlace): GeoResult['bbox'] {
  if (!r.boundingbox) return undefined;
  const [south, north, west, east] = r.boundingbox.map(Number);
  return [west, south, east, north];
}

export async function geocode(query: string, lang?: string): Promise<GeoResult | null> {
  try {
    const data = await nominatimSearch(query, { limit: 1, lang });
    if (!data.length) return null;
    const r = data[0];
    return {
      lat: Number(r.lat),
      lon: Number(r.lon),
      displayName: r.display_name,
      bbox: bboxFromNominatim(r),
    };
  } catch {
    return null;
  }
}

/* ---------- Typeahead suggestions ---------- */

export interface PlaceSuggestion {
  id: string;
  /** Primary label, e.g. "Kakunodatemachi". */
  name: string;
  /** Everything after the name, e.g. "Akita Prefecture, Japan". */
  context: string;
  /** OSM feature type used for ranking and the row icon: city, town, island… */
  kind: string;
  lat: number;
  lon: number;
  bbox?: [number, number, number, number];
}

/**
 * A travel guide wants places you can *visit*, so settlements and regions
 * outrank everything else and street/POI results are dropped outright. Without
 * this, "kyo" answers with six restaurants named Kyo before it mentions Kyoto.
 */
const KIND_SCORE: Record<string, number> = {
  country: 100,
  city: 96,
  town: 88,
  municipality: 84,
  island: 80,
  village: 76,
  state: 74,
  province: 74,
  region: 72,
  archipelago: 70,
  borough: 66,
  district: 64,
  county: 60,
  hamlet: 58,
  suburb: 56,
  quarter: 52,
  city_district: 50,
  locality: 46,
  neighbourhood: 42,
  national_park: 54,
  peninsula: 50,
  isle: 60,
  islet: 40,
};

/** Fallback when the specific type is unknown but the feature class is place-ish. */
const CLASS_SCORE: Record<string, number> = {
  place: 40,
  boundary: 58,
  natural: 22,
  tourism: 16,
  historic: 18,
  leisure: 10,
};

/** A suggestion plus the settlement weight it was ranked with. */
interface Scored extends PlaceSuggestion {
  weight: number;
}

function scoreKind(kind: string | undefined, klass: string | undefined): number {
  if (kind && kind in KIND_SCORE) return KIND_SCORE[kind];
  if (klass && klass in CLASS_SCORE) return CLASS_SCORE[klass];
  return 0; // addresses, shops, stations, roads — not destinations
}

/** Casefold + strip accents so "marrakech" and "Marrakech" compare equal. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function textBonus(name: string, query: string): number {
  const n = fold(name);
  const q = fold(query);
  if (!q) return 0;
  if (n === q) return 34;
  if (n.startsWith(q)) return 20;
  if (n.includes(q)) return 8;
  return 0;
}

function joinContext(parts: Array<string | undefined>, name: string): string {
  const seen = new Set([fold(name)]);
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const key = fold(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(', ');
}

// Photon only ships name translations for these; anything else 400s or comes
// back in the local script anyway, so we ask for the raw names instead.
const PHOTON_LANGS = new Set(['de', 'en', 'fr', 'it']);

// Drop Photon's "house" and "street" layers: a travel guide never wants a house
// number, and excluding them server-side leaves room for real destinations.
const PHOTON_LAYERS = ['city', 'district', 'locality', 'county', 'state', 'country'];

interface PhotonFeature {
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    extent?: [number, number, number, number]; // [west, north, east, south]
  };
  geometry?: { coordinates?: [number, number] }; // [lon, lat]
}

async function photonSuggest(
  query: string,
  lang: string,
  signal?: AbortSignal,
): Promise<Scored[]> {
  const layers = PHOTON_LAYERS.map((l) => `&layer=${l}`).join('');
  const url =
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=12` +
    (PHOTON_LANGS.has(lang) ? `&lang=${lang}` : '') +
    layers;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const out: Scored[] = [];
  for (const f of data.features ?? []) {
    const p = f.properties;
    const name = p.name;
    const coords = f.geometry?.coordinates;
    if (!name || !coords) continue;
    const kind = p.osm_value ?? p.type ?? '';
    const weight = scoreKind(kind, p.osm_key);
    if (weight <= 0) continue;
    let bbox: PlaceSuggestion['bbox'];
    if (p.extent) {
      const [west, north, east, south] = p.extent;
      bbox = [west, south, east, north];
    }
    out.push({
      id: `photon:${p.osm_type ?? ''}${p.osm_id ?? out.length}`,
      name,
      context: joinContext([p.district, p.city, p.county, p.state, p.country], name),
      kind,
      weight,
      lon: coords[0],
      lat: coords[1],
      bbox,
    });
  }
  return out;
}

function nominatimSuggest(rows: NominatimPlace[]): Scored[] {
  const out: Scored[] = [];
  for (const r of rows) {
    const kind = r.addresstype ?? r.type ?? '';
    const weight = scoreKind(kind, r.category);
    if (weight <= 0) continue;
    const segments = r.display_name.split(',').map((s) => s.trim());
    const name = r.name || segments[0];
    // Postcodes read as noise in a destination list; the country carries the meaning.
    const context = segments
      .slice(fold(segments[0]) === fold(name) ? 1 : 0)
      .filter((s) => !/^[\d\s-]+$/.test(s))
      .join(', ');
    out.push({
      id: `osm:${r.place_id ?? out.length}`,
      name,
      context,
      kind,
      weight,
      lat: Number(r.lat),
      lon: Number(r.lon),
      bbox: bboxFromNominatim(r),
    });
  }
  return out;
}

function rank(items: Scored[], query: string, max: number): PlaceSuggestion[] {
  const best = new Map<string, { item: Scored; score: number }>();
  items.forEach((item, i) => {
    // Sources return the same town as both a node and an admin boundary; keying
    // on name+context collapses those while keeping the Queenstown in Tasmania
    // distinct from the one in Otago.
    const key = `${fold(item.name)}|${fold(item.context)}`;
    const score = item.weight + textBonus(item.name, query) - i * 0.5; // upstream order breaks ties
    const prev = best.get(key);
    if (!prev || score > prev.score) best.set(key, { item, score });
  });
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((e) => e.item);
}

const suggestCache = new Map<string, PlaceSuggestion[]>();

/**
 * Typeahead lookup for the search box. Photon indexes the same OSM data as
 * Nominatim but matches on prefixes and tolerates typos, which is what makes
 * results appear while you are still typing ("kyo" → Kyoto, "marakesh" →
 * Marrakesh); plain Nominatim needs a complete, correctly spelled name. When it
 * is unreachable we fall back to Nominatim so the box still answers.
 */
export async function suggestPlaces(
  query: string,
  opts: { lang?: string; signal?: AbortSignal; limit?: number } = {},
): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  const { lang = 'en', signal, limit = 7 } = opts;
  if (q.length < 2) return [];

  const cacheKey = `${lang}:${fold(q)}:${limit}`;
  const cached = suggestCache.get(cacheKey);
  if (cached) return cached;

  let results: PlaceSuggestion[] = [];
  try {
    results = rank(await photonSuggest(q, lang, signal), q, limit);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
  }
  if (!results.length) {
    try {
      const rows = await nominatimSearch(q, { limit: 10, lang, signal });
      results = rank(nominatimSuggest(rows), q, limit);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      return [];
    }
  }

  if (suggestCache.size > 120) suggestCache.clear();
  suggestCache.set(cacheKey, results);
  return results;
}
