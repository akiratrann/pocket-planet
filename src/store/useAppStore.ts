import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CategoryId, Destination } from '../types';

// Kept in sync with LANGUAGES in i18n.ts (inlined here to avoid a circular import).
const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'vi', 'ja', 'ko', 'zh', 'ru', 'ar'];

function initialLanguage(): string {
  if (typeof window === 'undefined') return 'en';
  const saved = localStorage.getItem('pp-lang');
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.includes(nav) ? nav : 'en';
}

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * A lightweight snapshot of a place that can be saved independently of the live
 * guide (which is re-fetched per location). Enough to render a card + locate it.
 */
export interface SavedPlace {
  id: string;
  name: string;
  category: CategoryId;
  /** The guide/location this place belongs to (used to navigate back to it). */
  location: string;
  lat?: number;
  lon?: number;
  image?: string;
  description?: string;
  url?: string;
  score?: number;
}

export interface Itinerary {
  id: string;
  name: string;
  createdAt: number;
  places: SavedPlace[];
}

export function savedFromDestination(d: Destination, location: string): SavedPlace {
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    location,
    lat: d.lat,
    lon: d.lon,
    image: d.image ?? d.images?.[0],
    description: d.description,
    url: d.url,
    score: d.score,
  };
}

export type PanelTab = 'explore' | 'advice' | 'learn' | 'itinerary';

interface AppState {
  /** The place currently being explored (submitted search). */
  query: string;
  /** UI + place-name language preference (ISO code). */
  language: string;
  /** Categories toggled on. Empty set = show all. */
  activeCategories: Set<CategoryId>;
  selectedId: string | null;
  /** Destination currently hovered (for list <-> map sync). */
  hoveredId: string | null;
  /** Which side panel tab is showing. */
  panelTab: PanelTab;
  panelOpen: boolean;
  /**
   * Whether the map should frame (recenter/zoom to) the next loaded guide.
   * True for explicit searches; false for map-driven exploration so zooming
   * "guesses the region" and shows its places WITHOUT dragging the camera.
   */
  frameOnLoad: boolean;

  // --- Saved trip planning (persisted) ---
  /** Places the user pinned/bookmarked, most-recent first. */
  pinned: SavedPlace[];
  /** The user's itineraries. */
  itineraries: Itinerary[];
  /** Itinerary currently open in the tab / target for quick-adds. */
  activeItineraryId: string | null;

  setQuery: (q: string) => void;
  /** Load a place from map exploration — same as setQuery but keeps the camera put. */
  exploreTo: (q: string) => void;
  setLanguage: (lang: string) => void;
  toggleCategory: (c: CategoryId) => void;
  clearCategories: () => void;
  select: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setPanelTab: (t: PanelTab) => void;
  setPanelOpen: (open: boolean) => void;

  // Pins
  togglePin: (place: SavedPlace) => void;
  isPinned: (id: string) => boolean;

  // Itineraries
  createItinerary: (name?: string) => string;
  deleteItinerary: (id: string) => void;
  renameItinerary: (id: string, name: string) => void;
  setActiveItinerary: (id: string | null) => void;
  addToItinerary: (itineraryId: string, place: SavedPlace) => void;
  removeFromItinerary: (itineraryId: string, placeId: string) => void;
  moveInItinerary: (itineraryId: string, placeId: string, dir: -1 | 1) => void;
  /** Add to the active itinerary, creating a default one if none exists. */
  quickAddToItinerary: (place: SavedPlace) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      query: 'Kyoto',
      language: initialLanguage(),
      activeCategories: new Set<CategoryId>(),
      selectedId: null,
      hoveredId: null,
      panelTab: 'explore',
      panelOpen: true,
      frameOnLoad: true,

      pinned: [],
      itineraries: [],
      activeItineraryId: null,

      setQuery: (q) => set({ query: q, selectedId: null, frameOnLoad: true }),
      exploreTo: (q) => set({ query: q, selectedId: null, frameOnLoad: false }),
      setLanguage: (lang) => {
        if (typeof window !== 'undefined') localStorage.setItem('pp-lang', lang);
        set({ language: lang });
      },
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

      togglePin: (place) =>
        set((s) => {
          const exists = s.pinned.some((p) => p.id === place.id);
          return {
            pinned: exists
              ? s.pinned.filter((p) => p.id !== place.id)
              : [place, ...s.pinned],
          };
        }),
      isPinned: (id) => get().pinned.some((p) => p.id === id),

      createItinerary: (name) => {
        const id = uid();
        const it: Itinerary = {
          id,
          name: name?.trim() || 'My Trip',
          createdAt: Date.now(),
          places: [],
        };
        set((s) => ({ itineraries: [it, ...s.itineraries], activeItineraryId: id }));
        return id;
      },
      deleteItinerary: (id) =>
        set((s) => ({
          itineraries: s.itineraries.filter((it) => it.id !== id),
          activeItineraryId: s.activeItineraryId === id ? null : s.activeItineraryId,
        })),
      renameItinerary: (id, name) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === id ? { ...it, name: name.trim() || it.name } : it,
          ),
        })),
      setActiveItinerary: (id) => set({ activeItineraryId: id }),
      addToItinerary: (itineraryId, place) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === itineraryId && !it.places.some((p) => p.id === place.id)
              ? { ...it, places: [...it.places, place] }
              : it,
          ),
        })),
      removeFromItinerary: (itineraryId, placeId) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === itineraryId
              ? { ...it, places: it.places.filter((p) => p.id !== placeId) }
              : it,
          ),
        })),
      moveInItinerary: (itineraryId, placeId, dir) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== itineraryId) return it;
            const i = it.places.findIndex((p) => p.id === placeId);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= it.places.length) return it;
            const places = [...it.places];
            [places[i], places[j]] = [places[j], places[i]];
            return { ...it, places };
          }),
        })),
      quickAddToItinerary: (place) => {
        let id = get().activeItineraryId;
        if (!id || !get().itineraries.some((it) => it.id === id)) {
          id = get().createItinerary(`Trip to ${place.location || 'somewhere'}`);
        }
        get().addToItinerary(id, place);
      },
    }),
    {
      name: 'pp-trip-store',
      // Only persist trip-planning data; UI/session state stays in-memory.
      partialize: (s) => ({
        pinned: s.pinned,
        itineraries: s.itineraries,
        activeItineraryId: s.activeItineraryId,
      }),
    },
  ),
);
