import { CATEGORIES } from '../data/categories';
import { useAppStore } from '../store/useAppStore';

export default function CategoryBar({ counts }: { counts: Record<string, number> }) {
  const active = useAppStore((s) => s.activeCategories);
  const toggle = useAppStore((s) => s.toggleCategory);
  const clear = useAppStore((s) => s.clearCategories);
  const allOn = active.size === 0;

  return (
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
        All
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
            style={on ? { background: c.color, borderColor: c.color, color: '#fff' } : undefined}
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
            <span aria-hidden="true">{c.icon}</span> {c.label}
            <span className="chip__count">{count}</span>
          </label>
        );
      })}
    </div>
  );
}
