// Pick the pieces with the most houses that fit; build the walk.
// Ported from reference/optimize_route.py (Planner, to_segments).
//
//   1. Cost of a plan: zigzag every worked piece once, then make it a closed walk from home
//      (join separate groups by the shortest walk, pair up dead ends and odd intersections:
//      a Chinese-postman fix). A worked street walked again is done one side each way.
//   2. Search: start from every safe street. While over budget, drop the piece that loses the
//      fewest houses per minute saved. Then add back anything that fits, best first.
//   3. Walk: turn the chosen pieces into an ordered walk from home (Hierholzer), merged into
//      street-by-street segments.

import { pyRound, shortName } from './geo';
import type { Edge, Graph } from './graph';
import type { Pattern, Pt } from './types';

export type PlannerOptions = {
  /** Walking speed in feet per minute. */
  ftPerMin: number;
  doorMin: number;
  crossMin: number;
  /** Minutes available for the walk (window minus buffer). */
  budget: number;
  housesPerCrossing?: number;
};

type Mode = 'zigzag' | 'side1' | 'side2' | 'walk';

export type Step = {
  name: string;
  mode: Mode;
  points: Pt[];
  lengthFt: number;
  /** Houses on the walker's left and right in the direction walked. */
  left: number;
  right: number;
  to: string | null;
};

export type Segment = {
  name: string;
  points: Pt[];
  lengthFt: number;
  housesLeft: number;
  housesRight: number;
  pattern: Pattern;
  /** Overrides the pattern's default label in the schedule. */
  label?: string;
  why: string;
};

const INF = 1e18;

/** Keep only pieces that connect to home. A piece the walk can't reach would make every plan impossible. */
export function reachableEdges(graph: Graph): Edge[] {
  const adj = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    for (const n of [e.u, e.v]) adj.set(n, [...(adj.get(n) ?? []), e]);
  }
  const seen = new Set([graph.home]);
  const stack = [graph.home];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of adj.get(n) ?? []) {
      for (const m of [e.u, e.v]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
  }
  return graph.edges.filter((e) => seen.has(e.u));
}

/** Min-heap of [distance, node], ties broken by node coordinates like Python's tuple compare. */
class Heap {
  private a: Array<[number, string]> = [];
  constructor(private nodes: Map<string, Pt>) {}
  get size() { return this.a.length; }
  private less(x: [number, string], y: [number, string]) {
    if (x[0] !== y[0]) return x[0] < y[0];
    const p = this.nodes.get(x[1])!, q = this.nodes.get(y[1])!;
    return p[0] !== q[0] ? p[0] < q[0] : p[1] < q[1];
  }
  push(item: [number, string]) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop(): [number, string] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const other = (e: Edge, n: string) => (e.u === n ? e.v : e.u);

export class Planner {
  readonly edges: Edge[];
  readonly home: string;
  private nodes: Map<string, Pt>;
  private adj = new Map<string, Edge[]>();
  private spCache = new Map<string, { dist: Map<string, number>; prev: Map<string, Edge> }>();
  private hpc: number;
  // evaluate() runs tens of thousands of times per plan, so it works on numbered nodes and flat
  // arrays. Every loop keeps the reference's order, so ties break exactly as before.
  private keys: string[] = [];
  private index = new Map<string, number>();
  private ui: Int32Array;
  private vi: Int32Array;
  private distCache = new Map<number, Float64Array>();

  constructor(graph: Graph, private o: PlannerOptions) {
    this.edges = reachableEdges(graph);
    this.home = graph.home;
    this.nodes = graph.nodes;
    this.hpc = o.housesPerCrossing ?? 2;
    for (const e of this.edges) {
      for (const n of [e.u, e.v]) {
        const list = this.adj.get(n) ?? [];
        list.push(e);
        this.adj.set(n, list);
      }
    }
    for (const n of [this.home, ...this.edges.flatMap((e) => [e.u, e.v])]) {
      if (!this.index.has(n)) { this.index.set(n, this.keys.length); this.keys.push(n); }
    }
    const maxId = this.edges.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.ui = new Int32Array(maxId);
    this.vi = new Int32Array(maxId);
    for (const e of this.edges) { this.ui[e.id] = this.index.get(e.u)!; this.vi[e.id] = this.index.get(e.v)!; }
  }

  /** Walking minutes from node number s to every node number (Infinity if unreachable). */
  private distFrom(s: number): Float64Array {
    let d = this.distCache.get(s);
    if (!d) {
      d = new Float64Array(this.keys.length).fill(Infinity);
      for (const [k, v] of this.sp(this.keys[s]).dist) d[this.index.get(k)!] = v;
      this.distCache.set(s, d);
    }
    return d;
  }

  walk(e: Edge) { return e.lengthFt / this.o.ftPerMin; }
  houses(e: Edge) { return e.left + e.right; }
  zig(e: Edge) {
    const h = this.houses(e);
    return this.walk(e) + h * this.o.doorMin + Math.ceil(h / this.hpc) * this.o.crossMin;
  }

  /** Shortest walking minutes and predecessor pieces from node s over all safe pieces. */
  sp(s: string) {
    const hit = this.spCache.get(s);
    if (hit) return hit;
    const dist = new Map([[s, 0]]);
    const prev = new Map<string, Edge>();
    const pq = new Heap(this.nodes);
    pq.push([0, s]);
    while (pq.size) {
      const [d, n] = pq.pop();
      if (d > (dist.get(n) ?? INF)) continue;
      for (const e of this.adj.get(n) ?? []) {
        const m = other(e, n);
        const nd = d + this.walk(e);
        if (nd < (dist.get(m) ?? INF)) {
          dist.set(m, nd);
          prev.set(m, e);
          pq.push([nd, m]);
        }
      }
    }
    const out = { dist, prev };
    this.spCache.set(s, out);
    return out;
  }

  path(a: string, b: string): Edge[] {
    const { prev } = this.sp(a);
    const out: Edge[] = [];
    let n = b;
    while (n !== a) {
      const e = prev.get(n)!;
      out.push(e);
      n = other(e, n);
    }
    return out.reverse();
  }

  /** Groups of nodes joined by W, home's group first, in the reference's order. */
  private components(W: Edge[]): number[][] {
    const { ui, vi } = this;
    const N = this.keys.length;
    const parent = new Int32Array(N).fill(-1);
    const order: number[] = [];
    const add = (n: number) => { if (parent[n] < 0) { parent[n] = n; order.push(n); } else parent[n] = n; };
    add(this.index.get(this.home)!);
    for (const e of W) { add(ui[e.id]); add(vi[e.id]); }
    const find = (x: number) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (const e of W) parent[find(ui[e.id])] = find(vi[e.id]);
    const groupOf = new Map<number, number[]>();
    const groups: number[][] = [];
    for (const n of order) {
      const r = find(n);
      let g = groupOf.get(r);
      if (!g) { g = []; groupOf.set(r, g); groups.push(g); }
      g.push(n);
    }
    return groups;
  }

  /** Minutes for working set W as a closed walk from home, and the extra pieces walked to close it. */
  evaluate(W: Edge[]): [number, Edge[]] {
    const { ui, vi, keys } = this;
    let cost = W.reduce((s, e) => s + this.zig(e), 0);
    const dead: Edge[] = [];
    // 1. Join groups to home's (Prim over shortest walks); each link is walked both ways.
    const [homec, ...rest] = this.components(W);
    const joined = [...homec];
    while (rest.length) {
      let best: [number, number, number, number] | null = null;
      for (let ci = 0; ci < rest.length; ci++) {
        for (const a of joined) {
          const dist = this.distFrom(a);
          for (const b of rest[ci]) {
            const d = dist[b];
            if (d !== Infinity && (best === null || d < best[0])) best = [d, ci, a, b];
          }
        }
      }
      if (best === null) return [INF, []];
      const [d, ci, a, b]: [number, number, number, number] = best;
      const p = this.path(keys[a], keys[b]);
      dead.push(...p, ...p);
      cost += 2 * d;
      joined.push(...rest.splice(ci, 1)[0]);
    }
    // 2. Pair odd-degree nodes, in order of first appearance.
    const deg = new Int32Array(keys.length);
    const seen: number[] = [];
    const bump = (n: number) => { if (deg[n]++ === 0) seen.push(n); };
    for (const e of W) { bump(ui[e.id]); bump(vi[e.id]); }
    for (const e of dead) { bump(ui[e.id]); bump(vi[e.id]); }
    const odd = seen.filter((n) => deg[n] % 2);
    for (const [a, b] of this.matchNodes(odd)) {
      dead.push(...this.path(keys[a], keys[b]));
      cost += this.distFrom(a)[b];
    }
    // 3. A worked street walked again is done one side each way: no zigzag crossings.
    const inW = new Uint8Array(ui.length);
    for (const e of W) inW[e.id] = 1;
    const reused = new Uint8Array(ui.length);
    for (const e of dead) if (inW[e.id]) reused[e.id] = 1;
    for (const e of W) {
      if (reused[e.id]) {
        const h = this.houses(e);
        if (h) cost -= (Math.ceil(h / this.hpc) - 1) * this.o.crossMin;
      }
    }
    return [cost, dead];
  }

  private matchNodes(odd: number[]): Array<[number, number]> {
    if (!odd.length) return [];
    const n = odd.length;
    const dd = (a: number, b: number) => {
      const d = this.distFrom(a)[b];
      return d === Infinity ? 1e9 : d;
    };
    if (n <= 14) {
      // Exact minimum pairing over bitmasks. Same choices and pair order as the reference,
      // with flat arrays instead of a Map of copied lists (this runs tens of thousands of times).
      const dist = new Float64Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) dist[i * n + j] = dd(odd[i], odd[j]);
      const full = (1 << n) - 1;
      const cost = new Float64Array(1 << n).fill(-1);
      const pick = new Int8Array(1 << n).fill(-1);
      const solve = (mask: number): number => {
        if (mask === full) return 0;
        if (cost[mask] >= 0) return cost[mask];
        let i = 0;
        while ((mask >> i) & 1) i++;
        let best = INF, bestJ = -1;
        for (let j = i + 1; j < n; j++) {
          if ((mask >> j) & 1) continue;
          const c = solve(mask | (1 << i) | (1 << j)) + dist[i * n + j];
          if (c < best) { best = c; bestJ = j; }
        }
        cost[mask] = best;
        pick[mask] = bestJ;
        return best;
      };
      solve(0);
      const pairs: Array<[number, number]> = [];
      for (let mask = 0; mask !== full && pick[mask] >= 0; ) {
        let i = 0;
        while ((mask >> i) & 1) i++;
        const j = pick[mask];
        pairs.push([odd[i], odd[j]]);
        mask |= (1 << i) | (1 << j);
      }
      return pairs.reverse(); // the reference lists the deepest pair first
    }
    // Greedy for large sets, then pairwise improvement. Same order and tie-breaks as the
    // reference, on node numbers and a distance table (dd isn't symmetric: keep its argument order).
    const dist = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) dist[i * n + j] = dd(odd[i], odd[j]);
    const alive = new Uint8Array(n).fill(1);
    const P: Array<[number, number]> = [];
    for (let first = 0; first < n; first++) {
      if (!alive[first]) continue;
      const a = first;
      alive[a] = 0;
      let b = -1;
      for (let x = 0; x < n; x++) if (alive[x] && (b < 0 || dist[a * n + x] < dist[a * n + b])) b = x;
      alive[b] = 0;
      P.push([a, b]);
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < P.length; i++) {
        for (let j = i + 1; j < P.length; j++) {
          const [a, b] = P[i], [c, d] = P[j];
          let now = dist[a * n + b] + dist[c * n + d];
          // first alternative: (a, c) and (b, d)
          let alt = dist[a * n + c] + dist[b * n + d];
          if (alt + 1e-9 < now) { P[i] = [a, c]; P[j] = [b, d]; now = alt; improved = true; }
          // second alternative: (a, d) and (b, c)
          alt = dist[a * n + d] + dist[b * n + c];
          if (alt + 1e-9 < now) { P[i] = [a, d]; P[j] = [b, c]; now = alt; improved = true; }
        }
      }
    }
    return P.map(([x, y]): [number, number] => [odd[x], odd[y]]);
  }

  optimize(): { worked: Edge[]; minutes: number } {
    const W = new Map(this.edges.map((e) => [e.id, e]));
    let [cost] = this.evaluate([...W.values()]);
    while (cost > this.o.budget && W.size) {
      let best: [score: number, id: number, c: number] | null = null;
      for (const [eid, e] of W) {
        const [c] = this.evaluate([...W.values()].filter((x) => x.id !== eid));
        const saved = cost - c;
        if (saved <= 0) continue;
        const score = this.houses(e) / saved;
        if (best === null || score < best[0]) best = [score, eid, c];
        if (score === 0) break; // nothing scores lower, and the first of equals wins anyway
      }
      if (best === null) break;
      W.delete(best[1]);
      cost = best[2];
    }
    // Add back what fits, most houses per extra minute first.
    for (;;) {
      let best: [gain: number, e: Edge, c: number] | null = null;
      for (const e of this.edges) {
        if (W.has(e.id) || !this.houses(e)) continue;
        const [c] = this.evaluate([...W.values(), e]);
        if (c <= this.o.budget) {
          const gain = this.houses(e) / Math.max(c - cost, 0.1);
          if (best === null || gain > best[0]) best = [gain, e, c];
        }
      }
      if (best === null) break;
      W.set(best[1].id, best[1]);
      cost = best[2];
    }
    return { worked: [...W.values()], minutes: cost };
  }

  /** The ordered closed walk from home, one step per piece walked. */
  tour(W: Edge[]): Step[] {
    const [, dead] = this.evaluate(W);
    const multi: Array<[Edge, 'work' | 'dead']> = [
      ...W.map((e) => [e, 'work'] as [Edge, 'work']),
      ...dead.map((e) => [e, 'dead'] as [Edge, 'dead']),
    ];
    const inc = new Map<string, number[]>();
    multi.forEach(([e], idx) => {
      for (const n of [e.u, e.v]) inc.set(n, [...(inc.get(n) ?? []), idx]);
    });
    const used = multi.map(() => false);
    // Prefer working before walking on the way out, so houses come first.
    const pick = (n: string) =>
      (inc.get(n) ?? [])
        .filter((i) => !used[i])
        .sort((i, j) => {
          const wi = multi[i][1] !== 'work' ? 1 : 0, wj = multi[j][1] !== 'work' ? 1 : 0;
          return wi - wj || this.houses(multi[j][0]) - this.houses(multi[i][0]);
        });
    const stack: Array<[string, [number, string] | null]> = [[this.home, null]];
    const circuit: Array<[number, string]> = [];
    while (stack.length) {
      const [n, via] = stack[stack.length - 1];
      const opts = pick(n);
      if (opts.length) {
        const i = opts[0];
        used[i] = true;
        stack.push([other(multi[i][0], n), [i, n]]);
      } else {
        stack.pop();
        if (via) circuit.push(via);
      }
    }
    circuit.reverse();

    // A street walked once is zigzagged; walked twice, one side each way.
    const times = new Map<number, number>();
    for (const [i] of circuit) times.set(multi[i][0].id, (times.get(multi[i][0].id) ?? 0) + 1);
    const Wids = new Set(W.map((e) => e.id));
    const seen = new Map<number, number>();
    return circuit.map(([i, n]) => {
      const e = multi[i][0];
      const fwd = n === e.u;
      const k = seen.get(e.id) ?? 0;
      seen.set(e.id, k + 1);
      let mode: Mode;
      let houses: [number, number];
      if (!Wids.has(e.id)) [mode, houses] = ['walk', [0, 0]];
      else if (times.get(e.id) === 1) [mode, houses] = ['zigzag', [e.left, e.right]];
      else if (k === 0) [mode, houses] = ['side1', fwd ? [0, e.right] : [e.left, 0]]; // walker's right first: no crossing to start
      else if (k === 1) [mode, houses] = ['side2', fwd ? [0, e.right] : [e.left, 0]];
      else [mode, houses] = ['walk', [0, 0]];
      const points = fwd ? e.points : [...e.points].reverse();
      const [hl, hr] = fwd ? houses : [houses[1], houses[0]];
      const m = fwd ? e.v : e.u;
      const cross = [...new Set((this.adj.get(m) ?? []).filter((x) => x.name !== e.name).map((x) => x.name))].sort();
      let to: string | null;
      if (m === this.home) to = 'home';
      else if (e.busyAt.has(m)) to = `${shortName(e.busyAt.get(m)!)} (stop before it)`;
      else if (cross.length) to = shortName(cross[0]);
      else if ((this.adj.get(m) ?? []).length === 1) to = 'the dead end';
      else to = null;
      return { name: e.name, mode, points, lengthFt: e.lengthFt, left: hl, right: hr, to };
    });
  }
}

const SIDE_LABELS = {
  side1: ['right side now, the other side on the way back', "you'll walk back this way"],
  side2: ['back along the other side', 'done one side on the way out'],
} as const;

/** Merge steps into schedule rows: same street and mode merge; short no-house links fold in. */
export function toSegments(steps: Step[]): Segment[] {
  type Draft = Segment & { street: string; mode: Mode; to: string | null };
  const drafts: Draft[] = [];
  for (const st of steps) {
    const mode: Mode = st.mode !== 'walk' && !(st.left || st.right) ? 'walk' : st.mode; // no houses: just walking
    const name = shortName(st.name);
    const tiny = mode === 'walk' && st.lengthFt < 150;
    const last = drafts[drafts.length - 1];
    if (last && (tiny || (last.street === name && last.mode === mode))) {
      last.points.push(...st.points.slice(1));
      last.lengthFt += pyRound(st.lengthFt);
      last.housesLeft += st.left;
      last.housesRight += st.right;
      if (st.to) last.to = st.to;
      continue;
    }
    drafts.push({
      street: name, mode, to: st.to, name, points: [...st.points], lengthFt: pyRound(st.lengthFt),
      housesLeft: st.left, housesRight: st.right, pattern: 'walk_through', why: '',
    });
  }
  return drafts.map(({ street: _street, mode, to, ...seg }) => {
    if (to === 'home') seg.name += ' back home';
    else if (to) seg.name += ` to ${to}`;
    if (mode === 'zigzag') return { ...seg, pattern: 'zigzag', why: 'one pass covers both sides' };
    if (mode === 'side1' || mode === 'side2') {
      const [label, why] = SIDE_LABELS[mode];
      return { ...seg, pattern: 'one_side', label, why };
    }
    return { ...seg, pattern: 'walk_through', why: 'connects to the next street', housesLeft: 0, housesRight: 0 };
  });
}
