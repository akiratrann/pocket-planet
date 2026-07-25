import { create } from 'zustand';
import type { CategoryId } from '../types';

interface AppState {
  /** The place currently being explored (submitted search). */
  query: string;
  /** Categories toggled on. Empty set = show all. */
  activeCategories: Set<CategoryId>;
  selectedId: string | null;
  /** Destination currently hovered (for list <-> map sync). */
  hoveredId: string | null;
  /** Which side panel tab is showing. */
  panelTab: 'explore' | 'advice' | 'learn';
  panelOpen: boolean;

  setQuery: (q: string) => void;
  toggleCategory: (c: CategoryId) => void;
  clearCategories: () => void;
  select: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setPanelTab: (t: 'explore' | 'advice' | 'learn') => void;
  setPanelOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  query: 'Kyoto',
  activeCategories: new Set<CategoryId>(),
  selectedId: null,
  hoveredId: null,
  panelTab: 'explore',
  panelOpen: true,

  setQuery: (q) => set({ query: q, selectedId: null }),
  toggleCategory: (c) =>
    set((s) => {
      const next = new Set(s.activeCategories);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return { activeCategories: next };
    }),
  clearCategories: () => set({ activeCategories: new Set() }),
  select: (id) => set({ selectedId: id, panelOpen: true }),
  setHovered: (id) => set({ hoveredId: id }),
  setPanelTab: (t) => set({ panelTab: t }),
  setPanelOpen: (open) => set({ panelOpen: open }),
}));
