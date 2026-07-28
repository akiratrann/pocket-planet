import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import SearchBar from './components/SearchBar';
import CategoryBar from './components/CategoryBar';
import DestinationList from './components/DestinationList';
import DestinationDetail from './components/DestinationDetail';
import BuildProgress from './components/BuildProgress';
import LanguageSelector from './components/LanguageSelector';
import AuthWidget from './components/AuthWidget';
import ChatWidget from './components/ChatWidget';
import { useGuide } from './hooks/useGuide';
import { useAppStore } from './store/useAppStore';
import { useI18n } from './i18n';
import { CATEGORIES } from './data/categories';
import type { CategoryId, Destination } from './types';

/* ---------- Deferred code ----------
 *
 * Everything below is split out of the entry bundle. The app opens on the
 * Explore tab, so that is the only panel worth paying for up front; a reader in
 * Vietnam pulling bytes from a single machine in California should not wait on
 * the itinerary editor or the flashcard engine to see the first list of places.
 *
 * DestinationDetail and DestinationList deliberately stay eager: they ARE the
 * Explore tab, and DestinationList imports DestinationDetail's PlacePhoto /
 * RankProvenance anyway, so splitting it would move zero bytes off the critical
 * path while adding a spinner between a tap and the place you tapped.
 *
 * Each loader is a named function, not an inline arrow, so the tab buttons can
 * call it on hover to start the fetch before the click lands (see `prefetch`).
 */

// maplibre-gl is by far the largest dependency, and the map is scenery behind
// the panel — the panel text is what a user reads first. Loading it as a
// separate chunk lets the panel paint while the map is still arriving.
//
// Only the JS moves. maplibre's stylesheet stays eagerly imported in main.tsx:
// it has to load BEFORE App.css or it wins the cascade and flattens the map
// container to zero height. See the comment there.
const loadMapView = () => import('./components/MapView');
const loadAdvicePanel = () => import('./components/AdvicePanel');
const loadItineraryPanel = () => import('./components/ItineraryPanel');
const loadTravelPanel = () => import('./components/TravelPanel');
const loadLearningPanel = () => import('./components/LearningPanel');
const loadPinsPanel = () => import('./components/PinsPanel');

const MapView = lazy(loadMapView);
const AdvicePanel = lazy(loadAdvicePanel);
const ItineraryPanel = lazy(loadItineraryPanel);
const TravelPanel = lazy(loadTravelPanel);
const LearningPanel = lazy(loadLearningPanel);
const PinsPanel = lazy(loadPinsPanel);

/**
 * Start a chunk download on hover/focus, before the click.
 *
 * The gap between "pointer enters the tab" and "pointer clicks the tab" is
 * usually enough to hide the fetch entirely on a decent link, and is a real
 * head start on a bad one. Repeat calls are free — the module registry
 * de-duplicates in-flight imports.
 */
const prefetch = (load: () => Promise<unknown>) => () => {
  void load();
};

/**
 * Suspense fallback for a lazily-loaded panel.
 *
 * Reuses the `.status` / `.spinner` markup BuildProgress already uses for the
 * guide fetch, so a chunk arriving looks like data arriving instead of a new
 * kind of blank. It occupies the same block the panel will, which keeps the
 * swap from shifting the layout underneath a reader.
 */
function PanelFallback() {
  return (
    <div className="status" aria-busy="true">
      <div className="spinner" />
    </div>
  );
}

const MIN_W = 330;
const MAX_W = 720;
const SHEET_SNAPS = [26, 60, 92]; // mobile bottom-sheet heights (vh)

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

export default function App() {
  const query = useAppStore((s) => s.query);
  const exploreTo = useAppStore((s) => s.exploreTo);
  const frameOnLoad = useAppStore((s) => s.frameOnLoad);
  const active = useAppStore((s) => s.activeCategories);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoveredId = useAppStore((s) => s.hoveredId);
  const select = useAppStore((s) => s.select);
  const panelTab = useAppStore((s) => s.panelTab);
  const routeGeometry = useAppStore((s) => s.routeGeometry);
  const itineraries = useAppStore((s) => s.itineraries);
  const activeItineraryId = useAppStore((s) => s.activeItineraryId);
  const setPanelTab = useAppStore((s) => s.setPanelTab);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const setPanelOpen = useAppStore((s) => s.setPanelOpen);
  const pinned = useAppStore((s) => s.pinned);
  const pinsOpen = useAppStore((s) => s.pinsOpen);
  const setPinsOpen = useAppStore((s) => s.setPinsOpen);
  const { t, lang, dir } = useI18n();

  // Reflect language + direction on the document for correct RTL rendering.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const isMobile = useIsMobile();
  const [autoExplore, setAutoExplore] = useState(true);
  const [exploring, setExploring] = useState<string | null>(null);

  const [panelWidth, setPanelWidth] = useState(() =>
    clamp(Number(localStorage.getItem('pp-panel-width')) || 400, MIN_W, MAX_W),
  );
  const [sheetVh, setSheetVh] = useState(60);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  const { data: guide, isLoading, isError, error } = useGuide(query, lang);

  const counts = useMemo(() => {
    const c = Object.fromEntries(CATEGORIES.map((cat) => [cat.id, 0])) as Record<CategoryId, number>;
    guide?.destinations.forEach((d) => {
      c[d.category] += 1;
    });
    return c;
  }, [guide]);

  const visibleDestinations = useMemo(() => {
    if (!guide) return [];
    if (active.size === 0) return guide.destinations;
    return guide.destinations.filter((d) => active.has(d.category));
  }, [guide, active]);

  // On the Itinerary tab the map serves the TRIP, not the guide: only this
  // trip's stops, numbered in the order they'll be visited. Saved stops carry
  // their own coordinates, so a trip spanning several guides still maps.
  const activeItinerary = itineraries.find((it) => it.id === activeItineraryId) ?? null;
  const itineraryMode = panelTab === 'itinerary' && !!activeItinerary?.places.length;

  const itineraryOrder = useMemo(() => {
    if (!itineraryMode || !activeItinerary) return null;
    return new Map(activeItinerary.places.map((p, i) => [p.id, i + 1]));
  }, [itineraryMode, activeItinerary]);

  const itineraryDestinations = useMemo((): Destination[] => {
    if (!itineraryMode || !activeItinerary) return [];
    // Saved stops are a lighter shape than Destination; fill the display-only
    // fields the map needs rather than refetching each place's full guide.
    return activeItinerary.places
      .filter((p) => p.lat != null && p.lon != null)
      .map((p, i) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        wvType: '',
        // Non-null: the filter above already dropped stops without coordinates.
        lat: p.lat as number,
        lon: p.lon as number,
        score: p.score ?? 0,
        rank: i + 1,
        order: i,
        // A saved stop carries no scoring rationale; the trip order is the
        // reason it's on the map at all.
        reasons: [],
        // Spread conditionally: tsconfig enables exactOptionalPropertyTypes, so
        // an explicit `undefined` is not assignable to an optional field.
        ...(p.image ? { image: p.image } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.url ? { url: p.url } : {}),
      }));
  }, [itineraryMode, activeItinerary]);

  const mapDestinations = itineraryMode ? itineraryDestinations : visibleDestinations;

  const selected = guide?.destinations.find((d) => d.id === selectedId) ?? null;

  // Drag-to-resize (desktop width / mobile sheet height).
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const mobile = isMobile;
    const startPos = mobile ? e.clientY : e.clientX;
    const startVal = mobile ? sheetVh : panelWidth;
    setDragging(true);
    document.body.style.userSelect = 'none';

    const move = (ev: PointerEvent) => {
      if (mobile) {
        const vh = startVal + ((startPos - ev.clientY) / window.innerHeight) * 100;
        setSheetVh(clamp(vh, 14, 94));
      } else {
        setPanelWidth(clamp(startVal + (ev.clientX - startPos), MIN_W, MAX_W));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      setDragging(false);
      if (mobile) {
        setSheetVh((v) => SHEET_SNAPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)));
      } else {
        setPanelWidth((w) => {
          localStorage.setItem('pp-panel-width', String(Math.round(w)));
          return w;
        });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const closePanel = () => {
    if (isMobile) setSheetVh(SHEET_SNAPS[0]);
    else setPanelOpen(false);
  };

  const panelStyle: React.CSSProperties = isMobile
    ? { height: `${sheetVh}vh` }
    : { width: panelWidth };
  const collapsed = !isMobile && !panelOpen;

  return (
    <div className={'app' + (dragging ? ' app--dragging' : '')}>
      {/* The fallback is the map's own container box, empty. The map is a
          full-bleed backdrop, so a spinner here would be a full-screen spinner
          over content that is already readable; an empty box holds the exact
          space the canvas will fill and nothing moves when it arrives. */}
      <Suspense fallback={<div className="map-container" />}>
        <MapView
          guide={guide}
          destinations={mapDestinations}
          selectedId={selectedId}
          hoveredId={hoveredId}
          onSelect={select}
          autoExplore={autoExplore}
          onExplore={(place) => exploreTo(place)}
          onExploringChange={setExploring}
          allCategories={active.size === 0}
          frameOnLoad={frameOnLoad}
          lang={lang}
          routeGeometry={routeGeometry}
          itineraryOrder={itineraryOrder}
        />
      </Suspense>

      <div className="map-controls">
        <button
          className={'explore-toggle' + (autoExplore ? ' explore-toggle--on' : '')}
          onClick={() => setAutoExplore((v) => !v)}
          title="Automatically load places as you pan and zoom the world"
        >
          🌍 {t('explore_move')}: {autoExplore ? t('on') : t('off')}
        </button>
        {exploring && autoExplore && <div className="explore-toast">{exploring}…</div>}
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">🧭</span>
          <span className="brand__name">Pocket&nbsp;Planet</span>
        </div>
        <SearchBar isLoading={isLoading} />
        <div className="topbar__end">
          <button
            className={'pins-open' + (pinned.length ? ' pins-open--has' : '')}
            onClick={() => setPinsOpen(true)}
            onPointerEnter={prefetch(loadPinsPanel)}
            onFocus={prefetch(loadPinsPanel)}
            aria-haspopup="dialog"
            title={t('pins_open')}
            aria-label={t('pins_open')}
          >
            <span aria-hidden>📌</span>
            <span className="pins-open__count">{pinned.length}</span>
          </button>
          <LanguageSelector />
          <AuthWidget />
        </div>
      </header>

      {collapsed && (
        <button className="panel-reopen" onClick={() => setPanelOpen(true)} aria-label="Show panel">
          ⟩
        </button>
      )}

      <aside
        ref={panelRef}
        className={'panel' + (collapsed ? ' panel--closed' : '')}
        style={panelStyle}
      >
        {isMobile && (
          <div className="sheet-grab" onPointerDown={startDrag}>
            <span className="sheet-grab__bar" />
          </div>
        )}

        <div className="panel__header">
          <div className="panel__titlebar">
            <h1 className="panel__place">
              <span className="panel__place-name">{guide ? guide.title : query}</span>
              {guide && (
                <span className="panel__place-count">
                  {guide.destinations.length} {t('places')}
                </span>
              )}
            </h1>
            <button className="panel__close" onClick={closePanel} aria-label="Close panel" title="Close">
              ✕
            </button>
          </div>
          <div className="panel__tabs">
            <button
              className={'tab' + (panelTab === 'explore' ? ' tab--on' : '')}
              onClick={() => setPanelTab('explore')}
            >
              🗺️ {t('tab_explore')}
            </button>
            <button
              className={'tab' + (panelTab === 'advice' ? ' tab--on' : '')}
              onClick={() => setPanelTab('advice')}
              onPointerEnter={prefetch(loadAdvicePanel)}
              onFocus={prefetch(loadAdvicePanel)}
            >
              💡 {t('tab_advice')}
            </button>
            <button
              className={'tab' + (panelTab === 'itinerary' ? ' tab--on' : '')}
              onClick={() => setPanelTab('itinerary')}
              onPointerEnter={prefetch(loadItineraryPanel)}
              onFocus={prefetch(loadItineraryPanel)}
            >
              🧳 {t('tab_itinerary')}
            </button>
            <button
              className={'tab' + (panelTab === 'travel' ? ' tab--on' : '')}
              onClick={() => setPanelTab('travel')}
              onPointerEnter={prefetch(loadTravelPanel)}
              onFocus={prefetch(loadTravelPanel)}
            >
              ✈️ {t('tab_travel')}
            </button>
            <button
              className={'tab' + (panelTab === 'learn' ? ' tab--on' : '')}
              onClick={() => setPanelTab('learn')}
              onPointerEnter={prefetch(loadLearningPanel)}
              onFocus={prefetch(loadLearningPanel)}
            >
              🧠 {t('tab_learn')}
            </button>
          </div>
        </div>

        <div className="panel__scroll">
          {/* One boundary around the whole tab body rather than one per panel:
              only ever one tab is mounted, so a single fallback is enough, and
              it lands in the same place the panel content would — no nested
              spinners, no shifting. */}
          <Suspense fallback={<PanelFallback />}>
            {/* The itinerary belongs to its own destination, not to whatever is
                in the search bar, so it renders regardless of guide loading
                state. Gating it behind the search meant starting a new search
                replaced a trip the user was editing with a "Building your
                guide…" spinner — the data survived, but it read as though the
                trip had been wiped. */}
            {panelTab === 'itinerary' ? (
              <ItineraryPanel guide={guide} />
            ) : (
              <>
                {isLoading && <BuildProgress query={query} />}

                {isError && (
                  <div className="status status--error">
                    <p>
                      {t('error_title')} “{query}”.
                    </p>
                    <p className="status__hint">{(error as Error)?.message ?? t('error_hint')}</p>
                  </div>
                )}

                {guide && !isLoading && (
                  <>
                    {panelTab === 'explore' &&
                      (selected ? (
                        <DestinationDetail d={selected} location={guide.title} />
                      ) : (
                        <>
                          <div className="panel__sticky">
                            <CategoryBar counts={counts} />
                          </div>
                          <DestinationList
                            destinations={visibleDestinations}
                            location={guide.title}
                          />
                        </>
                      ))}
                    {panelTab === 'advice' && <AdvicePanel guide={guide} />}
                    {panelTab === 'travel' && <TravelPanel guide={guide} />}
                    {panelTab === 'learn' && <LearningPanel guide={guide} />}
                  </>
                )}
              </>
            )}
          </Suspense>
        </div>

        {!isMobile && panelOpen && (
          <div
            className="resize-handle"
            onPointerDown={startDrag}
            title="Drag to resize"
            role="separator"
            aria-orientation="vertical"
          />
        )}
      </aside>

      <ChatWidget guide={guide} />
      {/* No fallback: the pins dialog draws its own overlay and frame, so a
          bare spinner would float unstyled over the map for the one frame it
          takes to arrive. The 📌 button prefetches on hover, which in practice
          means the chunk is already there by the time it is clicked. */}
      {pinsOpen && (
        <Suspense fallback={null}>
          <PinsPanel />
        </Suspense>
      )}
    </div>
  );
}
