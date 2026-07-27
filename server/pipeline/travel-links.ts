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
}

export interface TravelOptionProvider {
  id: string;
  kind: TravelKind;
  build(q: TravelQuery): TravelOption[] | Promise<TravelOption[]>;
}

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
