Overpass, geocoder (Nominatim behind a `Geocoder` interface, Photon fallback) and Open-Meteo clients. Polite and cached.

- `geocoder.ts`: runs only when the visitor presses the button. At most one Nominatim request a second; switches to Photon if Nominatim fails or pushes back. Results cached for the session.
- `overpass.ts`: one successful request per plan, with the home point rounded to 3 decimals before it leaves the device. Cached per rounded point for the session; two plans at once share one request. Servers are asked one at a time: Haulween's relay (`api/streets.ts`, Overpass.ch), then Private.coffee. One retry for a quick failure, none after a 406 or 429, at most 4 attempts and 45 s in all. A site with no relay, or no key, skips it. Not overpass-api.de (its policy excludes apps on fast-deploy platforms), and nothing operated in Russia. Requests keep the browser's normal Referer, so servers can see which site is asking.
- `weather.ts`: sunset and hourly weather for the walk, at a point rounded to 2 decimals.
- `cache.ts`: memory plus `sessionStorage`, and plain-words errors.
