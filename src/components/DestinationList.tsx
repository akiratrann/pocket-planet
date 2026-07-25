import { useState } from 'react';
import { CATEGORIES, CATEGORY_MAP } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import type { CategoryId, Destination } from '../types';

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
            {cat.icon} {cat.label}
          </span>
          {d.price && <span className="dcard__meta-item">💰 {d.price}</span>}
        </div>
      </div>
    </button>
  );
}

export default function DestinationList({ destinations }: { destinations: Destination[] }) {
  const active = useAppStore((s) => s.activeCategories);

  if (!destinations.length) {
    return (
      <div className="empty">
        <p>No destinations found for this filter.</p>
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
              <span>{cat.icon} {cat.label}</span>
              <span className="dlist__count">{items.length}</span>
            </h3>
            {items.map((d) => (
              <DestinationCard key={d.id} d={d} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
