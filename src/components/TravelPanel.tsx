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
import type { Destination, Guide } from '../types';
import { useAppStore } from '../store/useAppStore';

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
  const [routeError, setRouteError] = useState<string | null>(null);

  const [origin, setOrigin] = useState('');
  const [date, setDate] = useState('');
  const [options, setOptions] = useState<TravelOption[] | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);

  // Default to the two top-ranked places so the panel is useful on first open.
  useEffect(() => {
    if (!fromId && routable[0]) setFromId(routable[0].id);
    if (!toId && routable[1]) setToId(routable[1].id);
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

  const find = (id: string): Destination | undefined => routable.find((d) => d.id === id);

  async function getDirections() {
    const a = find(fromId);
    const b = find(toId);
    if (!a || !b) return;

    if (mode === 'transit') {
      const url =
        `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${a.lat},${a.lon}`)}` +
        `&destination=${encodeURIComponent(`${b.lat},${b.lon}`)}&travelmode=transit`;
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    setRouting(true);
    setRouteError(null);
    try {
      const res = await fetch(
        `/api/route?from=${a.lat},${a.lon}&to=${b.lat},${b.lon}&mode=${mode}`,
      );
      if (!res.ok) throw new Error('Could not find a route');
      const data: RouteResponse = await res.json();
      setRoute(data);
      setRouteGeometry(data.geometry.length ? data.geometry : null);
    } catch (err) {
      setRouteError((err as Error).message);
      setRoute(null);
      setRouteGeometry(null);
    } finally {
      setRouting(false);
    }
  }

  async function loadOptions() {
    if (!origin.trim()) return;
    setLoadingOptions(true);
    try {
      const params = new URLSearchParams({ from: origin.trim(), to: guide.title });
      if (date) params.set('date', date);
      const res = await fetch(`/api/travel-options?${params}`);
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
                {routable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="travel__field">
              <span>To</span>
              <select value={toId} onChange={(e) => setToId(e.target.value)}>
                {routable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

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
              disabled={routing || fromId === toId}
            >
              {routing
                ? 'Finding route…'
                : mode === 'transit'
                  ? 'Open transit directions'
                  : 'Get directions'}
            </button>

            {fromId === toId && (
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
