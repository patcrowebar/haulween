// Route check: every stretch on a real street, never along or across a busy road.
// Ported from reference/plan_route.py (check_route), then made stricter:
//
// - The reference passed any stretch within 40 ft of a street. That let through a straight line
//   across a narrow yard or a corner cut across a lawn. Now every stretch between two route points
//   must lie on an actual street line (within 3 ft), and each street must start where the last ended.
// - A route may walk up to a point on a busy road and turn back, but never pass through it.
//
// A gap in OpenStreetMap is usually a real gap (a dead end, a park, someone's yard), not missing data.

import { Geo, dist, segDist, type XY } from './geo';
import type { Segment } from './optimize';
import type { NamedLine, Pt } from './types';

/** Slack for rounding: route points are street vertices, or home snapped onto a street. */
const ON_LINE_FT = 3;
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

/** Does every point of the stretch A-B (checked every 5 ft) lie on one of these lines? */
function onLines(A: XY, B: XY, lines: XY[][]): boolean {
  const n = Math.max(1, Math.ceil(dist(A, B) / 5));
  for (let k = 0; k <= n; k++) {
    const P: XY = [A[0] + ((B[0] - A[0]) * k) / n, A[1] + ((B[1] - A[1]) * k) / n];
    if (!lines.some((ln) => segDist(P, ln) <= ON_LINE_FT)) return false;
  }
  return true;
}

/** Problems with the route, in order. An empty list means the route can be shown. */
export function checkRoute(
  streets: { streetLines: NamedLine[]; busyRoads: NamedLine[] },
  segments: Segment[],
  home: Pt,
): string[] {
  if (!streets.streetLines.length) return ["no street lines, so the route couldn't be checked against real streets"];
  const geo = new Geo(home);
  const busy = streets.busyRoads.map((b) => ({ name: b.name, xy: b.points.map((p) => geo.xy(p)) }));
  const B = busy.map((b) => b.xy);
  const S = streets.streetLines.map((s) => s.points.map((p) => geo.xy(p)));
  const busyAt = (P: XY) => busy.find((b) => segDist(P, b.xy) <= ON_LINE_FT)?.name;

  const problems: string[] = [];
  let prev: XY | null = null; // the route point before the current one, across segments
  let prevEnd: XY | null = null;
  for (const s of segments) {
    if (s.points.length < 2) continue;
    const xy = s.points.map((p) => geo.xy(p));

    if (prevEnd) {
      const gap = dist(prevEnd, xy[0]);
      if (gap > ON_LINE_FT) problems.push(`Getting to ${s.name}: starts ${Math.round(gap)} ft from where the last street ended.`);
    }

    // Each stretch must follow a street line, and not a busy road's.
    let offFt = 0, onBusy = false;
    for (let i = 0; i < xy.length - 1; i++) {
      if (dist(xy[i], xy[i + 1]) <= ON_LINE_FT || onLines(xy[i], xy[i + 1], S)) continue;
      if (onLines(xy[i], xy[i + 1], B)) onBusy = true;
      else offFt += dist(xy[i], xy[i + 1]);
    }
    if (offFt) {
      problems.push(`${s.name}: a ${Math.round(offFt)} ft stretch is not on any street (a gap in the data `
        + 'is probably a real gap: dead end, park or yard). Cut it from real street pieces.');
    }
    // Also catch a street that runs right beside a busy road (as the reference did).
    const along = samples(xy).slice(3, -3).filter((P) => B.some((b) => segDist(P, b) < ALONG_BUSY_FT));
    if (onBusy || along.length >= 3) {
      const ft = onBusy ? Math.round(xy.slice(1).reduce((t, P, i) => t + dist(xy[i], P), 0)) : along.length * SAMPLE_FT;
      problems.push(`${s.name}: runs along a busy road for about ${ft} ft.`);
    }

    // Reaching a busy road and turning back is fine; walking through that point is a crossing.
    // (A walk along the busy road itself was reported above.)
    const walk: XY[] = prev && prevEnd && dist(prevEnd, xy[0]) <= ON_LINE_FT ? [prev, ...xy] : xy;
    for (let i = 1; i < walk.length - 1; i++) {
      const road = busyAt(walk[i]);
      if (road && !onBusy && dist(walk[i - 1], walk[i + 1]) > ON_LINE_FT) {
        problems.push(`${i === 1 && walk !== xy ? `Getting to ${s.name}` : s.name}: crosses ${road}. Turn back before it instead.`);
      }
    }
    prev = xy[xy.length - 2];
    prevEnd = xy[xy.length - 1];
  }
  return problems;
}
