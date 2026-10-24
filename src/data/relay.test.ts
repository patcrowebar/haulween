// The street-data relay (api/streets.ts), with a fake Overpass.ch and a made-up key. It must only
// ever send Haulween's own query for one rounded point, and never show the key anywhere.
import { describe, expect, it, vi } from 'vitest';
import { MAX_RADIUS_M, RADIUS_M, handleStreets, overpassQuery, relayPath, type RelayEnv } from '../../api/streets';

const KEY = 'made-up-test-key-123';
const SITE = 'https://haulween.vercel.app';
const ok = () => new Response(JSON.stringify({ version: 0.6, elements: [{ type: 'way', tags: { name: 'Elm St' } }] }, null, 2), { status: 200 });

function setup(upstream: () => Response | Promise<Response> = ok, env: Partial<RelayEnv> = {}) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => upstream());
  const logged: string[] = [];
  const call = (path: string, headers: Record<string, string> = { origin: SITE }, method = 'GET') =>
    handleStreets(new Request(SITE + path, { method, headers }), {
      key: KEY, fetch: fetchFn as unknown as typeof fetch, logError: (c) => logged.push(c), ...env,
    });
  return { fetchFn, logged, call };
}
const good = relayPath('41.800', '-82.100', RADIUS_M);

describe('the relay takes only a rounded point and a radius', () => {
  it.each([
    ['too many decimals', '/api/streets?lat=41.8001&lng=-82.100&r=900'],
    ['too few decimals', '/api/streets?lat=41.8&lng=-82.1&r=900'],
    ['a point out of range', '/api/streets?lat=91.000&lng=-82.100&r=900'],
    ['a radius over the maximum', `/api/streets?lat=41.800&lng=-82.100&r=${MAX_RADIUS_M + 1}`],
    ['a tiny radius', '/api/streets?lat=41.800&lng=-82.100&r=10'],
    ['a fractional radius', '/api/streets?lat=41.800&lng=-82.100&r=900.5'],
    ['the fields in another order', '/api/streets?lng=-82.100&lat=41.800&r=900'],
    ['an extra field', '/api/streets?lat=41.800&lng=-82.100&r=900&x=1'],
    ['a raw query', `/api/streets?data=${encodeURIComponent('[out:json];node(1);out;')}`],
    ['a raw query beside a point', `/api/streets?lat=41.800&lng=-82.100&r=900&data=${encodeURIComponent('node(1);out;')}`],
    ['nothing at all', '/api/streets'],
  ])('refuses %s, and never asks Overpass', async (_, path) => {
    const { call, fetchFn } = setup();
    const res = await call(path);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses anything but GET', async () => {
    const { call, fetchFn } = setup();
    expect((await call(good, { origin: SITE }, 'POST')).status).toBe(405);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends exactly the app's query, for that point and radius", async () => {
    const { call, fetchFn } = setup();
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`https://api.overpass.ch/v1/${KEY}/interpreter`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('data=' + encodeURIComponent(overpassQuery(41.8, -82.1, RADIUS_M)));
  });
});

describe('who may use it', () => {
  it('refuses another site (in a browser; outside one, this can be faked)', async () => {
    const { call, fetchFn } = setup();
    expect((await call(good, { origin: 'https://example.com' })).status).toBe(403);
    expect((await call(good, {})).status).toBe(403); // no Origin, no Sec-Fetch-Site: not our page
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows its own site, same-origin requests and listed origins', async () => {
    const { call } = setup(ok, { allowedOrigins: ['https://haulween-fork.example'] });
    expect((await call(good, { origin: SITE })).status).toBe(200);
    expect((await call(good, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call(good, { origin: 'https://haulween-fork.example' })).status).toBe(200);
  });
});

describe('with no key set up', () => {
  it('says so, and the app moves on to the free servers', async () => {
    const { call, fetchFn } = setup(ok, { key: undefined });
    const res = await call(good);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not-configured' });
    expect(res.headers.get('x-haulween-relay')).toBe('1');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('answers and caching', () => {
  it('caches a good answer by point for hours, compacted', async () => {
    const { call } = setup();
    const res = await call(good);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=21600, stale-while-revalidate=3600');
    expect(await res.text()).toBe('{"elements":[{"type":"way","tags":{"name":"Elm St"}}]}');
  });

  it.each([
    ['a 429', () => new Response('slow down', { status: 429 }), 429],
    ['a 406', () => new Response('no', { status: 406 }), 406],
    ['a 500', () => new Response('oops', { status: 500 }), 502],
    ['an error page', () => new Response('<html>down</html>', { status: 200 }), 502],
    ['an answer cut short', () => new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' })), 502],
    ['no answer', () => Promise.reject(new TypeError('fetch failed')), 502],
    ['a time-out', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 504],
  ])('passes on %s as %i, never cached', async (_, upstream, status) => {
    const { call } = setup(upstream);
    const res = await call(good);
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('privacy: the key and the point stay out of answers and logs', () => {
  it.each([
    ['a good answer', ok],
    ['a failure', () => Promise.reject(new TypeError(`request to https://api.overpass.ch/v1/${KEY}/interpreter failed`))],
    ['an upstream error', () => new Response(`bad key ${KEY}`, { status: 500 })],
  ])('%s', async (_, upstream) => {
    const { call, logged } = setup(upstream as () => Response);
    const res = await call(good);
    const seen = JSON.stringify([...res.headers]) + (await res.text()) + logged.join('\n');
    expect(seen).not.toContain(KEY);
    for (const line of logged) expect(line).not.toMatch(/41\.8|82\.1|lat=|haulween\.vercel/);
  });

  it('logs nothing at all for a good answer', async () => {
    const { call, logged } = setup();
    await call(good);
    expect(logged).toEqual([]);
  });
});
