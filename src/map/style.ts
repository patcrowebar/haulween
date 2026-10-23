// The map's look: OpenFreeMap's dark style recolored to the Halloween palette, or, in demo mode,
// a plain offline style with no tiles at all (the demo streets are drawn from the fixture).

import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

export const CREDITS =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> '
  + '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
export const DEMO_CREDITS = 'Demo: made-up streets, no real place';

export const COLORS = {
  bg: '#12131c',
  water: '#0e1726',
  green: '#15201b',
  building: '#1b1d29',
  road: '#2b2e40',
  roadCasing: '#1f2130',
  label: '#a2a3b8',
  route: '#f08a3c',
  busy: '#ff7a6b',
  street: '#3a3d55',
};

export function demoStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': COLORS.bg } }],
  };
}

/** Recolor the dark basemap so it sits behind an orange route. Unknown layers are left alone. */
export function recolor(map: MapLibreMap): void {
  const set = (id: string, prop: string, value: string) => {
    try {
      map.setPaintProperty(id, prop as Parameters<MapLibreMap['setPaintProperty']>[1], value);
    } catch {
      // the property doesn't apply to this layer
    }
  };
  for (const layer of map.getStyle().layers) {
    const id = layer.id.toLowerCase();
    if (layer.type === 'background') set(layer.id, 'background-color', COLORS.bg);
    else if (layer.type === 'fill') {
      if (id.includes('water')) set(layer.id, 'fill-color', COLORS.water);
      else if (/park|grass|wood|forest|green|landcover/.test(id)) set(layer.id, 'fill-color', COLORS.green);
      else if (id.includes('building')) set(layer.id, 'fill-color', COLORS.building);
      else set(layer.id, 'fill-color', COLORS.bg);
    } else if (layer.type === 'line') {
      if (id.includes('water') || id.includes('river')) set(layer.id, 'line-color', COLORS.water);
      else if (id.includes('casing')) set(layer.id, 'line-color', COLORS.roadCasing);
      else if (/road|street|highway|bridge|tunnel|path|transportation/.test(id)) set(layer.id, 'line-color', COLORS.road);
    } else if (layer.type === 'symbol') {
      set(layer.id, 'text-color', COLORS.label);
      set(layer.id, 'text-halo-color', COLORS.bg);
    }
  }
}
