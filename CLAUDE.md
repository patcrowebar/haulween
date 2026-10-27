# Haulween: Trick-or-Treat Route Planner

Haulween plans one safe Halloween walking route from home that hits the most houses in the time a family has and gets everyone home on time. It's an open-source, build-in-public project: the code is meant to be read, forked and run by anyone, for their own neighborhood.

The product spec is `docs/build-brief.md`. Read it before building a feature. This file is the rules for how to build.

## Stack

- **Static site.** React + TypeScript + Vite. There's no server, backend or database. The one approved exception is the street-data relay below. If a task seems to need anything else server-side, stop and ask.
- **Map:** MapLibre GL JS with OpenFreeMap vector tiles (no key). Recolor the style dark to match the theme.
- **Street data:** OpenStreetMap through Overpass: Haulween's relay (Overpass.ch) first, then Private.coffee directly from the browser.
- **The relay (`api/streets.ts`), the one approved server-side piece.** A single Vercel function that asks Overpass.ch with a key kept in Vercel's settings (`OVERPASS_KEY`), so the key never reaches the browser, the repo or a log. Free public servers are overloaded and refuse fast-deploy apps; a keyed provider keeps planning working. Its rules:
  - It takes only a home point rounded to 3 decimals and the search radius (200 to 1500 m), in one exact form, builds the app's own query itself and refuses everything else. It must never work as a general Overpass proxy (Overpass.ch forbids reselling raw access).
  - No key configured: it answers 501 and the app goes straight to the free servers. That's how forks run.
  - Good answers are cached by rounded point for 6 hours (Vercel's cache headers), so repeat plans don't spend quota. Failures are never cached.
  - It logs nothing about requests: no IPs, points or timings tied to a visitor. Failures are logged as a short category only, never with the request, the URL (the key is in it) or an error object.
  - It checks Origin, which only stops other websites' pages; anyone outside a browser can fake it. Overpass.ch's free-tier cap (10,000 requests a month, no overage charges) is the backstop.
  - Never put the key in code, tests, docs, logs or `.env` files in the repo (`.env*` is git-ignored).
- **Address lookup:** Nominatim, behind a `Geocoder` interface so Photon can be swapped in.
- **Weather and sunset:** Open-Meteo (no key).
- **AI (optional):** Claude, called straight from the browser with the visitor's own key.
- **Tests:** Vitest. The route logic is plain TypeScript with no React, so it's testable on its own.
- **Deploy:** Vercel or Netlify from the `main` branch. Every push deploys.
- **License:** MIT.

## Commands

```bash
npm install        # first time
npm run dev        # local at http://localhost:5173
npm test           # Vitest; must pass before any commit
npm run build      # production build
```

Phones only allow GPS on `https`. Test Night Mode on the deployed site, not on `localhost`.

## Where things live

```
src/
  route/        # pure logic: no React, no fetch, fully tested
    pocket.ts      # busy-road test + flood fill: which streets are safe
    graph.ts       # split streets at intersections into pieces; houses per side
    optimize.ts    # pick the pieces with the most houses that fit; build the walk
    schedule.ts    # pace, door time, crossings, times, head-home and latest times
    check.ts       # route check: every stretch on a real street, never along a busy road
  data/         # Overpass, geocoder, Open-Meteo clients (polite, cached)
  ai/           # Jack (optional): the Claude client, what it's sent, and the checks on its reply
  map/          # MapLibre setup, layers, dark style
  screens/      # Plan, Night Mode, Settings
api/
  streets.ts    # the street-data relay (Vercel function), and the one Overpass query
reference/      # the original Claude skill's Python: the behavior to match
docs/           # build brief, decisions, screenshots
```

## Port the reference, don't reinvent it

`reference/` holds the Python from the original Jack Claude skill (Haulween started as a skill called Jack), already tested on a real neighborhood: `osm_import.py`, `optimize_route.py`, `plan_route.py`, and `street-lookup.md`. When building `src/route/`, port that logic to TypeScript and keep its behavior. Write tests that pin the same results on the fixture in `src/route/__fixtures__/` (a saved Overpass response). If you think the reference is wrong, say so and explain why before changing behavior.

## Hard rules

These come from real bugs. Don't relax them without asking.

1. **Never bridge a gap in the street data.** When a street comes back in pieces, the gap is a dead end, a park or a yard, not missing data. Route only over pieces that share an intersection node. (The first real test route cut through backyards because of this.)
2. **The safe pocket.** A street is usable only if you can reach it from home without stepping onto a busy road. Busy means OpenStreetMap `highway` is primary, secondary or trunk, or 3+ lanes, or posted 35 mph or more. Never route along a busy road. Crossing one is allowed only when the user asks.
3. **The route check must pass before a route is shown.** Every stretch must lie on a real street line, every street must connect to the next, and no stretch may run along a busy road. If the check fails, fix the route. Don't display it with a warning.
4. **Optimize; don't hand-pick.** The optimizer chooses the street pieces and their order. Fixed loops lost about 10% of the houses in testing.
5. **Door time and walking pace are the main settings.** Defaults: 45 seconds per door and Steady pace. Always show all choices with their house estimates, and let the parent choose. (Door: 60, 45, 35, 30 seconds. Pace: Slow, Steady, Quick, Fast, shown by name and description, never mph. Haulween doesn't ask the kids' ages.)
6. **Patterns come from the walk:**
   - A street walked once is zigzagged.
   - A street walked twice is one side out and the other back.
   - A short connector with no houses is a walk-through.
7. **Name every schedule row by where it goes:** "Elm St to the dead end", "Maple Ave to Park Rd (stop before it)". Never just a street name repeated.
8. **House counts are estimates and say so.** They come from frontage: each side's length minus parks, schools, churches, fields and corners, divided by lot width (default 55 ft). OpenStreetMap building outlines are too patchy to count.
9. **Haulween never promises which houses give candy.** Nothing reliable tracks that.

## Privacy

- **The street address goes only to the geocoder.** Everything after that uses coordinates.
- **Overpass gets the home point rounded to 3 decimals** (about 100 m). Through the relay, Overpass.ch sees Vercel's address, not the visitor's.
- **Plans, settings and the API key stay in the visitor's browser** (`localStorage`). There's no analytics, telemetry or error reporting that sends data out.
- **Jack (only with a key) gets street names, house counts and times, and the parent's message.** Never the address, coordinates, the plan's title or the home street. The exact list is under Jack below.
- **Never log addresses, coordinates or keys** to the console in production builds.
- **Use the placeholder address in every example, test, screenshot caption and doc:** 1428 Elm St, Springwood, OH (the house from *A Nightmare on Elm Street*). Never commit a real home address or a street-data sample from someone's real home neighborhood.

## AI guide: Jack (optional, bring your own key)

The in-app AI guide is called **Jack**. He speaks in short, friendly lines, like a neighbor who knows every street.


- **The app must work fully with the AI off.** Route, map, Night Mode, replans by tapping and the schedule all work without a key.
- **The key is entered in Settings** (`#settings`, linked from the foot of the Plan screen and of Night Mode) and stored only in `localStorage`. Show where it's stored, include a "Forget my key" button, and suggest the visitor set a spending limit on their key. Never show the key again once it's saved. No key, no Jack anywhere.
- **Call the Claude API directly from the browser** with the `anthropic-dangerous-direct-browser-access: true` header. Send the key only to Claude's API, in the `x-api-key` header: never to any other host, never in a URL or body, never in logs.
- **Load no third-party scripts** except MapLibre and its dependencies, so nothing else can read the key.
- **Jack suggests; the parent decides.** For now Jack lives only in Night Mode ("Ask Jack"), not on the Plan screen. He answers in a line or two with at most one change, as structured JSON:
  - skip streets, only from the list the app offers (never the street they're on, the walk home or the home street),
  - an earlier home-by time (later than now, earlier than the current one),
  - a slower walking pace.

  The app checks the reply against those rules and refuses anything else whole. It tries the change with its own replan, runs the route check again, and shows the result. Nothing changes until the parent taps "Use this". Jack never reorders streets (hard rule 4: the optimizer picks the order), and never edits street data, geometry or house counts.
- **What Jack is sent, and nothing more** (`JackContext` in `src/ai/jack.ts`): the remaining streets in order with house counts and planned times, the time now, the head-home and home-by times, minutes behind, the pace name, the streets he may skip and the slower paces, and the parent's message. The last row goes as "the walk home", and the home street, wherever a row names it, as "your street". Adding anything here needs a reason and the maintainer's OK.
- **Later, Jack may get tools** that wrap the app's own functions (`exclude_street`, `include_street`, `set_door_seconds`, `set_walking_pace`, `set_window`, `replan_from_here`, `explain_route`). The same rules apply: the parent confirms, and every route goes through the route check.
- **Keep calls few and short.** One call per question: no history, `max_tokens` 400, effort `low`, thinking off, a 15 s limit and no retry. Standard API features only, no betas. No calls on page load. The model name lives in one constant, `CLAUDE_MODEL` in `src/config.ts` (now `claude-haiku-5-5`).
- **Explain failures in plain words.** A bad key, no credit, a rate limit, no signal, a timeout or a garbled reply gets one short line, and the route and Night Mode keep working.
- **Tests mock Claude.** No real key and no network calls in any test.

## Being a good neighbor to free services

- **Overpass:** one successful request per plan, cached per rounded home point for the session. At most 4 attempts, one at a time, never in parallel, about 45 s in all. No retry after a 406 or 429. Never query in a loop.
- **overpass-api.de is not used** because its policy excludes apps on fast-deploy platforms. Don't strip the Referer or otherwise hide who's asking to get past a server's rules.
- **Never use services operated in Russia.**
- **Nominatim:** look up only when the visitor presses Search, never as they type. Cache results, allow at most one request per second, and show its credit. If it fails or pushes back, switch to Photon.
- **OpenFreeMap and OpenStreetMap credits are always visible** on the map, through MapLibre's attribution control. OpenStreetMap data is ODbL-licensed, so attribution is required.

## Look and feel

Halloween night, built to be used one-handed in the dark.

- **Colors:** near-black background (`#12131c`), raised panels (`#1b1d29`), pumpkin orange (`#f08a3c`) for the route and main buttons, off-white text (`#ecebf2`), muted text (`#a2a3b8`).
- **Status colors:** on track `#7fd49a`, a few minutes behind `#f2c14e`, turn around `#ff7a6b`.
- **Fonts:** a characterful display face for headings (for example Bricolage Grotesque) and a highly legible body face (Atkinson Hyperlegible). Numbers use `tabular-nums`.
- **Layout:** tap targets at least 44 px, mobile-first, and no horizontal scroll at 375 px wide. Respect `prefers-reduced-motion`.
- **Map:** route in orange, numbered pins on each street (never stacked on Home), Home snapped onto its street, busy roads dashed.

## Writing in the app

Plain, short and friendly, written for a parent standing on a sidewalk. Name streets the way people say them ("Elm St", not "Elm Street"). No jargon like "segment", "edge" or "pocket" in anything a visitor sees.

## Working agreement for Claude Code

- **Before a commit:** `npm test` and `npm run build` must pass.
- **Changes to route logic need a test** that would have caught the bug.
- **Keep `src/route/` free of React and network calls.**
- **Ask before adding a dependency.** Prefer none.
- **Don't add a server, analytics, accounts, cloud saving or share links.** They're out of scope for v1 (see the brief). The street-data relay is the one approved exception; don't grow it into anything more.
- **Write commit messages people can follow along with,** since this is built in public. Say what changed and why.
