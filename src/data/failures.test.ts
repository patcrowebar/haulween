// What the clients do when the network is slow, busy or gone. All with a fake network.
import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from './cache';
import { FallbackGeocoder, NominatimGeocoder, PhotonGeocoder, Throttle } from './geocoder';
import { MESSAGES, OVERPASS_BACKUP_URL, OVERPASS_URL, OverpassClient, errorText, type Attempt } from './overpass';
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

describe('Overpass failures, each with its own words', () => {
  const BUSY = 'The street map service is busy. Wait a minute and try again.';
  /** The plain-text page overpass-api.de sends with a 502 (shortened), as WebKit got it. */
  const GATEWAY_PAGE = '# 502 Gateway Timeout\n\nThis Overpass API server is currently overloaded. The dispatcher gave up. runtime error.';

  it.each([['429', 429], ['504', 504]] as Array<[string, Answer]>)('says "busy" only for a real %s, after trying the backup', async (_, answer) => {
    const net = fakeNet(() => answer);
    await expect(client(net).streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
    expect(net.calls.map((c) => c.url)).toEqual([OVERPASS_URL, OVERPASS_BACKUP_URL]);
  });

  it('what Safari hit: a 502 error page, then a backup that never answers, is not "busy"', async () => {
    // Before, the page's words ("dispatcher", "runtime error") made this "busy", and "busy"
    // outranked the backup's time-out, so Safari always said the service was busy.
    const net = fakeNet((u) => (u === OVERPASS_URL ? { status: 502, body: GATEWAY_PAGE } : 'hang'));
    const err = await client(net).streetsNear(41.8, -82.1).catch((e: Error) => e);
    expect((err as Error).message).toBe(MESSAGES.down);
    expect((err as Error).message).not.toBe(BUSY);
  });

  it.each([
    ['a 502 error page', { status: 502, body: GATEWAY_PAGE }],
    ['a 503', 503],
    ['a 200 with an HTML error page', { status: 200, body: '<html><p>rate_limited</p></html>' }],
    ['a JSON answer that stopped early', { body: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' }) }],
  ] as Array<[string, Answer]>)('calls %s "having trouble", not busy', async (_, answer) => {
    await expect(client(fakeNet(() => answer)).streetsNear(41.8, -82.1)).rejects.toThrow(MESSAGES.down);
  });

  it('says a request that got no answer at all ("Load failed") is unanswered, not busy', async () => {
    const net = fakeNet(() => 'offline'); // fetch rejects with a TypeError, as Safari and Chrome do
    await expect(client(net, true).streetsNear(41.8, -82.1)).rejects.toThrow(MESSAGES.unreachable);
  });

  it('says "check your connection" only when the device is offline', async () => {
    await expect(client(fakeNet(() => 'offline'), false).streetsNear(41.8, -82.1))
      .rejects.toThrow("Couldn't reach the street map. Check your connection and try again.");
  });

  it('falls back to the backup when the main one is busy', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 429 : OK));
    await expect(client(net).streetsNear(41.8, -82.1)).resolves.toBeTruthy();
  });

  it('a real "busy" from one server still wins over a time-out from the other', async () => {
    const net = fakeNet((u) => (u === OVERPASS_URL ? 'hang' : 429));
    await expect(client(net).streetsNear(41.8, -82.1)).rejects.toThrow(BUSY);
  });
});

describe('?debug: what each street-data request did', () => {
  it('reports the server, status, time and error type, with no query or coordinates', async () => {
    const attempts: Attempt[] = [];
    const net = fakeNet((u) => (u === OVERPASS_URL ? { status: 502, body: 'x' } : 'offline'));
    const c = new OverpassClient(net.fetch, new SessionCache('t.', null), { timeoutMs: 30, isOnline: () => true, onAttempt: (a) => attempts.push(a) });
    await c.streetsNear(41.8, -82.1).catch(() => {});
    expect(attempts).toEqual([
      { server: 'overpass-api.de', status: 502, ms: expect.any(Number), outcome: 'down', error: null, bytes: 1 },
      { server: 'overpass.private.coffee', status: null, ms: expect.any(Number), outcome: 'unreachable', error: 'TypeError: Failed to fetch', bytes: null },
    ]);
    expect(JSON.stringify(attempts)).not.toMatch(/41\.8|82\.1|around/);
  });

  it('reports a time-out as a TimeoutError', async () => {
    const attempts: Attempt[] = [];
    const net = fakeNet((u) => (u === OVERPASS_URL ? 'hang' : OK));
    await new OverpassClient(net.fetch, new SessionCache('t.', null), { timeoutMs: 30, onAttempt: (a) => attempts.push(a) }).streetsNear(41.8, -82.1);
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
