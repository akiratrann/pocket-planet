import { useState } from 'react';
import type { Guide } from '../types';
import { useAppStore } from '../store/useAppStore';

export default function AdvicePanel({ guide }: { guide: Guide }) {
  const [open, setOpen] = useState<string | null>(guide.advice[0]?.id ?? null);

  return (
    <div className="advice">
      {guide.intro && <p className="advice__intro">{guide.intro}</p>}

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
