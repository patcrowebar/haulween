// Street data from the OpenStreetMap Overpass API. One POST per plan, cached per rounded home
// point for the session. Overpass only ever sees the home point rounded to 3 decimals (~100 m).
// If the main server fails, is busy or takes longer than 20 seconds, the same request goes once
// to a backup server.

import { HOME_POINT_DECIMALS } from '../config';
import { fromOverpass } from '../route/osm';
import type { OsmData } from '../route/types';
import { RequestError, SessionCache, TimeoutError, browserIsOnline, fetchTextWithin, type FailKind } from './cache';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Used only when the main server fails or is busy. */
export const OVERPASS_BACKUP_URL = 'https://overpass.private.coffee/api/interpreter';
/** Enough streets for a 2 to 3 hour window. */
export const RADIUS_M = 900;

export function roundPoint(lat: number, lng: number, decimals = HOME_POINT_DECIMALS): [number, number] {
  const m = 10 ** decimals;
  return [Math.round(lat * m) / m, Math.round(lng * m) / m];
}

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

type Fetch = typeof fetch;

export const OVERPASS_TIMEOUT_MS = 20_000;

export const MESSAGES: Record<FailKind, string> = {
  busy: 'The street map service is busy. Wait a minute and try again.',
  timeout: "The street map service didn't answer in time. Wait a minute and try again.",
  offline: "Couldn't reach the street map. Check your connection and try again.",
  bad: "The street map sent something we couldn't read. Wait a minute and try again.",
};

/** Overpass says "rate_limited", "Too Many Requests" or reports a runtime error when it sheds load. */
const BUSY_TEXT = /rate.?limit|too many requests|runtime error|dispatcher/i;

export type OverpassOptions = { timeoutMs?: number; isOnline?: () => boolean };

export class OverpassClient {
  private cache: SessionCache<OsmData>;
  private inFlight = new Map<string, Promise<OsmData>>();

  private timeoutMs: number;
  private isOnline: () => boolean;

  constructor(private fetchFn: Fetch = (...a) => fetch(...a), cache?: SessionCache<OsmData>, options: OverpassOptions = {}) {
    this.cache = cache ?? new SessionCache<OsmData>('haulween.osm.');
    this.timeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS;
    this.isOnline = options.isOnline ?? browserIsOnline;
  }

  /** Streets around home. Takes the exact point and rounds it before anything leaves the device. */
  async streetsNear(lat: number, lng: number): Promise<OsmData> {
    const [rLat, rLng] = roundPoint(lat, lng);
    const key = `${rLat},${rLng}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetchStreets(rLat, rLng).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    const data = await request;
    this.cache.set(key, data);
    return data;
  }

  private async fetchStreets(lat: number, lng: number): Promise<OsmData> {
    let first: RequestError;
    try {
      return await this.ask(OVERPASS_URL, lat, lng);
    } catch (e) {
      first = e as RequestError;
    }
    try {
      return await this.ask(OVERPASS_BACKUP_URL, lat, lng);
    } catch (e) {
      const kinds = [first.kind, (e as RequestError).kind];
      // Tell the parent the most useful thing: offline beats busy beats slow beats garbled.
      const kind = (['offline', 'busy', 'timeout', 'bad'] as const).find((k) => kinds.includes(k))!;
      throw new RequestError(MESSAGES[kind], kind);
    }
  }

  /** One request to one server. Always throws a RequestError on failure. */
  private async ask(url: string, lat: number, lng: number): Promise<OsmData> {
    const fail = (kind: FailKind, status?: number) => new RequestError(MESSAGES[kind], kind, status);
    let res: Response, text: string;
    try {
      ({ res, text } = await fetchTextWithin(this.fetchFn, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lng)),
      }, this.timeoutMs));
    } catch (e) {
      if (e instanceof TimeoutError) throw fail('timeout');
      // A refusal (429 and friends) often arrives without CORS headers, which the browser reports
      // exactly like a dropped connection. If the device is online, it was the service.
      throw fail(this.isOnline() ? 'busy' : 'offline');
    }
    const isJson = text.trimStart().startsWith('{');
    if (res.status === 429 || res.status === 504 || (!isJson && BUSY_TEXT.test(text.slice(0, 2000)))) {
      throw fail('busy', res.status);
    }
    if (!res.ok) throw fail('bad', res.status);
    let body: { elements?: unknown[]; remark?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw fail('bad', res.status);
    }
    // A remark means Overpass stopped early: the streets may be incomplete, so don't plan on them.
    if (body.remark && BUSY_TEXT.test(body.remark)) throw fail('busy', res.status);
    if (!Array.isArray(body.elements)) throw fail('bad', res.status);
    return fromOverpass(body as Parameters<typeof fromOverpass>[0]);
  }
}
