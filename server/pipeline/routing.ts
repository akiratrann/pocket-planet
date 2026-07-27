// Point-to-point routing for the "Getting around" directions.
//
// Uses the public Valhalla instance run by FOSSGIS — free, no API key, OSM-based
// (same data the rest of this app is built on).
//
// NOT OSRM: the public OSRM demo server ignores the profile in the URL and
// serves car routing for every mode. Its /foot and /driving endpoints return
// byte-identical durations, so a 4km walk reports as ~9 minutes instead of ~48.
// Valhalla returns genuinely different results per costing model.
//
// Public transit is deliberately absent — Valhalla needs GTFS feeds we don't
// host, and there is no free global transit routing API. The client deep-links
// transit to Google Maps instead; see travel-links.ts.

export type TravelMode = 'walking' | 'cycling' | 'driving';

const COSTING: Record<TravelMode, string> = {
  walking: 'pedestrian',
  cycling: 'bicycle',
  driving: 'auto',
};

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface RouteResult {
  mode: TravelMode;
  distanceKm: number;
  durationSec: number;
  /** Route line as [lon, lat] pairs, ready for a GeoJSON LineString. */
  geometry: Array<[number, number]>;
  /** Turn-by-turn text, when the router provides it. */
  steps: string[];
}

/**
 * Decode Valhalla's encoded polyline. Note the precision: Valhalla uses 6
 * decimal places (1e6), where Google's original format uses 5. Decoding with
 * the wrong precision silently yields coordinates off by 10x — a route that
 * lands in the ocean rather than an obvious error.
 */
function decodePolyline6(encoded: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

export async function routeBetween(
  from: RoutePoint,
  to: RoutePoint,
  mode: TravelMode,
): Promise<RouteResult | null> {
  const body = {
    locations: [
      { lat: from.lat, lon: from.lon },
      { lat: to.lat, lon: to.lon },
    ],
    costing: COSTING[mode] ?? 'pedestrian',
    directions_options: { units: 'kilometers' },
  };

  let data: {
    trip?: {
      summary?: { time?: number; length?: number };
      legs?: Array<{ shape?: string; maneuvers?: Array<{ instruction?: string }> }>;
    };
  };

  try {
    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    // Routing is a nice-to-have: a failure returns null and the UI degrades to
    // the straight-line distance rather than breaking the panel.
    return null;
  }

  const trip = data.trip;
  const leg = trip?.legs?.[0];
  if (!trip?.summary || !leg?.shape) return null;

  return {
    mode,
    distanceKm: Number(trip.summary.length ?? 0),
    durationSec: Math.round(Number(trip.summary.time ?? 0)),
    geometry: decodePolyline6(leg.shape),
    steps: (leg.maneuvers ?? [])
      .map((m) => (m.instruction ?? '').trim())
      .filter(Boolean)
      .slice(0, 40),
  };
}

/** Great-circle distance in km — the fallback when routing is unavailable. */
export function haversineKm(a: RoutePoint, b: RoutePoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
