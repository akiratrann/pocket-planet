import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import type { CategoryId, Destination, Guide } from '../types';
import FeedbackControls from './FeedbackControls';
import PinButton from './PinButton';
import './provenance.css';
import './place-photo.css';

/** How many sources to list before the "show all" link. */
const SOURCE_PREVIEW = 4;

/**
 * One photo slot, shared by the card thumbnail and the detail hero.
 *
 * A category tile is ALWAYS rendered at the slot's full size and the photo is
 * layered over it. Missing photo, dead URL and slow load then collapse into the
 * same benign outcome — you see the tile — instead of the browser's broken-image
 * glyph, and the box never changes size, so nothing below it reflows.
 *
 * Deliberately does not substitute a stock photo: on a travel guide a plausible
 * but wrong picture is a worse lie than an honest blank.
 */
export function PlacePhoto({
  src,
  category,
  variant,
  alt = '',
  label,
  onError,
}: {
  src?: string | undefined;
  category: CategoryId;
  variant: 'card' | 'hero';
  alt?: string;
  /** Shown under the icon when there is no usable photo (hero only). */
  label?: string | undefined;
  onError?: (() => void) | undefined;
}) {
  const cat = CATEGORY_MAP[category];
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const usable = Boolean(src) && !failed;

  return (
    <div
      className={`pphoto pphoto--${variant}`}
      style={{ ['--pp-tint' as string]: cat.color }}
    >
      <div className="pphoto__tile" aria-hidden="true">
        <span className="pphoto__icon">{cat.icon}</span>
        {!usable && label && <span className="pphoto__label">{label}</span>}
      </div>
      {usable && (
        <img
          className={'pphoto__img' + (loaded ? ' pphoto__img--in' : '')}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          ref={(el) => {
            // A cached photo can finish decoding before React attaches onLoad,
            // which would otherwise leave it stuck at opacity 0 forever.
            if (!el || !el.complete) return;
            if (el.naturalWidth === 0) {
              setFailed(true);
              onError?.();
            } else {
              setLoaded(true);
            }
          }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      )}
    </div>
  );
}

/**
 * The guide isn't threaded down to the list/detail components (App owns that),
 * but its provenance — the articles it was assembled from, the learned version —
 * is exactly what makes a rank believable. Read the already-loaded guide back out
 * of the query cache, matched on the title these components are handed.
 */
function useGuideFor(location: string): Guide | undefined {
  const client = useQueryClient();
  for (const [, guide] of client.getQueriesData<Guide>({ queryKey: ['guide'] })) {
    if (guide && guide.title === location) return guide;
  }
  return undefined;
}

/** Ingested source titles arrive HTML-escaped from their feeds; show them as text. */
function decodeEntities(s: string): string {
  if (!s.includes('&') || typeof document === 'undefined') return s;
  const el = document.createElement('textarea');
  el.innerHTML = s; // textarea content parses as text, never as markup
  return el.value;
}

/**
 * Explains a single place's rank: the ranker's own reasons, how the score is
 * scaled, and the real sources behind the guide. Nothing here is generated —
 * when a place has no standout signals we say so rather than inventing one.
 */
export function RankProvenance({ d, location }: { d: Destination; location: string }) {
  const { t } = useI18n();
  const guide = useGuideFor(location);
  const [allSources, setAllSources] = useState(false);

  const inCategory = guide
    ? guide.destinations.filter((x) => x.category === d.category).length
    : 0;
  const meta = guide?.meta;
  const sources = meta?.sources ?? [];
  const shownSources = allSources ? sources : sources.slice(0, SOURCE_PREVIEW);

  return (
    <div className="prov">
      <div className="prov__head">
        <span className="prov__title">
          {t('why_rank')} #{d.rank}
          {inCategory > 0 ? ` ${t('of')} ${inCategory}` : ''} {t('in')} {t('cat_' + d.category)}?
        </span>
        <span className="prov__score">{d.score}/100</span>
      </div>
      <p className="prov__basis">
        {t('score_basis')} {t('rank_scope')}
      </p>

      <div className="prov__section">
        <div className="prov__label">{t('what_lifted_it')}</div>
        {d.reasons.length > 0 ? (
          <ul className="prov__reasons">
            {d.reasons.map((r) => (
              <li key={r}>
                <span className="prov__check">✓</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="prov__none">{t('no_signals')}</p>
        )}
      </div>

      <div className="prov__section">
        <div className="prov__label">{t('ranked_by')}</div>
        <p className="prov__by">{t('ranked_by_body')}</p>
        {meta && (meta.feedbackApplied > 0 || meta.learnedVersion > 0) && (
          <p className="prov__learned">
            {meta.feedbackApplied > 0 && (
              <>
                {meta.feedbackApplied} {t('corrections_applied')} {location}
                {meta.learnedVersion > 0 ? ' · ' : ''}
              </>
            )}
            {meta.learnedVersion > 0 && `${t('model_version')}${meta.learnedVersion}`}
          </p>
        )}
      </div>

      <div className="prov__section">
        <div className="prov__label">{t('sources_used')}</div>
        <ul className="prov__sources">
          {guide?.sourceUrl && (
            <li>
              <a className="prov__src" href={guide.sourceUrl} target="_blank" rel="noreferrer">
                {guide.attribution || 'Wikivoyage'}
              </a>{' '}
              <span className="prov__srcmeta">· {t('base_guide')}</span>
            </li>
          )}
          {shownSources.map((s) => (
            <li key={s.url}>
              <a className="prov__src" href={s.url} target="_blank" rel="noreferrer">
                {decodeEntities(s.title)}
              </a>{' '}
              <span className="prov__srcmeta">
                {s.poiCount > 0 ? `· ${s.poiCount} ${t('places')} ` : ''}
                {/* When it was read matters: a stale source is a weaker claim. */}· {t('source_read')}{' '}
                {new Date(s.fetchedAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
        {sources.length > SOURCE_PREVIEW && !allSources && (
          <button className="prov__more" onClick={() => setAllSources(true)}>
            {t('show_all_sources')} ({sources.length})
          </button>
        )}
        {!sources.length && <p className="prov__none">{t('no_extra_sources')}</p>}
      </div>
    </div>
  );
}

export default function DestinationDetail({ d, location }: { d: Destination; location: string }) {
  const select = useAppStore((s) => s.select);
  const quickAddToItinerary = useAppStore((s) => s.quickAddToItinerary);
  const { t } = useI18n();
  const cat = CATEGORY_MAP[d.category];

  const [added, setAdded] = useState(false);
  const [showProvenance, setShowProvenance] = useState(false);
  // Reset the "Added ✓" confirmation whenever we view a different place.
  useEffect(() => setAdded(false), [d.id]);
  // A rank explanation belongs to one place; don't carry it over to the next.
  useEffect(() => setShowProvenance(false), [d.id]);

  // Build the gallery: `images` when present, else the single `image`.
  const photos = (d.images && d.images.length ? d.images : d.image ? [d.image] : []).filter(Boolean);
  const [active, setActive] = useState(0);
  const [broken, setBroken] = useState<Set<number>>(new Set());
  const shown = photos.filter((_, i) => !broken.has(i));
  // Track the INDEX, not just the URL: the hero's onError has to blacklist the
  // exact slot that failed so the gallery hides that thumbnail too.
  const activeIdx =
    photos[active] && !broken.has(active) ? active : photos.findIndex((_, i) => !broken.has(i));
  const activeSrc = activeIdx >= 0 ? photos[activeIdx] : undefined;

  return (
    <div className="detail">
      <button className="detail__back" onClick={() => select(null)}>
        {t('back_to_list')}
      </button>
      {/* The hero renders even with nothing to show — a place with no photo gets
          the same masthead shape as one with a photo, so a guide with patchy
          coverage doesn't look half-built. `key` resets the load state when the
          gallery switches picture. */}
      <PlacePhoto
        key={activeSrc ?? 'nophoto'}
        src={activeSrc}
        category={d.category}
        variant="hero"
        alt={activeSrc ? d.name : ''}
        label={t('photo_none')}
        onError={activeIdx >= 0 ? () => setBroken((prev) => new Set(prev).add(activeIdx)) : undefined}
      />
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
        <button
          className="detail__rank detail__rank--btn"
          onClick={() => setShowProvenance((v) => !v)}
          aria-expanded={showProvenance}
        >
          #{d.rank} {t('most_recommended')} · {d.score}/100
          <span className="scorebadge__cue" aria-hidden="true">
            ⓘ
          </span>
          {t('why_rank_short')}
        </button>
      </div>
      <h2 className="detail__title">{d.name}</h2>

      {showProvenance && <RankProvenance d={d} location={location} />}

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
