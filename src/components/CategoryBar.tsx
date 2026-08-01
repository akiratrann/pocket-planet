import { useState } from 'react';
import { CATEGORIES } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';

/**
 * Category filters.
 *
 * Collapsed by default, and that default is load-bearing rather than cosmetic:
 * expanded, the chip grid measured 318px inside a 269px scroll viewport. A
 * `position: sticky` element taller than its scroller can't pin correctly — it
 * scrolls partway, then sticks, which reads as two separate scrollbars — and it
 * pushed every ranked destination below the fold. Collapsed, the header is short
 * enough to sticky properly; expanded, the parent drops sticky (see .catwrap CSS).
 */
export default function CategoryBar({ counts }: { counts: Record<string, number> }) {
  const active = useAppStore((s) => s.activeCategories);
  const toggle = useAppStore((s) => s.toggleCategory);
  const clear = useAppStore((s) => s.clearCategories);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const allOn = active.size === 0;

  // Collapsed summary: name the active filters so hiding them never hides state.
  const activeLabels = CATEGORIES.filter((c) => active.has(c.id)).map(
    (c) => `${c.icon} ${t('cat_' + c.id)}`,
  );
  const summary = allOn ? t('all') : activeLabels.join(', ');

  return (
    <div className={'catwrap' + (open ? ' catwrap--open' : '')}>
      <div className="catwrap__bar">
        <button
          className="catwrap__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="catwrap__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {t('filters')}
          <span className="catwrap__summary">{summary}</span>
        </button>
        {!allOn && (
          <button className="catwrap__clear" onClick={clear}>
            {t('clear')}
          </button>
        )}
      </div>

      {open && (
        <div className="catbar" role="group" aria-label="Filter destinations by category">
          <button
            className={'chip chip--all' + (allOn ? ' chip--on' : '')}
            onClick={clear}
            aria-pressed={allOn}
            title="Show a quick overview across every category"
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
                  'chip chip--check' +
                  (on ? ' chip--on' : '') +
                  (count === 0 ? ' chip--disabled' : '')
                }
                // No per-category fill. Eight selected chips in eight brand
                // colours is a legend the reader has to learn, and it spends
                // the colour budget the score badge needs. Selection is
                // carried by an ink fill plus the checkmark below — two
                // channels, neither of them hue. See .chip--on in App.css.
                title={c.blurb}
              >
                <input
                  type="checkbox"
                  className="chip__cb"
                  checked={on}
                  disabled={count === 0}
                  onChange={() => toggle(c.id)}
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
      )}
    </div>
  );
}
