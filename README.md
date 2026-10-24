# Haulween

*Plan your epic candy haul and be home on time.*

Haulween plans one safe Halloween walking route from home that hits the most houses in the time your family has, and gets everyone home on time. It's a static web app: no server, no accounts. Your plan and settings stay in your browser.

Built in public. Fork it and run it for your own neighborhood.

**Live site:** https://haulween.vercel.app (deploys from `main`)

## Plan ahead

- **Plan the night before, or early on Halloween.** Haulween gets its street data from OpenStreetMap's free Overpass service. Everyone shares it, and it gets busy on Halloween afternoon.
- **Press "Start the night" once your route looks right.** That saves the plan in your browser, along with the street data it needs. It stays there when you close the browser or the phone restarts, until you press "End the night" or start a new night. Next time you open Haulween, tap "Back to Night Mode". (Private browsing windows forget it when they close.)
- **Night Mode works from that saved plan.** The map, checking off streets and "Replan from here" never fetch street data again. You still need a connection to open the page, and the map's background comes from the internet, so open Night Mode before you head out.
- **If you see "The street map service is busy,"** wait a minute and try again, or switch from Wi-Fi to cellular. Overpass limits each internet connection, so a whole household shares one limit.

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

- Streets come from OpenStreetMap through the Overpass API. Only your home point, rounded to about 100 m, is sent.
- Address lookup uses Nominatim, and only when you press Search.
- Weather and sunset come from Open-Meteo.
- Jack, the AI guide, is optional and uses your own Claude API key, kept only in your browser.

House counts are estimates from street frontage. Haulween never promises which houses give candy.

The spec is [docs/build-brief.md](docs/build-brief.md). The rules for contributors are in [CLAUDE.md](CLAUDE.md).

## Credits

Map data © OpenStreetMap contributors (ODbL). Tiles by OpenFreeMap.

## License

MIT
