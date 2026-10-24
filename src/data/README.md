Overpass, geocoder (Nominatim behind a `Geocoder` interface, Photon fallback) and Open-Meteo clients. Polite and cached.

- `geocoder.ts`: runs only when the visitor presses the button. At most one Nominatim request a second; switches to Photon if Nominatim fails or pushes back. Results cached for the session.
- `overpass.ts`: one POST per plan, with the home point rounded to 3 decimals before it leaves the device. Cached per rounded point for the session; two plans at once share one request. If a server fails, the servers are asked one at a time (VK Maps, then Private.coffee), with one retry for a quick failure and 45 s in all, so at most four requests. Not overpass-api.de: its operator asks fast-deployed AI-generated apps not to use it, and it refuses this site with 406. Requests keep the browser's normal Referer, so servers can see which site is asking.
- `weather.ts`: sunset and hourly weather for the walk, at a point rounded to 2 decimals.
- `cache.ts`: memory plus `sessionStorage`, and plain-words errors.
