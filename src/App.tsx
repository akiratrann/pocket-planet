import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import MapView from './components/MapView';
import SearchBar from './components/SearchBar';
import CategoryBar from './components/CategoryBar';
import DestinationList from './components/DestinationList';
import DestinationDetail from './components/DestinationDetail';
import AdvicePanel from './components/AdvicePanel';
import LearningPanel from './components/LearningPanel';
import ItineraryPanel from './components/ItineraryPanel';
import LanguageSelector from './components/LanguageSelector';
import ChatWidget from './components/ChatWidget';
import { useGuide } from './hooks/useGuide';
import { useAppStore } from './store/useAppStore';
import { useI18n } from './i18n';
import { CATEGORIES } from './data/categories';
import type { CategoryId } from './types';

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
  const setPanelTab = useAppStore((s) => s.setPanelTab);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const setPanelOpen = useAppStore((s) => s.setPanelOpen);
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
      <MapView
        guide={guide}
        destinations={visibleDestinations}
        selectedId={selectedId}
        hoveredId={hoveredId}
        onSelect={select}
        autoExplore={autoExplore}
        onExplore={(place) => exploreTo(place)}
        onExploringChange={setExploring}
        allCategories={active.size === 0}
        frameOnLoad={frameOnLoad}
        lang={lang}
      />

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
        <LanguageSelector />
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
            >
              💡 {t('tab_advice')}
            </button>
            <button
              className={'tab' + (panelTab === 'itinerary' ? ' tab--on' : '')}
              onClick={() => setPanelTab('itinerary')}
            >
              🧳 {t('tab_itinerary')}
            </button>
            <button
              className={'tab' + (panelTab === 'learn' ? ' tab--on' : '')}
              onClick={() => setPanelTab('learn')}
            >
              🧠 {t('tab_learn')}
            </button>
          </div>
        </div>

        <div className="panel__scroll">
          {isLoading && (
            <div className="status">
              <div className="spinner" />
              <p>
                {t('building_guide')} “{query}”…
              </p>
            </div>
          )}

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
                    <DestinationList destinations={visibleDestinations} location={guide.title} />
                  </>
                ))}
              {panelTab === 'advice' && <AdvicePanel guide={guide} />}
              {panelTab === 'itinerary' && <ItineraryPanel guide={guide} />}
              {panelTab === 'learn' && <LearningPanel guide={guide} />}
            </>
          )}
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
    </div>
  );
}
