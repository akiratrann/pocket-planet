import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Progress narration while a guide is assembled.
 *
 * Building a cold guide means several rounds of scraping and ranking, which can
 * take a while. A single frozen line for that whole stretch reads as a hang, so
 * this walks through the stages the pipeline genuinely runs, in the order it
 * runs them: fetch the base guide, find places on OSM, mine discussions and
 * editorial and video, then rank.
 *
 * These are descriptions of real work, not invented reassurance — but they are
 * timed, not driven by server events, so the last stage holds rather than
 * claiming completion. If we ever stream real progress, swap the timer for it.
 */
const STAGE_KEYS = [
  'stage_reading',
  'stage_places',
  'stage_discussions',
  'stage_editorial',
  'stage_photos',
  'stage_ranking',
] as const;

/** Roughly matched to observed stage durations; the final stage holds. */
const STEP_MS = 4500;

export default function BuildProgress({ query }: { query: string }) {
  const { t } = useI18n();
  const [stage, setStage] = useState(0);

  useEffect(() => {
    setStage(0);
    const id = setInterval(() => {
      setStage((s) => Math.min(s + 1, STAGE_KEYS.length - 1));
    }, STEP_MS);
    return () => clearInterval(id);
  }, [query]);

  return (
    <div className="status">
      <div className="spinner" />
      <p>
        {t('building_guide')} “{query}”…
      </p>
      <p className="status__stage" aria-live="polite">
        {t(STAGE_KEYS[stage])}
      </p>
      <div className="status__dots" aria-hidden="true">
        {STAGE_KEYS.map((k, i) => (
          <span key={k} className={'status__dot' + (i <= stage ? ' status__dot--on' : '')} />
        ))}
      </div>
    </div>
  );
}
