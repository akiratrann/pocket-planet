import { useMemo, useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination, type SavedPlace } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { Guide } from '../types';

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

export default function ItineraryPanel({ guide }: { guide: Guide }) {
  const { t } = useI18n();
  const itineraries = useAppStore((s) => s.itineraries);
  const activeId = useAppStore((s) => s.activeItineraryId);
  const pinned = useAppStore((s) => s.pinned);

  const createItinerary = useAppStore((s) => s.createItinerary);
  const deleteItinerary = useAppStore((s) => s.deleteItinerary);
  const renameItinerary = useAppStore((s) => s.renameItinerary);
  const setActiveItinerary = useAppStore((s) => s.setActiveItinerary);
  const addToItinerary = useAppStore((s) => s.addToItinerary);
  const removeFromItinerary = useAppStore((s) => s.removeFromItinerary);
  const moveInItinerary = useAppStore((s) => s.moveInItinerary);

  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const select = useAppStore((s) => s.select);
  const setPanelTab = useAppStore((s) => s.setPanelTab);

  const [addSource, setAddSource] = useState<'browse' | 'pinned'>('browse');

  const active = itineraries.find((it) => it.id === activeId) ?? null;

  const inItin = useMemo(
    () => new Set(active?.places.map((p) => p.id) ?? []),
    [active],
  );

  const browseCandidates = useMemo(
    () =>
      guide.destinations
        .filter((d) => !inItin.has(d.id))
        .map((d) => savedFromDestination(d, guide.title))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 120),
    [guide, inItin],
  );
  const pinnedCandidates = useMemo(
    () => pinned.filter((p) => !inItin.has(p.id)),
    [pinned, inItin],
  );

  // --- Itinerary list (home) ---
  if (!active) {
    return (
      <div className="itin">
        <div className="itin__bar">
          <h3 className="itin__h">🧳 {t('itinerary_your')}</h3>
          <button className="btn btn--sm" onClick={() => createItinerary(`Trip to ${guide.title}`)}>
            ＋ {t('itinerary_new')}
          </button>
        </div>
        {itineraries.length === 0 ? (
          <div className="empty">
            <p>{t('itinerary_empty')}</p>
          </div>
        ) : (
          <ul className="itin__list">
            {itineraries.map((it) => (
              <li key={it.id} className="itin__item">
                <button className="itin__open" onClick={() => setActiveItinerary(it.id)}>
                  <span className="itin__name">{it.name}</span>
                  <span className="itin__count">
                    {it.places.length} {t('places')}
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

  // --- One itinerary open (edit + add places) ---
  const goTo = (p: SavedPlace) => {
    if (p.location && p.location !== query) setQuery(p.location);
    select(p.id);
    setPanelTab('explore');
  };

  const candidates = addSource === 'browse' ? browseCandidates : pinnedCandidates;

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

      {active.places.length === 0 ? (
        <div className="empty empty--sm">
          <p>{t('itinerary_empty_places')}</p>
        </div>
      ) : (
        <ol className="itin__places">
          {active.places.map((p, i) => {
            const cat = CATEGORY_MAP[p.category];
            return (
              <li key={p.id} className="srow">
                <span className="srow__idx">{i + 1}</span>
                <PlaceThumb p={p} />
                <button className="srow__main" onClick={() => goTo(p)}>
                  <span className="srow__name">{p.name}</span>
                  <span className="srow__cat" style={{ color: cat.color }}>
                    {cat.icon} {t('cat_' + p.category)}
                    {p.location && p.location !== guide.title ? ` · ${p.location}` : ''}
                  </span>
                </button>
                <div className="srow__ctrls">
                  <button
                    disabled={i === 0}
                    onClick={() => moveInItinerary(active.id, p.id, -1)}
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    disabled={i === active.places.length - 1}
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
              </li>
            );
          })}
        </ol>
      )}

      <div className="itin__add">
        <h4 className="itin__addh">{t('itinerary_add_places')}</h4>
        <div className="seg" role="tablist">
          <button
            role="tab"
            aria-selected={addSource === 'browse'}
            className={'seg__btn' + (addSource === 'browse' ? ' seg__btn--on' : '')}
            onClick={() => setAddSource('browse')}
          >
            🗺️ {t('browse_places')}
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

        {candidates.length === 0 ? (
          <div className="empty empty--sm">
            <p>{addSource === 'pinned' ? t('pinned_empty') : t('no_filter_results')}</p>
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
