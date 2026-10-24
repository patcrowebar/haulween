// Where each numbered pin goes: on its own street, never on top of Home or another pin.
// Ported from reference/plan_route.py (route_geometry, _point_at, _spread). Plain logic, no MapLibre.

import type { Segment } from '../route/optimize';
import type { Pt } from '../route/types';

export type Pin = { n: number; lat: number; lng: number; name: string };

/** Minimum gap between pins (~25 m) and from Home (~45 m), in degrees as the reference measures. */
const MIN_DEG = 0.00025;
const HOME_DEG = 0.00045;

const ddist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The point a given fraction of the way along a polyline. */
export function pointAt(pts: Pt[], frac: number): Pt {
  if (pts.length === 1) return [...pts[0]] as Pt;
  const legs = pts.slice(1).map((p, i) => ddist(pts[i], p));
  const goal = legs.reduce((a, b) => a + b, 0) * frac;
  let acc = 0;
  for (let i = 0; i < legs.length; i++) {
    if (acc + legs[i] >= goal && legs[i] > 0) {
      const f = (goal - acc) / legs[i];
      return [pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), pts[i][1] + f * (pts[i + 1][1] - pts[i][1])];
    }
    acc += legs[i];
  }
  return [...pts[pts.length - 1]] as Pt;
}

/**
 * Where along its street a pin may go: the reference's preferred spots first, then every 2.5%
 * of the way. A pin always sits on its own street line, never beside it. (The reference pushed
 * a crowded pin onto rings around the street, which once left pin 15 off the route near Home.)
 */
export const SPOTS = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9, ...Array.from({ length: 41 }, (_, i) => i / 40)];

/** One pin per schedule row, numbered like the schedule. */
export function placePins(segments: Segment[], home: Pt): Pin[] {
  const taken: Pt[] = [];
  const pins: Pin[] = [];
  segments.forEach((s, i) => {
    if (!s.points.length) return;
    // The first clear spot; failing that, the one that crowds Home and the other pins least.
    const crowding = (c: Pt) => 10 * Math.max(0, HOME_DEG - ddist(c, home))
      + taken.reduce((t, o) => t + Math.max(0, MIN_DEG - ddist(c, o)), 0);
    let spot: Pt | null = null, least = Infinity;
    for (const f of SPOTS) {
      const c = pointAt(s.points, f);
      const k = crowding(c);
      if (k < least) { least = k; spot = c; }
      if (k === 0) break;
    }
    if (!spot) return;
    taken.push(spot);
    pins.push({ n: i + 1, lat: spot[0], lng: spot[1], name: s.name });
  });
  return pins;
}

/** The whole walk as one line, from Home and back. */
export function routeLine(segments: Segment[]): Pt[] {
  return segments.flatMap((s, i) => (i ? s.points.slice(1) : s.points));
}

export type Label = { name: string; lat: number; lng: number };
/** A screen box: left, top, right, bottom in pixels. */
export type Box = [number, number, number, number];

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * One name per street for the demo map (it has no basemap labels), along the street's longest
 * piece. Each label must fit inside the map and miss every pin, Home and the other labels, all
 * measured on screen. A street with no clear spot goes unlabeled.
 */
export function placeLabels(
  streets: Array<{ name: string; points: Pt[] }>,
  taken: Box[],
  project: (p: Pt) => [number, number],
  size: [width: number, height: number],
): Label[] {
  const longest = new Map<string, Pt[]>();
  const len = (pts: Pt[]) => pts.slice(1).reduce((t, p, i) => t + ddist(pts[i], p), 0);
  for (const s of streets) {
    const cur = longest.get(s.name);
    if (!cur || len(s.points) > len(cur)) longest.set(s.name, s.points);
  }
  const boxes = [...taken];
  const labels: Label[] = [];
  for (const [name, pts] of longest) {
    const w = name.length * 7 + 8, h = 16;
    for (const f of [0.25, 0.75, 0.5, 0.1, 0.9, 0.4, 0.6]) {
      const c = pointAt(pts, f);
      const [x, y] = project(c);
      const box: Box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
      const inside = box[0] >= 4 && box[1] >= 4 && box[2] <= size[0] - 4 && box[3] <= size[1] - 4;
      if (inside && boxes.every((b) => !overlaps(b, box))) {
        boxes.push(box);
        labels.push({ name, lat: c[0], lng: c[1] });
        break;
      }
    }
  }
  return labels;
}

/**
 * Where the Home label covers, around Home's point on screen: it sits just above the point, on a
 * little pointer, so the street right at Home stays clear for a pin (a short last row back home
 * can lie entirely within a label's width of Home).
 */
export const HOME_BOX = { halfWidth: 36, above: 47, below: 17 };

/**
 * Pins placed on screen, so none covers Home or another pin at the map's real zoom when its
 * street has room. Each pin stays on its own street line, wherever on it there's most room.
 */
export function placePinsOnScreen(
  segments: Segment[],
  home: Pt,
  project: (p: Pt) => [number, number],
  unproject: (xy: [number, number]) => Pt,
  pinHalf = 16,
): Pin[] {
  const [hx, hy] = project(home);
  const boxes: Box[] = [[hx - HOME_BOX.halfWidth, hy - HOME_BOX.above, hx + HOME_BOX.halfWidth, hy - HOME_BOX.below]];
  const boxAt = ([x, y]: [number, number]): Box => [x - pinHalf, y - pinHalf, x + pinHalf, y + pinHalf];
  const area = (a: Box, b: Box) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  // Covering Home is much worse than touching another pin.
  const crowding = (b: Box) => boxes.reduce((t, o, k) => t + area(o, b) * (k === 0 ? 10 : 1), 0);
  const pins: Pin[] = [];
  segments.forEach((s, i) => {
    if (!s.points.length) return;
    // Always on the pin's own street: the first clear spot, or the least crowded one.
    let spot: [number, number] | null = null, least = Infinity;
    for (const f of SPOTS) {
      const xy = project(pointAt(s.points, f));
      const k = crowding(boxAt(xy));
      if (k < least) { least = k; spot = xy; }
      if (k === 0) break;
    }
    if (!spot) return;
    boxes.push(boxAt(spot));
    const [lat, lng] = unproject(spot);
    pins.push({ n: i + 1, lat, lng, name: s.name });
  });
  return pins;
}
