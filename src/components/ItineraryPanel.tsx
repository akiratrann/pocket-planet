import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import {
  useAppStore,
  savedFromDestination,
  type Itinerary,
  type SavedPlace,
} from '../store/useAppStore';
import { useGuide } from '../hooks/useGuide';
import { useI18n } from '../i18n';
import type { Guide } from '../types';
// The distance/estimate model is shared with the Travel tab so both places
// describe the same leg identically. It is pure, dependency-free arithmetic —
// see the header of that file for why it lives next to the link providers.
import {
  estimateLeg,
  greatCircleKm,
  modesForKm,
  tierForKm,
  type TravelMode,
} from '../../server/pipeline/travel-links.ts';

/** Shape returned by GET /api/route — see server/pipeline/routing.ts. */
interface RouteResponse {
  mode: string;
  distanceKm: number;
  durationSec: number;
  geometry: Array<[number, number]>;
  steps: string[];
  approximate?: boolean;
}

/** Shape returned by GET /api/travel-options — see server/pipeline/travel-links.ts. */
interface TravelOption {
  id: string;
  provider: string;
  label: string;
  description: string;
  url: string;
  prefilled: boolean;
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

const MODE_ICON: Record<TravelMode, string> = {
  walking: '🚶',
  cycling: '🚲',
  driving: '🚗',
  transit: '🚇',
  train: '🚆',
  bus: '🚌',
  flight: '✈️',
};

// TODO: move to i18n — src/i18n.ts is owned by another change right now, so the
// strings that intercity travel adds are English-only constants for the moment.
const EN = {
  train: 'Train',
  bus: 'Bus',
  flight: 'Flight',
  est: 'est.',
  estimateNote: 'Estimated from the real distance — not a quoted fare or timetable.',
  noEstimate: 'timetabled',
  checkingRoad: 'Checking whether a road connects these…',
  noLandRoute: 'No road route connects these two stops, so only flying is offered.',
  bookHeading: 'Book or check live times',
  bookNote: 'These open the operator’s own site — that is where real prices and seats are.',
  bookLoading: 'Finding booking options…',
  straightLine: 'straight-line',
  byRoad: 'by road',
  apart: 'apart',
};

/** Modes that follow tarmac, so a measured road distance applies to them. */
const ROAD: ReadonlySet<TravelMode> = new Set(['driving', 'bus']);

/**
 * Beyond this the road probe is not worth making: nothing on land is offered
 * at that range anyway (see MODE_RANGE_KM), and asking a public router for a
 * 2000 km car route mostly just times out.
 */
const ROAD_PROBE_MAX_KM = 1500;

/**
 * `LegMode` in src/store/useAppStore.ts predates intercity travel and only
 * knows walking/cycling/driving/transit; that file belongs to another change,
 * so a train/bus/flight leg is persisted as `transit` (all three are "someone
 * else's timetable") and the mode the traveller actually picked is kept here,
 * keyed by trip + stop pair. Without this the chip would silently say "Transit"
 * for a flight after a reload.
 */
type ScheduledPick = 'train' | 'bus' | 'flight';
const SCHEDULED_KEY = 'pp.leg-scheduled-mode.v1';

function readScheduledMap(): Record<string, ScheduledPick> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEDULED_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeScheduledMode(key: string, mode: ScheduledPick | null): void {
  try {
    const map = readScheduledMap();
    if (mode) map[key] = mode;
    else delete map[key];
    localStorage.setItem(SCHEDULED_KEY, JSON.stringify(map));
  } catch {
    // Storage can be unavailable (private mode, quota). The leg still works;
    // its chip just falls back to the generic "Transit" label.
  }
}

function formatDuration(sec: number): string {
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Distances shrink to one decimal only when they're small enough to matter. */
function formatKm(km: number): string {
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

function hasCoords(p: SavedPlace): boolean {
  return typeof p.lat === 'number' && typeof p.lon === 'number';
}

function PlaceThumb({ p }: { p: SavedPlace }) {
  const cat = CATEGORY_MAP[p.category];
  const [ok, setOk] = useState(true);
  return p.image && ok ? (
    <img className="srow__thumb" src={p.image} alt="" loading="lazy" onError={() => setOk(false)} />
  ) : (
    <div className="srow__thumb srow__thumb--ph" style={{ background: cat.color }} aria-hidden>
      {cat.icon}
    </div>
  );
}

/**
 * The connector between two consecutive stops. Collapsed it's a slim bar; open
 * it offers the travel modes and, once one is picked, the leg is stored on the
 * itinerary.
 *
 * Which modes are offered depends on how far apart the two stops actually are
 * (great-circle from their coordinates, refined by a real road distance when
 * the router answers). Offering "Walk" between two cities was worse than
 * useless — it was the one option guaranteed to be wrong.
 *
 * Modes we cannot route (transit, train, bus, flight) are shown with a travel
 * time computed from that distance and labelled as an estimate. Nothing here is
 * a fare or a departure time; those live behind the clearly-separated booking
 * links, which is where real inventory is.
 */
function LegBar({ itin, from, to }: { itin: Itinerary; from: SavedPlace; to: SavedPlace }) {
  const { t } = useI18n();
  const setItineraryLeg = useAppStore((s) => s.setItineraryLeg);
  const removeItineraryLeg = useAppStore((s) => s.removeItineraryLeg);
  const setRouteGeometry = useAppStore((s) => s.setRouteGeometry);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<TravelMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = not probed / unknown, true = a road connects them, false = it doesn't.
  const [landRoute, setLandRoute] = useState<boolean | null>(null);
  const [probing, setProbing] = useState(false);
  const [roadKm, setRoadKm] = useState<number | null>(null);
  const [options, setOptions] = useState<TravelOption[] | null>(null);

  const legKey = `${itin.id}|${from.id}|${to.id}`;
  const [pick, setPick] = useState<ScheduledPick | null>(() => readScheduledMap()[legKey] ?? null);

  const leg = itin.legs.find((l) => l.fromId === from.id && l.toId === to.id) ?? null;
  const routable = hasCoords(from) && hasCoords(to);

  const straightKm = useMemo(
    () =>
      routable
        ? greatCircleKm({ lat: from.lat!, lon: from.lon! }, { lat: to.lat!, lon: to.lon! })
        : 0,
    [routable, from.lat, from.lon, to.lat, to.lon],
  );
  const tier = tierForKm(straightKm);
  const modes = useMemo(
    () => (routable ? modesForKm(straightKm, { landRoute }) : []),
    [routable, straightKm, landRoute],
  );

  const transitUrl =
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}` +
    `&destination=${to.lat},${to.lon}&travelmode=transit`;

  /** Place names are what booking sites want, and the city beats the venue. */
  const bookFrom = from.location || from.name;
  const bookTo = to.location || to.name;

  // Two things we can only learn from the network, and only for a leg the user
  // has actually opened: whether a road connects the stops at all (a failed car
  // route across open water is what tells us this is a flight-only leg), and
  // the real road distance, which sharpens the driving and coach estimates.
  //
  // The "already asked" flag is a ref, not state, on purpose: as state it would
  // be an effect dependency, so setting it would re-run the effect, whose
  // cleanup would then cancel the very request it had just started — the probe
  // spun forever without ever applying its answer.
  const probeStarted = useRef(false);
  useEffect(() => {
    if (!open || !routable || tier === 'local') return;
    if (probeStarted.current) return;
    probeStarted.current = true;
    if (straightKm > ROAD_PROBE_MAX_KM) {
      // Too far for anything on land to be on offer anyway — don't ask.
      setLandRoute(false);
      return;
    }
    let cancelled = false;
    setProbing(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/route?from=${from.lat},${from.lon}&to=${to.lat},${to.lon}&mode=driving`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error('probe failed');
        const data: RouteResponse = await res.json();
        if (cancelled) return;
        // `approximate` means the router could not connect them and fell back
        // to a straight line — in practice, water in the way.
        setLandRoute(!data.approximate);
        if (!data.approximate) setRoadKm(data.distanceKm);
      } catch {
        // A network failure is not evidence of an ocean: leave it unknown so
        // ground modes stay on offer rather than being wrongly withdrawn.
        if (!cancelled) setLandRoute(null);
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, routable, tier, straightKm, from.lat, from.lon, to.lat, to.lon]);

  // Booking hand-offs for an intercity leg. Fetched only when the picker is
  // open, and rendered under its own heading so it can't be mistaken for
  // something we computed.
  useEffect(() => {
    if (!open || tier === 'local' || options !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ from: bookFrom, to: bookTo });
        const res = await fetch(`/api/travel-options?${params}`, { cache: 'no-store' });
        if (!cancelled) setOptions(res.ok ? await res.json() : []);
      } catch {
        if (!cancelled) setOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tier, options, bookFrom, bookTo]);

  /** The four original modes have translations; the intercity three do not yet. */
  const modeLabel = (m: TravelMode): string =>
    m === 'train' ? EN.train : m === 'bus' ? EN.bus : m === 'flight' ? EN.flight : t('mode_' + m);

  const estimateFor = (m: TravelMode) =>
    estimateLeg(m, straightKm, ROAD.has(m) && roadKm !== null ? roadKm : undefined);

  async function choose(mode: TravelMode) {
    if (!routable) return;

    // Train / bus / flight: there is no router for these, so what gets stored
    // is our own computed estimate, flagged as approximate. The specific mode
    // goes to the side table because LegMode can't hold it (see above).
    if (mode === 'train' || mode === 'bus' || mode === 'flight') {
      const est = estimateFor(mode);
      writeScheduledMode(legKey, mode);
      setPick(mode);
      setItineraryLeg(itin.id, {
        fromId: from.id,
        toId: to.id,
        mode: 'transit',
        distanceKm: est.km,
        durationSec: est.durationSec ?? 0,
        approximate: true,
      });
      setOpen(false);
      return;
    }

    if (mode === 'transit') {
      // Local transit still has no free global routing API, so the schedule
      // itself comes from Google Maps. Unlike before, we don't hijack the tab
      // on selection — the hand-off is a link on the leg the user can take.
      writeScheduledMode(legKey, null);
      setPick(null);
      setItineraryLeg(itin.id, {
        fromId: from.id,
        toId: to.id,
        mode,
        distanceKm: straightKm,
        durationSec: 0,
        approximate: true,
      });
      setOpen(false);
      return;
    }

    setBusy(mode);
    setError(null);
    try {
      const res = await fetch(
        `/api/route?from=${from.lat},${from.lon}&to=${to.lat},${to.lon}&mode=${mode}`,
      );
      if (!res.ok) throw new Error('no route');
      const data: RouteResponse = await res.json();
      writeScheduledMode(legKey, null);
      setPick(null);
      setItineraryLeg(itin.id, {
        fromId: from.id,
        toId: to.id,
        // Narrowed to walking/cycling/driving by the early returns above, which
        // is exactly the routable subset of LegMode.
        mode,
        distanceKm: data.distanceKm,
        durationSec: data.durationSec,
        // exactOptionalPropertyTypes: only set the flag when it's actually true.
        ...(data.approximate ? { approximate: true as const } : {}),
      });
      // Show the leg the user just chose on the map, like the Travel tab does.
      if (data.geometry.length) setRouteGeometry(data.geometry);
      setOpen(false);
    } catch {
      setError(t('transport_failed'));
    } finally {
      setBusy(null);
    }
  }

  function drop() {
    writeScheduledMode(legKey, null);
    setPick(null);
    removeItineraryLeg(itin.id, from.id, to.id);
  }

  // What the chip shows: the stored mode, except that a stored `transit` may
  // really have been a train, coach or flight.
  const shown: TravelMode | null = leg ? (leg.mode === 'transit' ? (pick ?? 'transit') : leg.mode) : null;

  return (
    <li className="leg">
      <div className="leg__rail" aria-hidden />
      {leg && shown ? (
        <div className="leg__bar leg__bar--set">
          <button className="leg__summary" onClick={() => setOpen((v) => !v)}>
            <span>{MODE_ICON[shown]}</span>
            <strong>{modeLabel(shown)}</strong>
            {shown === 'transit' ? (
              <span className="leg__note">
                {formatKm(leg.distanceKm)} · {t('transit_gmaps')}
              </span>
            ) : (
              <span className="leg__note">
                {formatDuration(leg.durationSec)}
                {leg.approximate ? ` ${EN.est}` : ''} · {formatKm(leg.distanceKm)}
              </span>
            )}
          </button>
          {shown === 'transit' && (
            <a
              className="leg__x"
              href={transitUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={t('transit_gmaps')}
              aria-label={t('transit_gmaps')}
            >
              ↗
            </a>
          )}
          <button
            className="leg__x"
            onClick={drop}
            title={t('transport_remove')}
            aria-label={t('transport_remove')}
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          className="leg__bar leg__bar--empty"
          onClick={() => setOpen((v) => !v)}
          disabled={!routable}
          title={routable ? t('add_transport') : t('transport_no_coords')}
        >
          {busy
            ? `⏳ ${t('transport_finding')}`
            : `＋ ${t('add_transport')}` +
              (routable ? ` · ${formatKm(straightKm)} ${EN.apart}` : '')}
        </button>
      )}

      {open && (
        <div className="leg__picker">
          <p className="leg__dist">
            {formatKm(roadKm ?? straightKm)} {roadKm !== null ? EN.byRoad : EN.straightLine}
            {probing ? ` · ${EN.checkingRoad}` : ''}
          </p>

          <div className="leg__modes">
            {modes.map((m) => {
              const est = estimateFor(m);
              return (
                <button
                  key={m}
                  className={'leg__mode' + (shown === m ? ' leg__mode--on' : '')}
                  onClick={() => choose(m)}
                  disabled={busy !== null}
                  title={est.assumption}
                >
                  <span className="leg__modename">
                    {MODE_ICON[m]} {modeLabel(m)}
                  </span>
                  <span className="leg__modeest">
                    {est.durationSec === null
                      ? EN.noEstimate
                      : `~${formatDuration(est.durationSec)} ${EN.est}`}
                  </span>
                </button>
              );
            })}
          </div>

          {landRoute === false && straightKm <= ROAD_PROBE_MAX_KM && (
            <p className="leg__err">{EN.noLandRoute}</p>
          )}
          <p className="leg__estnote">{EN.estimateNote}</p>

          {tier !== 'local' && (
            <div className="leg__book">
              <h5 className="leg__bookh">{EN.bookHeading}</h5>
              {options === null ? (
                <p className="leg__estnote">{EN.bookLoading}</p>
              ) : options.length === 0 ? null : (
                <>
                  <ul className="leg__booklist">
                    {options.map((o) => (
                      <li key={o.id}>
                        <a
                          className="leg__booklink"
                          href={o.offer?.deepLink ?? o.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {o.label} <span className="leg__bookprov">{o.provider} ↗</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p className="leg__estnote">{EN.bookNote}</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="leg__err">{error}</p>}
    </li>
  );
}

// `guide` is optional: the panel renders even while a search is in flight, so a
// new search can't blank out a trip the user is editing. It's only used to
// suggest the currently-viewed place as a destination.
export default function ItineraryPanel({ guide }: { guide?: Guide }) {
  const { t, lang } = useI18n();
  const itineraries = useAppStore((s) => s.itineraries);
  const activeId = useAppStore((s) => s.activeItineraryId);
  const pinned = useAppStore((s) => s.pinned);

  const createItinerary = useAppStore((s) => s.createItinerary);
  const deleteItinerary = useAppStore((s) => s.deleteItinerary);
  const renameItinerary = useAppStore((s) => s.renameItinerary);
  const setActiveItinerary = useAppStore((s) => s.setActiveItinerary);
  const setItineraryDestination = useAppStore((s) => s.setItineraryDestination);
  const addToItinerary = useAppStore((s) => s.addToItinerary);
  const removeFromItinerary = useAppStore((s) => s.removeFromItinerary);
  const moveInItinerary = useAppStore((s) => s.moveInItinerary);
  const addItineraryDay = useAppStore((s) => s.addItineraryDay);
  const removeItineraryDay = useAppStore((s) => s.removeItineraryDay);
  const setStopDay = useAppStore((s) => s.setStopDay);

  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const select = useAppStore((s) => s.select);
  const setPanelTab = useAppStore((s) => s.setPanelTab);

  const [addSource, setAddSource] = useState<'browse' | 'pinned'>('browse');
  const [destText, setDestText] = useState('');
  const [editingDest, setEditingDest] = useState(false);
  const [newTripDest, setNewTripDest] = useState('');
  const [creating, setCreating] = useState(false);

  const active = itineraries.find((it) => it.id === activeId) ?? null;

  // The trip browses ITS OWN destination's guide, not whatever the search bar
  // is currently showing — that's what keeps a search elsewhere from quietly
  // re-pointing a trip in progress. Empty destination = query disabled.
  const destination = active?.destination ?? '';
  const { data: destGuide, isLoading: destLoading } = useGuide(destination, lang);

  const inItin = useMemo(() => new Set(active?.places.map((p) => p.id) ?? []), [active]);

  const browseCandidates = useMemo(
    () =>
      (destGuide?.destinations ?? [])
        .filter((d) => !inItin.has(d.id))
        .map((d) => savedFromDestination(d, destGuide?.title ?? destination))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 120),
    [destGuide, destination, inItin],
  );
  const pinnedCandidates = useMemo(
    () => pinned.filter((p) => !inItin.has(p.id)),
    [pinned, inItin],
  );

  // Places the user has already shown interest in make better destination
  // suggestions than a fixed list.
  const destSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [guide?.title, ...pinned.map((p) => p.location)]) {
      const v = (name ?? '').trim();
      if (!v || v === destination || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length === 4) break;
    }
    return out;
  }, [guide?.title, pinned, destination]);

  const applyDestination = (id: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    setItineraryDestination(id, v);
    setEditingDest(false);
    setAddSource('browse');
  };

  // --- Itinerary list (home) ---
  if (!active) {
    const startTrip = () => {
      const dest = newTripDest.trim();
      createItinerary(dest ? `Trip to ${dest}` : '', dest);
      setNewTripDest('');
      setCreating(false);
    };

    return (
      <div className="itin">
        <div className="itin__bar">
          <h3 className="itin__h">🧳 {t('itinerary_your')}</h3>
          <button className="btn btn--sm" onClick={() => setCreating((v) => !v)}>
            ＋ {t('itinerary_new')}
          </button>
        </div>

        {creating && (
          <form
            className="itin__new"
            onSubmit={(e) => {
              e.preventDefault();
              startTrip();
            }}
          >
            <label className="itin__newlabel" htmlFor="itin-new-dest">
              {t('itinerary_where')}
            </label>
            <div className="itin__newrow">
              <input
                id="itin-new-dest"
                className="itin__destinput"
                value={newTripDest}
                onChange={(e) => setNewTripDest(e.target.value)}
                placeholder={t('search_placeholder')}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <button className="btn btn--sm" type="submit">
                {t('create')}
              </button>
            </div>
            <div className="itin__chips">
              {destSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => setNewTripDest(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </form>
        )}

        {itineraries.length === 0 ? (
          <div className="empty">
            <p>{t('itinerary_empty')}</p>
          </div>
        ) : (
          <ul className="itin__list">
            {itineraries.map((it) => (
              <li key={it.id} className="itin__item">
                <button className="itin__open" onClick={() => setActiveItinerary(it.id)}>
                  <span className="itin__namewrap">
                    <span className="itin__name">{it.name}</span>
                    <span className="itin__sub">
                      📍 {it.destination || t('itinerary_dest_none')}
                    </span>
                  </span>
                  <span className="itin__count">
                    {it.places.length} {t('places')} · {it.days}{' '}
                    {t(it.days === 1 ? 'day_one' : 'day_many')}
                  </span>
                </button>
                <button
                  className="itin__del"
                  title={t('delete')}
                  aria-label={t('delete')}
                  onClick={() => deleteItinerary(it.id)}
                >
                  🗑️
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // --- One itinerary open (destination + days + stops + transport) ---
  const goTo = (p: SavedPlace) => {
    if (p.location && p.location !== query) setQuery(p.location);
    select(p.id);
    setPanelTab('explore');
  };

  const candidates = addSource === 'browse' ? browseCandidates : pinnedCandidates;
  const orderOf = new Map(active.places.map((p, i) => [p.id, i + 1]));
  const days = Array.from({ length: active.days }, (_, i) => i + 1);
  const stopsOn = (day: number) =>
    active.places.filter((p) => (active.dayOf[p.id] ?? 1) === day);

  return (
    <div className="itin">
      <button className="itin__back" onClick={() => setActiveItinerary(null)}>
        ← {t('itinerary_your')}
      </button>

      <div className="itin__head">
        <input
          className="itin__title"
          value={active.name}
          onChange={(e) => renameItinerary(active.id, e.target.value)}
          // Normalize once the user is done, not while they type — trimming
          // mid-edit is what made the space bar look broken.
          onBlur={(e) => {
            const cleaned = e.target.value.trim();
            renameItinerary(active.id, cleaned || t('itinerary_untitled'));
          }}
          aria-label={t('rename')}
          spellCheck={false}
        />
        <span className="itin__count">
          {active.places.length} {t('places')}
        </span>
      </div>

      {/* Destination: this trip's own, never inherited from the search bar. */}
      <div className="itin__dest">
        {editingDest ? (
          <form
            className="itin__destform"
            onSubmit={(e) => {
              e.preventDefault();
              applyDestination(active.id, destText);
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
                  onClick={() => applyDestination(active.id, s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </form>
        ) : (
          <div className="itin__destrow">
            <span className="itin__destname">
              📍 {destination || t('itinerary_dest_none')}
            </span>
            <button
              className="itin__destedit"
              onClick={() => {
                setDestText(destination);
                setEditingDest(true);
              }}
            >
              {destination ? t('change') : t('itinerary_where')}
            </button>
          </div>
        )}
        <p className="itin__desthint">{t('itinerary_dest_own')}</p>
      </div>

      {active.places.length === 0 && active.days === 1 ? (
        <div className="empty empty--sm">
          <p>{t('itinerary_empty_places')}</p>
        </div>
      ) : (
        days.map((day) => {
          const stops = stopsOn(day);
          return (
            <section className="itin__day" key={day}>
              <div className="itin__dayhead">
                <h4 className="itin__dayh">
                  {t('day')} {day}
                </h4>
                <span className="itin__count">
                  {stops.length} {t('places')}
                </span>
                {active.days > 1 && (
                  <button
                    className="itin__dayrm"
                    onClick={() => removeItineraryDay(active.id, day)}
                    title={t('remove_day')}
                    aria-label={t('remove_day')}
                  >
                    ✕
                  </button>
                )}
              </div>

              {stops.length === 0 ? (
                <p className="itin__dayempty">{t('day_empty')}</p>
              ) : (
                <ol className="itin__places">
                  {stops.map((p, i) => {
                    const cat = CATEGORY_MAP[p.category];
                    const next = stops[i + 1];
                    return [
                      <li key={p.id} className="srow">
                        <span className="srow__idx">{orderOf.get(p.id)}</span>
                        <PlaceThumb p={p} />
                        <button className="srow__main" onClick={() => goTo(p)}>
                          <span className="srow__name">{p.name}</span>
                          <span className="srow__cat" style={{ color: cat.color }}>
                            {cat.icon} {t('cat_' + p.category)}
                            {p.location && p.location !== destination ? ` · ${p.location}` : ''}
                          </span>
                        </button>
                        <div className="srow__ctrls">
                          {/* A one-day trip has nowhere to move a stop to, and
                              the row is tight enough without a dead control. */}
                          {active.days > 1 && (
                            <select
                              className="srow__day"
                              value={day}
                              onChange={(e) => setStopDay(active.id, p.id, Number(e.target.value))}
                              aria-label={t('move_to_day')}
                              title={t('move_to_day')}
                            >
                              {days.map((d) => (
                                <option key={d} value={d}>
                                  {t('day')} {d}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            disabled={i === 0}
                            onClick={() => moveInItinerary(active.id, p.id, -1)}
                            aria-label="Move up"
                          >
                            ↑
                          </button>
                          <button
                            disabled={i === stops.length - 1}
                            onClick={() => moveInItinerary(active.id, p.id, 1)}
                            aria-label="Move down"
                          >
                            ↓
                          </button>
                          <button
                            className="srow__rm"
                            onClick={() => removeFromItinerary(active.id, p.id)}
                            aria-label={t('remove')}
                            title={t('remove')}
                          >
                            ✕
                          </button>
                        </div>
                      </li>,
                      next ? (
                        <LegBar key={`${p.id}-leg`} itin={active} from={p} to={next} />
                      ) : null,
                    ];
                  })}
                </ol>
              )}
            </section>
          );
        })
      )}

      <button className="itin__addday" onClick={() => addItineraryDay(active.id)}>
        ＋ {t('add_day')}
      </button>

      <div className="itin__add">
        <h4 className="itin__addh">{t('itinerary_add_places')}</h4>
        <div className="seg" role="tablist">
          <button
            role="tab"
            aria-selected={addSource === 'browse'}
            className={'seg__btn' + (addSource === 'browse' ? ' seg__btn--on' : '')}
            onClick={() => setAddSource('browse')}
          >
            🗺️ {destination ? `${t('itinerary_places_in')} ${destination}` : t('browse_places')}
          </button>
          <button
            role="tab"
            aria-selected={addSource === 'pinned'}
            className={'seg__btn' + (addSource === 'pinned' ? ' seg__btn--on' : '')}
            onClick={() => setAddSource('pinned')}
          >
            📌 {t('from_pinned')} ({pinned.length})
          </button>
        </div>

        {addSource === 'browse' && !destination ? (
          <div className="empty empty--sm">
            <p>{t('itinerary_dest_first')}</p>
          </div>
        ) : addSource === 'browse' && destLoading ? (
          <div className="empty empty--sm">
            <p>{t('itinerary_loading_places')}</p>
          </div>
        ) : candidates.length === 0 ? (
          <div className="empty empty--sm">
            <p>
              {addSource === 'pinned' ? t('pinned_empty') : t('itinerary_no_places_found')}
            </p>
          </div>
        ) : (
          <ul className="itin__cands">
            {candidates.map((p) => {
              const cat = CATEGORY_MAP[p.category];
              return (
                <li key={p.id} className="srow srow--cand">
                  <PlaceThumb p={p} />
                  <div className="srow__main srow__main--static">
                    <span className="srow__name">{p.name}</span>
                    <span className="srow__cat" style={{ color: cat.color }}>
                      {cat.icon} {t('cat_' + p.category)}
                      {addSource === 'pinned' && p.location ? ` · ${p.location}` : ''}
                    </span>
                  </div>
                  <button
                    className="srow__add"
                    onClick={() => addToItinerary(active.id, p)}
                    aria-label={t('add_to_itinerary')}
                    title={t('add_to_itinerary')}
                  >
                    ＋
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
