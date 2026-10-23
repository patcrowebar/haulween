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

  components(W: Edge[]): Set<string>[] {
    const parent = new Map<string, string>([[this.home, this.home]]);
    for (const e of W) { parent.set(e.u, e.u); parent.set(e.v, e.v); }
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    for (const e of W) parent.set(find(e.u), find(e.v));
    const groups = new Map<string, Set<string>>();
    for (const n of parent.keys()) {
      const r = find(n);
      if (!groups.has(r)) groups.set(r, new Set());
      groups.get(r)!.add(n);
    }
    return [...groups.values()];
  }

  /** Minutes for working set W as a closed walk from home, and the extra pieces walked to close it. */
  evaluate(W: Edge[]): [number, Edge[]] {
    let cost = W.reduce((s, e) => s + this.zig(e), 0);
    const dead: Edge[] = [];
    // 1. Join groups to home's (Prim over shortest walks); each link is walked both ways.
    const comps = this.components(W);
    const homec = comps.find((c) => c.has(this.home))!;
    const joined = new Set(homec);
    const rest = comps.filter((c) => c !== homec);
    while (rest.length) {
      let best: [number, number, string, string] | null = null;
      for (let ci = 0; ci < rest.length; ci++) {
        for (const a of joined) {
          const { dist } = this.sp(a);
          for (const b of rest[ci]) {
            const d = dist.get(b);
            if (d !== undefined && (best === null || d < best[0])) best = [d, ci, a, b];
          }
        }
      }
      if (best === null) return [INF, []];
      const [d, ci, a, b]: [number, number, string, string] = best;
      const p = this.path(a, b);
      dead.push(...p, ...p);
      cost += 2 * d;
      for (const n of rest.splice(ci, 1)[0]) joined.add(n);
    }
    // 2. Pair odd-degree nodes.
    const deg = new Map<string, number>();
    for (const e of [...W, ...dead]) {
      deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
      deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
    }
    const odd = [...deg].filter(([, d]) => d % 2).map(([n]) => n);
    for (const [a, b] of this.match(odd)) {
      dead.push(...this.path(a, b));
      cost += this.sp(a).dist.get(b)!;
    }
    // 3. A worked street walked again is done one side each way: no zigzag crossings.
    const Wids = new Set(W.map((e) => e.id));
    const reused = new Set(dead.filter((e) => Wids.has(e.id)).map((e) => e.id));
    for (const e of W) {
      if (reused.has(e.id)) {
        const h = this.houses(e);
        if (h) cost -= (Math.ceil(h / this.hpc) - 1) * this.o.crossMin;
      }
    }
    return [cost, dead];
  }

  match(odd: string[]): Array<[string, string]> {
    if (!odd.length) return [];
    const D = new Map(odd.map((a) => [a, this.sp(a).dist]));
    const dd = (a: string, b: string) => D.get(a)!.get(b) ?? 1e9;
    const n = odd.length;
    if (n <= 14) {
      const memo = new Map<number, [number, Array<[string, string]>]>();
      const full = (1 << n) - 1;
      const solve = (mask: number): [number, Array<[string, string]>] => {
        if (mask === full) return [0, []];
        const hit = memo.get(mask);
        if (hit) return hit;
        let i = 0;
        while ((mask >> i) & 1) i++;
        let best: [number, Array<[string, string]>] = [INF, []];
        for (let j = i + 1; j < n; j++) {
          if ((mask >> j) & 1) continue;
          const [c0, ps] = solve(mask | (1 << i) | (1 << j));
          const c = c0 + dd(odd[i], odd[j]);
          if (c < best[0]) best = [c, [...ps, [odd[i], odd[j]]]];
        }
        memo.set(mask, best);
        return best;
      };
      return solve(0)[1];
    }
    // Greedy for large sets, then pairwise improvement.
    const left = new Set(odd);
    const pairs: Array<[string, string]> = [];
    while (left.size) {
      const a = left.values().next().value as string;
      left.delete(a);
      let b = '';
      for (const x of left) if (b === '' || dd(a, x) < dd(a, b)) b = x;
      left.delete(b);
      pairs.push([a, b]);
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const [a, b] = pairs[i], [c, d] = pairs[j];
          let now = dd(a, b) + dd(c, d);
          for (const [x, y] of [[[a, c], [b, d]], [[a, d], [b, c]]] as Array<[[string, string], [string, string]]>) {
            const alt = dd(x[0], x[1]) + dd(y[0], y[1]);
            if (alt + 1e-9 < now) {
              pairs[i] = x;
              pairs[j] = y;
              now = alt;
              improved = true;
            }
          }
        }
      }
    }
    return pairs;
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
