// What the clients do when the network is slow, busy or gone. All with a fake network.
import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from './cache';
import { FallbackGeocoder, NominatimGeocoder, PhotonGeocoder, Throttle } from './geocoder';
import { MESSAGES, OVERPASS_BACKUP_URL, OVERPASS_URL, OverpassClient } from './overpass';
import { WeatherClient } from './weather';
import { PLACEHOLDER_ADDRESS } from '../config';

type Answer = 'hang' | 'slow-body' | 'offline' | number | { status?: number; body: string };

/** A fake fetch: each URL gets a scripted answer. "hang" never answers but stops when aborted. */
function fakeNet(script: (url: string) => Answer) {
  const calls: Array<{ url: string; aborted: () => boolean }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const signal = init?.signal;
    calls.push({ url, aborted: () => !!signal?.aborted });
    const a = script(url);
    if (a === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    if (a === 'hang') {
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (a === 'slow-body') {
      // Headers arrive at once; the body never finishes.
      return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200 }));
    }
    if (typeof a === 'number') return Promise.resolve(new Response('{}', { status: a }));
    return Promise.resolve(new Response(a.body, { status: a.status ?? 200 }));
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const OK = { body: JSON.stringify({ elements: [] }) };
const client = (net: ReturnType<typeof fakeNet>, online = true) =>
  new OverpassClient(net.fetch, new SessionCache('t.', null), { timeoutMs: 30, isOnline: () => online });

describe('Overpass time limits', () => {
  it('stops waiting for a server that never answers and asks the backup once', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 'hang' : OK));
    await expect(client(net).streetsNear(41.8, -82.1)).resolves.toEqual({ streets: [], areas: [], sidewalks: [] });
    expect(net.calls.map((c) => c.url)).toEqual([OVERPASS_URL, OVERPASS_BACKUP_URL]);
    expect(net.calls[0].aborted()).toBe(true); // the stuck request was cancelled
  });

  it('counts a body that never finishes as a timeout too', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 'slow-body' : OK));
    await expect(client(net).streetsNear(41.8, -82.1)).resolves.toBeTruthy();
    expect(net.calls).toHaveLength(2);
  });

  it('says so plainly when both servers time out', async () => {
    const net = fakeNet(() => 'hang');
    await expect(client(net).streetsNear(41.8, -82.1)).rejects.toThrow(MESSAGES.timeout);
    expect(net.calls).toHaveLength(2);
  });

  it('uses a 20 second limit by default', async () => {
    vi.useFakeTimers();
    try {
      const net = fakeNet(() => 'hang');
      const c = new OverpassClient(net.fetch, new SessionCache('t.', null), { isOnline: () => true });
      const done = c.streetsNear(41.8, -82.1).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(net.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(net.calls).toHaveLength(2); // main gave up at 20 s; backup started
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await done).toBe(MESSAGES.timeout);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Overpass busy', () => {
  const BUSY = 'The street map service is busy. Wait a minute and try again.';

  it.each([
    ['429', 429],
    ['504', 504],
    ['a rate-limit page', { status: 200, body: '<html><p>rate_limited</p></html>' }],
    ['a "Too Many Requests" page', { status: 503, body: 'Too Many Requests' }],
    ['a JSON answer that stopped early', { body: JSON.stringify({ elements: [], remark: 'runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::rate_limited' }) }],
  ] as Array<[string, Answer]>)('treats %s as busy, tries the backup, then says busy', async (_, answer) => {
    const net = fakeNet(() => answer);
    await expect(client(net).streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
    expect(net.calls.map((c) => c.url)).toEqual([OVERPASS_URL, OVERPASS_BACKUP_URL]);
  });

  it('falls back to the backup when the main one is busy', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 429 : OK));
    await expect(client(net).streetsNear(41.8, -82.1)).resolves.toBeTruthy();
  });

  it('calls a refused request busy while the device is online (browsers hide the 429)', async () => {
    await expect(client(fakeNet(() => 'offline'), true).streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
  });

  it('says "check your connection" only when the device is offline', async () => {
    await expect(client(fakeNet(() => 'offline'), false).streetsNear(41.8, -82.1))
      .rejects.toThrow("Couldn't reach the street map. Check your connection and try again.");
  });

  it('prefers "busy" over "timed out" when one server did each', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 'hang' : 429));
    await expect(client(net).streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
  });
});

describe('address search and weather time limits', () => {
  const noWait = new Throttle(0);
  const photonOk = { body: JSON.stringify({ features: [{ geometry: { coordinates: [-82.1, 41.8] }, properties: { street: 'Elm Street' } }] }) };

  it('switches to Photon when Nominatim takes too long', async () => {
    const net = fakeNet((u) => (u.includes('nominatim') ? 'hang' : photonOk));
    const g = new FallbackGeocoder([
      new NominatimGeocoder(net.fetch, noWait, { timeoutMs: 30 }),
      new PhotonGeocoder(net.fetch, { timeoutMs: 30 }),
    ]);
    expect((await g.search(PLACEHOLDER_ADDRESS + ' (timeout test)'))?.source).toBe('Photon');
  });

  it('says address search is busy when both refuse, and "check your connection" only offline', async () => {
    const both = (online: boolean, a: Answer) => {
      const net = fakeNet(() => a);
      return new FallbackGeocoder([
        new NominatimGeocoder(net.fetch, noWait, { timeoutMs: 30, isOnline: () => online }),
        new PhotonGeocoder(net.fetch, { timeoutMs: 30, isOnline: () => online }),
      ]);
    };
    await expect(both(true, 429).search('busy test')).rejects.toThrow('Address search is busy. Wait a minute and try again.');
    await expect(both(true, 'hang').search('slow test')).rejects.toThrow("Address search didn't answer in time.");
    await expect(both(false, 'offline').search('offline test')).rejects.toThrow('Check your connection');
  });

  it('gives up on the weather after its time limit', async () => {
    const w = new WeatherClient(fakeNet(() => 'hang').fetch, 30);
    await expect(w.tonight(41.8, -82.1, '2026-10-31', 17, 20)).rejects.toThrow("Couldn't get the weather.");
  });
});
