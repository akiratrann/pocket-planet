import { useEffect, useRef } from 'react';
import {
  Map as MaplibreMap,
  Marker,
  NavigationControl,
  AttributionControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Destination, Guide } from '../types';
import type { QuerySource } from '../store/useAppStore';
import { CATEGORY_MAP } from '../data/categories';
import { reverseGeocode, scopeForSpanKm, isSamePlace, type MapScope } from '../data/geocode';
import { translate } from '../i18n';

// maplibre derives its worker URL from `new URL(`./${name}`, import.meta.url)`.
// The interpolated name defeats the bundler's static analysis, so the worker is
// never emitted and the production build resolves it to /assets/maplibre-gl-
// worker.mjs — which the SPA fallback answers with index.html. The worker then
// dies silently, and since ONLY vector tiles and glyphs are fetched off-thread,
// the symptom is a map that loads style.json, TileJSON and sprites and then
// renders nothing. Raster basemaps hid this because they load on the main
// thread. `?worker&url` makes Vite bundle the worker and hand back its real
// hashed URL.
setWorkerUrl(maplibreWorkerUrl);

// Vector basemap, no API key. It has to be vector: the previous CARTO *raster*
// basemap bakes place names into the PNGs, so "大阪市" over Osaka could not be
// translated client-side at any price. With vector tiles the names are feature
// properties and `forceEnglishLabels` below can pick which one to draw.
//
// OpenFreeMap serves OpenMapTiles-schema tiles whose features carry a full set
// of `name:<lang>` properties, which is exactly what the English rewrite needs.
// Attribution (OpenFreeMap / OpenMapTiles / OpenStreetMap) rides along in the
// source TileJSON, so the AttributionControl below picks it up on its own.
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Liberty's own labels are "latin\nnonlatin" stacks (`OYODONAKA 2-CHOME` over
// `大淀中二丁目`). Prefer the real English name, then OpenMapTiles' Latin
// transliteration, and only fall back to the local-script name when a feature
// has neither — which also keeps us off unshaped RTL text in most of the world,
// since we ship no RTL text plugin.
const ENGLISH_LABEL = [
  'coalesce',
  // OpenMapTiles names the English field `name_en` with an UNDERSCORE. An
  // earlier version asked for `name:en` (colon), which simply does not exist in
  // this schema — that branch always missed, so everything fell through to
  // `name:latin`, and anything without a latin name still rendered Japanese.
  // The style's own layers use `name_en`, which is how this was confirmed.
  ['get', 'name_en'],
  ['get', 'name:latin'],
  ['get', 'name_int'],
  ['get', 'name'],
] as unknown as ExpressionSpecification;

/**
 * The style's `place` source-layer labels — cities, towns, provinces, countries.
 * Taken from Liberty's layer ids; a layer that is absent is simply not matched,
 * so an upstream rename degrades to "clicking does nothing" rather than an error.
 */
const PLACE_LABEL_LAYERS = [
  'label_country_1',
  'label_country_2',
  'label_country_3',
  'label_state',
  'label_city_capital',
  'label_city',
  'label_town',
  'label_village',
  'label_other',
];

/**
 * Repoint every name-bearing symbol layer at the English label expression.
 * Layers keyed off `ref` (motorway shields) are left alone — a road number is
 * already language-neutral, and rewriting it would blank the shields.
 */
function forceEnglishLabels(map: MaplibreMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const field = layer.layout?.['text-field'];
    if (field == null || !JSON.stringify(field).includes('name')) continue;
    map.setLayoutProperty(layer.id, 'text-field', ENGLISH_LABEL);
  }
}

/**
 * What the current viewport says the user is looking at, when that disagrees
 * with the guide on screen.
 *
 * `offer` — a concrete place at the viewport's scope, waiting for one click.
 * `too-far` — a continental/global view, which no single guide answers.
 */
export type ScopeHint =
  | { kind: 'offer'; name: string; scope: MapScope }
  | { kind: 'too-far' };

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
  /** Who chose the loaded guide — decides re-scope vs. merely offer to. */
  querySource: QuerySource;
  /** Raised when the viewport's scope stops matching the guide. Null clears it. */
  onScopeHint: (hint: ScopeHint | null) => void;
  /** True when no category filter is active — keep the map uncluttered. */
  allCategories: boolean;
  /** Whether to frame the camera to a newly loaded guide (searches yes, zoom-explore no). */
  frameOnLoad: boolean;
  /** UI language, for localized region labels + marker tooltips. */
  lang: string;
  /** Directions line to draw, as [lon, lat] pairs. Null clears it. */
  routeGeometry?: Array<[number, number]> | null;
  /**
   * Itinerary mode: destination id -> 1-based stop number. When set, the map
   * shows ONLY these places, numbered in trip order rather than by rank, and
   * skips the zoom/score capping — a trip's stops are all wanted, always.
   */
  itineraryOrder?: Map<string, number> | null;
}

/** With no category filter, show just the top highlights so the map isn't cramped. */
const OVERVIEW_CAP = 10;

/**
 * How long the map must sit still before its scope is re-read.
 *
 * Long on purpose. Every re-scope can cost a guide build (25-70s cold on a place
 * nobody has asked for yet), so the trigger has to be "the user stopped and
 * looked", not "the wheel turned". A continuous wheel-zoom fires `moveend`
 * repeatedly and every one of those restarts this timer, so an eight-step zoom
 * out from a city to a country is ONE lookup, at the end.
 */
const RESCOPE_DEBOUNCE_MS = 1100;

/** Mean km per degree of latitude — good to ~0.3% anywhere, which is plenty here. */
const KM_PER_DEG = 111.32;

/** The widest the viewport reaches on the ground, in km. */
function viewportSpanKm(map: MaplibreMap): number {
  const b = map.getBounds();
  const latSpan = Math.min(Math.abs(b.getNorth() - b.getSouth()), 180);
  // Zoomed far enough out the world repeats and `east - west` runs past 360.
  const lonSpan = Math.min(Math.abs(b.getEast() - b.getWest()), 360);
  const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
  return Math.max(latSpan * KM_PER_DEG, lonSpan * KM_PER_DEG * Math.cos(midLat));
}

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

function markerElement(
  d: Destination,
  selected: boolean,
  lang: string,
  stopNumber?: number,
): HTMLElement {
  const cat = CATEGORY_MAP[d.category];
  // Wrapper is positioned by MapLibre; the inner pin owns all visual transforms,
  // so our CSS can never fight MapLibre's absolute positioning.
  const wrap = document.createElement('div');
  wrap.className = 'map-pin-wrap';
  const el = document.createElement('button');
  el.className = 'map-pin' + (selected ? ' map-pin--selected' : '');
  el.style.setProperty('--pin-color', cat.color);
  el.title = `${d.name} · #${d.rank} · ${translate(lang, 'cat_' + d.category)}`;
  el.innerHTML = `<span class="map-pin__glyph">${cat.icon}</span>`;
  // In a trip the stop number is the useful label; outside one, the rank badge
  // only earns its space for the top few.
  if (stopNumber) {
    el.innerHTML += `<span class="map-pin__rank map-pin__rank--stop">${stopNumber}</span>`;
  } else if (d.rank <= 3) {
    el.innerHTML += `<span class="map-pin__rank">${d.rank}</span>`;
  }
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
  querySource,
  onScopeHint,
  allCategories,
  frameOnLoad,
  lang,
  routeGeometry,
  itineraryOrder,
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
  const langRef = useRef(lang);
  const querySourceRef = useRef(querySource);
  const onScopeHintRef = useRef(onScopeHint);
  /** `scope:place` of the last re-scope decision, so each one is made once. */
  const lastScopeKeyRef = useRef<string>('');
  const suppressUntilRef = useRef<number>(0);
  const exploreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameOnLoadRef = useRef(frameOnLoad);
  frameOnLoadRef.current = frameOnLoad;
  const itineraryOrderRef = useRef(itineraryOrder);
  itineraryOrderRef.current = itineraryOrder;
  const hoveredRef = useRef(hoveredId);
  hoveredRef.current = hoveredId;

  destRef.current = destinations;
  guideRef.current = guide;
  selectedRef.current = selectedId;
  onSelectRef.current = onSelect;
  autoExploreRef.current = autoExplore;
  onExploreRef.current = onExplore;
  onExploringChangeRef.current = onExploringChange;
  allCategoriesRef.current = allCategories;
  langRef.current = lang;
  querySourceRef.current = querySource;
  onScopeHintRef.current = onScopeHint;

  /** Render only the pins that belong in the current viewport + zoom budget. */
  const renderMarkers = () => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const trip = itineraryOrderRef.current;
    const bounds = map.getBounds();
    // In "All categories" mode keep it to the top highlights; once the user
    // filters to specific categories, reveal the full zoom-based set.
    const cap = allCategoriesRef.current
      ? Math.min(OVERVIEW_CAP, capForZoom(map.getZoom()))
      : capForZoom(map.getZoom());

    const inView = destRef.current
      .filter((d) => d.lat != null && d.lon != null && bounds.contains([d.lon!, d.lat!]))
      .sort((a, b) => b.score - a.score);

    // A trip's stops are never capped or viewport-culled: every stop matters,
    // and culling them would make the numbered sequence read as if it had gaps.
    const chosen = trip
      ? destRef.current.filter((d) => d.lat != null && d.lon != null && trip.has(d.id))
      : inView.slice(0, cap);
    // Always keep the selected pin on the map — and the hovered one. Pins are
    // culled by zoom/score/viewport, so hovering a low-ranked place in the list
    // used to highlight nothing at all: the marker it wanted simply wasn't
    // rendered. Forcing it in makes hover answer "where is this?", which is the
    // whole point of the interaction.
    for (const id of [selectedRef.current, hoveredRef.current]) {
      if (!id || chosen.some((d) => d.id === id)) continue;
      const extra = destRef.current.find((d) => d.id === id);
      if (extra?.lat != null && extra?.lon != null) chosen.push(extra);
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
      const el = markerElement(
        d,
        d.id === selectedRef.current,
        langRef.current,
        trip?.get(d.id),
      );
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

  /**
   * Read what the settled viewport is asking about, and act on it.
   *
   * The old version asked two narrower questions — "is the viewport much bigger
   * than the guide's bbox? then load the guide's Wikivoyage PARENT" and "is the
   * viewport empty of pins? then load whatever is at the centre" — and zooming
   * out from Kyoto to the whole of Japan answered neither. Kyoto's pins were
   * still on screen, so the second never ran, and the first climbed a
   * Wikivoyage breadcrumb (Kyoto → Kansai) rather than to the level the user was
   * actually looking at. The panel just kept saying "Kyoto (prefecture)".
   *
   * So the question is now the one the user is really asking: at THIS span, what
   * place am I looking at? A city-sized view means the city, a prefecture-sized
   * view the prefecture, a country-sized view the country.
   */
  const runRescope = async () => {
    const map = mapRef.current;
    if (!map || !autoExploreRef.current) return;
    // Never re-scope out from under a gesture: inertia, an easing flyTo and a
    // trackpad pinch all keep firing `moveend` while the user is still moving.
    // Re-arm instead, so the lookup happens once they have actually stopped.
    if (map.isMoving() || map.isZooming() || map.isRotating()) {
      scheduleRescope();
      return;
    }
    if (Date.now() < suppressUntilRef.current) return;

    const scope = scopeForSpanKm(viewportSpanKm(map));
    // Continental / whole-world. There is no guide for "Asia", and picking the
    // country under the centre of a hemisphere would be a coin toss that costs a
    // 25-70s build, so the map says what it needs and does nothing.
    if (scope === 'world') {
      onScopeHintRef.current?.({ kind: 'too-far' });
      return;
    }

    const guide = guideRef.current;
    const bounds = map.getBounds();
    const hasPinsInView = destRef.current.some(
      (d) => d.lat != null && d.lon != null && bounds.contains([d.lon!, d.lat!]),
    );
    const guideCenterInView = !!guide && bounds.contains(guide.center);

    // Anchor the lookup on the guide when it is still on screen: zooming out
    // from Kyoto is a wider view OF KYOTO, so the country wanted is Kyoto's, not
    // whatever happens to sit under the middle of the window — which at this
    // span could easily be the Sea of Japan or South Korea. Only once the guide
    // has left the screen entirely is the viewport centre the better question.
    const centre = map.getCenter();
    const anchor =
      guide && guideCenterInView
        ? { lat: guide.center[1], lon: guide.center[0] }
        : { lat: centre.lat, lon: centre.lng };

    const place = await reverseGeocode(anchor.lat, anchor.lon, scope, langRef.current);
    // The map can be torn down across that await.
    if (!place || mapRef.current !== map || !autoExploreRef.current) return;

    // The viewport already agrees with the guide. Clear the memo as well as the
    // hint: coming back to a matching view is what earns a dismissed offer the
    // right to be made again later.
    if (guide && isSamePlace(place.name, guide.title)) {
      lastScopeKeyRef.current = '';
      onScopeHintRef.current?.(null);
      return;
    }

    // One decision per (scope, place). This is what makes a dismissal stick, and
    // what stops an answer we cannot match to a Wikivoyage title from being
    // re-offered forever.
    const key = `${place.scope}:${place.name.trim().toLowerCase()}`;
    if (key === lastScopeKeyRef.current) return;
    lastScopeKeyRef.current = key;

    // Roamed clean off the guide → nothing of the user's is on screen to
    // clobber, so load the new place, which is what "explore as I move" has
    // always done. Otherwise the app may only re-choose a guide it chose itself;
    // a destination the user typed is replaced on their click, never on a zoom.
    const roamedAway = !hasPinsInView && !guideCenterInView;
    if (roamedAway || querySourceRef.current === 'map') {
      onScopeHintRef.current?.(null);
      onExploringChangeRef.current?.(place.name);
      onExploreRef.current?.(place.name);
    } else {
      onScopeHintRef.current?.({ kind: 'offer', name: place.name, scope: place.scope });
    }
  };

  const scheduleRescope = () => {
    if (!mapRef.current || !autoExploreRef.current) return;
    if (exploreTimerRef.current) clearTimeout(exploreTimerRef.current);
    exploreTimerRef.current = setTimeout(() => {
      void runRescope();
    }, RESCOPE_DEBOUNCE_MS);
  };

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MaplibreMap({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.4,
      attributionControl: false,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-left');
    // `style.load` fires before the first symbol layout, so labels are drawn in
    // English from the very first frame rather than flashing local script.
    map.on('style.load', () => forceEnglishLabels(map));
    // Clicking a place LABEL searches it. The basemap already names every city,
    // province and country under the cursor, so making those names live turns
    // the map itself into navigation — the alternative is reading a name off
    // the map and retyping it into the search box.
    //
    // Only the `place` source-layer is wired up: roads, parks and POI labels are
    // not destinations this app can build a guide for, and making them look
    // clickable would promise something we can't deliver.
    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: PLACE_LABEL_LAYERS });
      const props = hits[0]?.properties as Record<string, unknown> | undefined;
      if (!props) return;
      // Same preference order as the label the user actually clicked, so we
      // search for the text they saw rather than the local-script name.
      const name = ['name_en', 'name:latin', 'name_int', 'name']
        .map((k) => props[k])
        .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (name) onExploreRef.current?.(name.trim());
    });

    // A label under the cursor should look clickable.
    map.on('mousemove', (e) => {
      const over = map.queryRenderedFeatures(e.point, { layers: PLACE_LABEL_LAYERS }).length > 0;
      map.getCanvas().style.cursor = over ? 'pointer' : '';
    });

    map.on('load', () => {
      loadedRef.current = true;
      renderMarkers();
    });
    map.on('moveend', () => {
      renderMarkers();
      // Google-Maps style: as you zoom/pan, work out what the view is asking
      // about and surface it. These loads NEVER move the camera (see the guide
      // effect) — zooming in/out just fills in the region, it doesn't drag you.
      scheduleRescope();
    });
    mapRef.current = map;
    return () => {
      if (exploreTimerRef.current) clearTimeout(exploreTimerRef.current);
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
    onExploringChangeRef.current?.(null);
    // `lastScopeKeyRef` is deliberately NOT reset here. The guide that just
    // arrived may be titled differently from the name we resolved to get it
    // ("Kyoto Prefecture" → "Kyoto (prefecture)"), and forgetting the decision
    // would have the very next settle propose that same place again, forever.
    // It is cleared in runRescope instead, when the view and the guide agree.

    // Exploratory loads (zoom/pan "guess the region") must not move the camera —
    // just let the new region's pins appear where the user is already looking.
    if (!frameOnLoadRef.current) {
      suppressUntilRef.current = Date.now() + 600;
      renderMarkers();
      return;
    }

    // Explicit search / navigation → frame the camera to the place.
    suppressUntilRef.current = Date.now() + 2500;
    const apply = () => {
      const bb = guide.bbox;
      // Guard against an implausibly large extent — a single stray/mislabelled
      // coordinate can otherwise stretch the bbox across a continent and fling
      // the camera thousands of km away (e.g. Vietnam → Central Asia).
      const spanOk =
        bb != null &&
        bb[2] > bb[0] &&
        bb[3] > bb[1] &&
        bb[2] - bb[0] < 25 &&
        bb[3] - bb[1] < 25;
      if (spanOk) {
        map.fitBounds(
          [
            [bb![0], bb![1]],
            [bb![2], bb![3]],
          ],
          { padding: { top: 80, bottom: 80, left: 60, right: 60 }, maxZoom: 15, duration: 900 },
        );
      } else {
        map.flyTo({ center: guide.center, zoom: 10, duration: 900 });
      }
    };
    if (loadedRef.current) apply();
    else map.once('load', apply);
  }, [guide]);

  // Re-render pins when the visible destination set changes (filters, learning).
  useEffect(() => {
    if (loadedRef.current) renderMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinations, selectedId, allCategories, itineraryOrder]);

  // Highlight the hovered destination's pin (list -> map sync). Renders first,
  // so a pin that was culled exists by the time we go to highlight it.
  useEffect(() => {
    if (loadedRef.current) renderMarkers();
    for (const [id, marker] of markersRef.current) {
      const pin = marker.getElement().firstElementChild;
      pin?.classList.toggle('map-pin--hover', id === hoveredId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Draw the directions line. The source and layer are created on first use and
  // reused after that — swapping the GeoJSON data is far cheaper than removing
  // and re-adding the layer on every route change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;

    const SRC = 'pp-route';
    const LINE = 'pp-route-line';
    const CASING = 'pp-route-casing';

    // Typed locally rather than via the global GeoJSON namespace, which isn't
    // in tsconfig.app.json's lib and fails the `tsc -b` build.
    const data = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: routeGeometry ?? [],
      },
    };

    const existing = map.getSource(SRC) as
      | { setData: (d: typeof data) => void }
      | undefined;

    if (existing) {
      existing.setData(data);
    } else {
      map.addSource(SRC, { type: 'geojson', data });
      // Casing underneath gives the line contrast over both light streets and
      // dark satellite-ish tiles.
      map.addLayer({
        id: CASING,
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: LINE,
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e4572e', 'line-width': 4 },
      });
    }

    // Frame the route so the whole thing is visible.
    if (routeGeometry && routeGeometry.length > 1) {
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      for (const [lon, lat] of routeGeometry) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
      suppressUntilRef.current = Date.now() + 2000;
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        { padding: 60, duration: 700, maxZoom: 16 },
      );
    }
  }, [routeGeometry]);

  return <div ref={containerRef} className="map-container" />;
}
