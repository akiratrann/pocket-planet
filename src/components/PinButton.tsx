import { useAppStore, type SavedPlace } from '../store/useAppStore';
import { useI18n } from '../i18n';

/** A small toggle that pins/unpins a place so it can be added to an itinerary. */
export default function PinButton({
  place,
  className,
  withLabel = false,
}: {
  place: SavedPlace;
  className?: string;
  /** When true, shows the "Pin"/"Pinned" text next to the icon (button style). */
  withLabel?: boolean;
}) {
  const togglePin = useAppStore((s) => s.togglePin);
  const pinned = useAppStore((s) => s.pinned.some((p) => p.id === place.id));
  const { t } = useI18n();
  const label = pinned ? t('pinned') : t('pin');
  return (
    <button
      type="button"
      className={'pinbtn' + (pinned ? ' pinbtn--on' : '') + (className ? ' ' + className : '')}
      aria-pressed={pinned}
      aria-label={pinned ? t('unpin') : t('pin')}
      title={pinned ? t('unpin') : t('pin')}
      onClick={(e) => {
        e.stopPropagation();
        togglePin(place);
      }}
    >
      {/* The icon is knocked out to a white silhouette when on (see App.css) —
          a red emoji on the accent fill was all but invisible, which is why a
          pinned place read as unpinned. */}
      <span className="pinbtn__icon" aria-hidden>
        {pinned ? '📌' : '📍'}
      </span>
      {withLabel && <span className="pinbtn__label">{label}</span>}
    </button>
  );
}
