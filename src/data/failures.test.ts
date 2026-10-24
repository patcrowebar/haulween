// What the clients do when the network is slow, busy or gone. All with a fake network.
import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from './cache';
import { FallbackGeocoder, NominatimGeocoder, PhotonGeocoder, Throttle } from './geocoder';
import {
  ALL_FAILED, OVERPASS_SERVERS, OVERPASS_TIMEOUT_MS, OVERPASS_TOTAL_MS, OverpassClient, RETIRED_SERVER, errorText, type Attempt,
} from './overpass';
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
const A = 'https://a.test/api/interpreter';
const B = 'https://b.test/api/interpreter';
const C = 'https://c.test/api/interpreter';

/** Fake servers A, B, C; tiny time limits; no real pauses. */
function client(net: ReturnType<typeof fakeNet>, o: { online?: boolean; servers?: string[]; timeoutMs?: number; totalMs?: number } = {}) {
  const progress: string[] = [];
  const attempts: Attempt[] = [];
  const c = new OverpassClient(net.fetch, new SessionCache('t.', null), {
    servers: o.servers ?? [A, B], timeoutMs: o.timeoutMs ?? 30, totalMs: o.totalMs ?? 5_000,
    isOnline: () => o.online ?? true, sleep: async () => {}, onProgress: (t) => progress.push(t), onAttempt: (a) => attempts.push(a),
  });
  return { c, progress, attempts };
}
const hosts = (net: ReturnType<typeof fakeNet>) => net.calls.map((x) => new URL(x.url).host[0]);

describe('the request overpass-api.de refused', () => {
  it("isn't sent there at all", () => {
    expect(OVERPASS_SERVERS).not.toContain(RETIRED_SERVER);
  });

  it('a 406 refusal is never retried; the next server is asked', async () => {
    // overpass-api.de answered this site's exact request with 406 Not Acceptable, in 0.4 s.
    const net = fakeNet((u) => (u === A ? { status: 406, body: '<html>406 Not Acceptable</html>' } : OK));
    const { c } = client(net);
    await expect(c.streetsNear(41.8, -82.1)).resolves.toBeTruthy();
    expect(hosts(net)).toEqual(['a', 'b']);
  });

  it('a refusal the browser hides (no CORS headers: "Failed to fetch") is retried once, then the next', async () => {
    const net = fakeNet((u) => (u === A ? 'offline' : OK)); // fetch rejects with a TypeError
    const { c, attempts } = client(net);
    await c.streetsNear(41.8, -82.1);
    expect(hosts(net)).toEqual(['a', 'a', 'b']);
    expect(attempts.map((a) => a.outcome)).toEqual(['unreachable', 'unreachable', 'ok']);
  });
});

describe('when map servers fail', () => {
  it('the first fails fast, then works on the retry', async () => {
    let n = 0;
    const net = fakeNet((u) => (u === A && n++ === 0 ? { status: 502, body: 'Gateway Timeout' } : OK));
    const { c, progress } = client(net);
    await expect(c.streetsNear(41.8, -82.1)).resolves.toBeTruthy();
    expect(hosts(net)).toEqual(['a', 'a']);
    expect(progress).toEqual(['Trying that map server again…']);
  });

  it('the first fails, the second hangs, the third works', async () => {
    const net = fakeNet((u) => (u === A ? { status: 502, body: 'x' } : u === B ? 'hang' : OK));
    const { c, progress, attempts } = client(net, { servers: [A, B, C] });
    await expect(c.streetsNear(41.8, -82.1)).resolves.toBeTruthy();
    expect(hosts(net)).toEqual(['a', 'a', 'b', 'c']); // a hang isn't a quick failure: no retry
    expect(net.calls[2].aborted()).toBe(true); // the stuck request was cancelled
    expect(progress).toEqual(['Trying that map server again…', 'Trying another map server…', 'Trying another map server…']);
    expect(attempts.map((a) => a.outcome)).toEqual(['down', 'down', 'timeout', 'ok']);
  });

  it('everything fails: plain words to try again in a few minutes', async () => {
    const net = fakeNet((u) => (u === A ? { status: 502, body: 'x' } : u === B ? 'hang' : 'offline'));
    const { c } = client(net, { servers: [A, B, C] });
    await expect(c.streetsNear(41.8, -82.1)).rejects.toThrow(ALL_FAILED);
  });

  it('never asks two servers at once', async () => {
    let inFlight = 0, most = 0;
    const net = fakeNet(() => 'hang');
    const tracked = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      inFlight++;
      most = Math.max(most, inFlight);
      return net.fetch(url, init).finally(() => { inFlight--; });
    });
    const c = new OverpassClient(tracked as unknown as typeof fetch, new SessionCache('t.', null), {
      servers: [A, B, C], timeoutMs: 20, totalMs: 1_000, sleep: async () => {}, isOnline: () => true,
    });
    await c.streetsNear(41.8, -82.1).catch(() => {});
    expect(most).toBe(1);
  });

  it('stops after the total time limit, however many servers are left', async () => {
    const net = fakeNet(() => 'hang');
    const { c } = client(net, { servers: [A, B, C], timeoutMs: 40, totalMs: 60 });
    const t0 = Date.now();
    await expect(c.streetsNear(41.8, -82.1)).rejects.toThrow(ALL_FAILED);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(net.calls.length).toBeLessThanOrEqual(2);
  });

  it('uses 25 s per server and 45 s in all by default', async () => {
    expect(OVERPASS_TIMEOUT_MS).toBe(25_000);
    expect(OVERPASS_TOTAL_MS).toBe(45_000);
    vi.useFakeTimers();
    try {
      const net = fakeNet(() => 'hang');
      const c = new OverpassClient(net.fetch, new SessionCache('t.', null), { isOnline: () => true });
      const done = c.streetsNear(41.8, -82.1).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(24_999);
      expect(net.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(net.calls).toHaveLength(2); // first gave up at 25 s; the next started
      await vi.advanceTimersByTimeAsync(20_000); // the second gets only what's left of 45 s
      expect(await done).toBe(ALL_FAILED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a body that never finishes as a time-out too', async () => {
    const net = fakeNet((u) => (u === A ? 'slow-body' : OK));
    await expect(client(net).c.streetsNear(41.8, -82.1)).resolves.toBeTruthy();
    expect(hosts(net)).toEqual(['a', 'b']);
  });
});

describe('Overpass failures, each with its own words', () => {
  const BUSY = 'The street map servers are busy right now. Try again in a few minutes.';

  it.each([['429', 429], ['504', 504]] as Array<[string, Answer]>)('says "busy" only when every server sent a real %s', async (_, answer) => {
    await expect(client(fakeNet(() => answer)).c.streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
  });

  it.each([
    ['a 502 error page', { status: 502, body: '# 502 Gateway Timeout. The dispatcher gave up. runtime error.' }],
    ['a 503', 503],
    ['a 200 with an HTML error page', { status: 200, body: '<html><p>rate_limited</p></html>' }],
    ['a JSON answer that stopped early', { body: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' }) }],
    ['no answer at all', 'offline'],
  ] as Array<[string, Answer]>)('never calls %s "busy"', async (_, answer) => {
    const err = await client(fakeNet(() => answer)).c.streetsNear(41.8, -82.1).catch((e: Error) => e);
    expect((err as Error).message).toBe(ALL_FAILED);
  });

  it('says "check your connection" when the device is offline, without trying the rest', async () => {
    const net = fakeNet(() => 'offline');
    await expect(client(net, { online: false }).c.streetsNear(41.8, -82.1))
      .rejects.toThrow("Couldn't reach the street map. Check your connection and try again.");
    expect(net.calls).toHaveLength(1);
  });
});

describe('?debug: what each street-data request did', () => {
  it('reports the server, status, time and error type, with no query or coordinates', async () => {
    const net = fakeNet((u) => (u === A ? { status: 502, body: 'x' } : 'offline'));
    const { c, attempts } = client(net);
    await c.streetsNear(41.8, -82.1).catch(() => {});
    expect(attempts[0]).toEqual({ server: 'a.test', status: 502, ms: expect.any(Number), outcome: 'down', error: null, bytes: 1 });
    expect(attempts[2]).toEqual({ server: 'b.test', status: null, ms: expect.any(Number), outcome: 'unreachable', error: 'TypeError: Failed to fetch', bytes: null });
    expect(JSON.stringify(attempts)).not.toMatch(/41\.8|82\.1|around/);
  });

  it('reports a time-out as a TimeoutError', async () => {
    const net = fakeNet((u) => (u === A ? 'hang' : OK));
    const { c, attempts } = client(net);
    await c.streetsNear(41.8, -82.1);
    expect(attempts.map((a) => [a.outcome, a.error])).toEqual([['timeout', 'TimeoutError'], ['ok', null]]);
  });

  it('never shows an error message that has numbers in it', () => {
    expect(errorText(new TypeError('Load failed'))).toBe('TypeError: Load failed');
    expect(errorText(new Error('bad point 41.8, -82.1'))).toBe('Error');
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
