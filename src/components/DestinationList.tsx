import { useState } from 'react';
import { CATEGORIES, CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { CategoryId, Destination } from '../types';
import PinButton from './PinButton';

function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="scorebadge" title={`Recommendation score ${score}/100`}>
      {score}
    </span>
  );
}

function DestinationCard({ d }: { d: Destination }) {
  const select = useAppStore((s) => s.select);
  const setHovered = useAppStore((s) => s.setHovered);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoveredId = useAppStore((s) => s.hoveredId);
  const { t } = useI18n();
  const [imgOk, setImgOk] = useState(true);
  const cat = CATEGORY_MAP[d.category];
  return (
    <button
      className={
        'dcard' +
        (selectedId === d.id ? ' dcard--active' : '') +
        (hoveredId === d.id ? ' dcard--hover' : '')
      }
      onClick={() => select(d.id)}
      onMouseEnter={() => setHovered(d.id)}
      onMouseLeave={() => setHovered(null)}
      style={{ ['--cat-color' as string]: cat.color }}
    >
      <div className="dcard__rank" style={{ background: cat.color }}>
        #{d.rank}
      </div>
      {d.image && imgOk ? (
        <img
          className="dcard__thumb"
          src={d.image}
          alt=""
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      ) : (
        <div className="dcard__thumb dcard__thumb--placeholder">{cat.icon}</div>
      )}
      <div className="dcard__body">
        <div className="dcard__title">
          {d.name}
          <ScoreBadge score={d.score} />
        </div>
        {d.description && <p className="dcard__desc">{d.description}</p>}
        <div className="dcard__meta">
          <span className="dcard__tag" style={{ color: cat.color }}>
            {cat.icon} {t('cat_' + d.category)}
          </span>
          {d.price && <span className="dcard__meta-item">💰 {d.price}</span>}
        </div>
      </div>
    </button>
  );
}

export default function DestinationList({
  destinations,
  location,
}: {
  destinations: Destination[];
  location: string;
}) {
  const active = useAppStore((s) => s.activeCategories);
  const { t } = useI18n();

  if (!destinations.length) {
    return (
      <div className="empty">
        <p>{t('no_filter_results')}</p>
      </div>
    );
  }

  // Show as ranked sections per category, respecting active filter.
  const visibleCats: CategoryId[] = CATEGORIES.map((c) => c.id).filter(
    (id) => active.size === 0 || active.has(id),
  );

  return (
    <div className="dlist">
      {visibleCats.map((id) => {
        const items = destinations.filter((d) => d.category === id).sort((a, b) => a.rank - b.rank);
        if (!items.length) return null;
        const cat = CATEGORY_MAP[id];
        return (
          <section key={id} className="dlist__section">
            <h3 className="dlist__heading" style={{ borderColor: cat.color }}>
              <span>{cat.icon} {t('cat_' + id)}</span>
              <span className="dlist__count">{items.length}</span>
            </h3>
            {items.map((d) => (
              <div key={d.id} className="dcard-wrap">
                <DestinationCard d={d} />
                <PinButton place={savedFromDestination(d, location)} className="dcard__pin" />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
