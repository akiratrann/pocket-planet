import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CATEGORY_MAP } from '../data/categories';
import { useAppStore, savedFromDestination } from '../store/useAppStore';
import { useI18n } from '../i18n';
import { EXTERNAL_REASONS } from '../data/ranking';
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
const ATTRIB = {
  /** The headline correction: a bare "80" badge otherwise reads as a verdict
   *  issued by whichever brand is named nearby. */
  scoreIs:
    'Pocket Planet’s own score, worked out by this app from the sources below — not a rating published by Lonely Planet, Reddit or any other source here.',
  /** Kept in sync with BADGE_TIP in DestinationList.tsx — it is deliberately
   *  duplicated rather than exported, so this module keeps exporting components
   *  only. Both disappear when these strings move to i18n. */
  badgeTip: 'Pocket Planet’s own score, not a source’s rating',
  sourceMix: 'Read across the whole guide',
  /** The chip counts are guide-wide. Without this line they would be read as
   *  "4 Lonely Planet mentions of THIS place", which is not what they are. */
  sourceMixNote: 'Articles and threads read for this guide — not mentions of this place.',
} as const;

/**
 * A source's publisher, from its URL host.
 *
 * Only a fallback now: `meta.sources[].provider` carries the publisher the
 * server actually recorded, and that is used when present. Older payloads (and
 * anything served from a cache built before that field existed) still arrive
 * without it, and the host is a fact already in the payload, so reading it back
 * out invents nothing.
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
function providerMix(
  sources: ReadonlyArray<{ url: string; provider?: string }>,
): Array<[string, number]> {
  const by = new Map<string, number>();
  for (const s of sources) {
    const p = s.provider || providerOf(s.url);
    by.set(p, (by.get(p) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Legacy fallback for guides assembled before the ranker emitted reason CODES:
 * back then the only outside-source reason was an English sentence, matched on
 * its wording. Live guides are split by `EXTERNAL_REASONS` instead.
 */
const EXTERNAL_REASON_RE = /trusted travel sources|mentioned by name/i;

/** One reason, as a stable key plus the text to show for it. */
interface ShownReason {
  key: string;
  text: string;
  external: boolean;
}

/**
 * The ranker's reasons, translated.
 *
 * It runs on the server and has no idea who is reading, so it emits stable
 * `reason_*` codes and the English sentences side by side. Codes are what we
 * render — that is what made these lines localizable — and the English text is
 * the fallback for a guide that predates them.
 */
function shownReasons(d: Destination, t: (k: string) => string): ShownReason[] {
  if (d.reasonCodes?.length) {
    return d.reasonCodes.map((code) => ({
      key: code,
      text: t(code),
      external: EXTERNAL_REASONS.has(code),
    }));
  }
  return d.reasons.map((r) => ({ key: r, text: r, external: EXTERNAL_REASON_RE.test(r) }));
}

/**
 * Per-source mention counts for one place, biggest first.
 *
 * These are raw counts of how often each source's text NAMES the place. They
 * are presented as exactly that everywhere they appear: a place being talked
 * about is not the same as a source recommending it, and the number is not a
 * rating out of anything.
 */
function mentionEntries(d: Destination): Array<[string, number]> {
  return Object.entries(d.mentions ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The per-source counts as chips. The caveat that keeps them from being read
 *  as ratings is the caller's job — never render these without it nearby. */
function MentionChips({ d }: { d: Destination }) {
  const entries = mentionEntries(d);
  if (!entries.length) return null;
  return (
    <div className="prov__mix prov__mix--mentions">
      {entries.map(([provider, n]) => (
        <span className="prov__chip" key={provider}>
          {provider}
          <span className="prov__chipn">{n}×</span>
        </span>
      ))}
    </div>
  );
}

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
  // has a photo" (something we measured) with "an outside source names it"
  // (something someone else wrote) is exactly the confusion this panel exists to
  // undo, so they never share a list.
  const reasons = shownReasons(d, t);
  const externalReasons = reasons.filter((r) => r.external);
  const listingReasons = reasons.filter((r) => !r.external);
  const mentions = mentionEntries(d);

  return (
    <div className="prov">
      <div className="prov__head">
        {/* One template per case rather than "Why" + "of" + "in" glued together:
            the pieces do not survive translation. Japanese builds this sentence
            category-first and puts the rank last, and Arabic reads the other way
            entirely, so only a whole sentence can be ordered correctly. */}
        <span className="prov__title">
          {inCategory > 0
            ? t('why_rank_q', { rank: d.rank, total: inCategory, category: t('cat_' + d.category) })
            : t('why_rank_q_bare', { rank: d.rank, category: t('cat_' + d.category) })}
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
              <li key={r.key}>
                <span className="prov__check">✓</span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="prov__none">{t('no_signals')}</p>
        )}
      </div>

      {/* "Ranked by who?" — answered per place, with the actual per-source
          counts the ranker used. This section used to have to admit that no
          per-source tally was kept; `Destination.mentions` now carries the raw
          numbers, so the honest thing is to show them, labelled as what they
          are. Never a rating, never "recommended by". */}
      <div className="prov__section">
        <div className="prov__label">{t('mentions_label')}</div>
        {mentions.length > 0 ? (
          <>
            <MentionChips d={d} />
            <ul className="prov__reasons">
              {externalReasons.map((r) => (
                <li key={r.key}>
                  {/* A quote mark, not a checkmark: this is someone else's page,
                      not a box we ticked. */}
                  <span className="prov__quote">❝</span>
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
            {d.mentionScore != null && d.mentionScore > 0 && (
              <p className="prov__note">
                +{d.mentionScore} {t('mentions_boost')}
              </p>
            )}
            <p className="prov__note">{t('mentions_note')}</p>
          </>
        ) : (
          <p className="prov__none">{t('mentions_none')}</p>
        )}
      </div>

      <div className="prov__section">
        <div className="prov__label">{t('ranked_by')}</div>
        <p className="prov__by">{t('ranked_by_body')}</p>
        {meta && (meta.feedbackApplied > 0 || meta.learnedVersion > 0) && (
          <p className="prov__learned">
            {meta.feedbackApplied > 0 && (
              <>
                {t('corrections_applied', { n: meta.feedbackApplied, place: location })}
                {meta.learnedVersion > 0 ? ' · ' : ''}
              </>
            )}
            {meta.learnedVersion > 0 && t('model_version', { v: meta.learnedVersion })}
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

      {/* Per-source signal, visible without opening anything — "ranked by who?"
          should not require a click. Hidden while the full panel is open, which
          shows the same chips with their caveat attached. */}
      {!showProvenance && d.mentions && Object.keys(d.mentions).length > 0 && (
        <div className="detail__mentions">
          <span className="detail__mentions-label">{t('mentions_label')}</span>
          <MentionChips d={d} />
        </div>
      )}

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
