#!/usr/bin/env python3
"""Pick the walk from home that collects the most houses in the time available.

Usage:
    python optimize_route.py osm.json streets.json --home LAT,LNG --start 5:00pm --end 8:00pm \
        --age 10 [--pace-mph 2.5] [--door-seconds 60] [--buffer 10] [--frontage 55] [--out segments.json]

Inputs come from the OpenStreetMap step (references/street-lookup.md): osm.json (raw compact data)
and streets.json (osm_import.py output; its `pocket` is the set of safe streets).

How it works:
  1. Graph. Every pocket street is split at its intersections into pieces (edges). Each edge gets its
     length and houses per side (real frontage minus parks, schools, churches, corners and busy-road
     edges). Home is snapped onto its street and becomes a node.
  2. Cost of a plan. "Work" a set of edges: zigzag each once (walk + doors + crossings). Then make it a
     closed walk from home: connect separate groups by the shortest walk and pair up dead ends and
     odd intersections by shortest walks (a Chinese-postman fix). Where that extra walking reuses a
     worked street, that street becomes "one side down, the other back" instead of zigzag, which
     saves its crossings.
  3. Search. Start from every safe street. While over the time budget, drop the edge that loses the
     fewest houses per minute saved. Then add back any edge that fits, most houses per minute first.
  4. Walk. Turn the chosen set into an actual ordered walk from home (Hierholzer), merged into
     street-by-street segments ready for plan_route.py.

Output: {"segments": [...plan_route segments...], "estimate": {...}, "skipped": [...]}.
Times here are estimates; plan_route.py produces the schedule.
"""
import argparse
import heapq
import itertools
import json
import math
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osm_import as oi  # noqa: E402
from plan_route import pace_for_age, parse_clock  # noqa: E402


def key(p):
    return (round(p[0], 5), round(p[1], 5))


def build_graph(osm, streets_out, home, frontage):
    geo = oi.Geo(home)
    allst = [s for s in osm["streets"] if s.get("g") and len(s["g"]) >= 2]
    for s in allst:
        s["xy"] = [geo.xy(p) for p in s["g"]]
    busy = [s for s in allst if oi.is_busy(s)]
    blockers = [[geo.xy(p) for p in a["g"]] for a in osm.get("areas", [])
                if a.get("k") in ("park", "pitch", "playground", "school", "place_of_worship", "grass",
                                  "recreation_ground", "cemetery", "commercial", "retail") and len(a["g"]) >= 4]

    pieces = [(r["name"], [list(p) for p in pc]) for r in streets_out["pocket"] for pc in r["pieces"]]
    count = {}
    for name, g in pieces:
        for p in g:
            count[key(p)] = count.get(key(p), 0) + 1
    busy_keys = {key(p) for b in busy for p in b["g"]}
    busy_name = {key(p): b["name"] for b in busy for p in b["g"]}

    # Snap home onto the nearest piece and insert it as a vertex.
    H = home
    best = None
    for pi, (name, g) in enumerate(pieces):
        for i in range(len(g) - 1):
            a, b = geo.xy(g[i]), geo.xy(g[i + 1])
            P = (0.0, 0.0)
            dx, dy = b[0] - a[0], b[1] - a[1]
            t = max(0.0, min(1.0, ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1e-9)))
            q = (a[0] + t * dx, a[1] + t * dy)
            d = math.hypot(*q)
            if best is None or d < best[0]:
                best = (d, pi, i, geo.ll(*q))
    _, pi, i, hp = best
    hp = [round(hp[0], 6), round(hp[1], 6)]
    pieces[pi][1].insert(i + 1, hp)
    home_key = key(hp)
    count[home_key] = 99

    # Split pieces at shared vertices (intersections), piece ends, busy-road contacts and home.
    edges = []
    for name, g in pieces:
        cur = [g[0]]
        for j in range(1, len(g)):
            cur.append(g[j])
            k = key(g[j])
            if j == len(g) - 1 or count.get(k, 0) > 1 or k in busy_keys or k == home_key:
                if len(cur) >= 2 and key(cur[0]) != key(cur[-1]):
                    edges.append({"name": name, "g": cur})
                cur = [g[j]]

    others_cache = {}
    for e in edges:
        xy = [geo.xy(p) for p in e["g"]]
        e["u"], e["v"] = key(e["g"][0]), key(e["g"][-1])
        e["len"] = sum(math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1))
        others = others_cache.setdefault(e["name"], [o["xy"] for o in allst if o["name"] != e["name"]])
        L = R = 0.0
        for P, (ux, uy) in oi.walk_points(xy, oi.STEP_FT):
            if any(oi.seg_dist(P, o) < oi.CORNER_FT for o in others):
                continue
            for sgn in (1, -1):
                Q = (P[0] - uy * oi.OFFSET_FT * sgn, P[1] + ux * oi.OFFSET_FT * sgn)
                if any(oi.inside(Q, bb) for bb in blockers) or any(oi.seg_dist(Q, b["xy"]) < 30 for b in busy):
                    continue
                if sgn == 1:
                    L += oi.STEP_FT
                else:
                    R += oi.STEP_FT
        e["left"], e["right"] = round(L / frontage), round(R / frontage)
    edges = [e for e in edges if e["len"] > 1]
    for n, e in enumerate(edges):
        e["id"] = n
    for e in edges:
        e["busy_at"] = {k: busy_name[k] for k in (e["u"], e["v"]) if k in busy_name}
    return edges, home_key


class Planner:
    def __init__(self, edges, home, ftpm, door_min, cross_min, budget, hpc=2):
        self.E, self.home = edges, home
        self.ftpm, self.door, self.cross, self.budget, self.hpc = ftpm, door_min, cross_min, budget, hpc
        self.adj = {}
        for e in edges:
            self.adj.setdefault(e["u"], []).append(e)
            self.adj.setdefault(e["v"], []).append(e)
        self._sp = {}

    def walk(self, e):
        return e["len"] / self.ftpm

    def houses(self, e):
        return e["left"] + e["right"]

    def zig(self, e):
        h = self.houses(e)
        return self.walk(e) + h * self.door + math.ceil(h / self.hpc) * self.cross

    def sp(self, s):
        """Shortest walking minutes and predecessor edges from node s over all pocket edges."""
        if s in self._sp:
            return self._sp[s]
        dist, prev, pq = {s: 0.0}, {}, [(0.0, s)]
        while pq:
            d, n = heapq.heappop(pq)
            if d > dist.get(n, 1e18):
                continue
            for e in self.adj.get(n, []):
                m = e["v"] if e["u"] == n else e["u"]
                nd = d + self.walk(e)
                if nd < dist.get(m, 1e18):
                    dist[m], prev[m] = nd, e
                    heapq.heappush(pq, (nd, m))
        self._sp[s] = (dist, prev)
        return self._sp[s]

    def path(self, a, b):
        dist, prev = self.sp(a)
        out, n = [], b
        while n != a:
            e = prev[n]
            out.append(e)
            n = e["v"] if e["u"] == n else e["u"]
        return out[::-1]

    def components(self, W):
        nodes = {self.home}
        for e in W:
            nodes |= {e["u"], e["v"]}
        parent = {n: n for n in nodes}

        def f(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for e in W:
            parent[f(e["u"])] = f(e["v"])
        groups = {}
        for n in nodes:
            groups.setdefault(f(n), set()).add(n)
        return list(groups.values())

    def evaluate(self, W):
        """(minutes, deadhead edges list) for working edge set W as a closed walk from home."""
        W = list(W)
        cost = sum(self.zig(e) for e in W)
        dead = []
        # 1. connect components to home's (Prim over shortest walks); each link walked both ways
        comps = self.components(W)
        homec = next(c for c in comps if self.home in c)
        joined, rest = set(homec), [c for c in comps if c is not homec]
        while rest:
            best = None
            for ci, c in enumerate(rest):
                for a in joined:
                    dist, _ = self.sp(a)
                    for b in c:
                        d = dist.get(b)
                        if d is not None and (best is None or d < best[0]):
                            best = (d, ci, a, b)
            if best is None:
                return 1e18, []
            d, ci, a, b = best
            p = self.path(a, b)
            dead += p + p
            cost += 2 * d
            joined |= rest.pop(ci)
        # 2. pair odd-degree nodes (degrees from worked + connector edges)
        deg = {}
        for e in W + dead:
            deg[e["u"]] = deg.get(e["u"], 0) + 1
            deg[e["v"]] = deg.get(e["v"], 0) + 1
        odd = [n for n, d in deg.items() if d % 2]
        pairs = self.match(odd)
        for a, b in pairs:
            p = self.path(a, b)
            dead += p
            cost += self.sp(a)[0][b]
        # 3. a worked street walked again can be done one side each way: no zigzag crossings
        Wids = {e["id"] for e in W}
        reused = {e["id"] for e in dead if e["id"] in Wids}
        for e in W:
            if e["id"] in reused:
                h = self.houses(e)
                cost -= (math.ceil(h / self.hpc) - 1) * self.cross if h else 0
        return cost, dead

    def match(self, odd):
        if not odd:
            return []
        D = {a: self.sp(a)[0] for a in odd}
        if len(odd) <= 14:
            n = len(odd)
            memo = {}

            def solve(mask):
                if mask == (1 << n) - 1:
                    return 0.0, []
                if mask in memo:
                    return memo[mask]
                i = next(j for j in range(n) if not mask >> j & 1)
                best = (1e18, [])
                for j in range(i + 1, n):
                    if not mask >> j & 1:
                        c, ps = solve(mask | 1 << i | 1 << j)
                        c += D[odd[i]].get(odd[j], 1e9)
                        if c < best[0]:
                            best = (c, ps + [(odd[i], odd[j])])
                memo[mask] = best
                return best
            return solve(0)[1]
        # greedy for large sets, then pairwise improvement
        left, pairs = set(odd), []
        while left:
            a = left.pop()
            b = min(left, key=lambda x: D[a].get(x, 1e9))
            left.remove(b)
            pairs.append((a, b))
        improved = True
        while improved:
            improved = False
            for i, j in itertools.combinations(range(len(pairs)), 2):
                (a, b), (c, d) = pairs[i], pairs[j]
                now = D[a].get(b, 1e9) + D[c].get(d, 1e9)
                for x, y in (((a, c), (b, d)), ((a, d), (b, c))):
                    alt = D[x[0]].get(x[1], 1e9) + D[y[0]].get(y[1], 1e9)
                    if alt + 1e-9 < now:
                        pairs[i], pairs[j], now, improved = x, y, alt, True
        return pairs

    def optimize(self):
        W = {e["id"]: e for e in self.E}
        cost, _ = self.evaluate(W.values())
        while cost > self.budget and W:
            best = None
            for eid, e in W.items():
                rest = [x for k, x in W.items() if k != eid]
                c, _ = self.evaluate(rest)
                saved = cost - c
                if saved <= 0:
                    continue
                lost = self.houses(e)
                score = lost / saved
                if best is None or score < best[0]:
                    best = (score, eid, c)
            if best is None:
                break
            _, eid, cost = best
            del W[eid]
        # add back what fits, most houses per extra minute first
        while True:
            best = None
            for e in self.E:
                if e["id"] in W or not self.houses(e):
                    continue
                c, _ = self.evaluate(list(W.values()) + [e])
                if c <= self.budget:
                    gain = self.houses(e) / max(c - cost, 0.1)
                    if best is None or gain > best[0]:
                        best = (gain, e, c)
            if best is None:
                break
            _, e, cost = best
            W[e["id"]] = e
        return list(W.values()), cost

    def tour(self, W):
        """Ordered closed walk from home: [(edge, from_node, kind)] with kind work/back/walk."""
        _, dead = self.evaluate(W)
        multi = [(e, "work") for e in W] + [(e, "dead") for e in dead]
        inc = {}
        for idx, (e, _) in enumerate(multi):
            inc.setdefault(e["u"], []).append(idx)
            inc.setdefault(e["v"], []).append(idx)
        used = [False] * len(multi)

        # Prefer working before walking on the way out, so houses come first.
        def pick(n):
            opts = [i for i in inc.get(n, []) if not used[i]]
            opts.sort(key=lambda i: (multi[i][1] != "work", -self.houses(multi[i][0])))
            return opts
        stack, circuit = [(self.home, None)], []
        while stack:
            n, via = stack[-1]
            opts = pick(n)
            if opts:
                i = opts[0]
                used[i] = True
                e = multi[i][0]
                m = e["v"] if e["u"] == n else e["u"]
                stack.append((m, (i, n)))
            else:
                stack.pop()
                if via:
                    circuit.append(via)
        circuit.reverse()
        # Assign houses: a street walked once is zigzagged; walked twice, one side each way.
        times = {}
        for i, n in circuit:
            times.setdefault(multi[i][0]["id"], []).append((i, n))
        Wids = {e["id"] for e in W}
        steps = []
        seen = {}
        for i, n in circuit:
            e = multi[i][0]
            fwd = (n == e["u"])
            k = seen.get(e["id"], 0)
            seen[e["id"]] = k + 1
            if e["id"] not in Wids:
                mode, houses = "walk", (0, 0)
            elif len(times[e["id"]]) == 1:
                mode, houses = "zigzag", (e["left"], e["right"])
            elif k == 0:
                mode = "side1"  # one side on the way out (the walker's right: no crossing to start)
                houses = (0, e["right"]) if fwd else (e["left"], 0)
            elif k == 1:
                mode = "side2"  # the other side on the way back
                houses = (0, e["right"]) if fwd else (e["left"], 0)
            else:
                mode, houses = "walk", (0, 0)
            g = e["g"] if fwd else e["g"][::-1]
            # houses on the walker's left/right in this direction
            hl, hr = (houses if fwd else (houses[1], houses[0]))
            m = e["v"] if fwd else e["u"]
            cross = sorted({x["name"] for x in self.adj.get(m, []) if x["name"] != e["name"]})
            if m == self.home:
                to = "home"
            elif m in e.get("busy_at", {}):
                to = e["busy_at"][m].replace(" Road", " Rd") + " (stop before it)"
            elif cross:
                to = cross[0].replace(" Avenue", " Ave").replace(" Road", " Rd").replace(" Lane", " Ln")
            elif len(self.adj.get(m, [])) == 1:
                to = "the dead end"
            else:
                to = None
            steps.append({"name": e["name"], "mode": mode, "g": g, "len": e["len"], "left": hl, "right": hr, "to": to})
        return steps


def to_segments(steps):
    """Merge steps into plan_route segments: same street and mode merge; tiny no-house links fold in."""
    for st in steps:  # a worked piece with no houses is just walking
        if st["mode"] in ("zigzag", "side1", "side2") and not (st["left"] or st["right"]):
            st["mode"] = "walk"
    segs = []
    for s in steps:
        nm = s["name"].replace(" Avenue", " Ave").replace(" Road", " Rd").replace(" Lane", " Ln").replace(" Street", " St")
        tiny = s["mode"] == "walk" and s["len"] < 150
        if segs and (tiny or (segs[-1]["_street"] == nm and segs[-1]["_mode"] == s["mode"])):
            t = segs[-1]
            t["points"] += s["g"][1:]
            t["length_ft"] += round(s["len"])
            t["houses_left"] += s["left"]
            t["houses_right"] += s["right"]
            if s.get("to"):
                t["_to"] = s["to"]
            continue
        segs.append({"_street": nm, "_mode": s["mode"], "_to": s.get("to"), "name": nm, "points": [list(p) for p in s["g"]],
                     "length_ft": round(s["len"]), "houses_left": s["left"], "houses_right": s["right"],
                     "kind": "through", "exit": "far", "width": "normal", "traffic": "quiet"})
    labels = {"side1": ("one_side", "right side now, the other side on the way back", "you'll walk back this way"),
              "side2": ("one_side", "back along the other side", "done one side on the way out")}
    for t in segs:
        m = t.pop("_mode")
        t.pop("_street")
        to = t.pop("_to", None)
        if to == "home":
            t["name"] += " back home"
        elif to:
            t["name"] += " to " + to
        if m == "zigzag":
            t["pattern"], t["why"] = "zigzag", "one pass covers both sides"
        elif m in labels:
            t["pattern"], t["label"], t["why"] = labels[m]
        else:
            t["pattern"], t["why"] = "walk_through", "connects to the next street"
            t["houses_left"] = t["houses_right"] = 0
    return segs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("osm")
    ap.add_argument("streets")
    ap.add_argument("--home", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--age", type=int, required=True, help="youngest walker")
    ap.add_argument("--pace-mph", type=float)
    ap.add_argument("--door-seconds", type=float, default=60)
    ap.add_argument("--cross-seconds", type=float, default=20)
    ap.add_argument("--buffer", type=float, default=10)
    ap.add_argument("--frontage", type=float, default=55)
    ap.add_argument("--exclude", default="", help="comma-separated street names to leave out")
    ap.add_argument("--out")
    a = ap.parse_args()
    home = [float(x) for x in a.home.split(",")]
    osm = json.load(open(a.osm))
    st = json.load(open(a.streets))
    if a.exclude:
        drop = {x.strip() for x in a.exclude.split(",")}
        st["pocket"] = [r for r in st["pocket"] if r["name"] not in drop]
    mph = a.pace_mph or pace_for_age(a.age)
    s, e = parse_clock(a.start), parse_clock(a.end)
    if e <= s:
        e += timedelta(days=1)
    budget = (e - s).total_seconds() / 60 - a.buffer
    edges, home_key = build_graph(osm, st, home, a.frontage)
    P = Planner(edges, home_key, mph * 5280 / 60, a.door_seconds / 60, a.cross_seconds / 60, budget)
    W, cost = P.optimize()
    steps = P.tour(W)
    segs = to_segments(steps)
    total_h = sum(P.houses(x) for x in W)
    all_h = sum(P.houses(x) for x in edges)
    skipped = {}
    Wids = {x["id"] for x in W}
    for x in edges:
        if x["id"] not in Wids and P.houses(x):
            skipped[x["name"]] = skipped.get(x["name"], 0) + P.houses(x)
    res = {"segments": segs,
           "estimate": {"minutes": round(cost), "budget": round(budget), "houses": total_h,
                        "houses_in_pocket": all_h, "edges_worked": len(W), "edges_total": len(edges)},
           "skipped": skipped}
    if a.out:
        json.dump(res, open(a.out, "w"))
    print(json.dumps(res["estimate"]))
    print("skipped (houses):", skipped)
    for t in segs:
        print(f'  {t["name"]:16} {t["pattern"]:12} {t["length_ft"]:5} ft  {t["houses_left"]}/{t["houses_right"]}  {t.get("label", "")}')


if __name__ == "__main__":
    main()
