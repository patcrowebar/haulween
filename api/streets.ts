// The one approved server-side piece: a Vercel function that fetches Haulween's own street query
// from Overpass.ch, so the Overpass.ch key stays in Vercel's settings (OVERPASS_KEY) and never
// reaches the browser, the repo or a log.
//
// It is not an Overpass proxy. It takes only a home point already rounded to 3 decimals and the
// plan's search radius, builds the one query the app uses, and rejects anything else. Overpass.ch's
// terms forbid reselling raw access; this gives none.
//
// Privacy: it logs nothing about requests (no IPs, points or timings). A failure is logged as a
// short category only, never with the request, the URL (the key is part of it) or an error object.
//
// Self-contained on purpose: Vercel runs this file as a Node ES module, where the app's
// extension-less imports don't resolve. The app imports the query from here instead, so there is
// one query, not two.

/** The plan's search radius: enough streets for a 2 to 3 hour window. */
export const RADIUS_M = 900;
/** The most the relay will accept. More would be a bigger query than any plan needs. */
export const MAX_RADIUS_M = 1500;
const MIN_RADIUS_M = 200;

/** The query from reference/street-lookup.md: named roads, parks, schools, churches, sidewalks. */
export function overpassQuery(lat: number, lng: number, radius = RADIUS_M): string {
  const around = `around:${radius},${lat},${lng}`;
  return `[out:json][timeout:60];
way(${around})[highway~"^(residential|living_street|unclassified|tertiary|secondary|primary|trunk)$"][name];out tags geom;
way(${around})[leisure~"^(park|pitch|playground|recreation_ground)$"];out tags geom;
way(${around})[amenity~"^(school|place_of_worship)$"];out tags geom;
way(${around})[landuse~"^(grass|recreation_ground|cemetery|commercial|retail)$"];out tags geom;
way(${around})[footway=sidewalk];out geom;`;
}

/** The relay's address for a point: the only form it accepts. */
export const relayPath = (lat: string, lng: string, radius: number) => `/api/streets?lat=${lat}&lng=${lng}&r=${radius}`;

/** Every relay answer carries this, so the app can tell the relay from a site with no relay. */
export const RELAY_HEADER = 'x-haulween-relay';

/** Upstream time limit: inside the function's 30 s and the app's 25 s wait for it. */
const UPSTREAM_MS = 22_000;
/** Vercel won't send a function response bigger than 4.5 MB. */
const MAX_BYTES = 4_400_000;
/** Cached by rounded point: 6 hours at Vercel's edge, an hour in the browser. */
const CACHE_OK = 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=3600';

export type RelayEnv = {
  key: string | undefined;
  fetch: typeof fetch;
  /** Origins allowed besides the relay's own (comma-separated in ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
  /** Where failure categories go. Never request details. */
  logError?: (category: string) => void;
};

function answer(status: number, body: string, cache: string, type = 'application/json'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': type, 'cache-control': cache, [RELAY_HEADER]: '1', 'x-content-type-options': 'nosniff' },
  });
}
const refuse = (status: number, reason: string) => answer(status, JSON.stringify({ error: reason }), 'no-store');

/** "41.800" with exactly 3 decimals, within range; anything else is refused. */
function coord(v: string | null, max: number): number | null {
  if (!v || !/^-?\d{1,3}\.\d{3}$/.test(v)) return null;
  const n = Number(v);
  return Math.abs(n) <= max ? n : null;
}

/**
 * The browser says where a request comes from (Origin, Sec-Fetch-Site). Anyone outside a browser
 * can fake both, so this only keeps other websites from using the relay from their visitors'
 * browsers. Overpass.ch's free-tier cap is the real backstop.
 */
function fromAllowedPage(request: Request, url: URL, allowed: string[]): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === url.origin || allowed.includes(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function handleStreets(request: Request, env: RelayEnv): Promise<Response> {
  const log = env.logError ?? (() => {});
  if (request.method !== 'GET') return refuse(405, 'method');
  const url = new URL(request.url);
  if (!fromAllowedPage(request, url, env.allowedOrigins ?? [])) return refuse(403, 'origin');

  // Exactly ?lat=…&lng=…&r=…, in that order and nothing more, so the cache can't be dodged.
  const lat = coord(url.searchParams.get('lat'), 90);
  const lng = coord(url.searchParams.get('lng'), 180);
  const r = Number(url.searchParams.get('r'));
  const canonical = lat !== null && lng !== null && Number.isInteger(r) && r >= MIN_RADIUS_M && r <= MAX_RADIUS_M
    && url.search === `?lat=${url.searchParams.get('lat')}&lng=${url.searchParams.get('lng')}&r=${r}`;
  if (!canonical) return refuse(400, 'input');

  if (!env.key) return refuse(501, 'not-configured');

  let res: Response, text: string;
  try {
    res = await env.fetch(`https://api.overpass.ch/v1/${env.key}/interpreter`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(overpassQuery(lat!, lng!, r)),
      signal: AbortSignal.timeout(UPSTREAM_MS),
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    log(timedOut ? 'upstream timeout' : 'upstream unreachable');
    return refuse(timedOut ? 504 : 502, timedOut ? 'upstream-timeout' : 'upstream-unreachable');
  }
  if (!res.ok) {
    log(`upstream status ${res.status}`);
    // 429 and 406 pass through, so the app knows not to retry; anything else is a bad gateway.
    const status = res.status === 429 || res.status === 406 || res.status === 504 ? res.status : 502;
    return refuse(status, 'upstream-status');
  }
  let body: { elements?: unknown; remark?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    log('upstream unreadable');
    return refuse(502, 'upstream-unreadable');
  }
  // Never cache an answer that stopped early: its streets may be incomplete.
  if (!Array.isArray(body.elements) || (typeof body.remark === 'string' && /error|limit|timed out/i.test(body.remark))) {
    log('upstream incomplete');
    return refuse(502, 'upstream-incomplete');
  }
  const compact = JSON.stringify({ elements: body.elements });
  if (compact.length > MAX_BYTES) {
    log('answer too large');
    return refuse(502, 'too-large');
  }
  return answer(200, compact, CACHE_OK);
}

type Env = { OVERPASS_KEY?: string; ALLOWED_ORIGINS?: string };
const processEnv = (): Env => (globalThis as { process?: { env: Env } }).process?.env ?? {};

/** Vercel's entry point. */
export function GET(request: Request): Promise<Response> {
  const env = processEnv();
  return handleStreets(request, {
    key: env.OVERPASS_KEY,
    fetch,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logError: (category) => console.error(`streets relay: ${category}`),
  });
}
