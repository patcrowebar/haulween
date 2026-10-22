#!/usr/bin/env python3
"""Turn OpenStreetMap data around home into Jack's street list, map layers and house estimates.

Usage:
    python osm_import.py osm.json --home LAT,LNG [--frontage 55] [--out streets.json]

Input: the compact JSON produced by the in-browser snippet in references/street-lookup.md:
  {"streets":   [{"name", "hw", "ms", "ln", "g": [[lat,lng],...]}],   named roads
   "areas":     [{"n", "k", "g": [[lat,lng],...]}],                   parks, pitches, schools, churches, grass
   "sidewalks": [[[lat,lng],...], ...]}                               footway=sidewalk lines (optional)

What it works out:
  busy      roads that are primary/secondary/trunk, 3+ lanes, or posted 35 mph+. Never walked along.
  pocket    the residential streets reachable from home without stepping onto a busy road
            (flood fill over street pieces that touch within ~15 m; a busy road blocks the fill).
  houses    per side of each pocket street: length that isn't park/school/church/field and isn't
            a corner, divided by lot frontage. Still an estimate, but from real geometry.
  sidewalk  share of each street with a mapped sidewalk within 20 m (OSM coverage is partial,
            so "no mapped sidewalk" means unknown, not none).

Output (JSON): home_street, pocket[] (name, length_ft, houses_left, houses_right, sidewalk_share,
pieces), outside[] (named residential streets across a busy road), and ready-made map layers for
plan_route.py: busy_roads, areas, context_streets.
"""
import argparse
import json
import math
import sys

FT_PER_DEG = 364_000
SNAP_FT = 50          # street pieces whose ends are this close count as connected
CORNER_FT = 45        # no house frontage this close to a cross street
OFFSET_FT = 55        # where a lot sits, measured from the street centerline
STEP_FT = 15


class Geo:
    def __init__(self, home):
        self.h = home
        self.kx = FT_PER_DEG * math.cos(math.radians(home[0]))

    def xy(self, p):
        return ((p[1] - self.h[1]) * self.kx, (p[0] - self.h[0]) * FT_PER_DEG)

    def ll(self, x, y):
        return [self.h[0] + y / FT_PER_DEG, self.h[1] + x / self.kx]


def length(g, geo):
    pts = [geo.xy(p) for p in g]
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def seg_dist(P, line):
    best = float("inf")
    for A, B in zip(line, line[1:]):
        dx, dy = B[0] - A[0], B[1] - A[1]
        l2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2))
        best = min(best, math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy))
    return best


def inside(P, poly):
    x, y, hit = P[0], P[1], False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def is_busy(s):
    hw = s.get("hw", "")
    if hw in ("primary", "secondary", "trunk", "motorway", "primary_link", "secondary_link", "trunk_link"):
        return True
    try:
        if int(str(s.get("ln") or 0)) >= 3:
            return True
    except ValueError:
        pass
    ms = str(s.get("ms") or "")
    digits = "".join(c for c in ms if c.isdigit())
    if digits and int(digits) >= 35:
        return True
    return False


def walk_points(line, step):
    """Points every `step` ft along a polyline (in ft space), with the local direction."""
    out = []
    for A, B in zip(line, line[1:]):
        d = math.dist(A, B)
        if d == 0:
            continue
        ux, uy = (B[0] - A[0]) / d, (B[1] - A[1]) / d
        n = max(1, int(d // step))
        for i in range(n):
            t = i * step
            out.append(((A[0] + ux * t, A[1] + uy * t), (ux, uy)))
    return out


def run(data, home, frontage):
    geo = Geo(home)
    streets = [s for s in data["streets"] if s.get("g") and len(s["g"]) >= 2]
    for s in streets:
        s["xy"] = [geo.xy(p) for p in s["g"]]
        s["busy"] = is_busy(s)
    busy = [s for s in streets if s["busy"]]
    res = [s for s in streets if not s["busy"]]
    areas = data.get("areas", [])
    blockers = [[geo.xy(p) for p in a["g"]] for a in areas
                if a.get("k") in ("park", "pitch", "playground", "school", "place_of_worship", "grass",
                                  "recreation_ground", "cemetery", "commercial", "retail")
                and len(a["g"]) >= 4]
    sidewalks = [[geo.xy(p) for p in w] for w in data.get("sidewalks", [])]

    # Home street: nearest residential piece.
    start = min(range(len(res)), key=lambda i: seg_dist((0, 0), res[i]["xy"]))

    # Flood fill over residential pieces; a connection doesn't count if the meeting point is on a busy road
    # (that would mean crossing it). Pieces touching only via a busy road stay outside.
    def ends(s):
        return [s["xy"][0], s["xy"][-1]] + s["xy"][1:-1]

    def on_busy(P):
        return any(seg_dist(P, b["xy"]) < 25 for b in busy)

    seen, stack = {start}, [start]
    while stack:
        i = stack.pop()
        for j, t in enumerate(res):
            if j in seen:
                continue
            # touch: any vertex of one within SNAP of the other's line, at a point not on a busy road
            touch = None
            for P in ends(res[i]):
                if seg_dist(P, t["xy"]) < SNAP_FT:
                    touch = P
                    break
            if touch is None:
                for P in ends(t):
                    if seg_dist(P, res[i]["xy"]) < SNAP_FT:
                        touch = P
                        break
            if touch is not None and not on_busy(touch):
                seen.add(j)
                stack.append(j)

    by_name = {}
    for i in sorted(seen):
        by_name.setdefault(res[i]["name"], []).append(res[i])

    def side_houses(s):
        """Usable frontage (ft) on each side of one piece."""
        others = [o["xy"] for o in streets if o is not s and o["name"] != s["name"]]
        left = right = 0.0
        for P, (ux, uy) in walk_points(s["xy"], STEP_FT):
            if any(seg_dist(P, o) < CORNER_FT for o in others):
                continue  # corner or crossing: no lot fronts here
            for sign in (1, -1):  # left = +normal (dx,dy rotated +90)
                Q = (P[0] - uy * OFFSET_FT * sign, P[1] + ux * OFFSET_FT * sign)
                if any(inside(Q, b) for b in blockers):
                    continue
                if any(seg_dist(Q, b["xy"]) < 30 for b in busy):
                    continue
                if sign == 1:
                    left += STEP_FT
                else:
                    right += STEP_FT
        return left, right

    pocket = []
    for name, pcs in by_name.items():
        L = sum(length(p["g"], geo) for p in pcs)
        left = right = 0.0
        sw_pts = sw_hit = 0
        for p in pcs:
            l, r = side_houses(p)
            left += l
            right += r
            for P, _ in walk_points(p["xy"], 40):
                sw_pts += 1
                if any(seg_dist(P, w) < 20 for w in sidewalks):
                    sw_hit += 1
        pocket.append({
            "name": name,
            "length_ft": round(L),
            "houses_left": round(left / frontage),
            "houses_right": round(right / frontage),
            "sidewalk_share": round(sw_hit / sw_pts, 2) if (sidewalks and sw_pts) else None,
            "touches_busy": sorted({b["name"] for b in busy for p in pcs
                                    if min(seg_dist(P, b["xy"]) for P in (p["xy"][0], p["xy"][-1])) < 40}),
            "distance_ft": round(min(math.dist((0, 0), P) for p in pcs for P in p["xy"])),
            "pieces": [p["g"] for p in pcs],
        })
    pocket.sort(key=lambda r: r["distance_ft"])

    pocket_names = set(by_name)
    outside = sorted({s["name"] for s in res} - pocket_names)

    # Map layers for plan_route.py (busy roads as separate pieces keep their true shape).
    busy_layer = [{"name": b["name"].replace("Avenue", "Ave").replace("Road", "Rd"), "points": b["g"]} for b in busy]
    area_layer = [{"name": a.get("n") or "", "points": a["g"]} for a in areas
                  if a.get("k") in ("park", "school", "pitch", "playground") and len(a["g"]) >= 4]
    context = [{"name": s["name"].replace("Avenue", "Ave").replace("Road", "Rd").replace("Lane", "Ln"),
                "points": s["g"], "label": False} for s in res]
    # Label each street once, on its longest piece.
    longest = {}
    for c, s in zip(context, res):
        Ls = length(s["g"], geo)
        if Ls > longest.get(c["name"], (0, None))[0]:
            longest[c["name"]] = (Ls, c)
    for _, c in longest.values():
        c["label"] = True

    return {
        "home_street": res[start]["name"],
        "busy_names": sorted({b["name"] for b in busy}),
        "pocket": pocket,
        "outside": outside,
        "busy_roads": busy_layer,
        "areas": area_layer,
        "context_streets": context,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("osm")
    ap.add_argument("--home", required=True, help="lat,lng")
    ap.add_argument("--frontage", type=float, default=55)
    ap.add_argument("--out")
    a = ap.parse_args()
    home = [float(x) for x in a.home.split(",")]
    data = json.load(open(a.osm))
    out = run(data, home, a.frontage)
    js = json.dumps(out)
    if a.out:
        open(a.out, "w").write(js)
    # Print a readable summary; full layers go to --out.
    print(json.dumps({k: out[k] for k in ("home_street", "busy_names", "outside")}, indent=1))
    for r in out["pocket"]:
        print(f'{r["name"]:20} {r["length_ft"]:5} ft  houses L/R ~{r["houses_left"]}/{r["houses_right"]}  '
              f'sidewalk {r["sidewalk_share"]}  {r["distance_ft"]} ft away  touches {r["touches_busy"]}')


if __name__ == "__main__":
    sys.exit(main())
