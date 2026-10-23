// Flat-earth geometry in feet around home, plus the small helpers every route file shares.
// Ported from reference/osm_import.py (Geo, length, seg_dist, inside, walk_points).

import type { Pt } from './types';

export type XY = [x: number, y: number];

export const FT_PER_DEG = 364_000;
/** No house frontage this close to a cross street. */
export const CORNER_FT = 45;
/** Where a lot sits, measured from the street centerline. */
export const OFFSET_FT = 55;
/** Frontage is measured in steps of this many feet. */
export const STEP_FT = 15;

/** Areas no lot fronts: parks, fields, schools, churches, shops. */
export const BLOCKER_KINDS = new Set([
  'park', 'pitch', 'playground', 'school', 'place_of_worship', 'grass',
  'recreation_ground', 'cemetery', 'commercial', 'retail',
]);

/** Converts [lat, lng] to feet east/north of home and back. */
export class Geo {
  readonly kx: number;
  constructor(readonly home: Pt) {
    this.kx = FT_PER_DEG * Math.cos((home[0] * Math.PI) / 180);
  }
  xy(p: Pt): XY {
    return [(p[1] - this.home[1]) * this.kx, (p[0] - this.home[0]) * FT_PER_DEG];
  }
  ll(x: number, y: number): Pt {
    return [this.home[0] + y / FT_PER_DEG, this.home[1] + x / this.kx];
  }
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function lineLength(line: XY[]): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) total += dist(line[i], line[i + 1]);
  return total;
}

/** Shortest distance from P to a polyline. */
export function segDist(P: XY, line: XY[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const A = line[i], B = line[i + 1];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const l2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy));
  }
  return best;
}

/** Point-in-polygon (ray casting). */
export function inside(P: XY, poly: XY[]): boolean {
  const [x, y] = P;
  let hit = false;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) hit = !hit;
  }
  return hit;
}

/** Points every `step` ft along a polyline, each with the local direction. */
export function walkPoints(line: XY[], step: number): Array<[XY, XY]> {
  const out: Array<[XY, XY]> = [];
  for (let i = 0; i < line.length - 1; i++) {
    const A = line[i], B = line[i + 1];
    const d = dist(A, B);
    if (d === 0) continue;
    const ux = (B[0] - A[0]) / d, uy = (B[1] - A[1]) / d;
    const n = Math.max(1, Math.floor(d / step));
    for (let k = 0; k < n; k++) out.push([[A[0] + ux * k * step, A[1] + uy * k * step], [ux, uy]]);
  }
  return out;
}

/** Frontage (ft) on each side of a line that a lot could face: not a corner, park, school or busy road. */
export function frontage(line: XY[], others: XY[][], blockers: XY[][], busy: XY[][]): [left: number, right: number] {
  let left = 0, right = 0;
  for (const [P, [ux, uy]] of walkPoints(line, STEP_FT)) {
    if (others.some((o) => segDist(P, o) < CORNER_FT)) continue; // corner or crossing: no lot fronts here
    for (const sign of [1, -1]) { // left = +normal
      const Q: XY = [P[0] - uy * OFFSET_FT * sign, P[1] + ux * OFFSET_FT * sign];
      if (blockers.some((b) => inside(Q, b))) continue;
      if (busy.some((b) => segDist(Q, b) < 30)) continue;
      if (sign === 1) left += STEP_FT;
      else right += STEP_FT;
    }
  }
  return [left, right];
}

/** Python's round(): halves go to the even neighbor. Keeps counts identical to the reference. */
export function pyRound(x: number, digits = 0): number {
  const m = 10 ** digits;
  const y = x * m;
  const r = Math.round(y);
  const isHalf = Math.abs(y % 1) === 0.5;
  return (isHalf && r % 2 !== 0 ? r - 1 : r) / m;
}

/** Node identity: a vertex rounded to 5 decimals (about 1 m), as the reference does. */
export function key(p: Pt): string {
  return `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
}

const SHORT: Array<[RegExp, string]> = [
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bLane\b/g, 'Ln'],
  [/\bDrive\b/g, 'Dr'], [/\bCourt\b/g, 'Ct'], [/\bBoulevard\b/g, 'Blvd'], [/\bPlace\b/g, 'Pl'],
  [/\bCircle\b/g, 'Cir'], [/\bTerrace\b/g, 'Ter'], [/\bParkway\b/g, 'Pkwy'],
];

/** Street names the way people say them: "Elm Street" -> "Elm St". */
export function shortName(name: string): string {
  return SHORT.reduce((s, [re, to]) => s.replace(re, to), name);
}
