import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchCapabilities,
  fetchPersonal,
  ingest,
  trainModel,
  trainStatus,
  type Capabilities,
  type TrainStatus,
} from '../data/api';
import { useAppStore } from '../store/useAppStore';
import { RANKING_WEIGHTS } from '../data/ranking';
import { OVERRIDE_CAP } from '../core/learning';
import { CATEGORY_MAP } from '../data/categories';
import type { Guide, ScoringMeta } from '../types';
import './learn-scoring.css';

/**
 * One line of the scoring table: what the signal is, and what it is worth.
 */
interface SignalRow {
  key: string;
  label: string;
  value: string;
  /** An extra line under the row (used for the per-source mention weights). */
  detail?: string;
}

/**
 * A weight, read from what the SERVER reported. Falls back to the value
 * compiled into the app for a weight the learned state predates — which is a
 * real case: `civicNamePenalty` was added after the current learned state was
 * saved, and the ranker itself falls back the same way.
 */
function weightOf(weights: Record<string, number>, key: keyof typeof RANKING_WEIGHTS): number {
  const v = weights[key];
  return Number.isFinite(v) ? v : (RANKING_WEIGHTS[key] as number);
}

/**
 * "What does this number represent?" — answered from the model that actually
 * produced it.
 *
 * The numbers here are the ones the backend reported for THIS guide
 * (`meta.scoring`), not a second copy of the defaults: the model has been
 * retrained two dozen times and its weights no longer match what shipped, so a
 * hand-written table would be a confident description of a model that no longer
 * exists. When the backend doesn't report them, that is said out loud instead of
 * quietly showing the defaults as if they were live.
 */
function ScoringExplainer({ guide }: { guide: Guide }) {
  const { t } = useI18n();
  const reported = guide.meta?.scoring;
  const scoring: ScoringMeta = reported ?? {
    weights: { ...RANKING_WEIGHTS },
    mentionWeights: {},
    mentionCap: 0,
    feedbackCap: OVERRIDE_CAP,
  };
  const w = scoring.weights;
  const upto = t('sig_upto');

  const rows: SignalRow[] = [
    { key: 'wikidata', label: t('sig_wikidata'), value: `+${weightOf(w, 'hasWikidata')}` },
    { key: 'image', label: t('sig_image'), value: `+${weightOf(w, 'hasImage')}` },
    { key: 'coords', label: t('sig_coordinates'), value: `+${weightOf(w, 'hasCoordinates')}` },
    { key: 'url', label: t('sig_url'), value: `+${weightOf(w, 'hasUrl')}` },
    { key: 'address', label: t('sig_address'), value: `+${weightOf(w, 'hasAddress')}` },
    { key: 'hours', label: t('sig_hours'), value: `+${weightOf(w, 'hasHours')}` },
    { key: 'price', label: t('sig_price'), value: `+${weightOf(w, 'hasPrice')}` },
    {
      key: 'desc',
      label: `${t('sig_description')} ${weightOf(w, 'descriptionLengthChars')} ${t('sig_chars')}`,
      value: `${upto} +${weightOf(w, 'descriptionLengthMax')}`,
    },
    { key: 'order', label: t('sig_order'), value: `${upto} +${weightOf(w, 'earlyOrderBonus')}` },
    {
      key: 'keywords',
      label: t('sig_keywords'),
      value: `+${weightOf(w, 'notableKeywordBonus')} (${t('sig_keywords_cap')} +${weightOf(w, 'notableKeywordCap')})`,
    },
  ];

  if (scoring.mentionCap > 0) {
    const per = Object.entries(scoring.mentionWeights)
      .sort((a, b) => b[1] - a[1])
      .map(([name, pts]) => `${name} +${pts}`)
      .join(' · ');
    rows.push({
      key: 'mentions',
      label: t('sig_mentions'),
      value: `${upto} +${scoring.mentionCap}`,
      ...(per ? { detail: `${per} ${t('sig_mentions_per')}` } : {}),
    });
  }
  rows.push(
    { key: 'feedback', label: t('sig_feedback'), value: `±${scoring.feedbackCap}` },
    { key: 'civic', label: t('sig_civic'), value: `−${weightOf(w, 'civicNamePenalty')}` },
  );

  return (
    <div className="learn__section">
      <h4>📐 {t('score_how_title')}</h4>
      {/* First sentence, before any number: whose score this is. */}
      <p className="learn__hint">{t('score_how_intro')}</p>

      <p className="score__start">
        {t('score_start')} <strong>{weightOf(w, 'base')}</strong> {t('score_points')}.
      </p>

      <div className="score__label">{t('score_signals_label')}</div>
      <ul className="score__table">
        {rows.map((r) => (
          <li className="score__row" key={r.key}>
            <span className="score__sig">
              {r.label}
              {r.detail && <span className="score__detail">{r.detail}</span>}
            </span>
            <span className={'score__pts' + (r.value.startsWith('−') ? ' score__pts--neg' : '')}>
              {r.value}
            </span>
          </li>
        ))}
      </ul>
      <p className="learn__hint learn__hint--muted">
        {reported ? t('score_weights_note') : t('score_weights_default_note')}
      </p>

      <div className="score__label">{t('score_scale_label')}</div>
      <p className="learn__hint">{t('score_scale_body')}</p>

      {/* The limits are not a footnote. A number in a box is read as a verdict
          unless it is told, plainly, what it is not. */}
      <div className="score__label score__label--warn">{t('score_not_label')}</div>
      <ul className="score__nots">
        <li>{t('score_not_quality')}</li>
        <li>{t('score_not_rating')}</li>
        <li>{t('score_not_endorsement')}</li>
        <li>{t('score_not_fair')}</li>
      </ul>
    </div>
  );
}

/**
 * What this account changes, stated exhaustively.
 *
 * A "personalised for you" claim is only honest if the reader can see the whole
 * of what it is based on, so this shows the actual saved-place counts behind it
 * and then says that there is nothing else. Signed out, it says that too rather
 * than implying an account unlocks a better guide — it doesn't; the guide is the
 * same for everyone.
 */
function PersonalSummary({ guide }: { guide: Guide }) {
  const { t, lang } = useI18n();
  const authUser = useAppStore((s) => s.authUser);
  const { data } = useQuery({
    queryKey: ['personal', guide.title, lang, authUser?.id ?? null],
    queryFn: () => fetchPersonal(guide.title, lang),
    enabled: !!authUser,
    staleTime: 60_000,
  });

  return (
    <div className="learn__section">
      <h4>🧭 {t('learn_personal_title')}</h4>
      {!authUser ? (
        <p className="learn__hint learn__hint--muted">{t('learn_personal_guest')}</p>
      ) : !data ? (
        <p className="learn__hint learn__hint--muted">…</p>
      ) : data.taste.length === 0 ? (
        <p className="learn__hint learn__hint--muted">{t('learn_personal_none')}</p>
      ) : (
        <>
          <p className="learn__hint">{t('learn_personal_body')}</p>
          <p className="score__start">
            <strong>{data.savedTotal}</strong> {t('learn_personal_saved')}
            {data.savedHere > 0 && (
              <>
                {' · '}
                <strong>{data.savedHere}</strong> {t('learn_personal_here')}
              </>
            )}
          </p>
          <div className="score__label">{t('learn_personal_cats')}</div>
          <div className="score__cats">
            {data.taste.map((c) => (
              <span className="score__cat" key={c.category}>
                {CATEGORY_MAP[c.category]?.icon} {t('cat_' + c.category)}
                <span className="score__catn">{c.saved}</span>
              </span>
            ))}
          </div>
          <p className="learn__hint learn__hint--muted">{t('learn_personal_note')}</p>
        </>
      )}
    </div>
  );
}

/**
 * The "brain" tab: explains how a place's score is worked out, shows what this
 * account personalises, shows what the system has learned for this place, lets
 * you feed it a new web resource to study, and lets you train the ranking model
 * on accumulated real-world signal (mentions + your feedback).
 */
export default function LearningPanel({ guide }: { guide: Guide }) {
  const qc = useQueryClient();
  const meta = guide.meta;
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<TrainStatus | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Re-ask the backend whenever the signed-in identity changes: logging in or
  // out has to move the controls without a reload.
  const authUser = useAppStore((s) => s.authUser);

  const offline = !meta;

  useEffect(() => {
    if (offline) return;
    trainStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [offline, meta?.learnedVersion]);

  useEffect(() => {
    if (offline) return;
    let live = true;
    fetchCapabilities().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, [offline, authUser?.id]);

  // Until the answer arrives, assume nothing is permitted — better a control
  // that appears a moment late than one that appears and then 401s.
  const canIngest = caps?.canIngest ?? false;
  const canTrain = caps?.canTrain ?? false;

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

  async function train() {
    setBusy('train');
    setMsg(null);
    try {
      const r = await trainModel();
      setMsg(`Trained to v${r.version}: ${r.rationale}`);
      setStatus((s) => (s ? { ...s, last: r, learnedVersion: r.version } : s));
      qc.invalidateQueries({ queryKey: ['guide'] });
    } catch (e) {
      setMsg(`Training failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  // No `meta` means this guide came from the client-side Wikivoyage fallback
  // rather than our backend — places still load, but nothing that depends on
  // the backend (feedback memory, ingestion, self-tuning) is available.
  //
  // This used to print "npm run dev:all", which is a developer instruction: in
  // production it reached real users as advice they could neither follow nor
  // understand. Describe the state and what still works instead.
  if (offline) {
    return (
      <div className="learn">
        <div className="learn__offline">
          <h4>🧠 {t('learn_offline_title')}</h4>
          <p>{t('learn_offline_body')}</p>
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

      {/* First thing in the tab: the answer to "what does this number mean?".
          It used to be answerable only from the little ⓘ on a card, which is
          not where a reader goes looking for a methodology. */}
      <ScoringExplainer guide={guide} />

      <PersonalSummary guide={guide} />

      <div className="learn__section">
        <h4>📡 Study a new web resource</h4>
        {canIngest ? (
          <>
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
          </>
        ) : (
          <p className="learn__hint learn__hint--muted">{t('learn_study_signin')}</p>
        )}
      </div>

      <div className="learn__section">
        <h4>🧠 Train the model</h4>
        <p className="learn__hint">
          The app records what makes places great — from community buzz (Reddit,
          Travel Stack Exchange) and your feedback — then fits its ranking model
          to that real signal so every location worldwide benefits. (Trains on a
          schedule too.)
        </p>

        {status && (
          <div className="train__stats">
            <div className="stat stat--sm">
              <div className="stat__num">{status.examples.toLocaleString()}</div>
              <div className="stat__label">Examples learned</div>
            </div>
            <div className="stat stat--sm">
              <div className="stat__num">{status.last?.positives ?? 0}</div>
              <div className="stat__label">Recommended</div>
            </div>
            <div className="stat stat--sm">
              <div className="stat__num">
                {status.last?.accuracy != null ? `${Math.round(status.last.accuracy * 100)}%` : '—'}
              </div>
              <div className="stat__label">Model fit</div>
            </div>
          </div>
        )}

        {status?.last?.weightChanges && status.last.weightChanges.length > 0 && (
          <div className="train__weights">
            <span className="train__weights-label">Last adjustments:</span>{' '}
            {status.last.weightChanges.map((w) => (
              <code key={w} className="train__chip">
                {w}
              </code>
            ))}
          </div>
        )}

        {canTrain ? (
          <button className="btn" disabled={!!busy} onClick={train}>
            {busy === 'train' ? 'Training…' : '🧠 Train the model now'}
          </button>
        ) : (
          <p className="learn__hint learn__hint--muted">{t('learn_train_admin')}</p>
        )}
        {status?.last && (
          <p className="learn__hint learn__hint--muted">
            Last trained {new Date(status.last.at).toLocaleString()}.
          </p>
        )}
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
