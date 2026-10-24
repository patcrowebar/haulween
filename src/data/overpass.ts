// Street data from OpenStreetMap through Overpass. One successful request per plan, cached per
// rounded home point for the session. Overpass only ever sees the home point rounded to
// 3 decimals (~100 m), never the address.
//
// Asked in turn, never in parallel, at most 4 attempts and about 45 s in all:
//   1. Haulween's relay (api/streets.ts), which asks Overpass.ch with a key kept in Vercel.
//      A site without it (a fork, or local development) just skips it.
//   2. Private.coffee, directly from the browser.
// A server that fails fast gets one more try after a short pause; a 406 or 429 never does.
//
// Not used: overpass-api.de, whose operator (FOSSGIS) asks apps on fast-deploy platforms not to
// use it, and which refuses this site with 406 (leaving out the Referer would get past that, but
// only by hiding who's asking); and VK Maps, operated in Russia. Haulween never uses services
// operated in Russia.

import { HOME_POINT_DECIMALS } from '../config';
import { fromOverpass } from '../route/osm';
import type { OsmData } from '../route/types';
import { RADIUS_M, RELAY_HEADER, overpassQuery, relayPath } from '../../api/streets';
import {
  RequestError, SessionCache, TimeoutError, browserIsOnline, fetchTextWithin, worstOf, type FailKind,
} from './cache';

export { RADIUS_M, overpassQuery };

export type Server = { label: string; url: string; relay?: boolean };

/** Haulween's own relay, on the same site. Only ever sees the rounded point and radius. */
export const RELAY: Server = { label: 'Haulween relay (Overpass.ch)', url: '/api/streets', relay: true };
/** Global, free, open to any project with no rate limit (OSM wiki, October 2026), sends CORS headers. */
export const PRIVATE_COFFEE: Server = { label: 'overpass.private.coffee', url: 'https://overpass.private.coffee/api/interpreter' };

/** In the order they're asked. */
export const OVERPASS_SERVERS: readonly Server[] = [RELAY, PRIVATE_COFFEE];

/** Never asked, with why. */
export const NOT_USED = {
  'https://overpass-api.de/api/interpreter': "its operator's policy excludes apps on fast-deploy platforms",
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter': 'operated in Russia',
} as const;

/** Most requests for one plan, across every server and retry. */
export const MAX_ATTEMPTS = 4;

export function roundPoint(lat: number, lng: number, decimals = HOME_POINT_DECIMALS): [number, number] {
  const m = 10 ** decimals;
  return [Math.round(lat * m) / m, Math.round(lng * m) / m];
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

/** One request to one server, for ?debug. Never the query, the address, coordinates or a key. */
export type Attempt = {
  server: string;
  /** HTTP status, or null when no answer reached the page. */
  status: number | null;
  ms: number;
  /** "not set up": this site has no relay, or no key for it. Not a failure: on to the next. */
  outcome: 'ok' | 'saved' | 'not set up' | FailKind;
  /** The browser's error type ("TypeError", "TimeoutError"), and its words when they're safe to show. */
  error: string | null;
  bytes: number | null;
};

export type OverpassOptions = {
  /** Servers, or plain interpreter URLs (for tests). */
  servers?: readonly (Server | string)[];
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

  private servers: readonly Server[];
  /** The relay said it isn't set up: don't ask it again this visit. */
  private relayOff = false;
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
    this.servers = (options.servers ?? OVERPASS_SERVERS).map((x) => (typeof x === 'string' ? { label: new URL(x).host, url: x } : x));
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

  /** Each server in turn, one retry for a quick failure, within the attempt and time limits. */
  private async fetchStreets(lat: number, lng: number): Promise<OsmData> {
    const deadline = this.now() + this.totalMs;
    const kinds: FailKind[] = [];
    let sent = 0;
    for (const server of this.servers) {
      if (server.relay && this.relayOff) continue;
      if (kinds.length) this.onProgress('Trying another map server…');
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - this.now();
        if (sent >= MAX_ATTEMPTS || left < Math.min(MIN_TRY_MS, this.totalMs)) return this.giveUp(kinds);
        const started = this.now();
        sent++;
        try {
          return await this.ask(server, lat, lng, Math.min(this.timeoutMs, left));
        } catch (e) {
          if (e instanceof NotSetUp) {
            this.relayOff = true;
            break;
          }
          const err = e as RequestError;
          kinds.push(err.kind);
          if (err.kind === 'offline') return this.giveUp(kinds);
          // One more try only for a quick failure that a moment might fix. Never for a 406 or 429
          // (the server refused, or asked us to slow down) or an answer it can't give.
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
  private async ask(server: Server, lat: number, lng: number, timeoutMs: number): Promise<OsmData> {
    const t0 = this.now();
    const report = (outcome: Attempt['outcome'], status: number | null, error: string | null, bytes: number | null) =>
      this.onAttempt({ server: server.label, status, ms: this.now() - t0, outcome, error, bytes });
    try {
      const out = await this.askOnce(server, lat, lng, timeoutMs);
      report('ok', out.status, null, out.bytes);
      return out.data;
    } catch (e) {
      if (e instanceof NotSetUp) {
        report('not set up', e.status, null, null);
        throw e;
      }
      const r = e as RequestError & { cause?: unknown; bytes?: number };
      report(r.kind, r.status ?? null, r.cause === undefined ? null : errorText(r.cause), r.bytes ?? null);
      throw e;
    }
  }

  /** One request to one server. Always throws a RequestError on failure. */
  private async askOnce(server: Server, lat: number, lng: number, timeoutMs: number): Promise<{ data: OsmData; status: number; bytes: number }> {
    let text = '';
    const fail = (kind: FailKind, status?: number, cause?: unknown) =>
      Object.assign(new RequestError(MESSAGES[kind], kind, status), { cause, bytes: text.length || undefined });
    let res: Response;
    // The relay takes only the rounded point and the radius, and builds the query itself.
    const url = server.relay ? relayPath(lat.toFixed(HOME_POINT_DECIMALS), lng.toFixed(HOME_POINT_DECIMALS), RADIUS_M) : server.url;
    const init: RequestInit = server.relay ? { method: 'GET' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(overpassQuery(lat, lng)),
      // The browser's default: the server sees which site is asking (the site's origin, never a
      // page address). Overpass operators ask apps to identify themselves; Haulween does.
      referrerPolicy: 'strict-origin-when-cross-origin',
    };
    try {
      ({ res, text } = await fetchTextWithin(this.fetchFn, url, init, timeoutMs));
    } catch (e) {
      if (e instanceof TimeoutError) throw fail('timeout', undefined, e);
      // No answer reached the page. A refusal can look like this (some arrive without CORS
      // headers), but so can a block or a dropped connection, so it isn't called "busy".
      throw fail(this.isOnline() ? 'unreachable' : 'offline', undefined, e);
    }
    // No relay on this site (a fork, local development), or no key for it: on to the next server.
    if (server.relay && (!res.headers.get(RELAY_HEADER) || res.status === 501)) throw new NotSetUp(res.status);
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

/** The relay isn't there, or has no key. */
class NotSetUp extends Error {
  constructor(readonly status: number) {
    super('not set up');
  }
}
