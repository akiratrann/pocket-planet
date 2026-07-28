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
 * Attribution copy for the score / rank explanation.
 *
 * These are new user-facing strings, but i18n.ts is owned by another agent right
 * now, so they live here as local constants and fall back to English.
 * TODO: move to i18n
 */
export const ATTRIB = {
  /** The headline correction: a bare "80" badge otherwise reads as a verdict
   *  issued by whichever brand is named nearby. */
  scoreIs:
    'Pocket Planet’s own score, worked out by this app from the sources below — not a rating published by Lonely Planet, Reddit or any other source here.',
  badgeTip: 'Pocket Planet’s own score, not a source’s rating',
  externalLabel: 'What outside sources said',
  /** Shown when the ranker flagged an outside mention. Says what we know AND
   *  what we don't: the guide carries no per-source tally for a place. */
  externalNoBreakdown:
    'Recorded as a mention only. The guide doesn’t keep a per-source tally for a place, so we can’t say which of the sources below it was, or how many times.',
  externalNone:
    'Nothing recorded. This place wasn’t matched to any of the outside sources read for this guide, so its position comes from its listing alone.',
  sourceMix: 'Read across the whole guide',
  /** The chip counts are guide-wide. Without this line they would be read as
   *  "4 Lonely Planet mentions of THIS place", which is not what they are. */
  sourceMixNote: 'Articles and threads read for this guide — not mentions of this place.',
} as const;

/**
 * A source's publisher, taken from its URL host.
 *
 * The host is a fact already in the payload, so grouping by it invents nothing.
 * (`meta.sources` drops the server's own `provider` field, and carries no
 * per-place breakdown at all — hence the caveats above.)
 */
const HOST_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)lonelyplanet\.com$/i, 'Lonely Planet'],
  [/(^|\.)reddit\.com$/i, 'Reddit'],
  [/(^|\.)youtube\.com$/i, 'YouTube'],
  [/(^|\.)travel\.stackexchange\.com$/i, 'Travel Stack Exchange'],
  [/(^|\.)stackexchange\.com$/i, 'Stack Exchange'],
  [/(^|\.)wikivoyage\.org$/i, 'Wikivoyage'],
  [/(^|\.)wikipedia\.org$/i, 'Wikipedia'],
];

function providerOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'Other'; // an unparseable URL gets no brand name attached to it
  }
  for (const [re, label] of HOST_LABELS) if (re.test(host)) return label;
  return host.replace(/^www\./, ''); // unknown publisher: show the bare host
}

/** Publisher → how many of the guide's sources came from it, most first. */
function providerMix(sources: ReadonlyArray<{ url: string }>): Array<[string, number]> {
  const by = new Map<string, number>();
  for (const s of sources) {
    const p = providerOf(s.url);
    by.set(p, (by.get(p) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The one reason the ranker emits that is about an OUTSIDE source rather than
 * about the listing itself (see `rawScore` in data/ranking.ts). Reasons are fixed
 * English literals produced by the ranker — they never go through i18n — so
 * matching on the wording is stable.
 */
const EXTERNAL_REASON_RE = /trusted travel sources/i;

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
  const mix = providerMix(sources);

  // Split the ranker's reasons by WHO they come from. Conflating "this listing
  // has a photo" (something we measured) with "an outside source recommends it"
  // (something someone else said) is exactly the confusion this panel exists to
  // undo, so they never share a list.
  const externalReasons = d.reasons.filter((r) => EXTERNAL_REASON_RE.test(r));
  const listingReasons = d.reasons.filter((r) => !EXTERNAL_REASON_RE.test(r));

  return (
    <div className="prov">
      <div className="prov__head">
        <span className="prov__title">
          {t('why_rank')} #{d.rank}
          {inCategory > 0 ? ` ${t('of')} ${inCategory}` : ''} {t('in')} {t('cat_' + d.category)}?
        </span>
        <span className="prov__score">{d.score}/100</span>
      </div>
      {/* Attribution comes FIRST, before any source is named further down — by the
          time a reader reaches "Lonely Planet" they must already know the number
          isn't theirs. */}
      <p className="prov__attrib">{ATTRIB.scoreIs}</p>
      <p className="prov__basis">
        {t('score_basis')} {t('rank_scope')}
      </p>

      <div className="prov__section">
        <div className="prov__label">{t('what_lifted_it')}</div>
        {listingReasons.length > 0 ? (
          <ul className="prov__reasons">
            {listingReasons.map((r) => (
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
        <div className="prov__label">{ATTRIB.externalLabel}</div>
        {externalReasons.length > 0 ? (
          <>
            <ul className="prov__reasons">
              {externalReasons.map((r) => (
                <li key={r}>
                  {/* A quote mark, not a checkmark: this is someone else's word,
                      not a box we ticked. */}
                  <span className="prov__quote">❝</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
            <p className="prov__note">{ATTRIB.externalNoBreakdown}</p>
          </>
        ) : (
          <p className="prov__none">{ATTRIB.externalNone}</p>
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
        {/* Which publishers were actually read, at a glance — this answers
            "ranked by who?" without making anyone scan the full link list.
            Guide-wide by nature, and labelled as such. */}
        {mix.length > 0 && (
          <>
            <div className="prov__mix" aria-label={ATTRIB.sourceMix}>
              {mix.map(([name, n]) => (
                <span className="prov__chip" key={name}>
                  {name}
                  <span className="prov__chipn">{n}</span>
                </span>
              ))}
            </div>
            <p className="prov__note">{ATTRIB.sourceMixNote}</p>
          </>
        )}
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
          // Most readers never open the panel, so the shortest possible version
          // of the attribution has to survive on hover alone.
          title={ATTRIB.badgeTip}
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
