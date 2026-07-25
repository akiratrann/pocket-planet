import { CATEGORIES } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import type { CategoryId } from '../types';

export default function CategoryBar({ counts }: { counts: Record<CategoryId, number> }) {
  const active = useAppStore((s) => s.activeCategories);
  const toggle = useAppStore((s) => s.toggleCategory);
  const clear = useAppStore((s) => s.clearCategories);

  return (
    <div className="catbar">
      <button
        className={'chip' + (active.size === 0 ? ' chip--on' : '')}
        onClick={clear}
      >
        All
      </button>
      {CATEGORIES.map((c) => {
        const count = counts[c.id] ?? 0;
        const on = active.has(c.id);
        return (
          <button
            key={c.id}
            className={'chip' + (on ? ' chip--on' : '')}
            style={on ? { background: c.color, borderColor: c.color, color: '#fff' } : undefined}
            onClick={() => toggle(c.id)}
            disabled={count === 0}
            title={c.blurb}
          >
            <span>{c.icon}</span> {c.label}
            <span className="chip__count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
