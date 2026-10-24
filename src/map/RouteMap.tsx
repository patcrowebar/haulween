// The route on a MapLibre map: orange walk, numbered pins, Home snapped onto its street,
// busy roads dashed, credits always showing. In Night Mode, also a dot for where you are and
// the streets you've finished.

import { useEffect, useRef } from 'react';
import { AttributionControl, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Segment } from '../route/optimize';
import type { NamedLine, Pt } from '../route/types';
import { HOME_BOX, placeLabels, placePinsOnScreen, routeLine, type Box } from './pins';
import { COLORS, CREDITS, DEMO_CREDITS, OPENFREEMAP_STYLE, demoStyle, recolor } from './style';

// MapLibre looks for its worker next to its own file, which a bundler moves. Point it there.
setWorkerUrl(workerUrl);

type Props = {
  segments: Segment[];
  lines: { streetLines: NamedLine[]; busyRoads: NamedLine[]; areas: NamedLine[] };
  demo: boolean;
  /** Night Mode: where GPS puts you (stays on this phone). */
  you?: Pt | null;
  done?: boolean[];
  current?: number;
  tall?: boolean;
};

const lngLat = (p: Pt): [number, number] => [p[1], p[0]];
const lines = (ls: NamedLine[]) => ({
  type: 'FeatureCollection' as const,
  features: ls.map((l) => ({
    type: 'Feature' as const,
    properties: { name: l.name },
    geometry: { type: 'LineString' as const, coordinates: l.points.map(lngLat) },
  })),
});

function pinElement(className: string, text: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  el.setAttribute('aria-label', label);
  el.setAttribute('role', 'img');
  return el;
}

export default function RouteMap({ segments, lines: pocket, demo, you = null, done, current, tall }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const pinEls = useRef<HTMLElement[]>([]);
  const youMarker = useRef<Marker | null>(null);
  /** Marks finished streets on the pins; runs again once the pins exist. */
  const paintPins = useRef<() => void>(() => {});

  useEffect(() => {
    if (!box.current) return;
    const route = routeLine(segments);
    const home = route[route.length - 1]; // every walk ends at Home, even a replan that starts elsewhere
    const bounds = route.reduce((b, p) => b.extend(lngLat(p)), new LngLatBounds(lngLat(home), lngLat(home)));
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const map = new MapLibreMap({
      container: box.current,
      style: demo ? demoStyle() : OPENFREEMAP_STYLE,
      bounds,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: reduceMotion ? 0 : 300,
    });
    map.addControl(new AttributionControl({ compact: false, customAttribution: demo ? DEMO_CREDITS : CREDITS }), 'bottom-right');
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.touchZoomRotate.disableRotation();

    const markers: Marker[] = [];
    mapRef.current = map;
    pinEls.current = [];
    map.on('load', () => {
      if (!demo) recolor(map);
      map.addSource('areas', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: pocket.areas.map((a) => ({
            type: 'Feature', properties: { name: a.name },
            geometry: { type: 'Polygon', coordinates: [a.points.map(lngLat)] },
          })),
        },
      });
      map.addSource('streets', { type: 'geojson', data: lines(pocket.streetLines) });
      map.addSource('busy', { type: 'geojson', data: lines(pocket.busyRoads) });
      map.addSource('route', { type: 'geojson', data: lines([{ name: 'route', points: route }]) });
      if (demo) {
        // No basemap in the demo, so draw the streets it plans over.
        map.addLayer({ id: 'areas', type: 'fill', source: 'areas', paint: { 'fill-color': COLORS.green } });
        map.addLayer({
          id: 'streets', type: 'line', source: 'streets',
          layout: { 'line-cap': 'round' }, paint: { 'line-color': COLORS.street, 'line-width': 6 },
        });
      }
      map.addLayer({
        id: 'busy', type: 'line', source: 'busy',
        paint: { 'line-color': COLORS.busy, 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'route', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.route, 'line-width': 5 },
      });

      const project = (p: Pt): [number, number] => {
        const { x, y } = map.project(lngLat(p));
        return [x, y];
      };
      const unproject = ([x, y]: [number, number]): Pt => {
        const { lat, lng } = map.unproject([x, y]);
        return [lat, lng];
      };
      // Placed on screen at the starting zoom, so no number hides Home or another number.
      const pins = placePinsOnScreen(segments, home, project, unproject);
      if (demo) {
        // No basemap labels in the demo, so name the streets, clear of the pins and Home.

        const around = (p: Pt, rx: number, ry: number): Box => {
          const [x, y] = project(p);
          return [x - rx, y - ry, x + rx, y + ry];
        };
        const { clientWidth, clientHeight } = map.getContainer();
        const controls: Box = [clientWidth - 64, 0, clientWidth, 116]; // zoom buttons
        const credits: Box = [clientWidth - 260, clientHeight - 28, clientWidth, clientHeight];
        const [hx, hy] = project(home);
        const homeBox: Box = [hx - HOME_BOX.halfWidth, hy - HOME_BOX.above, hx + HOME_BOX.halfWidth, hy - HOME_BOX.below];
        const taken = [controls, credits, homeBox, ...pins.map((p) => around([p.lat, p.lng], 16, 16))];
        const named = [...pocket.streetLines, ...pocket.busyRoads];
        for (const l of placeLabels(named, taken, project, [clientWidth, clientHeight])) {
          markers.push(new Marker({ element: pinElement('map-label', l.name, l.name) }).setLngLat([l.lng, l.lat]).addTo(map));
        }
      }
      for (const pin of pins) {
        const el = pinElement('map-pin', String(pin.n), `${pin.n}. ${pin.name}`);
        pinEls.current[pin.n - 1] = el;
        markers.push(new Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map));
      }
      paintPins.current();
      // Home sits just above its point on its street, so the street itself stays clear for pins.
      markers.push(new Marker({ element: pinElement('map-home', 'Home', 'Home'), anchor: 'bottom', offset: [0, -HOME_BOX.below] })
        .setLngLat(lngLat(home)).addTo(map));
    });

    return () => {
      markers.forEach((m) => m.remove());
      youMarker.current?.remove();
      youMarker.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [segments, pocket, demo]);

  // Finished streets fade; the one you're on stands out.
  useEffect(() => {
    const paint = () => pinEls.current.forEach((el, i) => {
      el?.classList.toggle('done', !!done?.[i]);
      el?.classList.toggle('now', current === i);
    });
    paintPins.current = paint;
    paint();
  }, [done, current, segments]);

  // The dot for where you are.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!you) {
      youMarker.current?.remove();
      youMarker.current = null;
      return;
    }
    if (!youMarker.current) youMarker.current = new Marker({ element: pinElement('map-you', '', 'You are here') });
    youMarker.current.setLngLat(lngLat(you)).addTo(map);
  }, [you, segments]);

  return (
    <div className="map-wrap">
      <div ref={box} className={`map${tall ? ' tall' : ''}`} role="region" aria-label="Map of the route with numbered streets and Home" />
      <p className="map-key">
        <span className="key-route" /> Your route <span className="key-busy" /> Busy road: stay off
      </p>
    </div>
  );
}
