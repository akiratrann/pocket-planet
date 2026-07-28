// "Getting there & around" — two questions travellers actually ask:
//
//   1. How do I reach this city?      -> distance + travel-time estimates we
//                                        compute here, with booking links kept
//                                        separate as the hand-off for fares
//   2. How do I get between places?   -> point-to-point directions on the map
//
// The destination is the traveller's choice, not whatever guide happens to be
// loaded — same model as the Itinerary tab, where a trip carries its own
// destination so that searching elsewhere can't re-point it.
//
// What is computed here versus what is linked out is kept visibly apart. Real
// bookable inventory (live fares, seats, departure times) needs a paid or
// approval-gated API; free test tiers return sample data, and dressing that up
// as availability would be a lie. So we show only what the coordinates honestly
// support — a distance and a speed-model estimate, both labelled as such — and
// send people to the operator for the numbers only the operator has.

import { useEffect, useMemo, useState } from 'react';
import type { Guide } from '../types';
import { useAppStore } from '../store/useAppStore';
import { geocode } from '../data/geocode';
import { useGuide } from '../hooks/useGuide';
import { useI18n } from '../i18n';
// Shared with ItineraryPanel so a leg is described identically in both places.
import {
  estimateLeg,
  greatCircleKm,
  modesForKm,
  type TravelMode,
} from '../../server/pipeline/travel-links.ts';

const MODE_ICON: Record<TravelMode, string> = {
  walking: '🚶',
  cycling: '🚲',
  driving: '🚗',
  transit: '🚇',
  train: '🚆',
  bus: '🚌',
  flight: '✈️',
};

// TODO: move to i18n — src/i18n.ts is owned by another change right now.
const EN: Record<TravelMode | string, string> = {
  walking: 'Walk',
  cycling: 'Cycle',
  driving: 'Drive',
  transit: 'Transit',
  train: 'Train',
  bus: 'Bus',
  flight: 'Flight',
};

/** Modes the in-app router can draw; the rest run to someone else's timetable. */
const ROUTED: ReadonlySet<TravelMode> = new Set(['walking', 'cycling', 'driving']);

interface RouteResponse {
  mode: string;
  distanceKm: number;
  durationSec: number;
  geometry: Array<[number, number]>;
  steps: string[];
  approximate?: boolean;
}

interface TravelOption {
  id: string;
  kind: string;
  provider: string;
  label: string;
  description: string;
  url: string;
  prefilled: boolean;
  /** Present only when a live-inventory provider answered — see travel-links.ts. */
  offer?: {
    operator: string;
    departISO: string;
    arriveISO: string;
    durationSec: number;
    changes: number;
    price?: { amount: number; currency: string };
    deepLink: string;
    fetchedAt: number;
    source: string;
  };
}

/** Chosen in the From/To selects to type an arbitrary place instead. */
const CUSTOM = '__custom__';

interface Endpoint {
  lat: number;
  lon: number;
  label: string;
}

/**
 * The Travel tab unmounts whenever the user switches panel or collapses it, so
 * a chosen destination cannot live in component state — it would be forgotten
 * the moment you looked at the map. It is kept here and in localStorage.
 * `null` means "follow whatever guide is loaded", which is the default.
 *
 * (The obvious home for this is the app store, but src/store/useAppStore.ts
 * belongs to another change; a single string is small enough to keep locally.)
 */
const DEST_KEY = 'pp.travel-destination.v1';

function readStoredDest(): string | null {
  try {
    const v = localStorage.getItem(DEST_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function writeStoredDest(v: string | null): void {
  try {
    if (v) localStorage.setItem(DEST_KEY, v);
    else localStorage.removeItem(DEST_KEY);
  } catch {
    // Storage unavailable: the choice just won't survive a reload.
  }
}

function formatDuration(sec: number): string {
  if (!sec) return '—';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function formatKm(km: number): string {
  return km >= 100 ? `${Math.round(km).toLocaleString()} km` : `${km.toFixed(1)} km`;
}

/**
 * The in-app answer: every mode that can actually cover this distance, with the
 * time it would take and the assumption that produced it, stated on the row.
 * No prices, because we have none.
 */
function EstimateList({
  straightKm,
  routedKm,
  modes,
}: {
  straightKm: number;
  routedKm?: number | undefined;
  modes: TravelMode[];
}) {
  return (
    <ul className="travel__ests">
      {modes.map((m) => {
        const est = estimateLeg(m, straightKm, m === 'driving' || m === 'bus' ? routedKm : undefined);
        return (
          <li key={m} className="travel__est">
            <span className="travel__est-mode">
              {MODE_ICON[m]} {EN[m]}
            </span>
            <span className="travel__est-time">
              {est.durationSec === null ? '—' : `~${formatDuration(est.durationSec)}`}
            </span>
            <span className="travel__est-basis">
              {formatKm(est.km)} ·{' '}
              {est.distanceBasis === 'routed'
                ? 'measured road distance'
                : est.distanceBasis === 'great-circle'
                  ? 'great-circle distance'
                  : 'great-circle distance with a typical detour allowance'}
            </span>
            <span className="travel__est-note">{est.assumption}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function TravelPanel({ guide }: { guide: Guide }) {
  const setRouteGeometry = useAppStore((s) => s.setRouteGeometry);
  const pinned = useAppStore((s) => s.pinned);
  const { t, lang } = useI18n();

  // --- Destination: the traveller's choice, sticky across panels ---
  const [chosenDest, setChosenDest] = useState<string | null>(() => readStoredDest());
  const [editingDest, setEditingDest] = useState(false);
  const [destText, setDestText] = useState('');

  const destination = (chosenDest ?? guide.title).trim();
  const followsGuide =
    destination.toLowerCase() === guide.title.trim().toLowerCase();

  // Only fetch when the choice differs from the guide already in hand — the
  // loaded guide is the same data, already paid for.
  const { data: otherGuide, isLoading: destLoading } = useGuide(
    followsGuide ? '' : destination,
    lang,
  );
  const destGuide = followsGuide ? guide : otherGuide;

  const applyDest = (value: string) => {
    const v = value.trim();
    if (!v) return;
    // Choosing the guide you're already looking at means "just follow along".
    const next = v.toLowerCase() === guide.title.trim().toLowerCase() ? null : v;
    setChosenDest(next);
    writeStoredDest(next);
    setEditingDest(false);
  };

  // Places the traveller has shown interest in beat any fixed list.
  const destSuggestions = useMemo(() => {
    const seen = new Set<string>([destination.toLowerCase()]);
    const out: string[] = [];
    for (const name of [guide.title, ...pinned.map((p) => p.location)]) {
      const v = (name ?? '').trim();
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      out.push(v);
      if (out.length === 4) break;
    }
    return out;
  }, [guide.title, pinned, destination]);

  // Only places with real coordinates can be routed between.
  const routable = useMemo(
    () =>
      (destGuide?.destinations ?? []).filter(
        (d) => typeof d.lat === 'number' && typeof d.lon === 'number',
      ),
    [destGuide],
  );

  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [mode, setMode] = useState<TravelMode>('walking');
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routing, setRouting] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  // Free-text endpoints. Directions shouldn't be limited to places that happen
  // to be in the loaded guide — a trip usually starts at a hotel, a station or
  // an address that no guide lists.
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');

  const [origin, setOrigin] = useState('');
  const [date, setDate] = useState('');
  const [options, setOptions] = useState<TravelOption[] | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  // Straight-line distance from the origin to the destination, once both have
  // coordinates. This is the honest half of "getting there".
  const [tripKm, setTripKm] = useState<number | null>(null);
  const [originLabel, setOriginLabel] = useState<string | null>(null);

  // Seed the two selects from the destination's top-ranked places, so the panel
  // is useful the moment it opens.
  //
  // Keyed on `routable` alone, and it assigns rather than fills-if-empty. As
  // two effects — one seeding, one clearing on a destination change — the clear
  // ran second within the same commit and wiped the seed, and because the
  // committed values had never actually changed, the seeding effect's
  // dependencies looked untouched and it never ran again: both selects sat
  // empty on "Pick two different places" forever.
  useEffect(() => {
    setFromId(routable[0]?.id ?? '');
    // routable[1], not [0] — defaulting both to the same place left the panel
    // stuck on "Pick two different places" before the user touched anything.
    setToId(routable[1] && routable[1].id !== routable[0]?.id ? routable[1].id : '');
  }, [routable]);

  // Clear the route when the destination changes — but deliberately NOT when
  // this panel unmounts. Switching to Explore to read about a place, or
  // collapsing the panel, should leave the route on the map; wiping it on
  // unmount made the line disappear the moment you looked away from it.
  useEffect(() => {
    setRouteGeometry(null);
    setRoute(null);
    setTripKm(null);
  }, [destination, setRouteGeometry]);

  // --- Getting around: distance between the two selected places -------------
  // Both endpoints are guide places with coordinates, so this needs no network
  // and lets the mode list drop anything that can't cover the distance.
  const pairKm = useMemo(() => {
    if (fromId === CUSTOM || toId === CUSTOM) return null;
    const a = routable.find((d) => d.id === fromId);
    const b = routable.find((d) => d.id === toId);
    if (!a || !b || a.id === b.id) return null;
    return greatCircleKm({ lat: a.lat!, lon: a.lon! }, { lat: b.lat!, lon: b.lon! });
  }, [routable, fromId, toId]);

  const aroundModes = useMemo(
    // Endpoints typed by hand aren't geocoded until submit, so until then we
    // can't measure the leg and simply offer the local set.
    () => (pairKm === null ? modesForKm(0) : modesForKm(pairKm)),
    [pairKm],
  );
  const aroundRouted = useMemo(() => aroundModes.filter((m) => ROUTED.has(m)), [aroundModes]);
  const aroundScheduled = useMemo(
    () => aroundModes.filter((m) => !ROUTED.has(m)),
    [aroundModes],
  );

  // Keep the selected mode inside what's actually possible for this pair —
  // leaving "Walk" selected on a 600 km leg would route nonsense.
  useEffect(() => {
    if (aroundRouted.length && !aroundRouted.includes(mode) && mode !== 'transit') {
      setMode(aroundRouted[0]);
    }
  }, [aroundRouted, mode]);

  async function resolveEndpoint(id: string, text: string): Promise<Endpoint | null> {
    if (id !== CUSTOM) {
      const d = routable.find((x) => x.id === id);
      return d ? { lat: d.lat!, lon: d.lon!, label: d.name } : null;
    }
    const q = text.trim();
    if (!q) return null;
    // Bias an otherwise ambiguous place name toward the city being viewed —
    // "central station" should mean this city's, not one on another continent.
    const hit = (await geocode(`${q}, ${destination}`, lang)) ?? (await geocode(q, lang));
    return hit ? { lat: hit.lat, lon: hit.lon, label: hit.displayName } : null;
  }

  // Refresh on load and on any change to the route inputs, rather than waiting
  // for a button press. Travel times shift with traffic and closures, so a
  // figure carried over from a previous visit is worse than none — it looks
  // current while being stale.
  //
  // Transit is excluded on purpose: it opens Google Maps in a new tab, and
  // auto-firing that would hijack the browser.
  useEffect(() => {
    if (!ROUTED.has(mode)) return;
    if (!fromId || !toId) return;
    if (fromId !== CUSTOM && fromId === toId) return;
    // Typed endpoints geocode on submit, not on every keystroke.
    if (fromId === CUSTOM || toId === CUSTOM) return;
    const id = setTimeout(() => {
      void getDirections();
    }, 250); // debounce rapid from/to/mode toggling into one request
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId, toId, mode]);

  // Booking links are rebuilt on load too, so a stale origin/date can't linger.
  useEffect(() => {
    if (origin.trim()) void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getDirections() {
    setRouting(true);
    setRouteError(null);
    try {
      const [a, b] = await Promise.all([
        resolveEndpoint(fromId, fromText),
        resolveEndpoint(toId, toText),
      ]);
      if (!a || !b) {
        setRouteError(t_couldNotFind(a, b));
        setRoute(null);
        setRouteGeometry(null);
        return;
      }

      if (mode === 'transit') {
        const url =
          `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${a.lat},${a.lon}`)}` +
          `&destination=${encodeURIComponent(`${b.lat},${b.lon}`)}&travelmode=transit`;
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }

      // no-store: routing must reflect the network as it is right now, not a
      // response the browser or an intermediary held on to. Same reason the
      // panel re-fetches on load rather than trusting what it showed last time.
      const res = await fetch(
        `/api/route?from=${a.lat},${a.lon}&to=${b.lat},${b.lon}&mode=${mode}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Could not find a route');
      const data: RouteResponse = await res.json();
      setRoute(data);
      setFetchedAt(Date.now());
      setRouteGeometry(data.geometry.length ? data.geometry : null);
    } catch (err) {
      setRouteError((err as Error).message);
      setRoute(null);
      setRouteGeometry(null);
    } finally {
      setRouting(false);
    }
  }

  /** Name whichever endpoint failed, so the user knows which one to correct. */
  function t_couldNotFind(a: Endpoint | null, b: Endpoint | null): string {
    if (!a && !b) return 'Could not find either place. Try a more specific name.';
    return `Could not find "${!a ? fromText : toText}". Try a more specific name.`;
  }

  async function loadOptions() {
    if (!origin.trim() || !destination) return;
    setLoadingOptions(true);
    try {
      // Measure the journey ourselves first. Geocoding the origin gives real
      // coordinates, and the destination guide already carries its centre, so
      // the distance below is computed rather than claimed.
      const hit = await geocode(origin.trim(), lang);
      const centre = destGuide?.center;
      if (hit && centre) {
        setTripKm(greatCircleKm({ lat: hit.lat, lon: hit.lon }, { lon: centre[0], lat: centre[1] }));
        setOriginLabel(hit.displayName.split(',')[0] ?? origin.trim());
      } else {
        setTripKm(null);
        setOriginLabel(null);
      }

      const params = new URLSearchParams({ from: origin.trim(), to: destination });
      if (date) params.set('date', date);
      const res = await fetch(`/api/travel-options?${params}`, { cache: 'no-store' });
      setOptions(res.ok ? await res.json() : []);
    } catch {
      setOptions([]);
    } finally {
      setLoadingOptions(false);
    }
  }

  const tripModes = tripKm === null ? [] : modesForKm(tripKm);

  return (
    <div className="travel">
      {/* Destination bar — mirrors the Itinerary tab so the two read as one
          product. Sticky, so browsing another city doesn't move your trip. */}
      <div className="itin__dest travel__dest">
        {editingDest ? (
          <form
            className="itin__destform"
            onSubmit={(e) => {
              e.preventDefault();
              applyDest(destText);
            }}
          >
            <div className="itin__newrow">
              <input
                className="itin__destinput"
                value={destText}
                onChange={(e) => setDestText(e.target.value)}
                placeholder={t('search_placeholder')}
                aria-label={t('itinerary_where')}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <button className="btn btn--sm" type="submit">
                {t('save')}
              </button>
              <button
                type="button"
                className="itin__destcancel"
                onClick={() => setEditingDest(false)}
              >
                {t('cancel')}
              </button>
            </div>
            <div className="itin__chips">
              {destSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => applyDest(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <div className="itin__destrow">
            <span className="itin__destname">📍 {destination}</span>
            <button
              className="itin__destedit"
              onClick={() => {
                setDestText(destination);
                setEditingDest(true);
              }}
            >
              {t('change')}
            </button>
          </div>
        )}
        <p className="itin__desthint">
          {followsGuide
            ? 'Following the guide you are viewing. Change it to plan travel to somewhere else.'
            : 'Your choice — it stays put while you browse other places.'}
        </p>
      </div>

      {/* ---- Getting there ---- */}
      <section className="travel__section">
        <h3 className="travel__heading">Getting to {destination}</h3>
        <p className="travel__hint">
          Where are you travelling from? We work out the distance and a realistic travel time
          for every mode that can actually cover it.
        </p>

        <div className="travel__row">
          <input
            className="travel__input"
            placeholder="e.g. San Francisco"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadOptions()}
            aria-label="Travelling from"
          />
          <input
            className="travel__input travel__input--date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Departure date"
          />
        </div>
        <button
          className="travel__go"
          onClick={loadOptions}
          disabled={!origin.trim() || loadingOptions || destLoading}
        >
          {loadingOptions ? 'Working it out…' : 'Show me the options'}
        </button>

        {tripKm !== null && tripModes.length > 0 && (
          <div className="travel__computed">
            <h4 className="travel__blockh">
              <span className="travel__badge travel__badge--calc">Calculated here</span>
              {originLabel ?? origin} → {destination} · {formatKm(tripKm)} apart
            </h4>
            <EstimateList straightKm={tripKm} modes={tripModes} />
            <p className="travel__hint">
              Times are estimates from the real distance between the two places. They are not
              fares, seat availability or scheduled departures — no free source publishes those.
            </p>
          </div>
        )}

        {options && options.length > 0 && (
          <div className="travel__linkblock">
            <h4 className="travel__blockh">
              <span className="travel__badge travel__badge--link">Booking sites</span>
              Real prices and departures
            </h4>
            <ul className="travel__options">
              {options.map((o) => (
                <li key={o.id}>
                  <a
                    className="travel__option"
                    href={o.offer?.deepLink ?? o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="travel__option-label">{o.label}</span>
                    <span className="travel__option-provider">{o.provider} ↗</span>
                    <span className="travel__option-desc">{o.description}</span>
                    {/* A live-inventory provider fills in `offer`; until one is
                        configured every row here is a hand-off, and says so. */}
                    {o.offer ? (
                      <span className="travel__option-note">
                        {o.offer.operator} · {formatDuration(o.offer.durationSec)}
                        {o.offer.price
                          ? ` · ${o.offer.price.amount} ${o.offer.price.currency}`
                          : ''}{' '}
                        · quoted by {o.offer.source}
                      </span>
                    ) : (
                      <span className="travel__option-note">
                        {o.prefilled
                          ? 'Opens their site with this route filled in'
                          : 'Opens their search page — enter the route there'}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {options && options.length === 0 && (
          <p className="travel__hint">No options found for that origin.</p>
        )}
      </section>

      {/* ---- Getting around: point-to-point directions ---- */}
      <section className="travel__section">
        <h3 className="travel__heading">Getting around</h3>

        {destLoading ? (
          <p className="travel__hint">Loading places in {destination}…</p>
        ) : routable.length < 2 ? (
          <p className="travel__hint">
            Not enough places with map coordinates here yet to give directions.
          </p>
        ) : (
          <>
            <label className="travel__field">
              <span>From</span>
              <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value={CUSTOM}>📍 Anywhere else…</option>
                {routable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {fromId === CUSTOM && (
              <input
                className="travel__input"
                placeholder="Hotel, station, address…"
                value={fromText}
                onChange={(e) => setFromText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && getDirections()}
                aria-label="Start from"
              />
            )}

            <label className="travel__field">
              <span>To</span>
              <select value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value={CUSTOM}>📍 Anywhere else…</option>
                {routable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {toId === CUSTOM && (
              <input
                className="travel__input"
                placeholder="Hotel, station, address…"
                value={toText}
                onChange={(e) => setToText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && getDirections()}
                aria-label="Travel to"
              />
            )}

            {pairKm !== null && (
              <p className="travel__hint">
                These two are {formatKm(pairKm)} apart in a straight line, so only the modes
                below make sense for the trip.
              </p>
            )}

            <div className="travel__modes">
              {aroundRouted.map((m) => (
                <button
                  key={m}
                  className={'travel__mode' + (mode === m ? ' travel__mode--on' : '')}
                  onClick={() => setMode(m)}
                >
                  {MODE_ICON[m]} {EN[m]}
                </button>
              ))}
              {/* Transit stays selectable whenever it's in range: it's the one
                  scheduled mode we can hand straight to a live schedule. */}
              {aroundModes.includes('transit') && (
                <button
                  className={'travel__mode' + (mode === 'transit' ? ' travel__mode--on' : '')}
                  onClick={() => setMode('transit')}
                >
                  {MODE_ICON.transit} {EN.transit}
                </button>
              )}
            </div>

            {ROUTED.has(mode) || mode === 'transit' ? (
              <button
                className="travel__go"
                onClick={getDirections}
                disabled={routing || (fromId !== CUSTOM && fromId === toId)}
              >
                {routing
                  ? 'Finding route…'
                  : mode === 'transit'
                    ? 'Open transit directions'
                    : 'Get directions'}
              </button>
            ) : null}

            {fromId !== CUSTOM && fromId === toId && (
              <p className="travel__hint">Pick two different places.</p>
            )}

            {mode === 'transit' && (
              <p className="travel__hint">
                Transit schedules come from Google Maps — this opens in a new tab.
              </p>
            )}

            {/* An intercity pair inside "Getting around": we can't route a train
                or a flight, but we can still say how long it would take. */}
            {pairKm !== null && aroundScheduled.some((m) => m !== 'transit') && (
              <div className="travel__computed">
                <h4 className="travel__blockh">
                  <span className="travel__badge travel__badge--calc">Calculated here</span>
                  Other ways to cover this distance
                </h4>
                <EstimateList
                  straightKm={pairKm}
                  modes={aroundScheduled.filter((m) => m !== 'transit')}
                />
              </div>
            )}

            {routeError && <p className="travel__hint">{routeError}</p>}

            {route && mode !== 'transit' && (
              <div className="travel__result">
                <div className="travel__summary">
                  <strong>{formatDuration(route.durationSec)}</strong>
                  <span>{route.distanceKm.toFixed(1)} km</span>
                </div>
                {fetchedAt && (
                  <span className="travel__fresh">
                    Live · checked {new Date(fetchedAt).toLocaleTimeString()}
                  </span>
                )}
                {route.approximate ? (
                  <p className="travel__hint">
                    Routing is unavailable right now — that&apos;s the straight-line distance.
                  </p>
                ) : (
                  <p className="travel__hint">Route drawn on the map.</p>
                )}
                {route.steps.length > 0 && (
                  <ol className="travel__steps">
                    {route.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
