// Turn a raw Overpass response into the route logic's street data.
// Same rules as the in-browser snippet in reference/street-lookup.md.

import type { OsmData, Pt } from './types';

type OverpassElement = {
  type: string;
  tags?: Record<string, string | undefined>;
  geometry?: Array<{ lat: number; lon: number }>;
};

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function fromOverpass(response: { elements: OverpassElement[] }): OsmData {
  const out: OsmData = { streets: [], areas: [], sidewalks: [] };
  for (const e of response.elements) {
    const t = e.tags ?? {};
    const g: Pt[] = (e.geometry ?? []).map((p) => [r5(p.lat), r5(p.lon)]);
    if (t.footway === 'sidewalk') out.sidewalks.push(g);
    else if (t.highway) {
      if (!t.name) continue; // the query asks for named roads only
      out.streets.push({ name: t.name, highway: t.highway, maxspeed: t.maxspeed ?? '', lanes: t.lanes ?? '', points: g });
    } else out.areas.push({ name: t.name ?? '', kind: t.leisure ?? t.amenity ?? t.landuse ?? '', points: g });
  }
  return out;
}
