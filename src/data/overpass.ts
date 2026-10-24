// Street data from the OpenStreetMap Overpass API. One POST per plan, cached per rounded home
// point for the session. Overpass only ever sees the home point rounded to 3 decimals (~100 m).
//
// Servers are asked one at a time, never in parallel. A server that fails fast gets one more
// try after a short pause; then the next server. Everything together stops after about 45 s.
//
// Not overpass-api.de. Its operator (FOSSGIS) asks fast-deployed AI-generated apps not to use it
// (wiki.openstreetmap.org/wiki/Overpass_API), and it answers this site's requests with
// 406 Not Acceptable. Leaving out the Referer would get past that, but only by hiding who's
// asking, so Haulween uses servers that welcome any project instead, and keeps identifying itself.

import { HOME_POINT_DECIMALS } from '../config';
import { fromOverpass } from '../route/osm';
import type { OsmData } from '../route/types';
import {
  RequestError, SessionCache, TimeoutError, browserIsOnline, fetchTextWithin, worstOf, type FailKind,
} from './cache';

/**
 * Public servers, in the order they're asked. Both are global, free and open to any project with
 * no rate limit (OSM wiki, October 2026), and both send CORS headers. VK Maps goes first: when
 * it's struggling it says so at once, in a way the browser can read, so moving on costs little.
 */
export const OVERPASS_SERVERS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', // VK Maps
  'https://overpass.private.coffee/api/interpreter', // Private.coffee
] as const;
/** Never asked: its operator asks apps like this one not to (see above). */
export const RETIRED_SERVER = 'https://overpass-api.de/api/interpreter';
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

/**
 * Longest wait for one server. Not lower: a normal answer took 39 s on a busy afternoon, and a
 * dense neighborhood is a bigger query than that one.
 */
export const OVERPASS_TIMEOUT_MS = 25_000;
/** Longest wait for street data in all, across every server and retry. */
export const OVERPASS_TOTAL_MS = 45_000;
/** A failure this quick is often a hiccup: worth one more try after RETRY_PAUSE_MS. */
const FAST_FAIL_MS = 3_000;
const RETRY_PAUSE_MS = 2_500;
/** Not worth starting a request with less time than this left. */
const MIN_TRY_MS = 3_000;

/** When every server failed: what to do, in plain words. */
export const ALL_FAILED = "We couldn't get the street map from any of the free map servers right now. Try again in a few minutes.";

export const MESSAGES: Record<FailKind, string> = {
  busy: 'The street map servers are busy right now. Try again in a few minutes.',
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

export type OverpassOptions = {
  servers?: readonly string[];
  /** Per server, and in all. */
  timeoutMs?: number;
  totalMs?: number;
  retryPauseMs?: number;
  isOnline?: () => boolean;
  onAttempt?: (a: Attempt) => void;
  /** Words for the button while it works, like "Trying another map server…". */
  onProgress?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** An error's type and, if it's plain words (no digits, so no coordinates), its message. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const msg = e.message.trim();
  return /^[A-Za-z][A-Za-z ,.'()-]{0,79}$/.test(msg) ? `${e.name}: ${msg}` : e.name;
}

export class OverpassClient {
  private cache: SessionCache<OsmData>;
  private inFlight = new Map<string, Promise<OsmData>>();

  private servers: readonly string[];
  private timeoutMs: number;
  private totalMs: number;
  private retryPauseMs: number;
  private isOnline: () => boolean;
  private onAttempt: (a: Attempt) => void;
  private onProgress: (text: string) => void;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private fetchFn: Fetch = (...a) => fetch(...a), cache?: SessionCache<OsmData>, options: OverpassOptions = {}) {
    this.cache = cache ?? new SessionCache<OsmData>('haulween.osm.');
    this.servers = options.servers ?? OVERPASS_SERVERS;
    this.timeoutMs = options.timeoutMs ?? OVERPASS_TIMEOUT_MS;
    this.totalMs = options.totalMs ?? OVERPASS_TOTAL_MS;
    this.retryPauseMs = options.retryPauseMs ?? RETRY_PAUSE_MS;
    this.isOnline = options.isOnline ?? browserIsOnline;
    this.onAttempt = options.onAttempt ?? (() => {});
    this.onProgress = options.onProgress ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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

  /** Each server in turn, one retry for a quick failure, all within the total time limit. */
  private async fetchStreets(lat: number, lng: number): Promise<OsmData> {
    const deadline = this.now() + this.totalMs;
    const kinds: FailKind[] = [];
    for (const [i, url] of this.servers.entries()) {
      if (i > 0) this.onProgress('Trying another map server…');
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - this.now();
        if (left < Math.min(MIN_TRY_MS, this.totalMs)) return this.giveUp(kinds);
        const started = this.now();
        try {
          return await this.ask(url, lat, lng, Math.min(this.timeoutMs, left));
        } catch (e) {
          const err = e as RequestError;
          kinds.push(err.kind);
          if (err.kind === 'offline') return this.giveUp(kinds);
          // One more try only for a quick failure that a moment might fix. Never for a 429 (the
          // server asked us to slow down) or an answer it can't give (4xx, unreadable).
          const quick = this.now() - started < FAST_FAIL_MS;
          const passing = err.kind === 'down' || err.kind === 'unreachable' || (err.kind === 'busy' && err.status === 504);
          if (attempt > 0 || !quick || !passing) break;
          this.onProgress('Trying that map server again…');
          await this.sleep(this.retryPauseMs);
        }
      }
    }
    return this.giveUp(kinds);
  }

  /** Every server failed. Offline or a real "busy" get their own words; anything else, try later. */
  private giveUp(kinds: FailKind[]): never {
    if (kinds.includes('offline')) throw new RequestError(MESSAGES.offline, 'offline');
    if (kinds.length && kinds.every((k) => k === 'busy')) throw new RequestError(MESSAGES.busy, 'busy');
    throw new RequestError(ALL_FAILED, worstOf(kinds));
  }

  /** One request to one server, timed and reported for ?debug. */
  private async ask(url: string, lat: number, lng: number, timeoutMs: number): Promise<OsmData> {
    const t0 = this.now();
    const report = (outcome: Attempt['outcome'], status: number | null, error: string | null, bytes: number | null) =>
      this.onAttempt({ server: new URL(url).host, status, ms: this.now() - t0, outcome, error, bytes });
    try {
      const out = await this.askOnce(url, lat, lng, timeoutMs);
      report('ok', out.status, null, out.bytes);
      return out.data;
    } catch (e) {
      const r = e as RequestError & { cause?: unknown; bytes?: number };
      report(r.kind, r.status ?? null, r.cause === undefined ? null : errorText(r.cause), r.bytes ?? null);
      throw e;
    }
  }

  /** One request to one server. Always throws a RequestError on failure. */
  private async askOnce(url: string, lat: number, lng: number, timeoutMs: number): Promise<{ data: OsmData; status: number; bytes: number }> {
    let text = '';
    const fail = (kind: FailKind, status?: number, cause?: unknown) =>
      Object.assign(new RequestError(MESSAGES[kind], kind, status), { cause, bytes: text.length || undefined });
    let res: Response;
    try {
      ({ res, text } = await fetchTextWithin(this.fetchFn, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lng)),
        // The browser's default: the server sees which site is asking (the site's origin, never a
        // page address). Overpass operators ask apps to identify themselves; Haulween does.
        referrerPolicy: 'strict-origin-when-cross-origin',
      }, timeoutMs));
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
