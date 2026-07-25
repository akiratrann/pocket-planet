import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ingest, selfTune } from '../data/api';
import type { Guide } from '../types';

/**
 * The "brain" tab: shows what the system has learned for this place, lets you
 * feed it a new web resource to study, and lets you trigger a self-tuning pass.
 */
export default function LearningPanel({ guide }: { guide: Guide }) {
  const qc = useQueryClient();
  const meta = guide.meta;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const offline = !meta;

  async function study(withUrl?: string) {
    setBusy('study');
    setMsg(null);
    try {
      const r = await ingest(guide.title, withUrl);
      setMsg(`Studied “${r.source.title}” — found ${r.source.poiCount} place(s) via ${r.source.provider}.`);
      setUrl('');
      qc.invalidateQueries({ queryKey: ['guide'] });
    } catch (e) {
      setMsg(`Ingestion failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function tune() {
    setBusy('tune');
    setMsg(null);
    try {
      const r = await selfTune();
      setMsg(`Self-tuned to v${r.version}: ${r.rationale}`);
      qc.invalidateQueries({ queryKey: ['guide'] });
    } catch (e) {
      setMsg(`Tuning failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (offline) {
    return (
      <div className="learn">
        <div className="learn__offline">
          <h4>🧠 Learning engine offline</h4>
          <p>
            The app is reading Wikivoyage directly. Start the backend to enable
            feedback memory, web ingestion and self-tuning:
          </p>
          <pre className="learn__code">npm run dev:all</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="learn">
      <div className="learn__stats">
        <div className="stat">
          <div className="stat__num">{meta.provider}</div>
          <div className="stat__label">LLM engine</div>
        </div>
        <div className="stat">
          <div className="stat__num">v{meta.learnedVersion}</div>
          <div className="stat__label">Knowledge version</div>
        </div>
        <div className="stat">
          <div className="stat__num">{meta.feedbackApplied}</div>
          <div className="stat__label">Lessons here</div>
        </div>
        <div className="stat">
          <div className="stat__num">{meta.ingestedPois}</div>
          <div className="stat__label">Web POIs</div>
        </div>
      </div>

      <div className="learn__section">
        <h4>📡 Study a new web resource</h4>
        <p className="learn__hint">
          Paste a URL (a “best things to do in {guide.title}” article, a blog, an
          official site) and the engine will read it, extract places, and merge
          them into this guide.
        </p>
        <div className="learn__row">
          <input
            className="learn__input"
            placeholder={`https://…  (about ${guide.title})`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn" disabled={!!busy || !url.trim()} onClick={() => study(url)}>
            {busy === 'study' ? '…' : 'Study'}
          </button>
        </div>
        <button className="btn btn--ghost learn__auto" disabled={!!busy} onClick={() => study()}>
          ✨ Auto-study {guide.title} (Wikipedia)
        </button>
      </div>

      <div className="learn__section">
        <h4>🔧 Self-improve</h4>
        <p className="learn__hint">
          Review all feedback and update the global ranking + category rules so
          every location benefits. (Runs automatically on a schedule too.)
        </p>
        <button className="btn" disabled={!!busy} onClick={tune}>
          {busy === 'tune' ? 'Tuning…' : 'Run self-tuning now'}
        </button>
      </div>

      {meta.sources.length > 0 && (
        <div className="learn__section">
          <h4>📚 Sources studied for {guide.title}</h4>
          <ul className="learn__sources">
            {meta.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>{' '}
                <span className="learn__src-meta">
                  · {s.poiCount} places · {new Date(s.fetchedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && <div className="learn__msg">{msg}</div>}
    </div>
  );
}
