#!/usr/bin/env python3
"""Jack's route math: pace, per-street pattern, schedule, totals, Maps link, map.

Usage:
    python plan_route.py plan.json            # prints the plan as JSON
    python plan_route.py plan.json --map out.html   # also writes the map fragment

Claude does the judgment work (which streets, in what order, house counts,
width/traffic/sidewalks). This script does the arithmetic so the clock adds up.
See the input schema in SKILL.md ("Step 4").
"""
import json
import math
import sys
import urllib.parse
from datetime import datetime, timedelta

# Youngest walker -> walking pace in mph, between doors (not counting door stops).
# Deliberately slow: costumes, dark, excitement, stopping to compare candy.
PACE_BY_AGE = [
    (3, 1.2),   # 3 and under (walking, not riding)
    (5, 1.5),   # 4-5
    (8, 2.0),   # 6-8
    (12, 2.5),  # 9-12
    (99, 3.0),  # 13+
]
FT_PER_MILE = 5280


def pace_for_age(age):
    for max_age, mph in PACE_BY_AGE:
        if age <= max_age:
            return mph
    return 3.0


def parse_clock(s):
    """Accepts '17:00', '5:00pm', '5pm', '5:30 PM'."""
    s = s.strip().upper().replace(" ", "").replace(".", "")
    for fmt in ("%H:%M", "%I:%M%p", "%I%p"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    raise ValueError(f"Can't read time '{s}'. Use 17:00 or 5:00pm.")


def fmt_clock(dt):
    return dt.strftime("%-I:%M")


def choose_pattern(seg, ctx):
    """Return (pattern, reason). Patterns: zigzag, down_back, one_side."""
    left, right = seg.get("houses_left", 0), seg.get("houses_right", 0)
    total = left + right
    kind = seg.get("kind", "through")
    forced = seg.get("pattern") or ctx["force_pattern"]

    few, many = min(left, right), max(left, right)
    lopsided = few <= 2 or (many > 0 and few / many < 0.25)

    if seg.get("pattern"):  # set per street (by the user, or by optimize_route.py)
        return seg["pattern"], seg.get("why", "")
    if forced and forced != "no_zigzag":
        return forced, "your call"
    if lopsided and total > 0:
        return "one_side", "the other side has few or no houses"
    if kind in ("dead_end", "cul_de_sac"):
        return "down_back", "dead end, you walk back out anyway"
    if seg.get("traffic") in ("moderate", "busy") or seg.get("width") == "wide":
        return "down_back", "wider or busier street, cross once"
    if forced == "no_zigzag":
        return "down_back", "no zigzag tonight"
    if ctx["little_ones"] and not ctx["allow_zigzag_with_little"]:
        return "down_back", "little ones along, fewer crossings"

    # Quiet, narrow-ish through street: compare the clock.
    exit_far = seg.get("exit", "far") == "far"
    L = seg["length_ft"]
    speed = ctx["ft_per_min"]
    crossings = math.ceil(total / ctx["houses_per_crossing"])
    zig = L / speed + crossings * ctx["cross_min"]
    if exit_far:
        # Down-and-back leaves you at the near end; you walk the street a third time to exit far.
        db = 3 * L / speed + 1 * ctx["cross_min"]
    else:
        # Zigzag leaves you at the far end; you walk back to exit near.
        zig += L / speed
        db = 2 * L / speed + 1 * ctx["cross_min"]
    if zig < db:
        return "zigzag", f"saves about {round(db - zig)} min over walking it twice"
    return "down_back", "crossing back and forth would cost more than walking it twice"


def segment_cost(seg, pattern, ctx):
    """Walk feet, door count, crossings, minutes for one street."""
    left, right = seg.get("houses_left", 0), seg.get("houses_right", 0)
    L = seg["length_ft"]
    exit_far = seg.get("exit", "far") == "far"
    kind = seg.get("kind", "through")
    if pattern == "walk_through":
        walk, doors, crossings = L, 0, 0
        walk += seg.get("approach_ft", 0)
        minutes = walk / ctx["ft_per_min"] + seg.get("major_crossings", 0) * ctx["major_cross_min"]
        return walk, doors, crossings, minutes
    if pattern == "zigzag":
        walk = L if exit_far else 2 * L
        doors = left + right
        crossings = math.ceil(doors / ctx["houses_per_crossing"])
    elif pattern == "one_side":
        side = "left" if left >= right else "right"
        doors = max(left, right)
        if kind in ("dead_end", "cul_de_sac") or not exit_far:
            walk, crossings = 2 * L, 0
        else:
            walk, crossings = L, 0
        seg["_side"] = side
    else:  # down_back
        doors = left + right
        if kind in ("dead_end", "cul_de_sac"):
            walk, crossings = 2 * L, (0 if kind == "cul_de_sac" else 1)
        else:
            walk = 2 * L if not exit_far else 3 * L
            crossings = 1
    walk += seg.get("approach_ft", 0)
    minutes = walk / ctx["ft_per_min"] + doors * ctx["door_min"] + crossings * ctx["cross_min"] \
        + seg.get("major_crossings", 0) * ctx["major_cross_min"]
    return walk, doors, crossings, minutes


def pattern_label(seg, pattern):
    if seg.get("label"):
        return seg["label"]
    if pattern == "walk_through":
        return "walk through, skip the houses"
    if pattern == "zigzag":
        return "zigzag"
    if pattern == "one_side":
        return f"{seg.get('_side', 'left')} side only"
    first = seg.get("first_side", "left")
    other = "right" if first == "left" else "left"
    return f"down the {first}, back the {other}"


def maps_links(start, end, waypoints, max_wp=9, use_address=True):
    """Google Maps walking directions. Splits into legs if over the waypoint limit.
    use_address=False keeps the street address out (for links that go on a shareable page)."""
    def loc(p):
        if use_address and p.get("address"):
            return p["address"]
        return f"{p['lat']},{p['lng']}"
    stops = [start] + waypoints + [end]
    links, i = [], 0
    while i < len(stops) - 1:
        chunk = stops[i:i + max_wp + 2]
        q = {
            "api": "1",
            "origin": loc(chunk[0]),
            "destination": loc(chunk[-1]),
            "travelmode": "walking",
        }
        mids = chunk[1:-1]
        if mids:
            q["waypoints"] = "|".join(loc(m) for m in mids)
        links.append("https://www.google.com/maps/dir/?" + urllib.parse.urlencode(q, safe="|,"))
        i += len(chunk) - 1
    return links


def _point_at(pts, frac):
    """Point a given fraction of the way along a polyline (by length)."""
    if len(pts) == 1:
        return list(pts[0])
    legs = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    goal, acc = sum(legs) * frac, 0.0
    for i, d in enumerate(legs):
        if acc + d >= goal and d > 0:
            f = (goal - acc) / d
            return [pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), pts[i][1] + f * (pts[i + 1][1] - pts[i][1])]
        acc += d
    return list(pts[-1])


def _midpoint(pts):
    return _point_at(pts, 0.5)


def _spread(markers, home, min_deg=0.00025, home_deg=0.00045):
    """Nudge pins that land on Home or on each other (~25 m), so every number is readable."""
    taken = [[home["lat"], home["lng"]]]
    for k in markers:
        lat0, lng0 = k["lat"], k["lng"]
        # Try the original spot, then 8 positions on rings of growing radius around it.
        candidates = [(lat0, lng0)] + [
            (lat0 + r * min_deg * math.sin(a * math.pi / 4), lng0 + r * min_deg * 1.3 * math.cos(a * math.pi / 4))
            for r in (1.2, 2.4, 3.6) for a in range(8)
        ]
        for c in candidates:
            if math.dist(c, taken[0]) >= home_deg and all(math.dist(c, t) >= min_deg for t in taken[1:]):
                break
        k["lat"], k["lng"] = c
        taken.append(list(c))
    return markers


def route_geometry(start, end, segs):
    """Route polyline (out-and-back streets drawn both ways) and one pin per street, placed on the street.

    The walk from home to the first street, and back home at the end, follows the first street's own
    line when home sits on it, so the map doesn't draw straight lines across yards.
    """
    H = [start["lat"], start["lng"]]
    first = next((s["points"] for s in segs if s.get("points")), None)

    def along(poly, frm, to):
        """Vertices of poly walked from the point nearest frm to the point nearest to."""
        i = min(range(len(poly)), key=lambda j: math.dist(poly[j], frm))
        k = min(range(len(poly)), key=lambda j: math.dist(poly[j], to))
        return poly[i:k + 1] if i <= k else poly[k:i + 1][::-1]

    line = [H]
    if first and min(math.dist(H, q) for q in first) < 0.0004:
        line += along(first, H, first[0])[1:]
    markers, taken, home_deg, min_deg = [], [H], 0.00045, 0.00025
    for n, s in enumerate(segs, 1):
        pts = s.get("points") or []
        if not pts:
            continue
        line.extend(pts)
        if s["_pattern"] in ("down_back",) or (s["_pattern"] == "one_side" and s.get("exit", "far") == "same") \
                or s.get("kind") in ("dead_end", "cul_de_sac"):
            line.extend(list(reversed(pts))[1:])  # out and back
        spot = None
        for f in (0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9):
            c = _point_at(pts, f)
            if math.dist(c, H) >= home_deg and all(math.dist(c, t) >= min_deg for t in taken[1:]):
                spot = c
                break
        if spot is None:
            spot = _midpoint(pts)
            _spread_one = _spread([{"lat": spot[0], "lng": spot[1]}], {"lat": H[0], "lng": H[1]})[0]
            spot = [_spread_one["lat"], _spread_one["lng"]]
        taken.append(spot)
        markers.append({"n": n, "lat": round(spot[0], 6), "lng": round(spot[1], 6), "name": s["name"],
                        "time": s["_time"], "pattern": s["_label"]})
    E = [end["lat"], end["lng"]]
    last = line[-1]
    if first and E == H and min(math.dist(last, q) for q in first) < 0.0001:
        line += along(first, last, H)[1:]
    line.append(E)
    return line, markers


def map_fragment(start, end, segs, title, busy_roads=None, areas=None):
    """Leaflet map as an HTML fragment (no html/head/body), for an inline widget or artifact.

    busy_roads: [{"name": "Main St", "points": [[lat,lng],...]}] drawn dashed gray.
    areas: [{"name": "the park", "points": [[lat,lng],...]}] drawn as green fills.
    These matter because many inline viewers block map tiles: without them the route
    floats on a blank background.
    """
    line, markers = route_geometry(start, end, segs)
    # Coordinates only: the street address never goes into a rendered page.
    data = json.dumps({"line": line, "markers": markers,
                       "start": {"lat": start["lat"], "lng": start["lng"]},
                       "end": {"lat": end["lat"], "lng": end["lng"]},
                       "busy": busy_roads or [], "areas": areas or [],
                       "one_way": end is not start and end.get("lat") != start.get("lat")})
    return f"""<h2 class="sr-only">{title}: walking route map with numbered streets and home marked.</h2>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
#jackmap{{height:420px;border-radius:12px;background:var(--surface-1,#f3f1ea);border:0.5px solid var(--border,#ddd)}}
#jackmap.leaflet-container{{background:var(--surface-1,#f3f1ea)}}
.jk-n{{background:#D85A30;color:#fff;border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font:500 13px system-ui}}
.jk-home{{background:#2C2C2A;color:#fff;border:2px solid #fff;border-radius:6px;padding:2px 6px;font:500 12px system-ui;white-space:nowrap}}
.jk-lbl{{font:11px system-ui;color:var(--text-secondary,#666);white-space:nowrap}}
.jk-cap{{font:13px system-ui;color:var(--text-secondary,#666);margin:8px 0 0}}
</style>
<div id="jackmap"></div>
<p class="jk-cap">Numbers are street order. Gray dashed lines are busy roads to stay off.</p>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function(){{
  var d={data};
  var m=L.map('jackmap',{{zoomControl:true,attributionControl:false}});
  L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png',{{maxZoom:19}}).addTo(m);
  function lbl(t,ll,ax){{L.marker(ll,{{icon:L.divIcon({{className:'',html:'<div class="jk-lbl">'+t+'</div>',iconAnchor:ax||[0,0]}})}}).addTo(m);}}
  d.areas.forEach(function(a){{var pg=L.polygon(a.points,{{color:'#639922',weight:1,fillColor:'#97C459',fillOpacity:.35}}).addTo(m);lbl(a.name,pg.getBounds().getCenter(),[30,6]);}});
  d.busy.forEach(function(b){{L.polyline(b.points,{{color:'#888780',weight:4,dashArray:'6 6'}}).addTo(m);lbl(b.name,b.points[Math.floor(b.points.length/2)]);}});
  var pl=L.polyline(d.line,{{color:'#D85A30',weight:5,opacity:.9}}).addTo(m);
  L.marker([d.start.lat,d.start.lng],{{icon:L.divIcon({{className:'',html:'<div class="jk-home">Home</div>',iconAnchor:[24,12]}})}}).addTo(m);
  if(d.one_way) L.marker([d.end.lat,d.end.lng],{{icon:L.divIcon({{className:'',html:'<div class="jk-home">Pickup</div>',iconAnchor:[24,12]}})}}).addTo(m);
  d.markers.forEach(function(k){{
    L.marker([k.lat,k.lng],{{icon:L.divIcon({{className:'',html:'<div class="jk-n">'+k.n+'</div>',iconAnchor:[13,13]}})}})
     .bindPopup(k.n+'. '+k.name+'<br>'+k.time+' · '+k.pattern).addTo(m);
  }});
  m.fitBounds(pl.getBounds(),{{padding:[30,30]}});
}})();
</script>"""


def check_route(p, segs, start, end):
    """Flag any stretch of the route that isn't on a known street, or that runs along a busy road.

    Needs street lines in the plan (context_streets and busy_roads, which osm_import.py provides).
    A straight line drawn across a gap in the data fails this check, which is the point: a gap
    in OpenStreetMap is usually a real gap (a dead end, a park, someone's yard), not missing data.
    """
    lines = [c["points"] for c in p.get("context_streets", [])]
    busy = [b["points"] for b in p.get("busy_roads", [])]
    if not lines:
        return ["no street lines in the plan, so the route couldn't be checked against real streets"]
    lat0 = start["lat"]
    k = math.cos(math.radians(lat0)) * 364_000

    def xy(pt):
        return ((pt[1] - start["lng"]) * k, (pt[0] - start["lat"]) * 364_000)

    L = [[xy(q) for q in ln] for ln in lines + busy]
    B = [[xy(q) for q in ln] for ln in busy]

    def dist(P, line):
        best = float("inf")
        for A, C in zip(line, line[1:]):
            dx, dy = C[0] - A[0], C[1] - A[1]
            l2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2))
            best = min(best, math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy))
        return best

    def samples(pts, step=30):
        xs = [xy(q) for q in pts]
        out = []
        for A, C in zip(xs, xs[1:]):
            d = math.dist(A, C)
            n = max(1, int(d // step))
            out += [(A[0] + (C[0] - A[0]) * i / n, A[1] + (C[1] - A[1]) * i / n) for i in range(n)]
        return out + xs[-1:]

    problems = []
    prev_end = None
    for s in segs:
        pts = s.get("points") or []
        if len(pts) < 2:
            continue
        ss = samples(pts)
        off = [P for P in ss if min(dist(P, ln) for ln in L) > 40]
        if off:
            problems.append(f"{s['name']}: about {len(off) * 30} ft of it is not on any street (gap in the data "
                            f"is probably a real gap: dead end, park or yard). Cut it from real street pieces.")
        inner = ss[3:-3]  # ignore corners, where crossing a busy road is the only contact
        along = [P for P in inner if any(dist(P, b) < 25 for b in B)]
        if len(along) >= 3:
            problems.append(f"{s['name']}: runs along a busy road for about {len(along) * 30} ft.")
        if prev_end is not None:
            gap = math.dist(xy(prev_end), xy(pts[0]))
            if gap > 150:
                mid = samples([prev_end, pts[0]], 40)
                if any(min(dist(P, ln) for ln in L) > 40 for P in mid):
                    problems.append(f"Getting to {s['name']}: jumps {round(gap)} ft from the previous street "
                                    f"with no street connecting them.")
        last = pts[0] if (s.get("exit") == "same" or s.get("kind") in ("dead_end", "cul_de_sac")) else pts[-1]
        prev_end = last
    return problems


def plan(p):
    youngest = p["youngest_age"]
    mph = p.get("pace_mph") or pace_for_age(youngest)
    if p.get("stroller"):
        mph = min(mph, 2.0)
    ctx = {
        "ft_per_min": mph * FT_PER_MILE / 60,
        "door_min": p.get("door_seconds", 60) / 60,
        "cross_min": p.get("cross_seconds", 20) / 60,
        "major_cross_min": p.get("major_cross_seconds", 90) / 60,
        "houses_per_crossing": p.get("houses_per_crossing", 2),
        "force_pattern": p.get("force_pattern"),
        "little_ones": youngest <= 5,
        "allow_zigzag_with_little": p.get("allow_zigzag_with_little", False),
    }
    start_dt = parse_clock(p["start_time"])
    end_dt = parse_clock(p["end_time"])
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    buffer_min = p.get("buffer_min", 10)
    start = p["start"]
    end = p.get("end") or start
    return_ft = p.get("return_ft", 0)
    return_min = return_ft / ctx["ft_per_min"] + p.get("return_major_crossings", 0) * ctx["major_cross_min"]

    segs = [dict(s) for s in p["segments"]]
    for s in segs:
        pat, why = choose_pattern(s, ctx)
        s["_pattern"], s["_why"] = pat, why
        s["_walk"], s["_doors"], s["_cross"], s["_min"] = segment_cost(s, pat, ctx)
        s["_label"] = pattern_label(s, pat)

    all_segs = list(segs)
    budget = (end_dt - start_dt).total_seconds() / 60 - buffer_min
    dropped = []

    def total_min(ss):
        return sum(x["_min"] for x in ss) + return_min

    walked_through = []

    def is_branch(x):
        # A branch comes back out where it went in, so cutting it leaves the loop intact.
        return x.get("kind") in ("dead_end", "cul_de_sac") or x.get("exit", "far") == "same"

    def pass_through(x):
        # The route still needs this street to get somewhere: walk it, skip the doors.
        L = x["length_ft"]
        x["_walk"] = L + x.get("approach_ft", 0)
        x["_doors"], x["_cross"] = 0, 0
        x["_min"] = x["_walk"] / ctx["ft_per_min"] + x.get("major_crossings", 0) * ctx["major_cross_min"]
        x["_pattern"], x["_label"], x["_why"] = "walk_through", "walk through, skip the houses", "needed to get to the next street"
        x["_passed"] = True

    # Trim optional streets, worst houses-per-minute first, until the plan fits.
    # Branches get cut; streets the route has to walk through stay as walk-throughs.
    while total_min(segs) > budget:
        opts = [x for x in segs if x.get("optional") and not x.get("_passed")]
        if not opts:
            break
        worst = min(opts, key=lambda x: x["_doors"] / max(x["_min"], 0.1))
        if is_branch(worst):
            segs.remove(worst)
            dropped.append(worst["name"])
        else:
            pass_through(worst)
            walked_through.append(worst["name"])

    # Refill: greedy trimming can overshoot, so put back any cut branch that now fits,
    # best houses-per-minute first, in its original place in the route.
    order = {id(s): i for i, s in enumerate(all_segs)}
    for s in sorted([x for x in all_segs if x["name"] in dropped],
                    key=lambda x: -x["_doors"] / max(x["_min"], 0.1)):
        if total_min(segs) + s["_min"] <= budget:
            segs.append(s)
            segs.sort(key=lambda x: order[id(x)])
            dropped.remove(s["name"])

    t = start_dt
    schedule = []
    for s in segs:
        s["_time"] = fmt_clock(t)
        row = {
            "time": fmt_clock(t), "t24": t.strftime("%H:%M"), "street": s["name"], "pattern": s["_label"], "why": s["_why"],
            "houses": s["_doors"], "minutes": round(s["_min"]), "optional": bool(s.get("optional")),
        }
        if s["_pattern"] == "down_back" and s.get("kind", "through") == "through" and s.get("exit", "far") == "far":
            row["fix"] = "walks this street 3 times; reorder so the route exits where it entered (exit: same)"
        schedule.append(row)
        t += timedelta(minutes=s["_min"])
    head_home = t
    home = t + timedelta(minutes=return_min)
    latest_head_home = end_dt - timedelta(minutes=return_min)

    walk_ft = sum(s["_walk"] for s in segs) + return_ft
    walk_min = walk_ft / ctx["ft_per_min"]
    doors = sum(s["_doors"] for s in segs)
    over = (home - end_dt).total_seconds() / 60

    # One waypoint per street: its far end / turnaround, which forces Google to walk that street.
    wps = []
    for s in segs:
        pt = s.get("waypoint") or (s.get("points") or [None])[-1]
        if pt:
            wps.append({"lat": pt[0], "lng": pt[1]})
    # de-dup consecutive identical points
    clean = []
    for w in wps:
        if not clean or (abs(clean[-1]["lat"] - w["lat"]) > 1e-5 or abs(clean[-1]["lng"] - w["lng"]) > 1e-5):
            clean.append(w)

    out = {
        "pace": {"mph": mph, "door_seconds": p.get("door_seconds", 60),
                 "basis": f"youngest walker age {youngest}" + (" + stroller/wagon" if p.get("stroller") else "")},
        "schedule": schedule,
        "head_home": fmt_clock(head_home),
        "latest_head_home": fmt_clock(latest_head_home),
        "home_by": fmt_clock(home),
        "window_end": fmt_clock(end_dt),
        "minutes_over_window": round(over) if over > 0 else 0,
        "minutes_spare": round(-over) if over < 0 else 0,
        "dropped_optional": dropped,
        "walked_through": walked_through,
        "route_check": check_route(p, segs, start, end),
        "totals": {
            "distance_miles": round(walk_ft / FT_PER_MILE, 2),
            "houses_estimate": doors,
            "walking_minutes": round(walk_min),
            "door_minutes": round(doors * ctx["door_min"]),
            "total_minutes": round((home - start_dt).total_seconds() / 60),
            "street_crossings": sum(s["_cross"] for s in segs),
            "major_road_crossings": sum(s.get("major_crossings", 0) for s in segs) + p.get("return_major_crossings", 0),
        },
        "maps_links": maps_links(start, end, clean),
        "_page": {
            "links": maps_links(start, end, clean, use_address=False),
            "start24": start_dt.strftime("%H:%M"), "end24": end_dt.strftime("%H:%M"),
            "head_home24": head_home.strftime("%H:%M"), "latest24": latest_head_home.strftime("%H:%M"),
            "end_next_day": end_dt.date() != start_dt.date(),
        },
    }
    return out, segs, start, end


def build_page(p, out, segs, start, end):
    """The shareable route page: assets/route_page.html with this plan's data filled in.

    Plan fields the page also uses (all optional):
      date            "2026-10-31" (default Oct 31 this year)
      night           ["Sunset 5:59 pm, dark by 6:27. Bring flashlights.", ...]
      notes           ["Pace 2.5 mph plus a minute a door (set by the 10-year-old). ...", ...]
      context_streets [{"name": "Ash St", "points": [[lat,lng],[lat,lng]]}, ...]  gray streets around the route
      basemap         {"bounds": {"n","s","w","e"}, "light": "data:image/jpeg;base64,..."}  real map image underneath
                      (stitched OpenStreetMap tiles; see references/street-lookup.md). Dimmed in dark mode.
    No street address goes into the page: home and the Google Maps link use coordinates.
    """
    import hashlib
    import html as htmlmod
    import os
    pg = out["_page"]
    # Snap home onto the street the route starts on, so the line doesn't jog across a front yard.
    first = next((x["points"] for x in segs if x.get("points")), None)
    if first:
        k = math.cos(math.radians(start["lat"]))
        best = None
        for a, b in zip(first, first[1:]):
            ax, ay, bx, by = a[1] * k, a[0], b[1] * k, b[0]
            px, py = start["lng"] * k, start["lat"]
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1e-12)))
            q = [ay + t * dy, (ax + t * dx) / k]
            d = math.dist([start["lat"], start["lng"] * k], [q[0], q[1] * k])
            if best is None or d < best[0]:
                best = (d, q)
        if best and best[0] < 0.0006:  # within ~60 m: it's this street
            start = {"lat": best[1][0], "lng": best[1][1]}
    if not p.get("end"):
        end = start  # a loop ends where it starts
    line, pins = route_geometry(start, end, segs)
    streets, seen = [], set()
    for s in segs:  # route streets get a gray base and a name label under the orange line
        name = s["name"].split(" (")[0]
        if s.get("points") and len(s["points"]) >= 2 and name not in seen:
            streets.append({"name": name, "points": s["points"]})
            seen.add(name)
    for c in p.get("context_streets", []):
        if c["name"] not in seen and len(c.get("points", [])) >= 2:
            streets.append({"name": c["name"], "points": c["points"]})
            seen.add(c["name"])
    one_way = bool(p.get("end"))
    if not one_way:
        end = start
    date = p.get("date") or f"{datetime.now().year}-10-31"
    title = p.get("title", "Halloween Route")

    def label(hm):
        d = parse_clock(hm)
        return d.strftime("%-I:%M") + (" pm" if d.hour >= 12 else " am")

    data = {
        "key": hashlib.sha1((title + date).encode()).hexdigest()[:10],
        "title": title, "date": date,
        "startLabel": label(p["start_time"]), "endLabel": label(p["end_time"]),
        "start24": pg["start24"], "end24": pg["end24"], "endNextDay": pg["end_next_day"],
        "head_home": out["head_home"], "head_home24": pg["head_home24"],
        "latest_head_home": out["latest_head_home"], "latest24": pg["latest24"],
        "home_by": out["home_by"],
        "rows": [dict(r, n=i, passed=r["pattern"].startswith("walk through"))
                 for i, r in enumerate(out["schedule"], 1)],
        "totals": out["totals"],
        "links": pg["links"],
        "night": p.get("night", []),
        "notes": p.get("notes", []),
        "map": {
            "home": [start["lat"], start["lng"]],
            "end": [end["lat"], end["lng"]] if one_way else None,
            "route": line[1:],
            "pins": [{"n": k["n"], "lat": k["lat"], "lng": k["lng"]} for k in pins],
            "busy": p.get("busy_roads", []), "areas": p.get("areas", []),
            "streets": streets,
            "basemap": p.get("basemap"),
        },
    }
    tpl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "route_page.html")
    with open(tpl_path) as f:
        tpl = f.read()
    blob = json.dumps(data).replace("</", "<\\/")
    return tpl.replace("__JACK_TITLE__", htmlmod.escape(title)).replace("__JACK_DATA__", blob)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1]) as f:
        p = json.load(f)
    out, segs, start, end = plan(p)
    if "--map" in sys.argv:
        path = sys.argv[sys.argv.index("--map") + 1]
        with open(path, "w") as f:
            f.write(map_fragment(start, end, segs, p.get("title", "Trick-or-treat route"),
                                 p.get("busy_roads", []), p.get("areas", [])))
        out["map_file"] = path
    if "--page" in sys.argv:
        path = sys.argv[sys.argv.index("--page") + 1]
        with open(path, "w") as f:
            f.write(build_page(p, out, segs, start, end))
        out["page_file"] = path
    out.pop("_page", None)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
