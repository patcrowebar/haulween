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

/** Nudge a spot onto rings around it until it clears Home and the other pins. */
function spread(spot: Pt, home: Pt, taken: Pt[]): Pt {
  const candidates: Pt[] = [spot];
  for (const r of [1.2, 2.4, 3.6]) {
    for (let a = 0; a < 8; a++) {
      candidates.push([
        spot[0] + r * MIN_DEG * Math.sin((a * Math.PI) / 4),
        spot[1] + r * MIN_DEG * 1.3 * Math.cos((a * Math.PI) / 4),
      ]);
    }
  }
  const clear = (c: Pt) => ddist(c, home) >= HOME_DEG && taken.every((t) => ddist(c, t) >= MIN_DEG);
  return candidates.find(clear) ?? candidates[candidates.length - 1];
}

/** One pin per schedule row, numbered like the schedule. */
export function placePins(segments: Segment[], home: Pt): Pin[] {
  const taken: Pt[] = [];
  const pins: Pin[] = [];
  segments.forEach((s, i) => {
    if (!s.points.length) return;
    let spot: Pt | null = null;
    for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      const c = pointAt(s.points, f);
      if (ddist(c, home) >= HOME_DEG && taken.every((t) => ddist(c, t) >= MIN_DEG)) {
        spot = c;
        break;
      }
    }
    spot ??= spread(pointAt(s.points, 0.5), home, taken);
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
 * Pins placed on screen, so none covers Home or another pin at the map's real zoom. Each pin
 * tries spots along its own street first, then rings around the street's middle.
 */
export function placePinsOnScreen(
  segments: Segment[],
  home: Pt,
  project: (p: Pt) => [number, number],
  unproject: (xy: [number, number]) => Pt,
  homeHalf: [number, number] = [36, 15],
  pinHalf = 16,
): Pin[] {
  const [hx, hy] = project(home);
  const boxes: Box[] = [[hx - homeHalf[0], hy - homeHalf[1], hx + homeHalf[0], hy + homeHalf[1]]];
  const boxAt = ([x, y]: [number, number]): Box => [x - pinHalf, y - pinHalf, x + pinHalf, y + pinHalf];
  const clear = (b: Box) => boxes.every((o) => !overlaps(o, b));
  const pins: Pin[] = [];
  segments.forEach((s, i) => {
    if (!s.points.length) return;
    let spot: [number, number] | null = null;
    for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      const xy = project(pointAt(s.points, f));
      if (clear(boxAt(xy))) { spot = xy; break; }
    }
    if (!spot) {
      const [mx, my] = project(pointAt(s.points, 0.5));
      for (const r of [36, 56, 76, 96]) {
        for (let a = 0; a < 8 && !spot; a++) {
          const xy: [number, number] = [mx + r * Math.cos((a * Math.PI) / 4), my + r * Math.sin((a * Math.PI) / 4)];
          if (clear(boxAt(xy))) spot = xy;
        }
        if (spot) break;
      }
    }
    spot ??= project(pointAt(s.points, 0.5));
    boxes.push(boxAt(spot));
    const [lat, lng] = unproject(spot);
    pins.push({ n: i + 1, lat, lng, name: s.name });
  });
  return pins;
}
