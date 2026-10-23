#!/usr/bin/env python3
"""Run the reference Python on the Springwood test fixture and print what it plans.

The expected numbers in src/route/*.test.ts come from this script.

Usage (from the repo root):
    python3 reference/run_fixture.py            # the reference exactly as written
    python3 reference/run_fixture.py --gap-is-real

The reference joins streets whose ends come within 50 ft. On Springwood that jumps the 40 ft
yard in Spruce St and pulls in Lakeview Dr, which no walk can reach, and the optimizer gives up
(cost 1e18, a six-hour route that fails its own route check). --gap-is-real drops the streets
past the yard, which is what the TypeScript port does by joining streets only at shared points.
"""
import copy
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import optimize_route as orr  # noqa: E402
import osm_import as oi  # noqa: E402
import plan_route as pr  # noqa: E402

FIXTURE = os.path.join(HERE, "..", "src", "route", "__fixtures__", "springwood.overpass.json")
FT = 364_000
ORIGIN = (41.8, -82.1)
KX = FT * math.cos(math.radians(ORIGIN[0]))
HOME = [ORIGIN[0] + 30 / FT, ORIGIN[1] - 100 / KX]  # 1428 Elm St (placeholder)

RUNS = [  # start, end, youngest age, door seconds, streets left out
    ("5:00pm", "6:00pm", 6, 60, []),
    ("5:00pm", "8:00pm", 10, 60, []),
    ("5:00pm", "6:00pm", 10, 30, []),
    ("5:00pm", "5:45pm", 4, 60, ["Maple Ave"]),
]


def compact(overpass):
    """The in-browser snippet from street-lookup.md, in Python."""
    r5 = lambda x: round(x * 1e5) / 1e5  # noqa: E731
    out = {"streets": [], "areas": [], "sidewalks": []}
    for e in overpass["elements"]:
        t = e.get("tags", {})
        g = [[r5(p["lat"]), r5(p["lon"])] for p in e.get("geometry", [])]
        if t.get("footway") == "sidewalk":
            out["sidewalks"].append(g)
        elif t.get("highway"):
            out["streets"].append({"name": t.get("name"), "hw": t["highway"], "ms": t.get("maxspeed", ""),
                                   "ln": t.get("lanes", ""), "g": g})
        else:
            out["areas"].append({"n": t.get("name", ""), "k": t.get("leisure") or t.get("amenity") or t.get("landuse"),
                                 "g": g})
    return out


def main():
    osm = compact(json.load(open(FIXTURE)))
    if "--gap-is-real" in sys.argv:
        south_of_yard = ORIGIN[0] - 320 / FT
        osm["streets"] = [s for s in osm["streets"] if s["name"] != "Lakeview Dr"
                          and not (s["name"] == "Spruce St" and s["g"][0][0] < south_of_yard)]
    st = oi.run(copy.deepcopy(osm), HOME, 55)
    print("home street:", st["home_street"], "| busy:", st["busy_names"], "| outside:", st["outside"])
    for r in st["pocket"]:
        print(f'  {r["name"]:12} {r["length_ft"]:5} ft  houses {r["houses_left"]}/{r["houses_right"]}  '
              f'sidewalk {r["sidewalk_share"]}  {r["distance_ft"]} ft away')
    for start, end, age, door, excl in RUNS:
        s2 = copy.deepcopy(st)
        s2["pocket"] = [r for r in s2["pocket"] if r["name"] not in excl]
        edges, home_key = orr.build_graph(copy.deepcopy(osm), s2, HOME, 55)
        budget = (pr.parse_clock(end) - pr.parse_clock(start)).total_seconds() / 60 - 10
        P = orr.Planner(edges, home_key, pr.pace_for_age(age) * 5280 / 60, door / 60, 20 / 60, budget)
        W, cost = P.optimize()
        segs = orr.to_segments(P.tour(W))
        out, _, _, _ = pr.plan({"youngest_age": age, "door_seconds": door, "start_time": start, "end_time": end,
                                "start": {"lat": HOME[0], "lng": HOME[1]}, "segments": segs,
                                "context_streets": st["context_streets"], "busy_roads": st["busy_roads"]})
        print(f"\n{start}-{end}, age {age}, {door}s a door, without {excl or 'nothing'}: "
              f"{sum(P.houses(e) for e in W)} houses, {cost:.1f} of {budget:.0f} min, head home {out['head_home']}")
        for row in out["schedule"]:
            print(f'  {row["time"]:>5}  {row["street"]:42} {row["pattern"]:48} {row["houses"]:3} houses {row["minutes"]:3} min')
        print("  totals:", out["totals"])
        print("  route check:", out["route_check"] or "passes")


if __name__ == "__main__":
    main()
