// Route check: every stretch on a real street, never along a busy road.
// Ported from reference/plan_route.py (check_route).
//
// A straight line drawn across a gap in the data fails this check, which is the point: a gap in
// OpenStreetMap is usually a real gap (a dead end, a park, someone's yard), not missing data.

import { Geo, dist, segDist, type XY } from './geo';
import type { Segment } from './optimize';
import type { NamedLine, Pt } from './types';

const OFF_STREET_FT = 40;
const ALONG_BUSY_FT = 25;
const SAMPLE_FT = 30;

function samples(line: XY[], step = SAMPLE_FT): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const A = line[i], C = line[i + 1];
    const n = Math.max(1, Math.floor(dist(A, C) / step));
    for (let k = 0; k < n; k++) out.push([A[0] + ((C[0] - A[0]) * k) / n, A[1] + ((C[1] - A[1]) * k) / n]);
  }
  return line.length ? [...out, line[line.length - 1]] : out;
}

/** Problems with the route, in order. An empty list means the route can be shown. */
export function checkRoute(
  streets: { streetLines: NamedLine[]; busyRoads: NamedLine[] },
  segments: Segment[],
  home: Pt,
): string[] {
  if (!streets.streetLines.length) return ["no street lines, so the route couldn't be checked against real streets"];
  const geo = new Geo(home);
  const B = streets.busyRoads.map((b) => b.points.map((p) => geo.xy(p)));
  const L = [...streets.streetLines.map((s) => s.points.map((p) => geo.xy(p))), ...B];
  const offStreet = (P: XY) => Math.min(...L.map((ln) => segDist(P, ln))) > OFF_STREET_FT;

  const problems: string[] = [];
  let prevEnd: XY | null = null;
  for (const s of segments) {
    if (s.points.length < 2) continue;
    const xy = s.points.map((p) => geo.xy(p));
    const ss = samples(xy);
    const off = ss.filter(offStreet);
    if (off.length) {
      problems.push(`${s.name}: about ${off.length * SAMPLE_FT} ft of it is not on any street (a gap in the data `
        + 'is probably a real gap: dead end, park or yard). Cut it from real street pieces.');
    }
    const inner = ss.slice(3, -3); // ignore corners, where crossing a busy road is the only contact
    const along = inner.filter((P) => B.some((b) => segDist(P, b) < ALONG_BUSY_FT));
    if (along.length >= 3) problems.push(`${s.name}: runs along a busy road for about ${along.length * SAMPLE_FT} ft.`);
    if (prevEnd) {
      const gap = dist(prevEnd, xy[0]);
      if (gap > 150 && samples([prevEnd, xy[0]], 40).some(offStreet)) {
        problems.push(`Getting to ${s.name}: jumps ${Math.round(gap)} ft from the previous street with no street connecting them.`);
      }
    }
    prevEnd = xy[xy.length - 1];
  }
  return problems;
}
