import { useEffect, useLayoutEffect, useRef } from 'react';
import { CATEGORIES } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';

/**
 * Publish "is there more this way?" for each end of the rail as data attributes,
 * so the CSS can fade only the edges that are actually hiding something.
 *
 * Written straight to the DOM node rather than held in React state: this fires
 * on every scroll frame, and re-rendering nine chips to change two attributes
 * would be the most expensive thing in the panel. Nothing else reads it.
 */
function useEdgeFades(ref: React.RefObject<HTMLDivElement | null>) {
  const sync = () => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: fractional scroll offsets on zoomed/HiDPI displays otherwise
    // leave a fade permanently lit at a genuine end-of-scroll.
    const max = el.scrollWidth - el.clientWidth;
    el.dataset.overflowStart = el.scrollLeft > 1 ? 'on' : 'off';
    el.dataset.overflowEnd = el.scrollLeft < max - 1 ? 'on' : 'off';
  };

  // After every render: the chip set and its labels change with the guide, the
  // language and the filter counts, and any of those changes scrollWidth.
  useLayoutEffect(sync);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', sync, { passive: true });
    // Catches panel resize (the drag handle) and mobile rotation alike, neither
    // of which fires a scroll event even though both change what is clipped.
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Category filters: one horizontally-scrolling rail, always visible.
 *
 * This used to be a wrapping grid hidden behind a "Filters" disclosure, and the
 * disclosure was load-bearing rather than cosmetic: expanded, eight wrapped
 * chips measured ~318px tall inside a ~269px scroll viewport, and a
 * `position: sticky` element taller than its own scroller cannot pin — it
 * scrolls partway, then sticks, which is what read as two scrollbars in one
 * list. Collapsing it was a workaround for the height, not a decision about
 * filters.
 *
 * A single non-wrapping row is ~34px tall at ANY panel width, which removes the
 * height problem at its source. So the disclosure goes: the filters are the
 * primary way to steer this list and hiding them behind a click — with only a
 * comma-joined text summary to say what was on — was the densest, noisiest part
 * of the panel for the least benefit.
 *
 * Two things follow from the rail being the only presentation:
 *
 *   - The "All" chip IS the clear control (it already called `clear()`), so the
 *     separate "Clear" button was a second affordance for one action. Removed.
 *   - Keyboard reach is via the chips themselves, not a tabstop on the
 *     container. Every chip is a real focusable control, and focusing one
 *     scrolls it into view, so a keyboard user can walk the whole rail past the
 *     fold. A `tabindex=0` on the scroller — the usual advice for scrollable
 *     regions — is for regions whose CONTENT is not focusable; here it would
 *     only add an extra dead tab stop in front of every chip.
 *   - The rail is the only thing on screen that scrolls sideways, so it has to
 *     say so. `useEdgeFades` below reports which end is currently hiding chips
 *     and the CSS fades only that end.
 */
export default function CategoryBar({ counts }: { counts: Record<string, number> }) {
  const active = useAppStore((s) => s.activeCategories);
  const toggle = useAppStore((s) => s.toggleCategory);
  const clear = useAppStore((s) => s.clearCategories);
  const { t } = useI18n();
  const allOn = active.size === 0;
  const rail = useRef<HTMLDivElement>(null);
  useEdgeFades(rail);

  return (
    <div className="catbar" ref={rail} role="group" aria-label={t('filters')}>
      <button
        className={'chip chip--all' + (allOn ? ' chip--on' : '')}
        onClick={clear}
        aria-pressed={allOn}
        title="Show every category"
      >
        <span className="chip__box" aria-hidden="true">
          {allOn ? '✓' : ''}
        </span>
        {t('all')}
      </button>

      {CATEGORIES.map((c) => {
        const count = counts[c.id] ?? 0;
        const on = active.has(c.id);
        return (
          <label
            key={c.id}
            className={
              'chip chip--check' + (on ? ' chip--on' : '') + (count === 0 ? ' chip--disabled' : '')
            }
            // No per-category fill. Eight selected chips in eight brand colours
            // is a legend the reader has to learn, and it spends the colour
            // budget the score badge needs. Selection is carried by an ink fill
            // plus the checkmark below — two channels, neither of them hue.
            // See .chip--on in App.css.
            title={c.blurb}
          >
            <input
              type="checkbox"
              className="chip__cb"
              checked={on}
              disabled={count === 0}
              onChange={() => toggle(c.id)}
              // The native checkbox is visually hidden as a 1x1 sliver pinned to
              // the chip's leading edge, so the browser's own focus scrolling
              // brings only that sliver into the rail — on the wider chips
              // ("Nature & Outdoors", "Activities & Tours") more than half the
              // chip, and the right-hand side of its focus ring, stayed past the
              // fold. Scroll the CHIP instead. `nearest` does nothing when it is
              // already fully visible, and it honours the rail's
              // scroll-padding, so the chip lands clear of the edge fades.
              onFocus={(e) =>
                e.currentTarget.closest('.chip')?.scrollIntoView({
                  block: 'nearest',
                  inline: 'nearest',
                })
              }
            />
            <span className="chip__box" aria-hidden="true">
              {on ? '✓' : ''}
            </span>
            <span aria-hidden="true">{c.icon}</span> {t('cat_' + c.id)}
            <span className="chip__count">{count}</span>
          </label>
        );
      })}
    </div>
  );
}
