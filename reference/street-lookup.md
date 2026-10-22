# Street lookup: building the street list for a route

Jack has no parcel or street-network data built in, so it has to assemble the neighborhood from lookups. This is the slow part of a plan. Doing it in this order keeps it to a handful of tool calls and stops you from routing onto streets you only assumed exist.

## 0. Privacy

Use the street address only in the place lookup for the starting point. Every later lookup uses street names, intersections, and a location bias around the coordinates. If you query a map service directly (step 3a), round the home coordinates to 3 decimals (about 100 m) and never put the address in a URL.

## 1. Pin home

Look up the address with the place search tool. Keep its lat/lng and the town and ZIP it reports. Street names repeat from town to town, so the ZIP is what you check every later result against.

## 2. Fence in the pocket: the busy roads

The route should stay inside the block of neighborhood bounded by busy roads (see the safety defaults in SKILL.md). Name the candidates: any road the user said to avoid, plus numbered routes, arterials, and roads with shopping or bus stops near home.

Pin each busy road with **3 or more points**. Look up its intersections with other roads around home ("Main St & Ridge Rd, Springwood OH"). One intersection is not enough: busy roads curve, and the side-of-road test in step 6 is only as good as these points. Bus stop results named "X Rd & Y Rd" are fine stand-ins for intersections.

## 3. Get candidate street names

Use the best source available, in this order. Option a needs the Claude desktop app open and online. Options b and c work anywhere.

**a. OpenStreetMap through the Claude app's browser (best, tested).** This gives every street's real shape, busy-road classes and speed limits, parks, schools, and many sidewalks. Use it whenever the built-in browser tools are present. Then skip steps 4 to 6 and run `scripts/osm_import.py` (step iii below).

i. Open `https://overpass-api.de/api/status` in the built-in browser (`preview_start`). If it asks for site access, request it with scope "site". Don't load a query URL directly: the server answers a plain page load with "406 Not Acceptable".

ii. On that page, run this with the JavaScript tool, with `LAT`/`LNG` set to the home coordinates **rounded to 3 decimals**:

```js
const LAT = 41.800, LNG = -82.100;   // rounded home point, never the address
const q = `[out:json][timeout:60];
way(around:900,${LAT},${LNG})[highway~"^(residential|living_street|unclassified|tertiary|secondary|primary|trunk)$"][name];out tags geom;
way(around:900,${LAT},${LNG})[leisure~"^(park|pitch|playground|recreation_ground)$"];out tags geom;
way(around:900,${LAT},${LNG})[amenity~"^(school|place_of_worship)$"];out tags geom;
way(around:900,${LAT},${LNG})[landuse~"^(grass|recreation_ground|cemetery|commercial|retail)$"];out tags geom;
way(around:900,${LAT},${LNG})[footway=sidewalk];out geom;`;
const r = await fetch('/api/interpreter', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'data=' + encodeURIComponent(q)});
const d = await r.json(), r5 = x => Math.round(x * 1e5) / 1e5;
const out = {streets: [], areas: [], sidewalks: []};
for (const e of d.elements) {
  const t = e.tags || {}, g = (e.geometry || []).map(p => [r5(p.lat), r5(p.lon)]);
  if (t.footway === 'sidewalk') out.sidewalks.push(g);
  else if (t.highway) out.streets.push({name: t.name, hw: t.highway, ms: t.maxspeed || '', ln: t.lanes || '', g});
  else out.areas.push({n: t.name || '', k: t.leisure || t.amenity || t.landuse, g});
}
JSON.stringify(out)
```

The result is often too big to show inline. When it is, the tool saves it to a file and says where. Either way, write the JSON to `osm.json` in the working folder. Use 900 m for a 2 to 3 hour window. Use 600 m for an hour or less, or with little kids.

iii. Run the import with the exact home coordinates:

```bash
python scripts/osm_import.py osm.json --home LAT,LNG --frontage 55 --out streets.json
```

It finds the **pocket**: the residential streets you can reach from home without stepping onto a busy road. Busy means primary, secondary or trunk, 3+ lanes, or posted 35 mph or more. For each pocket street it prints length, houses per side (real length minus park, school, church, field and corner frontage), sidewalk share, and which busy roads it touches. `streets.json` also holds the map layers (`busy_roads`, `areas`, `context_streets`) to copy into plan.json as-is.

Things to watch for:
- **The pocket is often smaller or differently shaped than lookups suggest.** In testing it revealed a primary road one block from home that name lookups never surfaced, and showed that two streets assumed to connect didn't. Trust it over earlier guesses.
- **A gap in the data is a real gap until proven otherwise.** When a street comes back in pieces with a gap between them, assume the gap is a dead end, a park, or someone's yard, not missing data. In testing, every gap that looked like missing data turned out to be real: the home block of a street was a dead end, cut off from the street's other pieces. Never draw a straight line across a gap. Route only over pieces that share an intersection (the import's connectivity already does this). If one unknown connection would change the route, ask the user that one question.
- **Building outlines are too patchy to count houses** (in testing, 70 buildings mapped where hundreds of houses stand). That's why houses come from frontage, not buildings.
- **A sidewalk share of 0 or `None` means unknown.** It doesn't mean there's no sidewalk.
- **If the pocket has more houses than the window allows** (common with long windows), cut the streets nearest the busy roads and keep the densest ones near home.

iv. **Map background.** In the same browser tab, stitch OpenStreetMap tiles into one image for the page, since the published page can't load map images itself. Set the box to the route area plus about 300 m on every side:

```js
const Z = 17, N = 41.8060, S = 41.7950, W = -82.1080, E = -82.0920;   // box around the route
const lon2x = l => (l + 180) / 360 * 2 ** Z;
const lat2y = a => (1 - Math.log(Math.tan(a * Math.PI / 180) + 1 / Math.cos(a * Math.PI / 180)) / Math.PI) / 2 * 2 ** Z;
const x2lon = x => x / 2 ** Z * 360 - 180;
const y2lat = y => { const n = Math.PI - 2 * Math.PI * y / 2 ** Z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const x0 = Math.floor(lon2x(W)), x1 = Math.floor(lon2x(E)), y0 = Math.floor(lat2y(N)), y1 = Math.floor(lat2y(S));
const c = document.createElement('canvas'); c.width = (x1 - x0 + 1) * 256; c.height = (y1 - y0 + 1) * 256;
const ctx = c.getContext('2d'); let fails = 0;
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {      // one at a time: be polite to the tile server
  try { const r = await fetch(`https://tile.openstreetmap.org/${Z}/${x}/${y}.png`);
        ctx.drawImage(await createImageBitmap(await r.blob()), (x - x0) * 256, (y - y0) * 256); } catch (e) { fails++; }
}
JSON.stringify({bounds: {n: y2lat(y0), s: y2lat(y1 + 1), w: x2lon(x0), e: x2lon(x1 + 1)}, light: c.toDataURL('image/jpeg', 0.82), fails})
```

Save the result as plan.json's `basemap`. It's usually around 400 KB, so the tool saves it to a file. Keep it to about 40 tiles at zoom 17 (that's under 0.6 miles across) and never re-download in a loop: the OpenStreetMap tile servers allow light, occasional use. **Look at a crop of the image before using it.** A provider that wants an account key returns a sheet of "API KEY REQUIRED" tiles with no error, which happened with CARTO in testing. The page shows the "© OpenStreetMap contributors" credit automatically when a basemap is present, and dims the map in dark mode.

To build route segments, slice each pocket street between real intersections and use the sliced polyline as the segment's `points`. The map then follows the real curves, and the last point becomes the Google Maps waypoint.

**b. ZIP street list.** Fetch `https://www.redfin.com/sitemap/{STATE}/{ZIP}` (e.g. `/sitemap/OH/44101`) and ask for every street name on the page. That gives the full name list for the ZIP but no locations. If home is near a ZIP line, fetch the neighboring ZIP too: the streets across the line may be closer than half of home's own ZIP.

**c. Landmarks.** Search places near home for parks, fields, schools, churches, and apartment complexes. Their addresses reveal street names ("1428 Elm St, Springwood, OH"), and they also mark the stretches that will be one side only.

## 4. Locate the names

Look up street names in batches of 10 with the place search tool, biased to home (radius about 1,000 m). Each result is a point near the street's middle. Keep only results in home's town or ZIP and within about 3,500 ft. Throw out the rest without a second look: a same-named street two towns over is a common trap.

Neighborhoods are often themed (presidents, trees, generals). When two or three hits cluster near home with a shared theme, try the rest of the theme next.

## 5. Find each street's ends

A center point doesn't tell you which way a street runs or whether it connects. For each street you kept, look up two intersections: one with the home street or a street you've already placed, and one with whatever is probably at the other end. Batch 10 per call.

- The result type is `intersection` (or a bus stop named for both roads): that's a real end. Record it and the name of the street it meets.
- The result is a business, park, or just one of the streets: they probably don't meet. Try another pairing, or leave the street as `needs_ends`.

Stop when the usable streets add up to about 1.2 times the door budget. The door budget is the window minus buffer, in minutes, since each door takes about a minute. You don't need the whole map, only enough dense streets to fill the night.

## 6. Run the scout

Write `scout.json` (format in the docstring) and run:

```bash
python scripts/street_scout.py scout.json
```

What to do with each status:
- **usable**: goes into the plan. `houses_per_side_est` is from length and lot width. Adjust it for parks, fields, churches, and corner lots you know about.
- **needs_ends**: one more intersection lookup, or put it in the plan as `optional` with a note to confirm on the night.
- **outside**: across a busy road from home. Leave it out unless the user asks, and then cross at a signal.
- **too_far**: leave it out.
- **touches_busy**: the street reaches a busy road. You can use it, but turn around before the busy road (`exit: "same"`) and never walk along the busy road to connect two streets.
- **check_side**: close to a busy road and the side test isn't certain. Verify with one more intersection, or treat it as outside.

Set `frontage_ft` for the neighborhood: rowhomes 16 to 25, twins 30 to 40, typical post-war suburbs 50 to 60, newer suburbs 60 to 80, large lots 100+.

## 7. Carry the uncertainty into the plan

- A street whose connection you couldn't confirm goes in as `optional`, so it's cut first and the loop survives without it.
- Pass the busy roads and parks to `plan_route.py` as `busy_roads` and `areas`. Inline viewers often block map tiles, and these are what make the map readable without them.
- If one unconfirmed connection would change the whole route (for example, the only way back without touching a busy road), ask the user that one question. People know their own block. Otherwise plan around it and name it in the assumptions line.
