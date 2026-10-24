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

**Demo mode:** add `?demo` to the address (http://localhost:5173/?demo, or https://haulween.vercel.app/?demo), or press "Try the demo". It plans around 1428 Elm St in Springwood, a made-up neighborhood, with made-up weather and no network calls at all. Screenshots in `docs/screenshots/` come from it.

## How it works

- Streets come from OpenStreetMap through free public Overpass servers (VK Maps, then Private.coffee). Only your home point, rounded to about 100 m, is sent.
- Address lookup uses Nominatim, and only when you press Search.
- Weather and sunset come from Open-Meteo.
- Jack, the AI guide, is optional and uses your own Claude API key, kept only in your browser.

House counts are estimates from street frontage. Haulween never promises which houses give candy.

The spec is [docs/build-brief.md](docs/build-brief.md). The rules for contributors are in [CLAUDE.md](CLAUDE.md).

## Credits

Map data © OpenStreetMap contributors (ODbL). Tiles by OpenFreeMap.

## License

MIT
