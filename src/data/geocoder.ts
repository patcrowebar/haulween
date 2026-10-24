// Address lookup. The street address goes to the geocoder and nowhere else.
// Nominatim first; if it fails or pushes back, Photon. Both are behind the same interface.

import { isNum, withDefaults } from '../stored';
import {
  RequestError, SessionCache, TimeoutError, browserIsOnline, fetchTextWithin, worstOf, type FailKind,
} from './cache';

type Fetch = typeof fetch;

export const LOOKUP_TIMEOUT_MS = 10_000;

const MESSAGES: Record<FailKind, string> = {
  busy: 'Address search is busy. Wait a minute and try again.',
  down: 'Address search is having trouble right now. Try again in a few minutes.',
  unreachable: "Couldn't get an answer from address search. Try again in a minute, or on another network.",
  timeout: "Address search didn't answer in time. Wait a minute and try again.",
  offline: "Couldn't reach address search. Check your connection and try again.",
  bad: "Address search sent something we couldn't read. Try again in a minute.",
};

/** GET some JSON within the time limit, turning every failure into a RequestError. */
async function getJson<T>(fetchFn: Fetch, url: string, init: RequestInit, ms: number, isOnline: () => boolean): Promise<T> {
  let res: Response, text: string;
  try {
    ({ res, text } = await fetchTextWithin(fetchFn, url, init, ms));
  } catch (e) {
    // No answer reached the page: that says nothing about why, so it isn't called "busy".
    const kind = e instanceof TimeoutError ? 'timeout' : isOnline() ? 'unreachable' : 'offline';
    throw new RequestError(MESSAGES[kind], kind);
  }
  if (!res.ok) {
    const kind = res.status === 429 || res.status === 504 ? 'busy' : res.status >= 500 ? 'down' : 'bad';
    throw new RequestError(MESSAGES[kind], kind, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestError(MESSAGES.bad, 'bad', res.status);
  }
}

export type Place = {
  lat: number;
  lng: number;
  /** The street, as the geocoder spells it ("Elm Street"); empty if it gave none. */
  road: string;
  /**
   * The town or city, never a small local area name: a neighborhood, suburb or hamlet name
   * ("Lakeview") means little to anyone else. Empty if there's none.
   */
  town: string;
  /** Who found it, for the credit line. */
  source: 'Nominatim' | 'Photon';
};

/**
 * A place read back from the cache, which an older version may have written. Versions before
 * road and town kept one `label` ("Elm Street, Lakeview"); its street is kept, but not its town,
 * which could be a small local area name. null if there's no usable point.
 */
export function toPlace(saved: unknown): Place | null {
  const p = withDefaults(saved, { lat: NaN, lng: NaN, road: '', town: '', source: 'Nominatim' as Place['source'], label: '' });
  if (!isNum(p.lat) || !isNum(p.lng)) return null;
  const parts = p.label.split(',').map((s) => s.trim());
  const road = p.road || (parts.length >= 2 ? parts[0] : '');
  return { lat: p.lat, lng: p.lng, road, town: p.town, source: p.source === 'Photon' ? 'Photon' : 'Nominatim' };
}

export interface Geocoder {
  readonly name: Place['source'];
  /** Credit to show next to the search box. */
  readonly credit: string;
  search(address: string): Promise<Place | null>;
}

export type LookupOptions = { timeoutMs?: number; isOnline?: () => boolean };

/** Lets at most one request start per `gapMs`. Nominatim asks for 1 per second. */
export class Throttle {
  private next = 0;
  constructor(private gapMs: number, private now = () => Date.now(), private sleep = defaultSleep) {}
  async wait(): Promise<void> {
    const t = this.now();
    const start = Math.max(t, this.next);
    this.next = start + this.gapMs;
    if (start > t) await this.sleep(start - t);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NominatimGeocoder implements Geocoder {
  readonly name = 'Nominatim' as const;
  readonly credit = 'Address search by Nominatim, © OpenStreetMap contributors';
  constructor(
    private fetchFn: Fetch = (...a) => fetch(...a),
    private throttle = new Throttle(1000),
    private options: LookupOptions = {},
  ) {}

  async search(address: string): Promise<Place | null> {
    await this.throttle.wait();
    const q = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1', addressdetails: '1' });
    const rows = await getJson<Array<{ lat: string; lon: string; address?: Record<string, string> }>>(
      this.fetchFn, `https://nominatim.openstreetmap.org/search?${q}`, { headers: { Accept: 'application/json' } },
      this.options.timeoutMs ?? LOOKUP_TIMEOUT_MS, this.options.isOnline ?? browserIsOnline,
    );
    if (!rows.length) return null;
    const a = rows[0].address ?? {};
    return {
      lat: Number(rows[0].lat),
      lng: Number(rows[0].lon),
      road: a.road ?? '',
      town: a.city ?? a.town ?? a.village ?? a.municipality ?? '',
      source: this.name,
    };
  }
}

export class PhotonGeocoder implements Geocoder {
  readonly name = 'Photon' as const;
  readonly credit = 'Address search by Photon (Komoot), © OpenStreetMap contributors';
  constructor(private fetchFn: Fetch = (...a) => fetch(...a), private options: LookupOptions = {}) {}

  async search(address: string): Promise<Place | null> {
    const q = new URLSearchParams({ q: address, limit: '1' });
    const body = await getJson<{
      features: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }>;
    }>(this.fetchFn, `https://photon.komoot.io/api/?${q}`, {}, this.options.timeoutMs ?? LOOKUP_TIMEOUT_MS,
      this.options.isOnline ?? browserIsOnline);
    const f = body.features[0];
    if (!f) return null;
    const p = f.properties;
    return {
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      road: p.street ?? p.name ?? '',
      town: p.city ?? p.town ?? p.village ?? '',
      source: this.name,
    };
  }
}

/** Tries each geocoder in turn when one fails, and caches what it finds. */
export class FallbackGeocoder {
  private cache = new SessionCache<unknown>('haulween.geo.');
  /** The geocoder that answered last, for the credit line. */
  current: Geocoder;

  constructor(
    private geocoders: Geocoder[] = [new NominatimGeocoder(), new PhotonGeocoder()],
    storage?: Storage | null,
  ) {
    if (storage !== undefined) this.cache = new SessionCache<unknown>('haulween.geo.', storage);
    this.current = geocoders[0];
  }

  async search(address: string): Promise<Place | null> {
    const key = address.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return null;
    const hit = this.cache.get(key);
    if (hit === null) return null; // looked up before: not found
    const cached = hit === undefined ? null : toPlace(hit);
    if (cached) return cached;
    const kinds: FailKind[] = [];
    for (const g of this.geocoders) {
      try {
        const place = await g.search(address.trim());
        this.current = g;
        this.cache.set(key, place);
        return place;
      } catch (e) {
        kinds.push(e instanceof RequestError ? e.kind : 'bad');
      }
    }
    const kind = worstOf(kinds);
    throw new RequestError(MESSAGES[kind], kind);
  }
}
