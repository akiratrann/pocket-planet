import { useState } from 'react';
import type { Guide, LocationOpinions, Opinion } from '../types';
import { useAppStore } from '../store/useAppStore';

function OpinionList({ items, kind }: { items: Opinion[]; kind: 'pos' | 'neg' }) {
  return (
    <ul className={'opinions__list opinions__list--' + kind}>
      {items.map((o, i) => (
        <li key={i} className="opinions__item">
          <span className="opinions__text">{o.text}</span>
          {o.source &&
            (o.url ? (
              <a className="opinions__src" href={o.url} target="_blank" rel="noreferrer">
                {o.source}
              </a>
            ) : (
              <span className="opinions__src">{o.source}</span>
            ))}
        </li>
      ))}
    </ul>
  );
}

function TravellerOpinions({ opinions }: { opinions: LocationOpinions }) {
  const { positives, negatives } = opinions;
  if (!positives.length && !negatives.length) return null;
  return (
    <section className="opinions">
      <h4 className="opinions__title">What travellers say</h4>
      {positives.length > 0 && (
        <div className="opinions__group">
          <div className="opinions__head opinions__head--pos">👍 Praised for</div>
          <OpinionList items={positives} kind="pos" />
        </div>
      )}
      {negatives.length > 0 && (
        <div className="opinions__group">
          <div className="opinions__head opinions__head--neg">👎 Common gripes</div>
          <OpinionList items={negatives} kind="neg" />
        </div>
      )}
      <p className="opinions__basis">{opinions.basis}</p>
    </section>
  );
}

export default function AdvicePanel({ guide }: { guide: Guide }) {
  const [open, setOpen] = useState<string | null>(guide.advice[0]?.id ?? null);
  const opinions = guide.meta?.opinions;

  return (
    <div className="advice">
      {guide.intro && <p className="advice__intro">{guide.intro}</p>}

      {opinions && <TravellerOpinions opinions={opinions} />}

      {guide.advice.length === 0 && (
        <p className="empty">No detailed travel advice is available for this place yet.</p>
      )}

      {guide.advice.map((section) => {
        const isOpen = open === section.id;
        return (
          <div key={section.id} className={'accordion' + (isOpen ? ' accordion--open' : '')}>
            <button
              className="accordion__head"
              onClick={() => setOpen(isOpen ? null : section.id)}
            >
              <span>
                {section.icon} {section.title}
              </span>
              <span className="accordion__chevron">{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && <div className="accordion__body">{section.body}</div>}
          </div>
        );
      })}

      {guide.related.length > 0 && (
        <div className="advice__related">
          <h4>Explore nearby</h4>
          <RelatedLinks names={guide.related} />
        </div>
      )}

      <p className="advice__attribution">
        {guide.attribution} ·{' '}
        <a href={guide.sourceUrl} target="_blank" rel="noreferrer">
          View source
        </a>
      </p>
    </div>
  );
}

function RelatedLinks({ names }: { names: string[] }) {
  const setQuery = useAppStore((s) => s.setQuery);
  return (
    <div className="advice__related-list">
      {names.map((n) => (
        <button key={n} className="chip chip--ghost" onClick={() => setQuery(n)}>
          {n}
        </button>
      ))}
    </div>
  );
}
