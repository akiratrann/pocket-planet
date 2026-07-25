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
): Promise<ReverseResult | null> {
  const nz = nominatimZoom(mapZoom);
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1' +
    `&lat=${lat}&lon=${lon}&zoom=${nz}`;
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

export async function geocode(query: string): Promise<GeoResult | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: GEO_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      boundingbox?: [string, string, string, string]; // [south, north, west, east]
    }>;
    if (!data.length) return null;
    const r = data[0];
    let bbox: GeoResult['bbox'];
    if (r.boundingbox) {
      const [south, north, west, east] = r.boundingbox.map(Number);
      bbox = [west, south, east, north];
    }
    return {
      lat: Number(r.lat),
      lon: Number(r.lon),
      displayName: r.display_name,
      bbox,
    };
  } catch {
    return null;
  }
}
