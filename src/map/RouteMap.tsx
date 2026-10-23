// The route on a MapLibre map: orange walk, numbered pins, Home snapped onto its street,
// busy roads dashed, credits always showing.

import { useEffect, useRef } from 'react';
import { AttributionControl, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Plan } from '../route/plan';
import type { NamedLine, Pt } from '../route/types';
import { placeLabels, placePinsOnScreen, routeLine, type Box } from './pins';
import { COLORS, CREDITS, DEMO_CREDITS, OPENFREEMAP_STYLE, demoStyle, recolor } from './style';

// MapLibre looks for its worker next to its own file, which a bundler moves. Point it there.
setWorkerUrl(workerUrl);

type Props = { plan: Plan; demo: boolean };

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

export default function RouteMap({ plan, demo }: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current) return;
    const route = routeLine(plan.segments);
    const home = route[0];
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
    map.on('load', () => {
      if (!demo) recolor(map);
      const { pocket } = plan;
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
      const pins = placePinsOnScreen(plan.segments, home, project, unproject);
      if (demo) {
        // No basemap labels in the demo, so name the streets, clear of the pins and Home.

        const around = (p: Pt, rx: number, ry: number): Box => {
          const [x, y] = project(p);
          return [x - rx, y - ry, x + rx, y + ry];
        };
        const { clientWidth, clientHeight } = map.getContainer();
        const controls: Box = [clientWidth - 64, 0, clientWidth, 116]; // zoom buttons
        const credits: Box = [clientWidth - 260, clientHeight - 28, clientWidth, clientHeight];
        const taken = [controls, credits, around(home, 34, 14), ...pins.map((p) => around([p.lat, p.lng], 16, 16))];
        const named = [...pocket.streetLines, ...pocket.busyRoads];
        for (const l of placeLabels(named, taken, project, [clientWidth, clientHeight])) {
          markers.push(new Marker({ element: pinElement('map-label', l.name, l.name) }).setLngLat([l.lng, l.lat]).addTo(map));
        }
      }
      for (const pin of pins) {
        markers.push(
          new Marker({ element: pinElement('map-pin', String(pin.n), `${pin.n}. ${pin.name}`) })
            .setLngLat([pin.lng, pin.lat])
            .addTo(map),
        );
      }
      markers.push(new Marker({ element: pinElement('map-home', 'Home', 'Home') }).setLngLat(lngLat(home)).addTo(map));
    });

    return () => {
      markers.forEach((m) => m.remove());
      map.remove();
    };
  }, [plan, demo]);

  return (
    <div className="map-wrap">
      <div ref={box} className="map" role="region" aria-label="Map of the route with numbered streets and Home" />
      <p className="map-key">
        <span className="key-route" /> Your route <span className="key-busy" /> Busy road: stay off
      </p>
    </div>
  );
}
