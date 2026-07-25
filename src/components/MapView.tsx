import { useEffect, useRef } from 'react';
import {
  Map as MaplibreMap,
  Marker,
  NavigationControl,
  AttributionControl,
  type StyleSpecification,
} from 'maplibre-gl';
import type { Destination, Guide } from '../types';
import { CATEGORY_MAP } from '../data/categories';
import { reverseGeocode } from '../data/geocode';

// Clean, no-API-key raster basemap (CARTO Voyager over OpenStreetMap data).
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
};

interface Props {
  guide?: Guide;
  destinations: Destination[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  /** Auto-load a place when the user roams to an empty part of the world. */
  autoExplore: boolean;
  onExplore: (placeName: string) => void;
  onExploringChange: (label: string | null) => void;
  /** True when no category filter is active — keep the map uncluttered. */
  allCategories: boolean;
}

/** With no category filter, show just the top highlights so the map isn't cramped. */
const OVERVIEW_CAP = 10;

/** How many pins to show at a given zoom — few when zoomed out, all up close. */
function capForZoom(zoom: number): number {
  if (zoom < 3) return 8;
  if (zoom < 5) return 16;
  if (zoom < 7) return 30;
  if (zoom < 9) return 60;
  if (zoom < 11) return 120;
  if (zoom < 13) return 250;
  return 100000;
}

function markerElement(d: Destination, selected: boolean): HTMLElement {
  const cat = CATEGORY_MAP[d.category];
  // Wrapper is positioned by MapLibre; the inner pin owns all visual transforms,
  // so our CSS can never fight MapLibre's absolute positioning.
  const wrap = document.createElement('div');
  wrap.className = 'map-pin-wrap';
  const el = document.createElement('button');
  el.className = 'map-pin' + (selected ? ' map-pin--selected' : '');
  el.style.setProperty('--pin-color', cat.color);
  el.title = `${d.name} · #${d.rank} in ${cat.label}`;
  el.innerHTML = `<span class="map-pin__glyph">${cat.icon}</span>`;
  if (d.rank <= 3) el.innerHTML += `<span class="map-pin__rank">${d.rank}</span>`;
  wrap.appendChild(el);
  return wrap;
}

export default function MapView({
  guide,
  destinations,
  selectedId,
  hoveredId,
  onSelect,
  autoExplore,
  onExplore,
  onExploringChange,
  allCategories,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const loadedRef = useRef(false);

  // Latest values for use inside stable map event handlers.
  const destRef = useRef(destinations);
  const guideRef = useRef(guide);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const autoExploreRef = useRef(autoExplore);
  const onExploreRef = useRef(onExplore);
  const onExploringChangeRef = useRef(onExploringChange);
  const allCategoriesRef = useRef(allCategories);
  const lastExploredRef = useRef<string>('');
  const suppressUntilRef = useRef<number>(0);
  const exploreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  destRef.current = destinations;
  guideRef.current = guide;
  selectedRef.current = selectedId;
  onSelectRef.current = onSelect;
  autoExploreRef.current = autoExplore;
  onExploreRef.current = onExplore;
  onExploringChangeRef.current = onExploringChange;
  allCategoriesRef.current = allCategories;

  /** Render only the pins that belong in the current viewport + zoom budget. */
  const renderMarkers = () => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const bounds = map.getBounds();
    // In "All categories" mode keep it to the top highlights; once the user
    // filters to specific categories, reveal the full zoom-based set.
    const cap = allCategoriesRef.current
      ? Math.min(OVERVIEW_CAP, capForZoom(map.getZoom()))
      : capForZoom(map.getZoom());

    const inView = destRef.current
      .filter((d) => d.lat != null && d.lon != null && bounds.contains([d.lon!, d.lat!]))
      .sort((a, b) => b.score - a.score);

    const chosen = inView.slice(0, cap);
    // Always keep the selected pin on the map.
    const sel = selectedRef.current;
    if (sel && !chosen.some((d) => d.id === sel)) {
      const s = destRef.current.find((d) => d.id === sel);
      if (s?.lat != null && s?.lon != null) chosen.push(s);
    }
    const wanted = new Set(chosen.map((d) => d.id));

    for (const [id, marker] of markers) {
      if (!wanted.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
    for (const d of chosen) {
      if (markers.has(d.id)) continue;
      const el = markerElement(d, d.id === selectedRef.current);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectRef.current?.(d.id);
      });
      const marker = new Marker({ element: el, anchor: 'bottom' })
        .setLngLat([d.lon!, d.lat!])
        .addTo(map);
      markers.set(d.id, marker);
    }
  };

  /** When you roam to an empty area, discover what place is there and load it. */
  const maybeAutoExplore = () => {
    const map = mapRef.current;
    if (!map || !autoExploreRef.current) return;
    if (Date.now() < suppressUntilRef.current) return;
    const zoom = map.getZoom();
    if (zoom < 4) return;

    // If we already have pins in view, we're looking at loaded data — don't reload.
    const bounds = map.getBounds();
    const hasInView = destRef.current.some(
      (d) => d.lat != null && d.lon != null && bounds.contains([d.lon!, d.lat!]),
    );
    if (hasInView) return;

    if (exploreTimerRef.current) clearTimeout(exploreTimerRef.current);
    exploreTimerRef.current = setTimeout(async () => {
      const c = map.getCenter();
      const place = await reverseGeocode(c.lat, c.lng, map.getZoom());
      if (!place) return;
      const key = place.name.trim().toLowerCase();
      if (key === lastExploredRef.current || key === guideRef.current?.title.toLowerCase()) return;
      lastExploredRef.current = key;
      onExploringChangeRef.current?.(place.name);
      onExploreRef.current?.(place.name);
    }, 650);
  };

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MaplibreMap({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [0, 20],
      zoom: 1.4,
      attributionControl: false,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-left');
    map.on('load', () => {
      loadedRef.current = true;
      renderMarkers();
    });
    map.on('moveend', () => {
      renderMarkers();
      maybeAutoExplore();
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit the map to the current guide's extent when a new guide loads.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !guide) return;
    // Suppress auto-explore during/just after the programmatic camera move.
    suppressUntilRef.current = Date.now() + 2500;
    lastExploredRef.current = guide.title.trim().toLowerCase();
    onExploringChangeRef.current?.(null);
    const apply = () => {
      if (guide.bbox) {
        map.fitBounds(
          [
            [guide.bbox[0], guide.bbox[1]],
            [guide.bbox[2], guide.bbox[3]],
          ],
          { padding: { top: 80, bottom: 80, left: 60, right: 60 }, maxZoom: 15, duration: 900 },
        );
      } else {
        map.flyTo({ center: guide.center, zoom: 11, duration: 900 });
      }
    };
    if (loadedRef.current) apply();
    else map.once('load', apply);
  }, [guide]);

  // Re-render pins when the visible destination set changes (filters, learning).
  useEffect(() => {
    if (loadedRef.current) renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinations, selectedId, allCategories]);

  // Highlight the hovered destination's pin (list -> map sync).
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const pin = marker.getElement().firstElementChild;
      pin?.classList.toggle('map-pin--hover', id === hoveredId);
    }
  }, [hoveredId]);

  // Pan to the selected destination.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const d = destinations.find((x) => x.id === selectedId);
    if (d?.lat != null && d?.lon != null) {
      suppressUntilRef.current = Date.now() + 2000;
      map.flyTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 14), duration: 700 });
    }
  }, [selectedId, destinations]);

  return <div ref={containerRef} className="map-container" />;
}
