// Street data from the OpenStreetMap Overpass API. One POST per plan, cached per rounded home
// point for the session. Overpass only ever sees the home point rounded to 3 decimals (~100 m).

import { HOME_POINT_DECIMALS } from '../config';
import { fromOverpass } from '../route/osm';
import type { OsmData } from '../route/types';
import { SessionCache, ServiceError } from './cache';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
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

export class OverpassClient {
  private cache: SessionCache<OsmData>;
  private inFlight = new Map<string, Promise<OsmData>>();

  constructor(private fetchFn: Fetch = (...a) => fetch(...a), cache?: SessionCache<OsmData>) {
    this.cache = cache ?? new SessionCache<OsmData>('haulween.osm.');
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
    let res: Response;
    try {
      res = await this.fetchFn(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lng)),
      });
    } catch {
      throw new ServiceError("Couldn't reach the street map. Check your connection and try again.");
    }
    if (res.status === 429 || res.status === 504) {
      throw new ServiceError('The street map is busy right now. Try again in a minute.', res.status);
    }
    if (!res.ok) throw new ServiceError("The street map didn't answer. Try again in a minute.", res.status);
    return fromOverpass(await res.json());
  }
}
