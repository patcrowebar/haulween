# Haulween

*Plan your epic candy haul and be home on time.*

Haulween plans one safe Halloween walking route from home that hits the most houses in the time your family has, and gets everyone home on time. It's a static web app: no server, no accounts. Your plan and settings stay in your browser.

Built in public. Fork it and run it for your own neighborhood.

**Live site:** https://haulween.vercel.app (deploys from `main`)

## Plan ahead

- **Plan the night before, or early on Halloween.** Haulween gets its street data from OpenStreetMap's free Overpass service. Everyone shares it, and it gets busy on Halloween afternoon.
- **Your route is saved as soon as it's planned.** It stays in your browser, with the street data it needs, when you close the browser or the phone restarts. Next time you open Haulween, the route is there with "Start the night" ready, and no street data is fetched again. Planning the night before just works. (Private browsing windows forget it when they close.)
- **Pressing "Start the night" early is fine.** Until your start time, the bar says when you start, and nothing is tracked unless you set off along the route.
- **Open Night Mode before you head out.** Once it's open, the bar, checking off streets and "Replan from here" keep working if you lose signal. Opening the page needs a connection, and so does the map's background.
- **If the street map doesn't come,** try again in a few minutes. Haulween asks the free public map servers one at a time, and they're all busy on Halloween afternoon. Add `?debug` to the address to see what each one said.

## Run it

Needs Node 24 or newer (see `.nvmrc`).

```bash
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

Phones only allow GPS on `https`, so test Night Mode on the deployed site.

**Demo mode:** add `?demo` to the address (http://localhost:5173/?demo, or https://haulween.vercel.app/?demo), or press "Try the demo". It plans around 1428 Elm St in Springwood, a made-up neighborhood, with made-up weather and no network calls at all. The screenshots below come from it.

## Screenshots

From demo mode on a 390 px wide phone screen, around 1428 Elm St in made-up Springwood.

| Plan | Door time and pace | Map | Night Mode |
| --- | --- | --- | --- |
| <img src="docs/screenshots/1-plan-form.png" alt="The Plan form: starting address, night, start and home-by times, roads to avoid" width="180"> | <img src="docs/screenshots/2-results-door-and-pace.png" alt="Results: about 144 houses, home by 7:44 pm, with the four door times and the four walking paces" width="180"> | <img src="docs/screenshots/3-map.png" alt="The route in orange with numbered streets, Home, and a busy road dashed" width="180"> | <img src="docs/screenshots/4-night-mode.png" alt="Night Mode: On track, the street you're on, and your dot on the map" width="180"> |

## How it works

- Streets come from OpenStreetMap through Overpass: first Haulween's relay, a small Vercel function that asks Overpass.ch with a key kept in Vercel, then Private.coffee if the relay can't help.
- Address lookup uses Nominatim (Photon as a backup), and only when you press Search.
- Weather and sunset come from Open-Meteo.
- Jack, the AI guide, is optional and uses your own Claude API key, kept only in your browser.

## Privacy

Who gets what:

| Service | Gets | Sees your internet address? |
| --- | --- | --- |
| Nominatim, or Photon as a backup | The address you typed, only when you press Search | Yes |
| Haulween's relay (Vercel) | Your home point rounded to about 100 m, and the search radius | Yes, as any website does. The relay itself logs nothing about requests. |
| Overpass.ch (servers in Germany), through the relay | The same rounded point, as a street-map query | No: it sees Vercel's address, not yours |
| Private.coffee, only if the relay can't help | The same rounded point, as a street-map query | Yes |
| Open-Meteo | Your home point rounded to about 1 km, and the night | Yes |
| OpenFreeMap | The map area you're looking at, as map tiles | Yes |

Your address, plans, settings and any API key stay in your browser. There are no accounts, analytics or tracking. Haulween never uses overpass-api.de (its policy excludes apps on fast-deploy platforms) or any service operated in Russia.

**Running your own copy:** without an `OVERPASS_KEY` in your host's settings, the relay says so and Haulween goes straight to the free servers.

House counts are estimates from street frontage. Haulween never promises which houses give candy.

The spec is [docs/build-brief.md](docs/build-brief.md). The rules for contributors are in [CLAUDE.md](CLAUDE.md).

## Credits

Map data © OpenStreetMap contributors (ODbL). Tiles by OpenFreeMap.

## License

MIT
