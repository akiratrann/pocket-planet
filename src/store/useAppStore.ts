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

/** Transport the user picked between two consecutive stops. */
export type LegMode = 'walking' | 'cycling' | 'driving' | 'transit';

export interface ItineraryLeg {
  /** Stop travelled from / to — a leg is identified by that pair. */
  fromId: string;
  toId: string;
  mode: LegMode;
  distanceKm: number;
  durationSec: number;
  /** Router was unreachable, so this is the straight-line estimate. */
  approximate?: boolean;
}

export interface Itinerary {
  id: string;
  name: string;
  createdAt: number;
  /** Visiting order across the whole trip; always sorted by day. */
  places: SavedPlace[];
  /**
   * The place this trip is FOR. Deliberately its own field rather than the
   * app-wide search query: searching for somewhere else must not re-point a
   * trip the user already started planning. Empty until chosen.
   */
  destination: string;
  /** How many days the trip is split into (>= 1). */
  days: number;
  /** placeId -> 1-based day number. Every stop in `places` has an entry. */
  dayOf: Record<string, number>;
  legs: ItineraryLeg[];
}

const LEG_MODES: readonly string[] = ['walking', 'cycling', 'driving', 'transit'];

/** Stable sort so a day's stops keep the order the user arranged them in. */
function sortByDay(places: SavedPlace[], dayOf: Record<string, number>): SavedPlace[] {
  return [...places].sort((a, b) => (dayOf[a.id] ?? 1) - (dayOf[b.id] ?? 1));
}

/**
 * Drop legs that no longer sit between two stops that are consecutive within a
 * day — reordering or re-daying a stop invalidates the transport either side of
 * it, and a stale leg would otherwise resurface if the pair met again later.
 */
function pruneLegs(
  places: SavedPlace[],
  dayOf: Record<string, number>,
  legs: ItineraryLeg[],
): ItineraryLeg[] {
  const pairs = new Set<string>();
  for (let i = 0; i < places.length - 1; i++) {
    const a = places[i];
    const b = places[i + 1];
    if ((dayOf[a.id] ?? 1) === (dayOf[b.id] ?? 1)) pairs.add(`${a.id}→${b.id}`);
  }
  return legs.filter((l) => pairs.has(`${l.fromId}→${l.toId}`));
}

/**
 * Itineraries persisted before days/legs/destination existed are a bare
 * `{ id, name, createdAt, places }`, and an older client can sync that shape
 * back from the account too. Rebuild anything coming from storage or the
 * network instead of trusting it — a missing `places` array used to be enough
 * to blank the panel.
 */
function normalizeItinerary(raw: unknown): Itinerary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;

  const places = (Array.isArray(o.places) ? o.places : []).filter(
    (p): p is SavedPlace =>
      !!p && typeof p === 'object' && typeof (p as SavedPlace).id === 'string',
  );

  const storedDays = (o.dayOf && typeof o.dayOf === 'object' ? o.dayOf : {}) as Record<
    string,
    unknown
  >;
  const dayOf: Record<string, number> = {};
  for (const p of places) {
    const d = Math.floor(Number(storedDays[p.id]));
    dayOf[p.id] = Number.isFinite(d) && d >= 1 ? d : 1;
  }

  const days = Math.max(1, Math.floor(Number(o.days)) || 1, ...Object.values(dayOf));
  const ids = new Set(places.map((p) => p.id));
  const legs = (Array.isArray(o.legs) ? o.legs : []).filter(
    (l): l is ItineraryLeg =>
      !!l &&
      typeof l === 'object' &&
      ids.has((l as ItineraryLeg).fromId) &&
      ids.has((l as ItineraryLeg).toId) &&
      LEG_MODES.includes((l as ItineraryLeg).mode),
  );

  const ordered = sortByDay(places, dayOf);
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'My Trip',
    createdAt: Number(o.createdAt) || Date.now(),
    destination: typeof o.destination === 'string' ? o.destination : '',
    places: ordered,
    days,
    dayOf,
    legs: pruneLegs(ordered, dayOf, legs),
  };
}

function normalizeItineraries(raw: unknown): Itinerary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeItinerary).filter((it): it is Itinerary => it !== null);
}

/** Union two pinned lists by id (keeps existing order, appends new). */
function mergePinned(a: SavedPlace[], b: SavedPlace[]): SavedPlace[] {
  const seen = new Set(a.map((p) => p.id));
  return [...a, ...b.filter((p) => !seen.has(p.id))];
}

/** Union itineraries by id; for a shared id keep whichever has more places. */
function mergeItineraries(a: unknown, b: unknown): Itinerary[] {
  const byId = new Map<string, Itinerary>();
  for (const it of [...normalizeItineraries(a), ...normalizeItineraries(b)]) {
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
  /** Whether the "all pins" overview is open. */
  pinsOpen: boolean;
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
  setPinsOpen: (open: boolean) => void;

  // Itineraries
  createItinerary: (name?: string, destination?: string) => string;
  deleteItinerary: (id: string) => void;
  renameItinerary: (id: string, name: string) => void;
  setActiveItinerary: (id: string | null) => void;
  /** Point a trip at a place of its own, independent of the search bar. */
  setItineraryDestination: (id: string, destination: string) => void;
  addToItinerary: (itineraryId: string, place: SavedPlace) => void;
  removeFromItinerary: (itineraryId: string, placeId: string) => void;
  /** Reorder within a day; crossing days is `setStopDay`'s job. */
  moveInItinerary: (itineraryId: string, placeId: string, dir: -1 | 1) => void;
  addItineraryDay: (id: string) => void;
  /** Drop a day; its stops fall back to the day before it. */
  removeItineraryDay: (id: string, day: number) => void;
  setStopDay: (itineraryId: string, placeId: string, day: number) => void;
  setItineraryLeg: (itineraryId: string, leg: ItineraryLeg) => void;
  removeItineraryLeg: (itineraryId: string, fromId: string, toId: string) => void;
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
      pinsOpen: false,
      itineraries: [],
      activeItineraryId: null,
      authUser: null,

      // A new search always lands on Explore. Staying on Itinerary/Travel showed
      // a spinner in a tab that has nothing to do with the search, which read as
      // the itinerary being wiped by the search.
      setQuery: (q) =>
        set({ query: q, selectedId: null, frameOnLoad: true, panelTab: 'explore' }),
      // Map-driven loads also belong on Explore: clicking a city label while
      // reading Advice should show that city's places, not leave you on a tab
      // describing somewhere else.
      exploreTo: (q) =>
        set({ query: q, selectedId: null, frameOnLoad: false, panelTab: 'explore' }),
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
      setPinsOpen: (open) => set({ pinsOpen: open }),

      createItinerary: (name, destination) => {
        const id = uid();
        const it: Itinerary = {
          id,
          name: name?.trim() || 'My Trip',
          createdAt: Date.now(),
          places: [],
          destination: destination?.trim() ?? '',
          days: 1,
          dayOf: {},
          legs: [],
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
      setItineraryDestination: (id, destination) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === id ? { ...it, destination: destination.trim() } : it,
          ),
        })),
      addToItinerary: (itineraryId, place) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== itineraryId || it.places.some((p) => p.id === place.id)) return it;
            // New stops land on the last day, which is also what keeps `places`
            // ordered by day without a re-sort.
            return {
              ...it,
              places: [...it.places, place],
              dayOf: { ...it.dayOf, [place.id]: it.days },
            };
          }),
        })),
      removeFromItinerary: (itineraryId, placeId) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== itineraryId) return it;
            const places = it.places.filter((p) => p.id !== placeId);
            const dayOf = { ...it.dayOf };
            delete dayOf[placeId];
            return { ...it, places, dayOf, legs: pruneLegs(places, dayOf, it.legs) };
          }),
        })),
      moveInItinerary: (itineraryId, placeId, dir) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== itineraryId) return it;
            const i = it.places.findIndex((p) => p.id === placeId);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= it.places.length) return it;
            // A stop only reorders inside its own day — dragging it past the
            // boundary would silently change which day it happens on.
            if ((it.dayOf[it.places[j].id] ?? 1) !== (it.dayOf[placeId] ?? 1)) return it;
            const places = [...it.places];
            [places[i], places[j]] = [places[j], places[i]];
            return { ...it, places, legs: pruneLegs(places, it.dayOf, it.legs) };
          }),
        })),
      addItineraryDay: (id) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === id ? { ...it, days: it.days + 1 } : it,
          ),
        })),
      removeItineraryDay: (id, day) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== id || it.days <= 1) return it;
            const dayOf: Record<string, number> = {};
            for (const p of it.places) {
              const d = it.dayOf[p.id] ?? 1;
              // Stops on the dropped day merge into the previous one so nothing
              // silently disappears from the trip.
              dayOf[p.id] = d > day ? d - 1 : d === day ? Math.max(1, day - 1) : d;
            }
            const places = sortByDay(it.places, dayOf);
            return {
              ...it,
              days: it.days - 1,
              dayOf,
              places,
              legs: pruneLegs(places, dayOf, it.legs),
            };
          }),
        })),
      setStopDay: (itineraryId, placeId, day) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) => {
            if (it.id !== itineraryId) return it;
            const target = Math.max(1, Math.min(it.days, day));
            const moved = it.places.find((p) => p.id === placeId);
            if (!moved || (it.dayOf[placeId] ?? 1) === target) return it;
            const dayOf = { ...it.dayOf, [placeId]: target };
            // Re-insert at the END of the target day rather than sorting, so a
            // moved stop lands where the user is looking: after that day's
            // existing stops.
            const rest = it.places.filter((p) => p.id !== placeId);
            let at = rest.length;
            for (let i = 0; i < rest.length; i++) {
              if ((dayOf[rest[i].id] ?? 1) > target) {
                at = i;
                break;
              }
            }
            const places = [...rest.slice(0, at), moved, ...rest.slice(at)];
            return { ...it, places, dayOf, legs: pruneLegs(places, dayOf, it.legs) };
          }),
        })),
      setItineraryLeg: (itineraryId, leg) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === itineraryId
              ? {
                  ...it,
                  legs: [
                    ...it.legs.filter(
                      (l) => !(l.fromId === leg.fromId && l.toId === leg.toId),
                    ),
                    leg,
                  ],
                }
              : it,
          ),
        })),
      removeItineraryLeg: (itineraryId, fromId, toId) =>
        set((s) => ({
          itineraries: s.itineraries.map((it) =>
            it.id === itineraryId
              ? {
                  ...it,
                  legs: it.legs.filter((l) => !(l.fromId === fromId && l.toId === toId)),
                }
              : it,
          ),
        })),
      quickAddToItinerary: (place) => {
        let id = get().activeItineraryId;
        if (!id || !get().itineraries.some((it) => it.id === id)) {
          // Seed the destination from the stop being added, not from the search
          // bar — from here on the trip carries its own destination.
          id = get().createItinerary(
            `Trip to ${place.location || 'somewhere'}`,
            place.location,
          );
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
      // Trips saved before days/legs/destination existed are upgraded on the
      // way out of localStorage, so the panel never sees the old flat shape.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        return { ...current, ...saved, itineraries: normalizeItineraries(saved.itineraries) };
      },
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
