import { useState } from 'react';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import type { Destination } from '../types';
import FeedbackControls from './FeedbackControls';

export default function DestinationDetail({ d, location }: { d: Destination; location: string }) {
  const select = useAppStore((s) => s.select);
  const [imgOk, setImgOk] = useState(true);
  const cat = CATEGORY_MAP[d.category];

  return (
    <div className="detail">
      <button className="detail__back" onClick={() => select(null)}>
        ← Back to list
      </button>
      {d.image && imgOk && (
        <img className="detail__hero" src={d.image} alt={d.name} onError={() => setImgOk(false)} />
      )}
      <div className="detail__head">
        <span className="detail__cat" style={{ background: cat.color }}>
          {cat.icon} {cat.label}
        </span>
        <span className="detail__rank">
          #{d.rank} most recommended · {d.score}/100
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
            <dt>📍 Address</dt>
            <dd>{d.address}</dd>
          </div>
        )}
        {d.hours && (
          <div>
            <dt>🕑 Hours</dt>
            <dd>{d.hours}</dd>
          </div>
        )}
        {d.price && (
          <div>
            <dt>💰 Price</dt>
            <dd>{d.price}</dd>
          </div>
        )}
        {d.phone && (
          <div>
            <dt>📞 Phone</dt>
            <dd>{d.phone}</dd>
          </div>
        )}
      </dl>

      <div className="detail__actions">
        {d.url && (
          <a className="btn" href={d.url} target="_blank" rel="noreferrer">
            🌐 Website
          </a>
        )}
        {d.lat != null && d.lon != null && (
          <a
            className="btn btn--ghost"
            href={`https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=17/${d.lat}/${d.lon}`}
            target="_blank"
            rel="noreferrer"
          >
            🧭 Open in map
          </a>
        )}
      </div>

      <FeedbackControls destination={d} location={location} />
    </div>
  );
}
