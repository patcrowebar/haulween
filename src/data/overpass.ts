// Street data from the OpenStreetMap Overpass API. One POST per plan, cached per rounded home
// point for the session. Overpass only ever sees the home point rounded to 3 decimals (~100 m).
// If the main server fails, is busy or takes longer than 20 seconds, the same request goes once
// to a backup server.

import { HOME_POINT_DECIMALS } from '../config';
import { fromOverpass } from '../route/osm';
import type { OsmData } from '../route/types';
import {
  RequestError, SessionCache, TimeoutError, browserIsOnline, fetchTextWithin, worstOf, type FailKind,
} from './cache';

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
  down: 'The street map service is having trouble right now. Try again in a few minutes.',
  unreachable: "Couldn't get an answer from the street map service. Try again in a minute, or on another network.",
  timeout: "The street map service didn't answer in time. Wait a minute and try again.",
  offline: "Couldn't reach the street map. Check your connection and try again.",
  bad: "The street map sent something we couldn't read. Wait a minute and try again.",
};

/** One request to one server, for ?debug. Never the query, the address or coordinates. */
export type Attempt = {
  server: string;
  /** HTTP status, or null when no answer reached the page. */
  status: number | null;
  ms: number;
  outcome: 'ok' | 'saved' | FailKind;
  /** The browser's error type ("TypeError", "TimeoutError"), and its words when they're safe to show. */
  error: string | null;
  bytes: number | null;
};

export type OverpassOptions = { timeoutMs?: number; isOnline?: () => boolean; onAttempt?: (a: Attempt) => void };

/** An error's type and, if it's plain words (no digits, so no coordinates), its message. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const msg = e.message.trim();
  return /^[A-Za-z][A-Za-z ,.'()-]{0,79}$/.test(msg) ? `${e.name}: ${msg}` : e.name;
}

export class OverpassClient {
  private cache: SessionCache<OsmData>;
  private inFlight = new Map<string, Promise<OsmData>>();

  private timeoutMs: number;
  private isOnline: () => boolean;
  private onAttempt: (a: Attempt) => void;

  constructor(private fetchFn: Fetch = (...a) => fetch(...a), cache?: SessionCache<OsmData>, options: OverpassOptions = {}) {
    this.cache = cache ?? new SessionCache<OsmData>('haulween.osm.');
    this.timeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS;
    this.isOnline = options.isOnline ?? browserIsOnline;
    this.onAttempt = options.onAttempt ?? (() => {});
  }

  /** Streets around home. Takes the exact point and rounds it before anything leaves the device. */
  async streetsNear(lat: number, lng: number): Promise<OsmData> {
    const [rLat, rLng] = roundPoint(lat, lng);
    const key = `${rLat},${rLng}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.onAttempt({ server: 'saved in this tab', status: null, ms: 0, outcome: 'saved', error: null, bytes: null });
      return hit;
    }
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
      const kind = worstOf([first.kind, (e as RequestError).kind]);
      throw new RequestError(MESSAGES[kind], kind);
    }
  }

  /** One request to one server, timed and reported for ?debug. */
  private async ask(url: string, lat: number, lng: number): Promise<OsmData> {
    const t0 = Date.now();
    const report = (outcome: Attempt['outcome'], status: number | null, error: string | null, bytes: number | null) =>
      this.onAttempt({ server: new URL(url).host, status, ms: Date.now() - t0, outcome, error, bytes });
    try {
      const out = await this.askOnce(url, lat, lng);
      report('ok', out.status, null, out.bytes);
      return out.data;
    } catch (e) {
      const r = e as RequestError & { cause?: unknown; bytes?: number };
      report(r.kind, r.status ?? null, r.cause === undefined ? null : errorText(r.cause), r.bytes ?? null);
      throw e;
    }
  }

  /** One request to one server. Always throws a RequestError on failure. */
  private async askOnce(url: string, lat: number, lng: number): Promise<{ data: OsmData; status: number; bytes: number }> {
    let text = '';
    const fail = (kind: FailKind, status?: number, cause?: unknown) =>
      Object.assign(new RequestError(MESSAGES[kind], kind, status), { cause, bytes: text.length || undefined });
    let res: Response;
    try {
      ({ res, text } = await fetchTextWithin(this.fetchFn, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lng)),
      }, this.timeoutMs));
    } catch (e) {
      if (e instanceof TimeoutError) throw fail('timeout', undefined, e);
      // No answer reached the page. A refusal can look like this (some arrive without CORS
      // headers), but so can a block or a dropped connection, so it isn't called "busy".
      throw fail(this.isOnline() ? 'unreachable' : 'offline', undefined, e);
    }
    // "Busy" means exactly what the service said: 429 Too Many Requests or 504 Gateway Timeout.
    if (res.status === 429 || res.status === 504) throw fail('busy', res.status);
    if (res.status >= 500) throw fail('down', res.status);
    if (!res.ok) throw fail('bad', res.status);
    let body: { elements?: unknown[]; remark?: string };
    try {
      body = JSON.parse(text);
    } catch (e) {
      // An error page instead of data (Overpass sends plain text or HTML when it's struggling).
      throw fail(text.trimStart().startsWith('{') ? 'bad' : 'down', res.status, e);
    }
    // A remark means Overpass stopped early (out of time or memory, or shedding load): the
    // streets may be incomplete, so don't plan on them.
    if (body.remark && /error|limit|timed out|dispatcher/i.test(body.remark)) throw fail('down', res.status);
    if (!Array.isArray(body.elements)) throw fail('bad', res.status);
    return { data: fromOverpass(body as Parameters<typeof fromOverpass>[0]), status: res.status, bytes: text.length };
  }
}
