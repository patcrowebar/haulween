Overpass, geocoder (Nominatim behind a `Geocoder` interface, Photon fallback) and Open-Meteo clients. Polite and cached.

- `geocoder.ts`: runs only when the visitor presses the button. At most one Nominatim request a second; switches to Photon if Nominatim fails or pushes back. Results cached for the session.
- `overpass.ts`: one POST per plan, with the home point rounded to 3 decimals before it leaves the device. Cached per rounded point for the session; two plans at once share one request.
- `weather.ts`: sunset and hourly weather for the walk, at a point rounded to 2 decimals.
- `cache.ts`: memory plus `sessionStorage`, and plain-words errors.
