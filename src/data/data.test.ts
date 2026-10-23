import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from './cache';
import { FallbackGeocoder, NominatimGeocoder, PhotonGeocoder, Throttle } from './geocoder';
import { OverpassClient, roundPoint } from './overpass';
import { WeatherClient, addMinutes, flagsFor } from './weather';
import { PLACEHOLDER_ADDRESS } from '../config';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const noWait = new Throttle(0);

describe('Overpass client', () => {
  it('rounds the home point to 3 decimals before it leaves the device', async () => {
    const fetchFn = vi.fn(() => json({ elements: [] }));
    await new OverpassClient(fetchFn, new SessionCache('t.', null)).streetsNear(41.8000824, -82.1003685);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://overpass-api.de/api/interpreter');
    expect(init.method).toBe('POST');
    const query = decodeURIComponent(String(init.body).slice(5));
    expect(query).toContain('around:900,41.8,-82.1)');
    expect(query).not.toContain('41.8000824');
    expect(roundPoint(41.8006, -82.1004)).toEqual([41.801, -82.1]);
  });

  it('sends one request per rounded point, even when asked twice at once', async () => {
    const fetchFn = vi.fn(() => json({ elements: [] }));
    const c = new OverpassClient(fetchFn, new SessionCache('t.', null));
    await Promise.all([c.streetsNear(41.80001, -82.10001), c.streetsNear(41.80002, -82.10002)]);
    await c.streetsNear(41.8001, -82.1001);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('explains a busy server in plain words', async () => {
    const c = new OverpassClient(() => json({}, 429), new SessionCache('t.', null));
    await expect(c.streetsNear(41.8, -82.1)).rejects.toThrow('The street map is busy right now. Try again in a minute.');
  });
});

describe('geocoder', () => {
  const nominatimRow = [{ lat: '41.8', lon: '-82.1', address: { road: 'Elm Street', city: 'Springwood' } }];

  it('reads a Nominatim answer', async () => {
    const g = new NominatimGeocoder(() => json(nominatimRow), noWait);
    expect(await g.search(PLACEHOLDER_ADDRESS)).toEqual({ lat: 41.8, lng: -82.1, label: 'Elm Street, Springwood', source: 'Nominatim' });
  });

  it('switches to Photon when Nominatim pushes back', async () => {
    const photon = { features: [{ geometry: { coordinates: [-82.1, 41.8] }, properties: { street: 'Elm Street', city: 'Springwood' } }] };
    const g = new FallbackGeocoder([new NominatimGeocoder(() => json({}, 429), noWait), new PhotonGeocoder(() => json(photon))]);
    const place = await g.search(PLACEHOLDER_ADDRESS + ' (photon test)');
    expect(place?.source).toBe('Photon');
    expect(g.current.name).toBe('Photon');
  });

  it('caches results so the same search never asks twice', async () => {
    const fetchFn = vi.fn(() => json(nominatimRow));
    const g = new FallbackGeocoder([new NominatimGeocoder(fetchFn, noWait)]);
    await g.search(PLACEHOLDER_ADDRESS + ' (cache test)');
    await g.search('  ' + PLACEHOLDER_ADDRESS.toUpperCase() + '  (CACHE TEST) ');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('waits a second between Nominatim requests', async () => {
    let now = 0;
    const waits: number[] = [];
    const t = new Throttle(1000, () => now, async (ms) => { waits.push(ms); now += ms; });
    await t.wait();
    await t.wait();
    now += 300;
    await t.wait();
    expect(waits).toEqual([1000, 700]);
  });
});

describe('weather', () => {
  const body = {
    daily: { sunset: ['2026-10-31T18:31'] },
    hourly: {
      time: ['2026-10-31T16:00', '2026-10-31T17:00', '2026-10-31T18:00', '2026-10-31T19:00', '2026-10-31T21:00'],
      temperature_2m: [55.2, 52.4, 49.6, 47.1, 40],
      apparent_temperature: [53, 50, 46, 43.6, 35],
      precipitation_probability: [10, 20, 45, 30, 90],
    },
  };

  it('reads sunset, dark and the hours of the walk, at a point rounded to 2 decimals', async () => {
    const fetchFn = vi.fn(() => json(body));
    const t = await new WeatherClient(fetchFn).tonight(41.80082, -82.10037, '2026-10-31', 17, 19);
    expect(String((fetchFn.mock.calls[0] as unknown as [string])[0])).toContain('latitude=41.80&longitude=-82.10');
    expect(t.sunset).toBe('18:31');
    expect(t.dark).toBe('19:01');
    expect(t.hours.map((h) => h.time)).toEqual(['17:00', '18:00', '19:00']);
    expect(flagsFor(t)).toEqual({ rain: true, cold: true, lowF: 44, maxRain: 45 });
  });

  it('does clock math across midnight', () => {
    expect(addMinutes('23:50', 30)).toBe('00:20');
  });
});
