import { useState } from 'react';
import { CATEGORIES, CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { CategoryId, Destination } from '../types';
import PinButton from './PinButton';
import { ATTRIB, PlacePhoto, RankProvenance } from './DestinationDetail';
import './provenance.css';

function DestinationCard({
  d,
  showWhy,
  onToggleWhy,
}: {
  d: Destination;
  showWhy: boolean;
  onToggleWhy: () => void;
}) {
  const select = useAppStore((s) => s.select);
  const setHovered = useAppStore((s) => s.setHovered);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoveredId = useAppStore((s) => s.hoveredId);
  const { t } = useI18n();
  const cat = CATEGORY_MAP[d.category];
  return (
    // The card was a <button>; the score badge is now a button too, so the card
    // becomes a div with a full-bleed hit layer behind it (buttons can't nest).
    <div
      className={
        'dcard' +
        (selectedId === d.id ? ' dcard--active' : '') +
        (hoveredId === d.id ? ' dcard--hover' : '')
      }
      onMouseEnter={() => setHovered(d.id)}
      onMouseLeave={() => setHovered(null)}
      style={{ ['--cat-color' as string]: cat.color }}
    >
      <button className="dcard__hit" onClick={() => select(d.id)} aria-label={d.name} />
      <div className="dcard__rank" style={{ background: cat.color }}>
        #{d.rank}
      </div>
      {/* No label at this size — a 78px tile has no room for a caption, and the
          category icon already says "we know what this is, we just have no
          picture of it". */}
      <PlacePhoto src={d.image} category={d.category} variant="card" />
      <div className="dcard__body">
        <div className="dcard__title">
          {d.name}
          <button
            className="scorebadge scorebadge--btn"
            onClick={onToggleWhy}
            aria-expanded={showWhy}
            // The bare number is the most misreadable thing on the card, so the
            // hover text names its author before it names anything else.
            title={`${d.score}/100 — ${ATTRIB.badgeTip}. ${t('why_rank')} #${d.rank}?`}
          >
            {d.score}
            <span className="scorebadge__cue" aria-hidden="true">
              ⓘ
            </span>
          </button>
        </div>
        {d.description && <p className="dcard__desc">{d.description}</p>}
        <div className="dcard__meta">
          <span className="dcard__tag" style={{ color: cat.color }}>
            {cat.icon} {t('cat_' + d.category)}
          </span>
          {d.price && <span className="dcard__meta-item">💰 {d.price}</span>}
        </div>
      </div>
    </div>
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
  // Only one rank explanation is open at a time, so the list never turns into a
  // wall of expanded panels.
  const [whyId, setWhyId] = useState<string | null>(null);

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
                <DestinationCard
                  d={d}
                  showWhy={whyId === d.id}
                  onToggleWhy={() => setWhyId((cur) => (cur === d.id ? null : d.id))}
                />
                <PinButton place={savedFromDestination(d, location)} className="dcard__pin" />
                {whyId === d.id && <RankProvenance d={d} location={location} />}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
