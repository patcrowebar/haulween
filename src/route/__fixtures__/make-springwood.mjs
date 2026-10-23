// Builds springwood.overpass.json: a made-up neighborhood saved in the exact shape of an
// Overpass API response (the query in reference/street-lookup.md, "out tags geom").
//
// Why made up: a fixture taken from a real place is a sample of somebody's home streets.
// This one is drawn by hand and sits over open water in Lake Erie, so it can't match anyone's block.
// It's built to exercise every rule the route logic has to get right:
//
//   Main St      primary road, west edge of the pocket (busy by class)
//   Ridge Rd     tertiary, posted 35 mph, north edge (busy by speed)
//   Park Rd      tertiary, 3 lanes, east edge (busy by lanes)
//   Elm St       home street (1428 Elm St), Main St to Park Rd, two OSM ways split at Cedar St
//   Maple Ave    parallel to Elm, Main St to Park Rd
//   Walnut St, Cedar St, Birch St   cross streets from Elm St up to Ridge Rd
//   Park Ln      connector through Elm Park: no houses on either side (a walk-through)
//   Willow Ct    dead end south of Elm St
//   Spruce St    comes back in two pieces with a 40 ft gap (a yard). The far piece leads to
//                Lakeview Dr, which must never be reached: the gap is not a street.
//   Pine St, Ash St, Hill St   across a busy road: outside the pocket
//   Elm Park, Springwood Elementary   no lots front these
//
// Run with: node src/route/__fixtures__/make-springwood.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIGIN = [41.8, -82.1]; // open water, Lake Erie
const FT_PER_DEG = 364_000;
const KX = FT_PER_DEG * Math.cos((ORIGIN[0] * Math.PI) / 180);
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/** Feet east/north of the origin -> an Overpass {lat, lon}, on the 5-decimal grid Overpass data uses. */
const pt = ([x, y]) => ({ lat: r5(ORIGIN[0] + y / FT_PER_DEG), lon: r5(ORIGIN[1] + x / KX) });

let nextId = 9_000_001;
const way = (tags, ftPoints) => ({ type: 'way', id: nextId++, geometry: ftPoints.map(pt), tags });
const street = (name, highway, ftPoints, extra = {}) => way({ highway, name, ...extra }, ftPoints);
const area = (tags, ftPoints) => way(tags, [...ftPoints, ftPoints[0]]);

const elements = [
  // Busy roads around the pocket. Every street that meets one shares a vertex with it.
  street('Main St', 'primary', [[-1400, -900], [-1400, -600], [-1400, 0], [-1400, 300], [-1400, 600], [-1400, 1200], [-1400, 1500]]),
  street('Ridge Rd', 'tertiary', [[-1400, 1200], [-700, 1200], [0, 1200], [700, 1200], [1400, 1200]], { maxspeed: '35 mph' }),
  street('Park Rd', 'tertiary', [[1400, -900], [1400, 0], [1400, 300], [1400, 600], [1400, 1200], [1400, 1500]], { lanes: '3' }),

  // Inside the pocket.
  street('Elm St', 'residential', [[-1400, 0], [-700, 0], [-350, 0], [0, 0]]),
  street('Elm St', 'residential', [[0, 0], [350, 0], [700, 0], [1400, 0]]),
  street('Maple Ave', 'residential', [[-1400, 600], [-700, 600], [-350, 600], [0, 600], [700, 600], [1400, 600]]),
  street('Walnut St', 'residential', [[-700, 0], [-700, 600], [-700, 1200]]),
  street('Cedar St', 'residential', [[0, 0], [0, 600], [0, 1200]]),
  street('Birch St', 'residential', [[700, 0], [700, 600], [700, 1200]]),
  street('Park Ln', 'residential', [[-350, 0], [-350, 300], [-350, 600]]),
  street('Willow Ct', 'residential', [[350, 0], [350, -200], [350, -400]]),

  // Spruce St comes back in two pieces. The 40 ft between them is a yard, not a missing sidewalk.
  street('Spruce St', 'residential', [[-350, 0], [-350, -300]]),
  street('Spruce St', 'residential', [[-350, -340], [-350, -600]]),
  street('Lakeview Dr', 'residential', [[-700, -600], [-350, -600], [100, -600]]),

  // Across a busy road: reachable only by crossing it.
  street('Pine St', 'residential', [[-2100, 300], [-1400, 300]]),
  street('Ash St', 'residential', [[1400, 300], [2000, 300]]),
  street('Hill St', 'residential', [[0, 1200], [0, 1700]]),

  // Places no lot fronts.
  area({ leisure: 'park', name: 'Elm Park' }, [[-650, 30], [-50, 30], [-50, 570], [-650, 570]]),
  area({ amenity: 'school', name: 'Springwood Elementary' }, [[750, -30], [1350, -30], [1350, -500], [750, -500]]),

  // A mapped sidewalk along part of Elm St.
  way({ highway: 'footway', footway: 'sidewalk' }, [[-1350, -20], [-750, -20]]),
];

const response = {
  version: 0.6,
  generator: 'Overpass API (hand-made Haulween test fixture; not real data)',
  osm3s: {
    timestamp_osm_base: '2026-10-01T00:00:00Z',
    copyright: 'Made-up test data in the OpenStreetMap response format. Describes no real place.',
  },
  elements,
};

const out = fileURLToPath(new URL('./springwood.overpass.json', import.meta.url));
writeFileSync(out, JSON.stringify(response, null, 1) + '\n');
console.log(`wrote ${elements.length} ways to ${out}`);
