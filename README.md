# Haulween

*Plan your epic candy haul and be home on time.*

Haulween plans one safe Halloween walking route from home that hits the most houses in the time your family has, and gets everyone home on time. It's a static web app: no server, no accounts. Your plan and settings stay in your browser.

Built in public. Fork it and run it for your own neighborhood.

## Run it

Needs Node 24 or newer (see `.nvmrc`).

```bash
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

Phones only allow GPS on `https`, so test Night Mode on the deployed site.

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
