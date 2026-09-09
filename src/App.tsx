import maplibregl, { type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DetailPanel } from './components/DetailPanel';
import { Hud } from './components/Hud';
import { SearchBar, type Place } from './components/SearchBar';
import { Engine, type Stats } from './render/engine';
import type { Agent } from './sim/types';
import { densityForZoom } from './sim/world';

/**
 * OpenFreeMap serves OpenMapTiles-schema vector tiles with no key and no
 * sign-up. Vector tiles matter here beyond looks: the simulation reads road
 * geometry straight out of them so agents drive on real streets.
 */
const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/** Raster OSM fallback if the vector host is unreachable (agents go procedural). */
const RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const START = { lng: 139.7005, lat: 35.6595, zoom: 16.2 }; // Shibuya, Tokyo
const STYLE_TIMEOUT_MS = 9000;
const STREET_ZOOM = 16.2;

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const [selected, setSelected] = useState<Agent | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(START.zoom);
  const [ready, setReady] = useState(false);
  const [, forceTick] = useState(0);
  const [stats, setStats] = useState<Stats>({ people: 0, cars: 0, fps: 60, cells: 0, roadEdges: 0 });

  // --- map + engine lifecycle -------------------------------------------
  useEffect(() => {
    if (!mapDiv.current || !canvasRef.current) return;

    const map = new maplibregl.Map({
      container: mapDiv.current,
      style: VECTOR_STYLE,
      center: [START.lng, START.lat],
      zoom: START.zoom,
      // The overlay's mercator->screen transform assumes a north-up, flat
      // camera, so rotation and pitch stay off.
      bearing: 0,
      pitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();

    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          'Basemap &copy; <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> · data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · search by <a href="https://nominatim.org/" target="_blank" rel="noreferrer">Nominatim</a>',
      }),
      'bottom-right',
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('zoom', () => setZoom(map.getZoom()));
    map.on('error', (e) => console.warn('[map]', e.error?.message ?? e));

    // If the vector host is unreachable, drop to raster OSM tiles; the
    // simulation still runs there, just without road-following. This tests for
    // a missing *stylesheet* rather than isStyleLoaded(), which stays false
    // while tiles are merely still downloading.
    const watchdog = window.setTimeout(() => {
      if (!map.getStyle()) {
        console.warn('[map] vector style unavailable — falling back to raster OSM');
        map.setStyle(RASTER_STYLE);
      }
    }, STYLE_TIMEOUT_MS);

    // The overlay only needs map.project(), which is valid immediately, so the
    // simulation starts without waiting on tiles.
    const engine = new Engine(map, canvasRef.current, {
      onStats: setStats,
      onSelect: setSelected,
    });
    engineRef.current = engine;
    setReady(true);

    if (import.meta.env.DEV) {
      // Handy for poking at the simulation from the console.
      const w = window as unknown as Record<string, unknown>;
      w.__map = map;
      w.__engine = engine;
    }

    return () => {
      window.clearTimeout(watchdog);
      engine.dispose();
      engineRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Agent state mutates in place inside the sim loop; re-render the panel on a
  // slow timer rather than pushing React state 60 times a second.
  useEffect(() => {
    if (!selected) return;
    const t = setInterval(() => forceTick((n) => n + 1), 300);
    return () => clearInterval(t);
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') engineRef.current?.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const flyTo = useCallback((place: Place) => {
    engineRef.current?.select(null);
    mapRef.current?.flyTo({
      center: [place.lng, place.lat],
      zoom: STREET_ZOOM,
      speed: 1.5,
      curve: 1.6,
      essential: true,
    });
  }, []);

  const hint = densityForZoom(zoom) <= 0
      ? 'Zoom in to street level to populate the world'
    : stats.roadEdges === 0
      ? 'Waiting on road data — agents are on procedural paths'
      : null;

  return (
    <div className="app">
      <div ref={mapDiv} className="map" />
      <canvas ref={canvasRef} className="overlay" />

      <div className="top-bar">
        <SearchBar onPick={flyTo} />
      </div>

      <Hud stats={stats} zoom={zoom} hint={hint} />

      <DetailPanel
        agent={selected}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onClose={() => engineRef.current?.select(null)}
      />

      {ready && !selected && (
        <div className="tip">Click any car or pedestrian to inspect it and trace its route</div>
      )}
    </div>
  );
}
