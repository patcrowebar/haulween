// Busy-road test + flood fill: which streets are safe to reach from home.
// Ported from reference/osm_import.py (is_busy, run), with one change, below.
//
// The change: the reference joined two streets when an end of one came within 50 ft of the
// other. That jumps any gap shorter than 50 ft, such as a yard between two pieces of the same
// street, and pulls in streets you can't walk to. The optimizer then can't build any loop at
// all (the reference gave up and returned every street, six hours long). Here two streets join
// only where they share an intersection point (Hard rule 1). The busy-road test is unchanged.

import {
  BLOCKER_KINDS, Geo, frontage, key, lineLength, pyRound, segDist, walkPoints, dist, type XY,
} from './geo';
import type { NamedLine, OsmData, OsmStreet, Pt } from './types';

const BUSY_HIGHWAYS = new Set([
  'primary', 'secondary', 'trunk', 'motorway', 'primary_link', 'secondary_link', 'trunk_link',
]);

/** Busy: primary, secondary or trunk, 3+ lanes, or posted 35 mph or more. Never walked along. */
export function isBusy(s: Pick<OsmStreet, 'highway' | 'lanes' | 'maxspeed'>): boolean {
  if (BUSY_HIGHWAYS.has(s.highway)) return true;
  const lanes = (s.lanes || '0').trim();
  if (/^[+-]?\d+$/.test(lanes) && parseInt(lanes, 10) >= 3) return true; // "3;2" and the like are ignored
  const digits = (s.maxspeed || '').replace(/\D/g, '');
  return digits !== '' && parseInt(digits, 10) >= 35;
}

export type PocketStreet = {
  name: string;
  lengthFt: number;
  housesLeft: number;
  housesRight: number;
  /** Share of the street with a mapped sidewalk nearby. null means unknown, not none. */
  sidewalkShare: number | null;
  touchesBusy: string[];
  distanceFt: number;
  /** The OSM ways that make up this street inside the safe area. */
  pieces: Pt[][];
};

export type Pocket = {
  homeStreet: string;
  busyNames: string[];
  pocket: PocketStreet[];
  /** Named streets that can only be reached by crossing a busy road. */
  outside: string[];
  busyRoads: NamedLine[];
  /** Parks, schools and fields, for the map. */
  areas: NamedLine[];
  /** Every non-busy street line nearby. The route check measures against these. */
  streetLines: NamedLine[];
};

type Prepared = OsmStreet & { xy: XY[]; busy: boolean; keys: Set<string> };

export function prepareStreets(data: OsmData, geo: Geo): Prepared[] {
  return data.streets
    .filter((s) => s.points.length >= 2)
    .map((s) => ({ ...s, xy: s.points.map((p) => geo.xy(p)), busy: isBusy(s), keys: new Set(s.points.map(key)) }));
}

export function blockerPolygons(data: OsmData, geo: Geo): XY[][] {
  return data.areas
    .filter((a) => BLOCKER_KINDS.has(a.kind) && a.points.length >= 4)
    .map((a) => a.points.map((p) => geo.xy(p)));
}

export function findPocket(data: OsmData, home: Pt, frontageFt = 55): Pocket {
  const geo = new Geo(home);
  const streets = prepareStreets(data, geo);
  const busy = streets.filter((s) => s.busy);
  const res = streets.filter((s) => !s.busy);
  if (res.length === 0) throw new Error('No streets near home');
  const blockers = blockerPolygons(data, geo);
  const sidewalks = data.sidewalks.map((w) => w.map((p) => geo.xy(p)));

  // Home street: nearest residential piece.
  let start = 0;
  for (let i = 1; i < res.length; i++) {
    if (segDist([0, 0], res[i].xy) < segDist([0, 0], res[start].xy)) start = i;
  }

  // Flood fill. Two pieces connect only at a shared point that isn't on a busy road
  // (meeting there would mean crossing it).
  const onBusy = (P: XY) => busy.some((b) => segDist(P, b.xy) < 25);
  const sharedSafePoint = (a: Prepared, b: Prepared) =>
    a.points.some((p, i) => b.keys.has(key(p)) && !onBusy(a.xy[i]));
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const i = stack.pop()!;
    res.forEach((t, j) => {
      if (!seen.has(j) && sharedSafePoint(res[i], t)) {
        seen.add(j);
        stack.push(j);
      }
    });
  }

  const byName = new Map<string, Prepared[]>();
  for (const i of [...seen].sort((a, b) => a - b)) {
    const list = byName.get(res[i].name) ?? [];
    list.push(res[i]);
    byName.set(res[i].name, list);
  }

  const busyXY = busy.map((b) => b.xy);
  const pocket: PocketStreet[] = [];
  for (const [name, pcs] of byName) {
    let left = 0, right = 0, swPts = 0, swHit = 0;
    for (const p of pcs) {
      const others = streets.filter((o) => o !== p && o.name !== p.name).map((o) => o.xy);
      const [l, r] = frontage(p.xy, others, blockers, busyXY);
      left += l;
      right += r;
      for (const [P] of walkPoints(p.xy, 40)) {
        swPts++;
        if (sidewalks.some((w) => segDist(P, w) < 20)) swHit++;
      }
    }
    const touches = new Set<string>();
    for (const b of busy) {
      for (const p of pcs) {
        if (Math.min(segDist(p.xy[0], b.xy), segDist(p.xy[p.xy.length - 1], b.xy)) < 40) touches.add(b.name);
      }
    }
    pocket.push({
      name,
      lengthFt: pyRound(pcs.reduce((s, p) => s + lineLength(p.xy), 0)),
      housesLeft: pyRound(left / frontageFt),
      housesRight: pyRound(right / frontageFt),
      sidewalkShare: sidewalks.length && swPts ? pyRound(swHit / swPts, 2) : null,
      touchesBusy: [...touches].sort(),
      distanceFt: pyRound(Math.min(...pcs.flatMap((p) => p.xy.map((P) => dist([0, 0], P))))),
      pieces: pcs.map((p) => p.points),
    });
  }
  pocket.sort((a, b) => a.distanceFt - b.distanceFt);

  const outside = [...new Set(res.map((s) => s.name))].filter((n) => !byName.has(n)).sort();
  return {
    homeStreet: res[start].name,
    busyNames: [...new Set(busy.map((b) => b.name))].sort(),
    pocket,
    outside,
    busyRoads: busy.map((b) => ({ name: b.name, points: b.points })),
    areas: data.areas
      .filter((a) => ['park', 'school', 'pitch', 'playground'].includes(a.kind) && a.points.length >= 4)
      .map((a) => ({ name: a.name, points: a.points })),
    streetLines: res.map((s) => ({ name: s.name, points: s.points })),
  };
}
