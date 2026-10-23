// Split streets at intersections into pieces; houses per side.
// Ported from reference/optimize_route.py (build_graph).
//
// Pieces meet only where they share a vertex, so the walk can never jump a gap in the street data.

import { Geo, frontage, key, pyRound, type XY } from './geo';
import { blockerPolygons, prepareStreets, type Pocket } from './pocket';
import type { OsmData, Pt } from './types';

/** One stretch of street between two intersections (or an intersection and a dead end). */
export type Edge = {
  id: number;
  name: string;
  points: Pt[];
  /** Node keys at each end. */
  u: string;
  v: string;
  lengthFt: number;
  left: number;
  right: number;
  /** Ends that touch a busy road, with that road's name. */
  busyAt: Map<string, string>;
};

export type Graph = {
  edges: Edge[];
  home: string;
  /** Rounded [lat, lng] of every node, for tie-breaking the same way the reference does. */
  nodes: Map<string, Pt>;
};

export function buildGraph(data: OsmData, pocket: Pocket, home: Pt, frontageFt = 55): Graph {
  const geo = new Geo(home);
  const all = prepareStreets(data, geo);
  const busy = all.filter((s) => s.busy);
  const blockers = blockerPolygons(data, geo);

  const pieces: Array<{ name: string; g: Pt[] }> = pocket.pocket.flatMap((r) =>
    r.pieces.map((pc) => ({ name: r.name, g: pc.map((p) => [p[0], p[1]] as Pt) })),
  );
  const count = new Map<string, number>();
  for (const { g } of pieces) for (const p of g) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
  const busyName = new Map<string, string>();
  for (const b of busy) for (const p of b.points) busyName.set(key(p), b.name);

  // Snap home onto the nearest piece and insert it as a vertex.
  let best: { d: number; pi: number; i: number; hp: Pt } | null = null;
  pieces.forEach(({ g }, pi) => {
    for (let i = 0; i < g.length - 1; i++) {
      const a = geo.xy(g[i]), b = geo.xy(g[i + 1]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / (dx * dx + dy * dy || 1e-9)));
      const q: XY = [a[0] + t * dx, a[1] + t * dy];
      const d = Math.hypot(q[0], q[1]);
      if (best === null || d < best.d) best = { d, pi, i, hp: geo.ll(q[0], q[1]) };
    }
  });
  if (best === null) throw new Error('No safe streets to walk');
  const { pi, i: at, hp: rawHome } = best as { pi: number; i: number; hp: Pt };
  const hp: Pt = [Number(rawHome[0].toFixed(6)), Number(rawHome[1].toFixed(6))];
  pieces[pi].g.splice(at + 1, 0, hp);
  const homeKey = key(hp);
  count.set(homeKey, 99);

  // Split pieces at shared vertices (intersections), piece ends, busy-road contacts and home.
  const raw: Array<{ name: string; g: Pt[] }> = [];
  for (const { name, g } of pieces) {
    let cur: Pt[] = [g[0]];
    for (let j = 1; j < g.length; j++) {
      cur.push(g[j]);
      const k = key(g[j]);
      if (j === g.length - 1 || (count.get(k) ?? 0) > 1 || busyName.has(k) || k === homeKey) {
        if (cur.length >= 2 && key(cur[0]) !== key(cur[cur.length - 1])) raw.push({ name, g: cur });
        cur = [g[j]];
      }
    }
  }

  const busyXY = busy.map((b) => b.xy);
  const othersByName = new Map<string, XY[][]>();
  const edges: Edge[] = [];
  for (const { name, g } of raw) {
    const xy = g.map((p) => geo.xy(p));
    let len = 0;
    for (let k = 0; k < xy.length - 1; k++) len += Math.hypot(xy[k + 1][0] - xy[k][0], xy[k + 1][1] - xy[k][1]);
    if (len <= 1) continue;
    if (!othersByName.has(name)) othersByName.set(name, all.filter((o) => o.name !== name).map((o) => o.xy));
    const [L, R] = frontage(xy, othersByName.get(name)!, blockers, busyXY);
    const u = key(g[0]), v = key(g[g.length - 1]);
    const busyAt = new Map<string, string>();
    for (const n of [u, v]) if (busyName.has(n)) busyAt.set(n, busyName.get(n)!);
    edges.push({
      id: edges.length, name, points: g, u, v, lengthFt: len,
      left: pyRound(L / frontageFt), right: pyRound(R / frontageFt), busyAt,
    });
  }

  const nodes = new Map<string, Pt>();
  for (const e of edges) {
    for (const p of [e.points[0], e.points[e.points.length - 1]]) {
      nodes.set(key(p), [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]);
    }
  }
  return { edges, home: homeKey, nodes };
}
