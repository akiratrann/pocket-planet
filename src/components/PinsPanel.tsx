import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore, type SavedPlace } from '../store/useAppStore';
import { useI18n } from '../i18n';

// Same row thumbnail the itinerary uses. It lives inside ItineraryPanel and
// isn't exported, so it's mirrored here rather than reshaping that file.
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
 * Every pinned place, across every guide the user has explored, in one modal.
 * Pins are grouped by the guide they came from because a pin is only useful if
 * you can tell which trip it belongs to.
 */
export default function PinsPanel() {
  const { t } = useI18n();
  const pinned = useAppStore((s) => s.pinned);
  const togglePin = useAppStore((s) => s.togglePin);
  const setPinsOpen = useAppStore((s) => s.setPinsOpen);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const select = useAppStore((s) => s.select);
  const setPanelTab = useAppStore((s) => s.setPanelTab);

  const close = () => setPinsOpen(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPinsOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setPinsOpen]);

  const groups = useMemo(() => {
    const byLocation = new Map<string, SavedPlace[]>();
    for (const p of pinned) {
      const key = p.location || t('pins_unknown_place');
      const list = byLocation.get(key);
      if (list) list.push(p);
      else byLocation.set(key, [p]);
    }
    return [...byLocation.entries()];
  }, [pinned, t]);

  // Same jump the itinerary uses: load the place's guide first if we're looking
  // at a different one, then open its detail in Explore.
  const goTo = (p: SavedPlace) => {
    if (p.location && p.location !== query) setQuery(p.location);
    select(p.id);
    setPanelTab('explore');
    close();
  };

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div
        className="modal pins-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('pins_title')}
      >
        <button className="modal__close" onClick={close} aria-label={t('close')}>
          ×
        </button>
        <h2 className="pins__title">
          📌 {t('pins_title')}
          <span className="itin__count">
            {pinned.length} {t('places')}
          </span>
        </h2>

        {pinned.length === 0 ? (
          <div className="empty empty--sm">
            <p>{t('pinned_empty')}</p>
          </div>
        ) : (
          <div className="pins__scroll">
            {groups.map(([location, places]) => (
              <section key={location} className="pins__group">
                <h3 className="pins__grouph">
                  <span>🧭 {location}</span>
                  <span className="itin__count">{places.length}</span>
                </h3>
                <ul className="itin__cands">
                  {places.map((p) => {
                    const cat = CATEGORY_MAP[p.category];
                    return (
                      <li key={p.id} className="srow srow--cand">
                        <PlaceThumb p={p} />
                        <button className="srow__main" onClick={() => goTo(p)}>
                          <span className="srow__name">{p.name}</span>
                          <span className="srow__cat" style={{ color: cat.color }}>
                            {cat.icon} {t('cat_' + p.category)} · {location}
                          </span>
                        </button>
                        <div className="srow__ctrls">
                          <button
                            className="srow__rm"
                            onClick={() => togglePin(p)}
                            aria-label={t('unpin')}
                            title={t('unpin')}
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
