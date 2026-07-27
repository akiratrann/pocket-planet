import { useEffect, useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { Destination } from '../types';
import FeedbackControls from './FeedbackControls';
import PinButton from './PinButton';

export default function DestinationDetail({ d, location }: { d: Destination; location: string }) {
  const select = useAppStore((s) => s.select);
  const quickAddToItinerary = useAppStore((s) => s.quickAddToItinerary);
  const { t } = useI18n();
  const cat = CATEGORY_MAP[d.category];

  const [added, setAdded] = useState(false);
  // Reset the "Added ✓" confirmation whenever we view a different place.
  useEffect(() => setAdded(false), [d.id]);

  // Build the gallery: `images` when present, else the single `image`.
  const photos = (d.images && d.images.length ? d.images : d.image ? [d.image] : []).filter(Boolean);
  const [active, setActive] = useState(0);
  const [broken, setBroken] = useState<Set<number>>(new Set());
  const shown = photos.filter((_, i) => !broken.has(i));
  const activeSrc = photos[active] && !broken.has(active) ? photos[active] : shown[0];

  return (
    <div className="detail">
      <button className="detail__back" onClick={() => select(null)}>
        {t('back_to_list')}
      </button>
      {activeSrc && (
        <img
          className="detail__hero"
          src={activeSrc}
          alt={d.name}
          onError={() => setBroken((prev) => new Set(prev).add(photos.indexOf(activeSrc)))}
        />
      )}
      {shown.length > 1 && (
        <div className="detail__gallery">
          {photos.map((src, i) =>
            broken.has(i) ? null : (
              <button
                key={src}
                type="button"
                className={'detail__thumb' + (photos[active] === src ? ' detail__thumb--active' : '')}
                onClick={() => setActive(i)}
                aria-label={`Photo ${i + 1} of ${d.name}`}
              >
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  onError={() => setBroken((prev) => new Set(prev).add(i))}
                />
              </button>
            ),
          )}
        </div>
      )}
      <div className="detail__head">
        <span className="detail__cat" style={{ background: cat.color }}>
          {cat.icon} {t('cat_' + d.category)}
        </span>
        <span className="detail__rank">
          #{d.rank} {t('most_recommended')} · {d.score}/100
        </span>
      </div>
      <h2 className="detail__title">{d.name}</h2>

      {d.reasons.length > 0 && (
        <ul className="detail__reasons">
          {d.reasons.map((r) => (
            <li key={r}>✓ {r}</li>
          ))}
        </ul>
      )}

      {d.description && <p className="detail__desc">{d.description}</p>}

      <dl className="detail__facts">
        {d.address && (
          <div>
            <dt>📍 {t('address')}</dt>
            <dd>{d.address}</dd>
          </div>
        )}
        {d.hours && (
          <div>
            <dt>🕑 {t('hours')}</dt>
            <dd>{d.hours}</dd>
          </div>
        )}
        {d.price && (
          <div>
            <dt>💰 {t('price')}</dt>
            <dd>{d.price}</dd>
          </div>
        )}
        {d.phone && (
          <div>
            <dt>📞 {t('phone')}</dt>
            <dd>{d.phone}</dd>
          </div>
        )}
      </dl>

      <div className="detail__actions">
        <button
          className={'btn' + (added ? ' btn--done' : '')}
          onClick={() => {
            quickAddToItinerary(savedFromDestination(d, location));
            setAdded(true);
          }}
        >
          {added ? `✓ ${t('added')}` : `🧳 ${t('add_to_itinerary')}`}
        </button>
        <PinButton place={savedFromDestination(d, location)} className="btn btn--ghost pinbtn--wide" withLabel />
        {d.url && (
          <a className="btn" href={d.url} target="_blank" rel="noreferrer">
            🌐 {t('website')}
          </a>
        )}
        {d.lat != null && d.lon != null && (
          <a
            className="btn btn--ghost"
            href={`https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=17/${d.lat}/${d.lon}`}
            target="_blank"
            rel="noreferrer"
          >
            🧭 {t('open_in_map')}
          </a>
        )}
      </div>

      <FeedbackControls destination={d} location={location} />
    </div>
  );
}
