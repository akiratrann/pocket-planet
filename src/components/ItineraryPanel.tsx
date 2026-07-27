import { useMemo, useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import {
  useAppStore,
  savedFromDestination,
  type Itinerary,
  type LegMode,
  type SavedPlace,
} from '../store/useAppStore';
import { useGuide } from '../hooks/useGuide';
import { useI18n } from '../i18n';
import type { Guide } from '../types';

/** Shape returned by GET /api/route — see server/pipeline/routing.ts. */
interface RouteResponse {
  mode: string;
  distanceKm: number;
  durationSec: number;
  geometry: Array<[number, number]>;
  steps: string[];
  approximate?: boolean;
}

const LEG_MODES: Array<{ id: LegMode; icon: string }> = [
  { id: 'walking', icon: '🚶' },
  { id: 'cycling', icon: '🚲' },
  { id: 'driving', icon: '🚗' },
  { id: 'transit', icon: '🚆' },
];

const MODE_ICON: Record<LegMode, string> = {
  walking: '🚶',
  cycling: '🚲',
  driving: '🚗',
  transit: '🚆',
};

function formatDuration(sec: number): string {
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
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
 * itinerary. Transit is a Google Maps hand-off (no free global transit routing
 * — same reason TravelPanel deep-links it) so it carries no in-app duration.
 */
function LegBar({ itin, from, to }: { itin: Itinerary; from: SavedPlace; to: SavedPlace }) {
  const { t } = useI18n();
  const setItineraryLeg = useAppStore((s) => s.setItineraryLeg);
  const removeItineraryLeg = useAppStore((s) => s.removeItineraryLeg);
  const setRouteGeometry = useAppStore((s) => s.setRouteGeometry);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<LegMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leg = itin.legs.find((l) => l.fromId === from.id && l.toId === to.id) ?? null;
  const routable = hasCoords(from) && hasCoords(to);
  const transitUrl =
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}` +
    `&destination=${to.lat},${to.lon}&travelmode=transit`;

  async function choose(mode: LegMode) {
    if (!routable) return;

    if (mode === 'transit') {
      window.open(transitUrl, '_blank', 'noopener,noreferrer');
      setItineraryLeg(itin.id, {
        fromId: from.id,
        toId: to.id,
        mode,
        distanceKm: 0,
        durationSec: 0,
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
      setItineraryLeg(itin.id, {
        fromId: from.id,
        toId: to.id,
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

  return (
    <li className="leg">
      <div className="leg__rail" aria-hidden />
      {leg ? (
        <div className="leg__bar leg__bar--set">
          <button className="leg__summary" onClick={() => setOpen((v) => !v)}>
            <span>{MODE_ICON[leg.mode]}</span>
            <strong>{t('mode_' + leg.mode)}</strong>
            {leg.mode === 'transit' ? (
              <span className="leg__note">{t('transit_gmaps')}</span>
            ) : (
              <span className="leg__note">
                {formatDuration(leg.durationSec)} · {leg.distanceKm.toFixed(1)} km
                {leg.approximate ? ` · ${t('transport_approx')}` : ''}
              </span>
            )}
          </button>
          {leg.mode === 'transit' && (
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
            onClick={() => removeItineraryLeg(itin.id, from.id, to.id)}
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
          {busy ? `⏳ ${t('transport_finding')}` : `＋ ${t('add_transport')}`}
        </button>
      )}

      {open && (
        <div className="leg__modes">
          {LEG_MODES.map((m) => (
            <button
              key={m.id}
              className={'leg__mode' + (leg?.mode === m.id ? ' leg__mode--on' : '')}
              onClick={() => choose(m.id)}
              disabled={busy !== null}
            >
              {m.icon} {t('mode_' + m.id)}
            </button>
          ))}
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
