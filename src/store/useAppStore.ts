import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CategoryId, Destination } from '../types';
import {
  authLogin,
  authSignup,
  authMe,
  saveUserData,
  setAuthToken,
  getAuthToken,
  type AuthUser,
} from '../data/api';

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

/** Union two pinned lists by id (keeps existing order, appends new). */
function mergePinned(a: SavedPlace[], b: SavedPlace[]): SavedPlace[] {
  const seen = new Set(a.map((p) => p.id));
  return [...a, ...b.filter((p) => !seen.has(p.id))];
}

/** Union itineraries by id; for a shared id keep whichever has more places. */
function mergeItineraries(a: Itinerary[], b: Itinerary[]): Itinerary[] {
  const byId = new Map<string, Itinerary>();
  for (const it of [...a, ...b]) {
    const cur = byId.get(it.id);
    if (!cur || it.places.length > cur.places.length) byId.set(it.id, it);
  }
  return [...byId.values()].sort((x, y) => y.createdAt - x.createdAt);
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

export type PanelTab = 'explore' | 'advice' | 'learn' | 'itinerary' | 'travel';

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
  /** Route line drawn on the map, as [lon, lat] pairs. Null when no route. */
  routeGeometry: Array<[number, number]> | null;
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

  /** Signed-in account (null = browsing as a guest, data stays local only). */
  authUser: AuthUser | null;

  setQuery: (q: string) => void;
  /** Load a place from map exploration — same as setQuery but keeps the camera put. */
  exploreTo: (q: string) => void;
  setLanguage: (lang: string) => void;
  toggleCategory: (c: CategoryId) => void;
  clearCategories: () => void;
  select: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setPanelTab: (t: PanelTab) => void;
  setRouteGeometry: (g: Array<[number, number]> | null) => void;
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

  // Auth
  signup: (email: string, password: string, name?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** On app start: if a token exists, restore the session + merge saved data. */
  hydrateAuth: () => Promise<void>;
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
      routeGeometry: null,
      panelOpen: true,
      frameOnLoad: true,

      pinned: [],
      itineraries: [],
      activeItineraryId: null,
      authUser: null,

      // A new search always lands on Explore. Staying on Itinerary/Travel showed
      // a spinner in a tab that has nothing to do with the search, which read as
      // the itinerary being wiped by the search.
      setQuery: (q) =>
        set({ query: q, selectedId: null, frameOnLoad: true, panelTab: 'explore' }),
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
      // Selecting a place always shows it. The detail view lives in the Explore
      // tab, so jump there — otherwise clicking a map pin while reading Advice
      // or Learn appeared to do nothing at all.
      select: (id) =>
        set(id ? { selectedId: id, panelOpen: true, panelTab: 'explore' } : { selectedId: id }),
      setHovered: (id) => set({ hoveredId: id }),
      setPanelTab: (t) => set({ panelTab: t }),
      setRouteGeometry: (g) => set({ routeGeometry: g }),
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
      // Store the raw value. Trimming here ran on every keystroke, so typing a
      // space was undone the instant it was typed (the space bar appeared
      // broken), and clearing the field silently restored the old name. Empty
      // names are normalized on blur instead — see ItineraryPanel.
      renameItinerary: (id, name) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => (it.id === id ? { ...it, name } : it)),
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

      signup: async (email, password, name) => {
        const res = await authSignup(email, password, name);
        setAuthToken(res.token);
        // Fold any guest work into the new account so nothing is lost.
        const pinned = mergePinned(get().pinned, res.data.pinned ?? []);
        const itineraries = mergeItineraries(get().itineraries, res.data.itineraries ?? []);
        set({ authUser: res.user, pinned, itineraries });
        await saveUserData({ pinned, itineraries }).catch(() => {});
      },
      login: async (email, password) => {
        const res = await authLogin(email, password);
        setAuthToken(res.token);
        const pinned = mergePinned(res.data.pinned ?? [], get().pinned);
        const itineraries = mergeItineraries(res.data.itineraries ?? [], get().itineraries);
        set({ authUser: res.user, pinned, itineraries });
        await saveUserData({ pinned, itineraries }).catch(() => {});
      },
      logout: () => {
        setAuthToken(null);
        // Clear local personalization so the next person starts fresh (it's
        // safely stored server-side under the account).
        set({ authUser: null, pinned: [], itineraries: [], activeItineraryId: null });
      },
      hydrateAuth: async () => {
        if (!getAuthToken()) return;
        try {
          const { user, data } = await authMe();
          const pinned = mergePinned(data.pinned ?? [], get().pinned);
          const itineraries = mergeItineraries(data.itineraries ?? [], get().itineraries);
          set({ authUser: user, pinned, itineraries });
        } catch {
          // Token invalid/expired → drop it and continue as guest.
          setAuthToken(null);
          set({ authUser: null });
        }
      },
    }),
    {
      name: 'pp-trip-store',
      // Only persist trip-planning data; UI/session state stays in-memory.
      partialize: (s) => ({
        pinned: s.pinned,
        itineraries: s.itineraries,
        activeItineraryId: s.activeItineraryId,
        authUser: s.authUser,
      }),
    },
  ),
);

// When signed in, push pin/itinerary changes up to the account (debounced) so
// the experience follows the user across devices.
if (typeof window !== 'undefined') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  useAppStore.subscribe((state, prev) => {
    if (!state.authUser) return;
    if (state.pinned === prev.pinned && state.itineraries === prev.itineraries) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useAppStore.getState();
      void saveUserData({ pinned: s.pinned, itineraries: s.itineraries }).catch(() => {});
    }, 800);
  });
}
