import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from './cache';
import { FallbackGeocoder, NominatimGeocoder, PhotonGeocoder, Throttle } from './geocoder';
import { ALL_FAILED, OVERPASS_SERVERS, OverpassClient, RETIRED_SERVER, roundPoint } from './overpass';

const [FIRST, SECOND] = OVERPASS_SERVERS;
/** A client with no real pauses between tries. */
const quick = (fetchFn: unknown) =>
  new OverpassClient(fetchFn as typeof fetch, new SessionCache('t.', null), { sleep: async () => {}, isOnline: () => true });
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
    expect(url).toBe(FIRST);
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

  it('says "busy" when every server says so', async () => {
    const c = quick(() => json({}, 429));
    await expect(c.streetsNear(41.8, -82.1)).rejects.toThrow('The street map servers are busy right now. Try again in a few minutes.');
  });

  const urls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => (c as unknown as [string])[0]);

  it('never touches the next server when the first answers', async () => {
    const fetchFn = vi.fn(() => json({ elements: [] }));
    await quick(fetchFn).streetsNear(41.8, -82.1);
    expect(urls(fetchFn)).toEqual([FIRST]);
  });

  it('never asks overpass-api.de, whose operator asks apps like this one not to', async () => {
    const fetchFn = vi.fn(() => json({}, 500));
    await quick(fetchFn).streetsNear(41.8, -82.1).catch(() => {});
    expect(urls(fetchFn)).not.toContain(RETIRED_SERVER);
    expect(OVERPASS_SERVERS).not.toContain(RETIRED_SERVER);
  });

  it('keeps identifying the site to the servers (no hiding the Referer)', async () => {
    const fetchFn = vi.fn(() => json({ elements: [] }));
    await quick(fetchFn).streetsNear(41.8, -82.1);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.referrerPolicy).not.toBe('no-referrer');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
  });

  it.each([
    [429, [FIRST, SECOND]], // asked to slow down: no quick retry
    [504, [FIRST, FIRST, SECOND]],
    [500, [FIRST, FIRST, SECOND]],
  ])('after a quick %i, moves on as it should', async (status, expected) => {
    const fetchFn = vi.fn((url: string) => (url === FIRST ? json({}, status) : json({ elements: [] })));
    const data = await quick(fetchFn).streetsNear(41.8, -82.1);
    expect(data.streets).toEqual([]);
    expect(urls(fetchFn)).toEqual(expected);
    const [, init] = fetchFn.mock.calls[fetchFn.mock.calls.length - 1] as unknown as [string, RequestInit];
    expect(decodeURIComponent(String(init.body))).toContain('around:900,41.8,-82.1)'); // still rounded
  });

  it('retries a server that got no answer at all, then tries the next', async () => {
    const fetchFn = vi.fn((url: string) => (url === FIRST ? Promise.reject(new TypeError('Load failed')) : json({ elements: [] })));
    await quick(fetchFn).streetsNear(41.8, -82.1);
    expect(urls(fetchFn)).toEqual([FIRST, FIRST, SECOND]);
  });

  it('when every server fails, says to try again in a few minutes', async () => {
    const fetchFn = vi.fn((url: string) => json({}, url === FIRST ? 500 : 429));
    await expect(quick(fetchFn).streetsNear(41.8, -82.1)).rejects.toThrow(ALL_FAILED);
    expect(ALL_FAILED).toMatch(/try again in a few minutes/i);
  });
});

describe('geocoder', () => {
  const nominatimRow = [{ lat: '41.8', lon: '-82.1', address: { road: 'Elm Street', city: 'Springwood' } }];

  it('reads a Nominatim answer', async () => {
    const g = new NominatimGeocoder(() => json(nominatimRow), noWait);
    expect(await g.search(PLACEHOLDER_ADDRESS)).toEqual({ lat: 41.8, lng: -82.1, road: 'Elm Street', town: 'Springwood', source: 'Nominatim' });
  });

  it('takes the town, not a small local area name', async () => {
    const row = [{ lat: '41.8', lon: '-82.1', address: { road: 'Elm Street', suburb: 'Lakeview', hamlet: 'Lakeview', town: 'Springwood' } }];
    expect(await new NominatimGeocoder(() => json(row), noWait).search(PLACEHOLDER_ADDRESS)).toMatchObject({ town: 'Springwood' });
    const noTown = [{ lat: '41.8', lon: '-82.1', address: { road: 'Elm Street', neighbourhood: 'Lakeview', suburb: 'Lakeview' } }];
    expect(await new NominatimGeocoder(() => json(noTown), noWait).search(PLACEHOLDER_ADDRESS)).toMatchObject({ town: '' });
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
