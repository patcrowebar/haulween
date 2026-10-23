// Address lookup. The street address goes to the geocoder and nowhere else.
// Nominatim first; if it fails or pushes back, Photon. Both are behind the same interface.

import { SessionCache, ServiceError } from './cache';

export type Place = {
  lat: number;
  lng: number;
  /** Short label to show back to the visitor, e.g. "Elm St, Springwood". */
  label: string;
  /** Who found it, for the credit line. */
  source: 'Nominatim' | 'Photon';
};

export interface Geocoder {
  readonly name: Place['source'];
  /** Credit to show next to the search box. */
  readonly credit: string;
  search(address: string): Promise<Place | null>;
}

type Fetch = typeof fetch;

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
  constructor(private fetchFn: Fetch = (...a) => fetch(...a), private throttle = new Throttle(1000)) {}

  async search(address: string): Promise<Place | null> {
    await this.throttle.wait();
    const q = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1', addressdetails: '1' });
    const res = await this.fetchFn(`https://nominatim.openstreetmap.org/search?${q}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new ServiceError('Address search is busy right now.', res.status);
    const rows = (await res.json()) as Array<{ lat: string; lon: string; address?: Record<string, string> }>;
    if (!rows.length) return null;
    const a = rows[0].address ?? {};
    const town = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? '';
    return {
      lat: Number(rows[0].lat),
      lng: Number(rows[0].lon),
      label: [a.road, town].filter(Boolean).join(', '),
      source: this.name,
    };
  }
}

export class PhotonGeocoder implements Geocoder {
  readonly name = 'Photon' as const;
  readonly credit = 'Address search by Photon (Komoot), © OpenStreetMap contributors';
  constructor(private fetchFn: Fetch = (...a) => fetch(...a)) {}

  async search(address: string): Promise<Place | null> {
    const q = new URLSearchParams({ q: address, limit: '1' });
    const res = await this.fetchFn(`https://photon.komoot.io/api/?${q}`);
    if (!res.ok) throw new ServiceError('Address search is busy right now.', res.status);
    const body = (await res.json()) as {
      features: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }>;
    };
    const f = body.features[0];
    if (!f) return null;
    const p = f.properties;
    return {
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      label: [p.street ?? p.name, p.city ?? p.town ?? p.district].filter(Boolean).join(', '),
      source: this.name,
    };
  }
}

/** Tries each geocoder in turn when one fails, and caches what it finds. */
export class FallbackGeocoder {
  private cache = new SessionCache<Place | null>('haulween.geo.');
  /** The geocoder that answered last, for the credit line. */
  current: Geocoder;

  constructor(private geocoders: Geocoder[] = [new NominatimGeocoder(), new PhotonGeocoder()]) {
    this.current = geocoders[0];
  }

  async search(address: string): Promise<Place | null> {
    const key = address.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return null;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let lastError: unknown;
    for (const g of this.geocoders) {
      try {
        const place = await g.search(address.trim());
        this.current = g;
        this.cache.set(key, place);
        return place;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof ServiceError ? lastError : new ServiceError("Couldn't reach address search. Check your connection.");
  }
}
