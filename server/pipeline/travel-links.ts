// Intercity travel options — "how do I actually get to this city?"
//
// Every provider here is a DEEP LINK: we hand the user off to a real booking
// site with the route and date prefilled. Nothing is scraped and no prices are
// invented, so what the user sees when they click is real, current inventory.
//
// Why not live API inventory: flight APIs (Amadeus, Duffel, Kiwi) need paid or
// approval-gated keys, and their free test tiers return cached sample data that
// would be wrong to show as bookable. Rail is worse — there is no global train
// API; coverage is per-operator and mostly closed.
//
// The provider interface below is the seam for that upgrade. To add live
// inventory later, implement a provider whose build() calls an API and returns
// TravelOptions carrying real prices — the route, the panel, and the client
// need no changes.

export type TravelKind = 'multi' | 'flight' | 'transit' | 'rail';

export interface TravelQuery {
  /** Where the traveller is starting from, as a place name. */
  from: string;
  /** The destination city — the guide currently being viewed. */
  to: string;
  /** Optional ISO date (YYYY-MM-DD). */
  date?: string;
}

export interface TravelOption {
  id: string;
  kind: TravelKind;
  provider: string;
  label: string;
  description: string;
  url: string;
  /** True when the link carries the actual route/date, false for a plain search page. */
  prefilled: boolean;
  /**
   * A real, priced, bookable departure — present ONLY when a live inventory
   * provider answered. Every provider in this file is a deep link and leaves
   * this undefined, so the UI treats "has offer" as the switch between
   * "we know the actual price/time" and "go and look it up". A future provider
   * fills this in and the client renders it without any further change; see
   * `LiveInventoryProvider` below.
   */
  offer?: TravelOffer;
}

/**
 * What a live-inventory provider has to hand back before the UI may show a
 * price or a departure time as fact rather than as our own estimate. Anything
 * less is not enough: without `fetchedAt` we can't say how fresh it is, without
 * `deepLink` the traveller can't complete the booking, and without `source` we
 * can't attribute the number to whoever is actually quoting it.
 */
export interface TravelOffer {
  /** Scheduled mode this offer is for. */
  mode: ScheduledMode;
  /** Who actually operates it, e.g. "ANA", "SNCF", "FlixBus". */
  operator: string;
  /** Departure/arrival as ISO 8601 *with offset*, so local times are unambiguous. */
  departISO: string;
  arriveISO: string;
  /** Door-to-door duration of this specific departure, seconds. */
  durationSec: number;
  /** Stops/changes; 0 = direct. */
  changes: number;
  /** Total fare. Omitted only when the provider genuinely returns no price. */
  price?: { amount: number; currency: string };
  /** Where the traveller completes the booking. */
  deepLink: string;
  /** When this quote was fetched (epoch ms) — shown so nobody trusts a stale fare. */
  fetchedAt: number;
  /** Attribution for the quote, e.g. "Amadeus", "Duffel". */
  source: string;
}

export interface TravelOptionProvider {
  id: string;
  kind: TravelKind;
  build(q: TravelQuery): TravelOption[] | Promise<TravelOption[]>;
}

/**
 * The seam for real inventory. A provider that returns priced departures is
 * just a `TravelOptionProvider` whose options carry `offer`; drop it into
 * PROVIDERS and both panels render the live rows in place of our estimates —
 * no route change (index.ts passes this array straight through) and no UI
 * rewrite. It needs, at minimum: origin/destination resolution to the
 * provider's own station/airport codes, a date, and a key with production
 * (not sandbox) access — sandbox tiers return canned data that must never be
 * shown as availability.
 */
export type LiveInventoryProvider = TravelOptionProvider;

const enc = (s: string) => encodeURIComponent(s.trim());

/**
 * Rome2Rio — the single most useful link for this question. It compares trains,
 * buses, flights, ferries and driving between two place NAMES (no airport or
 * station codes needed) and hands off to operators for booking.
 */
const rome2rio: TravelOptionProvider = {
  id: 'rome2rio',
  kind: 'multi',
  build: ({ from, to }) => [
    {
      id: 'rome2rio',
      kind: 'multi',
      provider: 'Rome2Rio',
      label: 'Compare all ways to get there',
      description: 'Trains, buses, flights, ferries and driving, side by side with typical prices and durations.',
      url: `https://www.rome2rio.com/s/${enc(from)}/${enc(to)}`,
      prefilled: true,
    },
  ],
};

/** Google Flights accepts a natural-language query, so no IATA codes needed. */
const googleFlights: TravelOptionProvider = {
  id: 'google-flights',
  kind: 'flight',
  build: ({ from, to, date }) => {
    const q = `Flights from ${from} to ${to}${date ? ` on ${date}` : ''}`;
    return [
      {
        id: 'google-flights',
        kind: 'flight',
        provider: 'Google Flights',
        label: 'Search flights',
        description: 'Live fares and schedules across airlines, with booking handoff.',
        url: `https://www.google.com/travel/flights?q=${enc(q)}`,
        prefilled: true,
      },
    ];
  },
};

/**
 * Public transit directions. This is the deliberate stand-in for in-app transit
 * routing: Valhalla has no GTFS feeds and there is no free global transit
 * routing API, so we hand the exact origin/destination to Google Maps, which
 * has real schedules almost everywhere.
 */
const googleTransit: TravelOptionProvider = {
  id: 'google-transit',
  kind: 'transit',
  build: ({ from, to }) => [
    {
      id: 'google-transit',
      kind: 'transit',
      provider: 'Google Maps',
      label: 'Public transit directions',
      description: 'Real bus, metro and rail schedules for this route.',
      url:
        `https://www.google.com/maps/dir/?api=1&origin=${enc(from)}` +
        `&destination=${enc(to)}&travelmode=transit`,
      prefilled: true,
    },
  ],
};

/**
 * Rail booking is regional, so this is an honest search handoff rather than a
 * prefilled itinerary — hence prefilled: false, which the UI labels plainly.
 */
const rail: TravelOptionProvider = {
  id: 'rail',
  kind: 'rail',
  build: ({ from, to }) => [
    {
      id: 'trainline',
      kind: 'rail',
      provider: 'Trainline',
      label: 'Book trains (Europe & UK)',
      description: 'Rail and coach tickets across Europe. Search the route on their site.',
      url: 'https://www.thetrainline.com/',
      prefilled: false,
    },
    {
      id: 'omio',
      kind: 'rail',
      provider: 'Omio',
      label: 'Book trains & buses',
      description: `Multi-country rail and bus booking. Search ${from} to ${to}.`,
      url: 'https://www.omio.com/',
      prefilled: false,
    },
  ],
};

const PROVIDERS: TravelOptionProvider[] = [rome2rio, googleFlights, googleTransit, rail];

export async function getTravelOptions(q: TravelQuery): Promise<TravelOption[]> {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        return await p.build(q);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

/* ==========================================================================
 * Distance model — the part of "how do I get there" we can answer honestly
 * with no API key at all.
 *
 * This section is deliberately pure and dependency-free: the client imports it
 * so that the Travel tab and the Itinerary legs apply ONE set of thresholds and
 * ONE set of speed assumptions. Two copies of this table would eventually
 * disagree, and the traveller would see a leg described differently in two
 * places in the same app.
 *
 * Everything here is an ESTIMATE derived from real coordinates. It is never a
 * fare, a seat, or a timetabled departure — those only ever come from a
 * `TravelOffer` above.
 * ========================================================================== */

/** Modes nobody can route in-app: they run to someone else's timetable. */
export type ScheduledMode = 'transit' | 'train' | 'bus' | 'flight';
/** Modes the in-app router (Valhalla) can actually draw. */
export type RoutedMode = 'walking' | 'cycling' | 'driving';
export type TravelMode = RoutedMode | ScheduledMode;

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Great-circle distance in km. Mirrors `haversineKm` in ./routing.ts rather
 * than importing it, because this module is bundled into the browser and must
 * not drag the routing client (and its fetch/polyline code) along with it.
 */
export function greatCircleKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(rad(a.lat)) * Math.cos(rad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type TravelTier = 'local' | 'regional' | 'long';

/**
 * Tier boundaries, in straight-line km.
 *
 * 30 km is roughly "still the same city or its outskirts" — the range where
 * walking, cycling, a taxi and the local metro are all genuinely on the table.
 * 300 km is about three to four hours by road: past it, driving stops being the
 * obvious answer and flying starts to make sense. Both are round numbers on
 * purpose; there is no sharp physical boundary, and pretending to more
 * precision than that would be false confidence.
 */
export const TIER_MAX_KM: Record<'local' | 'regional', number> = {
  local: 30,
  regional: 300,
};

/**
 * Per-mode reach, in straight-line km. A mode is offered only inside its range,
 * so we never suggest something that cannot actually be done — the "walk from
 * Hoi An to Hanoi" problem.
 *
 *  - walking 8 km  : ~1 hr 40 min on foot; beyond that it is a hike, not a leg.
 *  - cycling 30 km : ~2 hr on a bike, the usual limit of a day-hire.
 *  - driving 1200 km: two long days at the wheel; past that nobody drives it.
 *  - transit 60 km : urban/commuter networks; not an intercity answer.
 *  - train 25-1500 km: below 25 km it is the metro (that's `transit`); 1500 km
 *    is about the longest sleeper anyone books instead of flying.
 *  - bus 25-900 km : coaches exist further, but past ~900 km they lose to air.
 *  - flight 250 km+: shorter than that and getting to the airport costs more
 *    time than the flight saves.
 */
export const MODE_RANGE_KM: Record<TravelMode, { min: number; max: number }> = {
  walking: { min: 0, max: 8 },
  cycling: { min: 0, max: 30 },
  driving: { min: 0, max: 1200 },
  transit: { min: 0, max: 60 },
  train: { min: 25, max: 1500 },
  bus: { min: 25, max: 900 },
  flight: { min: 250, max: Infinity },
};

/** Modes that need a road or a rail line, i.e. cannot cross open water. */
export const GROUND_MODES: readonly TravelMode[] = [
  'walking',
  'cycling',
  'driving',
  'transit',
  'train',
  'bus',
];

export function tierForKm(km: number): TravelTier {
  if (km <= TIER_MAX_KM.local) return 'local';
  if (km <= TIER_MAX_KM.regional) return 'regional';
  return 'long';
}

/**
 * Which modes to offer for a leg of this length.
 *
 * `landRoute` carries what we actually found out rather than a guess:
 *   true/null — a road route exists, or we don't know yet (offer normally)
 *   false     — the router could not connect the two points by road, which in
 *               practice means open water. Everything that needs tarmac or
 *               track is dropped and only flying is left.
 */
export function modesForKm(
  km: number,
  opts: { landRoute?: boolean | null } = {},
): TravelMode[] {
  const tier = tierForKm(km);
  const byTier: Record<TravelTier, TravelMode[]> = {
    // Same city: everything from your own two feet upwards.
    local: ['walking', 'cycling', 'driving', 'transit'],
    // Intercity: walking and cycling are gone; the coach and the train arrive.
    regional: ['driving', 'train', 'bus'],
    // Long haul: only the two modes that cover hundreds of km in a day.
    long: ['flight', 'train'],
  };

  let modes = byTier[tier].filter((m) => {
    const r = MODE_RANGE_KM[m];
    return km >= r.min && km <= r.max;
  });

  if (opts.landRoute === false) modes = modes.filter((m) => !GROUND_MODES.includes(m));

  // A leg longer than every ground mode's reach but under the flight minimum
  // can empty the list; flying is the only thing that still works.
  if (!modes.length) modes = ['flight'];
  return modes;
}

/**
 * Straight-line distance understates a journey, because roads bend and rails
 * follow valleys. These are the usual correction factors; flying needs none.
 */
const DETOUR_FACTOR: Record<TravelMode, number> = {
  walking: 1.3,
  cycling: 1.25,
  driving: 1.25,
  transit: 1.3,
  train: 1.15,
  bus: 1.25,
  flight: 1,
};

/**
 * Average door-to-door speed in km/h, banded by distance because a mode's
 * average speed is not constant: a 5 km drive is stop-start city traffic, a
 * 500 km drive is mostly motorway. Bands are [maxKm, kmh].
 *
 * These are deliberately conservative. The same 600 km by rail is three hours
 * on a high-speed line and fifteen on an older one, and we have no way to know
 * which this route has. Erring slow means the estimate reads as the "allow
 * about this long" figure it is, rather than promising a journey nobody can
 * book. The numbers were sanity-checked against real routed answers — a
 * 780 km road route the router put at 11 hr 25 min (≈68 km/h) lands inside
 * the driving band below.
 */
const SPEED_BANDS: Record<Exclude<TravelMode, 'transit' | 'flight'>, Array<[number, number]>> = {
  walking: [[Infinity, 4.8]],
  cycling: [[Infinity, 15]],
  driving: [
    [10, 24], // urban, stop-start
    [80, 50], // A-roads and ring roads
    [400, 68], // mostly motorway, with breaks
    [Infinity, 72],
  ],
  train: [
    [100, 55], // regional stopping services
    [400, 70],
    [Infinity, 80], // conventional long-distance; high-speed lines beat this
  ],
  bus: [
    [100, 40],
    [400, 50],
    [Infinity, 55],
  ],
};

/** Cruise speed and the fixed cost of taxi, climb and descent on any flight. */
const FLIGHT_CRUISE_KMH = 780;
const FLIGHT_FIXED_SEC = 45 * 60;

export interface TravelEstimate {
  mode: TravelMode;
  /** Distance the figure is based on, km. */
  km: number;
  /** Where `km` came from — routed is measured, the others are computed here. */
  distanceBasis: 'routed' | 'great-circle' | 'great-circle+detour';
  /** null when no honest estimate is possible (see `assumption`). */
  durationSec: number | null;
  /** The assumption behind the number, in plain English, for display. */
  assumption: string;
}

function speedFor(mode: keyof typeof SPEED_BANDS, km: number): number {
  for (const [maxKm, kmh] of SPEED_BANDS[mode]) if (km <= maxKm) return kmh;
  return SPEED_BANDS[mode][SPEED_BANDS[mode].length - 1][1];
}

/**
 * Travel time for a leg, derived from its real distance.
 *
 * `routedKm`, when given, is a distance a router actually measured — we use it
 * as-is and skip the detour correction, and the result is labelled as resting
 * on a measured distance rather than a computed one.
 */
export function estimateLeg(
  mode: TravelMode,
  straightKm: number,
  routedKm?: number,
): TravelEstimate {
  const routed = typeof routedKm === 'number' && routedKm > 0;
  const factor = DETOUR_FACTOR[mode];
  const km = routed ? routedKm : straightKm * factor;
  const distanceBasis: TravelEstimate['distanceBasis'] = routed
    ? 'routed'
    : factor === 1
      ? 'great-circle'
      : 'great-circle+detour';

  // Urban transit is the one mode where a speed model would be a fiction: the
  // time is set by a timetable and the interchange you happen to catch, and it
  // varies by a factor of three between a metro and a rural bus. We say so
  // instead of inventing a number.
  if (mode === 'transit') {
    return {
      mode,
      km,
      distanceBasis,
      durationSec: null,
      assumption: 'Depends on the timetable — check live departures.',
    };
  }

  if (mode === 'flight') {
    return {
      mode,
      km,
      distanceBasis,
      durationSec: Math.round((km / FLIGHT_CRUISE_KMH) * 3600) + FLIGHT_FIXED_SEC,
      assumption: `Gate to gate at ~${FLIGHT_CRUISE_KMH} km/h cruise plus 45 min taxi and climb. Airport time is on top.`,
    };
  }

  const kmh = speedFor(mode, km);
  const wording: Record<Exclude<TravelMode, 'transit' | 'flight'>, string> = {
    walking: `At a steady ${kmh} km/h walking pace.`,
    cycling: `At ${kmh} km/h on a bike, without long stops.`,
    driving: `At ~${kmh} km/h average for this distance, before traffic and breaks.`,
    train: `At ~${kmh} km/h average, i.e. a conventional service with stops. A high-speed line would be much faster, an older one slower.`,
    bus: `At ~${kmh} km/h average for this distance, including stops.`,
  };
  return {
    mode,
    km,
    distanceBasis,
    durationSec: Math.round((km / kmh) * 3600),
    assumption: wording[mode],
  };
}
