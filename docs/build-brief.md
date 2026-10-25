# Build Brief: Haulween

*Plan your epic candy haul and be home on time.*

A lightweight spec for vibe coding an app idea. Fill out each section below — keep it tight. The whole thing should fit on one screen. If a section starts feeling like a PRD, you've gone too far.

---

## 1. One-Liner

> *An app that does **[X]** for **[Y]** so they can **[Z]**.*

An app that plans one safe Halloween walking route through the densest streets near home for families with trick-or-treaters, so they can get the most candy in the time they have and still be home on time.

---

## 2. Problem

> *2–3 sentences. What's broken today, and why does it suck?*

Families wander the same few blocks, double back, and run out of time before the best streets, or end up walking along busy roads in the dark. Nobody knows which streets are densest, which ones dead-end, or when to turn back. General map apps route you from A to B. They don't plan a loop that collects the most houses.

---

## 3. Desired Outcome

> *One sentence. What changes for the user after they use this. Not a feature, not a metric — a state change.*

The family walks out the door at 5:00 with a route they trust, hits the most houses they can, and is back home by the time they said, with nobody arguing about where to go next.

---

## 4. Target User

> *One persona. Who they are, their tech comfort level, and the context they'll use the app in.*

A parent of trick-or-treaters, from little ones to teens, comfortable with phone apps but not maps or settings. They plan on the couch a day or two before. On Halloween they're outside in the dark, holding a candy bag and their phone in one hand, glancing at it between houses.

---

## 5. Core User Journey

> *3–7 steps. The happy path from open to "win." Plain English.*

1. Parent enters the starting address, the time window ("5 to 8 pm"), and any roads to avoid.
2. The parent picks how long they'll spend at each door and how fast they walk, seeing the house estimate for every choice. Jack, the optional AI guide, can help with those and with odd cases.
3. The app shows a real map with the route, numbered streets, a street-by-street schedule, the total houses, and the head-home time.
4. Parent tweaks it ("skip Maple Ct", or taps a street to add it), and the route re-optimizes.
5. On Halloween, the parent opens Night Mode. A GPS dot shows where they are, and a status bar says "On track" or "6 min behind".
6. If they're running late, the parent types or says "we're 15 minutes behind". Jack replans from where they are and sets a new head-home time.
7. A "Turn around now" alert fires at the latest safe time, and everyone's home on time.

---

## 6. Must-Have Features

> *3–5 features, ranked. The ranking matters more than the list.*

1. **Route plan on a real map.** The app finds the safe pocket of streets around home (bounded by busy roads), runs the optimizer for the most houses that fit the time, and shows the route on a MapLibre map with numbered streets, a schedule, totals, and a head-home time.
2. **Night Mode.** A live GPS dot, auto-detection of the current street with a manual check-off fallback, the on-track/behind bar, a head-home countdown, and the turn-around alert.
3. **Jack, the optional AI guide (Claude, bring your own key).** It asks the setup questions that matter, reviews every route for odd cases (dead ends, data gaps, busy roads, a street that only looks connected), and handles plain-English replans. It can't change the map data. It can only call the app's planning functions (exclude a street, change door time, replan from here) and explain the result. Everything else works with the AI off.
4. **Per-street walking patterns.** Zigzag for streets walked once, one side out and the other back for streets walked twice, and walk-through for short connectors. Tap a street on the map to add or skip it.
5. **Tonight card and handoff.** Sunset and dark times, rain and cold flags, and an "Open in Google Maps" walking link.

---

## 7. Explicitly Out of Scope

> *What this app is NOT. The most-skipped section, the one that saves the most credits.*

No backend or server of any kind, no AI running on the maintainer's key, no accounts or login, no saving plans to the cloud, no share links, no "which houses give candy" ratings or crowdsourcing, no social feed, no turn-by-turn voice navigation, no multi-family coordination, no payments, no native iOS or Android app.

---

## 8. Data Model

> *Just the nouns and their key fields. Not a schema.*

- **Plan** has a home point (snapped to its street), a time window, a date, door seconds, walking pace (Slow, Steady, Quick or Fast), roads to avoid, and an ordered list of Segments.
- **Street piece** is a stretch between two intersections from OpenStreetMap. It has a name, its geometry, its length, and houses on the left and on the right (frontage minus parks, schools, churches and corners).
- **Segment** is one row of the schedule. It has a street piece or pieces, a pattern (zigzag, one side, or walk-through), houses, a planned start time, a "skip if behind" flag, and done yes/no.
- **Busy road** has a name and geometry, and is never walked along. Busy means primary, secondary or trunk, 3+ lanes, or posted 35 mph or more.
- **Night status** has the current position, the current segment, minutes ahead or behind, and the latest safe head-home time.
- **Chat message** is a message to or from Jack, plus any plan change it made.
- **Settings** has the visitor's Claude API key (kept only in their browser, with a "forget my key" button), door seconds, and units.

---

## 9. Auth & Access

> *Three forced questions.*

- **Login needed?** No. Plans and settings are saved only in the visitor's browser. The AI is optional: visitors paste their own Claude API key, it's stored only in their browser, and the app calls Claude directly from the browser. There's no server.
- **Sign-in method?** N/A for v1.
- **User types?** Just one type: the visitor running a plan, with or without their own AI key.

---

## 10. Look & Feel

> *One line + one reference app. A reference does more work than a paragraph of adjectives.*

Halloween night: near-black backgrounds, pumpkin-orange route and buttons, a dark recolored map, huge high-contrast type and tap targets you can read one-handed in the dark. Like Citymapper's live-trip screen, dressed for Halloween.

---

## 11. Platform & Constraints

> *What you know. Claude infers the rest of the stack from your vibe coding tool.*

- **Vibe coding tool:** Claude Code. The project is a static React + TypeScript + Vite site in a public GitHub repo (MIT license), deployed free from GitHub to Vercel or Netlify. The repo's CLAUDE.md carries the rules.
- **Where it runs:** Mobile-first web app.
- **Hard constraints:**
  - **Map:** MapLibre GL with OpenFreeMap tiles (no key needed), recolored dark. Test Night Mode GPS on the deployed `https` site, since phones block GPS on plain `http`.
  - **Street data:** from the OpenStreetMap Overpass API, called from the browser with a POST request. Send only the home point rounded to 3 decimals, never the address.
  - **Address lookup:** a keyless geocoder such as Nominatim. Respect its rate limit.
  - **Weather and sunset:** Open-Meteo, which needs no key.
  - **Never bridge a gap in the street data.** A gap is a dead end, a park or a yard. Every route must pass a check that each stretch lies on a real street and never runs along a busy road.
  - **The safe pocket** is the set of streets reachable from home without stepping onto a busy road.
  - **Defaults:** 45 seconds per door and a Steady pace (2.0 mph; the choices run 1.5 to 3.0), both always shown with every choice's house estimate for the parent to change, a 10-minute buffer, and a loop that ends at home.
  - **The app works fully with the AI off.**
  - **Bring-your-own-key AI:** the browser calls Claude directly using the `anthropic-dangerous-direct-browser-access` header. The key is kept only in the browser, never logged or sent anywhere else. Load no third-party scripts beyond the map libraries. Keep AI calls few and short.
  - **No secrets in the repo.**
  - **The route check and optimizer tests must pass on every change.**
  - **The map always shows the OpenStreetMap and OpenFreeMap credits.**
  - **Address lookups run only on Search, are cached, and can switch to Photon.**
  - **The street address never leaves the device** except for the address lookup.

---

*Once this brief is filled out, hand it to Claude and ask for the vibe coding prompts. Claude will translate the brief into the exact prompts to paste into your tool, in the right order, without you burning credits on clarification rounds.*
