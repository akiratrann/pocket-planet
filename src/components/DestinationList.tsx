import { useState } from 'react';
import { CATEGORIES, CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { CategoryId, Destination } from '../types';
import PinButton from './PinButton';
import { PlacePhoto, RankProvenance } from './DestinationDetail';
import './provenance.css';

/**
 * The shortest form of the score attribution, for the badge's hover text. Most
 * readers never open the panel, so this is the only place the bare number gets
 * an author. Mirrors ATTRIB.badgeTip in DestinationDetail.tsx.
 * TODO: move to i18n
 */
const BADGE_TIP = 'Pocket Planet’s own score, not a source’s rating';

/**
 * Quantise the 0-100 score into one of four named bands.
 *
 * A bare number is unreadable on its own — nothing on the card tells a reader
 * whether 62 is good. Bands give the number a vocabulary, and the badge then
 * encodes it three ways at once (band colour, band name, and a fill bar
 * showing the position on the scale) so the meaning never rests on colour
 * alone. Four bands, not a continuous ramp: a gradient says "78 is slightly
 * more than 74", which is not the fact anyone is deciding on.
 */
type ScoreBand = 'essential' | 'excellent' | 'worth' | 'minor';
function scoreBand(score: number): ScoreBand {
  if (score >= 85) return 'essential';
  if (score >= 70) return 'excellent';
  if (score >= 50) return 'worth';
  return 'minor';
}

function DestinationCard({
  d,
  hero,
  showWhy,
  onToggleWhy,
}: {
  d: Destination;
  /** The #1 of its category section — rendered as the headline card. */
  hero: boolean;
  showWhy: boolean;
  onToggleWhy: () => void;
}) {
  const select = useAppStore((s) => s.select);
  const setHovered = useAppStore((s) => s.setHovered);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoveredId = useAppStore((s) => s.hoveredId);
  const { t } = useI18n();
  const cat = CATEGORY_MAP[d.category];
  const band = scoreBand(d.score);
  return (
    // The card was a <button>; the score badge is now a button too, so the card
    // becomes a div with a full-bleed hit layer behind it (buttons can't nest).
    <div
      className={
        'dcard' +
        (hero ? ' dcard--hero' : '') +
        (selectedId === d.id ? ' dcard--active' : '') +
        (hoveredId === d.id ? ' dcard--hover' : '')
      }
      onMouseEnter={() => setHovered(d.id)}
      onMouseLeave={() => setHovered(null)}
      style={{ ['--cat-color' as string]: cat.color }}
    >
      <button className="dcard__hit" onClick={() => select(d.id)} aria-label={d.name} />
      {/* No category colour here any more: a rank is an ordinal, not a status,
          and eight competing hues in one list is a legend to memorise rather
          than a signal. The chip is neutral and sits on the image. */}
      <div className="dcard__rank">#{d.rank}</div>
      {/* The headline card's image is a full-width banner, so an empty one is a
          large area that has to say something or it reads as a load that never
          finished. A 78px thumb has no room for a caption and does not need
          one — the icon alone already says "we know what this is, we just have
          no picture of it". */}
      <PlacePhoto
        src={d.image}
        category={d.category}
        variant="card"
        label={hero ? t('photo_none') : undefined}
      />
      <div className="dcard__body">
        <div className="dcard__title">
          {d.name}
          <button
            className="scorebadge scorebadge--btn"
            data-band={band}
            // Drives the width of the fill bar, i.e. where this score sits on
            // the 0-100 scale. That position is the badge's third encoding
            // channel, after colour and the band's name.
            style={{ ['--score' as string]: d.score }}
            onClick={onToggleWhy}
            aria-expanded={showWhy}
            // The bare number is the most misreadable thing on the card, so the
            // hover text names the band, then names the score's author.
            title={`${d.score}/100 — ${t('band_' + band)}. ${BADGE_TIP}. ${t('why_rank')} #${d.rank}?`}
          >
            <span className="scorebadge__num">
              {d.score}
              <span className="scorebadge__cue" aria-hidden="true">
                ⓘ
              </span>
            </span>
            <span className="scorebadge__track" aria-hidden="true" />
            {/* Shown only on the headline card (CSS): naming the scale once per
                section teaches it; naming it on all fifteen rows is clutter. */}
            <span className="scorebadge__band">{t('band_' + band)}</span>
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
            {items.map((d, i) => (
              <div key={d.id} className="dcard-wrap">
                <DestinationCard
                  d={d}
                  // One headline card per section — its own #1. Two tiers is
                  // hierarchy; a third would just be noise.
                  hero={i === 0}
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
