// "Getting there & around" — two questions travellers actually ask:
//
//   1. How do I reach this city?      -> real booking links (flights/rail/transit)
//   2. How do I get between places?   -> point-to-point directions on the map
//
// The directions half uses OSM-based routing and draws the line on the map.
// Public transit is not routed in-app (no free global transit API) — it hands
// off to Google Maps with the route prefilled, which is labelled as such rather
// than presented as an in-app result.

import { useEffect, useMemo, useState } from 'react';
import type { Guide } from '../types';
import { useAppStore } from '../store/useAppStore';
import { geocode } from '../data/geocode';
import { useI18n } from '../i18n';

type Mode = 'walking' | 'cycling' | 'driving' | 'transit';

const MODES: Array<{ id: Mode; icon: string; label: string }> = [
  { id: 'walking', icon: '🚶', label: 'Walk' },
  { id: 'cycling', icon: '🚲', label: 'Cycle' },
  { id: 'driving', icon: '🚗', label: 'Drive' },
  { id: 'transit', icon: '🚆', label: 'Transit' },
];

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
}

/** Chosen in the From/To selects to type an arbitrary place instead. */
const CUSTOM = '__custom__';

interface Endpoint {
  lat: number;
  lon: number;
  label: string;
}

function formatDuration(sec: number): string {
  if (!sec) return '—';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export default function TravelPanel({ guide }: { guide: Guide }) {
  const setRouteGeometry = useAppStore((s) => s.setRouteGeometry);
  const { lang } = useI18n();

  // Only places with real coordinates can be routed between.
  const routable = useMemo(
    () => guide.destinations.filter((d) => typeof d.lat === 'number' && typeof d.lon === 'number'),
    [guide.destinations],
  );

  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('walking');
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

  // Default to the two top-ranked places so the panel is useful on first open.
  useEffect(() => {
    if (!fromId && routable[0]) setFromId(routable[0].id);
    // routable[1], not [0] — defaulting both to the same place left the panel
    // stuck on "Pick two different places" before the user touched anything.
    if (!toId && routable[1] && routable[1].id !== routable[0]?.id) setToId(routable[1].id);
  }, [routable, fromId, toId]);

  // Clear the route when the user moves to a different city — but deliberately
  // NOT when this panel unmounts. Switching to Explore to read about a place,
  // or collapsing the panel, should leave the route on the map; wiping it on
  // unmount made the line disappear the moment you looked away from it.
  useEffect(() => {
    setRouteGeometry(null);
    setRoute(null);
    setFromId('');
    setToId('');
  }, [guide.title, setRouteGeometry]);

  async function resolveEndpoint(id: string, text: string): Promise<Endpoint | null> {
    if (id !== CUSTOM) {
      const d = routable.find((x) => x.id === id);
      return d ? { lat: d.lat!, lon: d.lon!, label: d.name } : null;
    }
    const q = text.trim();
    if (!q) return null;
    // Bias an otherwise ambiguous place name toward the city being viewed —
    // "central station" should mean this city's, not one on another continent.
    const hit = (await geocode(`${q}, ${guide.title}`, lang)) ?? (await geocode(q, lang));
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
    if (mode === 'transit') return;
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
    if (!origin.trim()) return;
    setLoadingOptions(true);
    try {
      const params = new URLSearchParams({ from: origin.trim(), to: guide.title });
      if (date) params.set('date', date);
      const res = await fetch(`/api/travel-options?${params}`, { cache: 'no-store' });
      setOptions(res.ok ? await res.json() : []);
    } catch {
      setOptions([]);
    } finally {
      setLoadingOptions(false);
    }
  }

  return (
    <div className="travel">
      {/* ---- Getting there: real bookable options ---- */}
      <section className="travel__section">
        <h3 className="travel__heading">Getting to {guide.title}</h3>
        <p className="travel__hint">
          Where are you travelling from? We&apos;ll open real booking sites with this route
          filled in.
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
          disabled={!origin.trim() || loadingOptions}
        >
          {loadingOptions ? 'Finding options…' : 'Find travel options'}
        </button>

        {options && options.length > 0 && (
          <ul className="travel__options">
            {options.map((o) => (
              <li key={o.id}>
                <a
                  className="travel__option"
                  href={o.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="travel__option-label">{o.label}</span>
                  <span className="travel__option-provider">{o.provider}</span>
                  <span className="travel__option-desc">{o.description}</span>
                  {!o.prefilled && (
                    <span className="travel__option-note">
                      Opens their search page — enter the route there
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
        {options && options.length === 0 && (
          <p className="travel__hint">No options found for that origin.</p>
        )}
      </section>

      {/* ---- Getting around: point-to-point directions ---- */}
      <section className="travel__section">
        <h3 className="travel__heading">Getting around</h3>

        {routable.length < 2 ? (
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

            <div className="travel__modes">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={'travel__mode' + (mode === m.id ? ' travel__mode--on' : '')}
                  onClick={() => setMode(m.id)}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>

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

            {fromId !== CUSTOM && fromId === toId && (
              <p className="travel__hint">Pick two different places.</p>
            )}

            {mode === 'transit' && (
              <p className="travel__hint">
                Transit schedules come from Google Maps — this opens in a new tab.
              </p>
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
