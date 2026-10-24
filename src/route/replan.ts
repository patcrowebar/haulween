// "Running late? Replan from here", with no AI.
// The same optimizer as the first plan, run as an open walk: it starts where the family is, ends
// at home, and fits the minutes left. Houses already visited count for nothing, so the streets
// that bring the fewest houses are the first to go. Hard rule 3 still holds: a replan that fails
// the route check is never returned.

import { Geo, key, segDist } from './geo';
import type { Segment } from './optimize';
import { solve, type PlanOptions, type PlanResult } from './plan';
import { fmt24, windowOf } from './schedule';
import type { Pattern, Pt } from './types';

/** A row already walked (or the part of one walked so far). */
export type Visited = { points: Pt[]; pattern: Pattern };

export type Here = {
  /** The row the family is on now. */
  row: Segment;
  /** Where GPS puts them, if it does. Without it, the replan starts at the start of the row. */
  at: Pt | null;
};

export type ReplanOptions = PlanOptions & {
  /** The time now, in minutes after midnight of the plan's day (past 1440 after midnight). */
  now: number;
};

export type ReplanResult = PlanResult & { start?: Pt };

/** Index of the route point on `pts` nearest to `at`, measured along the line. */
export function nearestIndex(pts: Pt[], at: Pt): number {
  const geo = new Geo(at);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist([0, 0], [geo.xy(pts[i]), geo.xy(pts[i + 1])]);
    if (d < bestD - 1e-9) { bestD = d; best = i; }
  }
  return best;
}

export function replanFromHere(
  data: Parameters<typeof solve>[0], home: Pt, o: ReplanOptions, here: Here, visited: Visited[],
): ReplanResult {
  const [, end] = windowOf(o);
  const left = Math.max(0, end - o.now - (o.bufferMin ?? 10));
  const pts = here.row.points;
  let start: Pt = pts[0];
  const seen: Visited[] = [...visited];

  return {
    ...solve(data, home, o, {
      budget: left,
      prepare: (g) => {
        // Start at the first corner (or Home) at or ahead of the family on this row.
        const from = here.at ? nearestIndex(pts, here.at) : 0;
        let k = pts.length - 1;
        for (let i = from + (here.at ? 1 : 0); i < pts.length; i++) {
          if (g.nodes.has(key(pts[i]))) { k = i; break; }
        }
        start = pts[k];
        // Walking to that corner visits the houses on the way.
        if (k > 0) seen.push({ points: pts.slice(0, k + 1), pattern: here.row.pattern });
        takeOffVisited(g.edges, seen);
      },
      from: () => key(start),
      schedule: { ...o, startTime: fmt24(o.now), endTime: o.now >= end - 1 ? fmt24(o.now + 1) : o.endTime },
    }),
    start,
  };
}

/** Houses already visited count for nothing. A zigzag visits both sides; one side, the walker's right. */
function takeOffVisited(edges: Array<{ points: Pt[]; left: number; right: number }>, visited: Visited[]): void {
  const walked = new Map<string, Pattern>();
  for (const v of visited) {
    if (v.pattern === 'walk_through') continue;
    for (let i = 0; i < v.points.length - 1; i++) walked.set(`${key(v.points[i])}>${key(v.points[i + 1])}`, v.pattern);
  }
  for (const e of edges) {
    if (e.points.length < 2) continue;
    const a = key(e.points[0]), b = key(e.points[1]);
    for (const [pair, forward] of [[`${a}>${b}`, true], [`${b}>${a}`, false]] as const) {
      const pattern = walked.get(pair);
      if (pattern === 'zigzag') { e.left = 0; e.right = 0; }
      else if (pattern === 'one_side') {
        if (forward) e.right = 0;
        else e.left = 0;
      }
    }
  }
}
