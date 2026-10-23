// Sunset and weather for the night, from Open-Meteo (no key). Gets a point rounded to
// 2 decimals (about 1 km): plenty for weather, and less precise than anything else we send.

import { SessionCache, ServiceError } from './cache';

export type Tonight = {
  date: string;
  /** "17:31", local time at home. */
  sunset: string;
  /** About when it's fully dark: sunset plus civil twilight (~30 min). */
  dark: string;
  /** Hourly during the walk window, local time. */
  hours: Array<{ time: string; tempF: number; feelsF: number; rainChance: number }>;
};

export type TonightFlags = { rain: boolean; cold: boolean; lowF: number; maxRain: number };

type Fetch = typeof fetch;

/** Whole-minute clock math on "HH:MM" strings. */
export function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Rain if any hour is 40%+; cold if it feels below 45°F. */
export function flagsFor(t: Tonight): TonightFlags {
  const lowF = Math.min(...t.hours.map((h) => h.feelsF));
  const maxRain = Math.max(0, ...t.hours.map((h) => h.rainChance));
  return { rain: maxRain >= 40, cold: lowF < 45, lowF, maxRain };
}

export class WeatherClient {
  private cache = new SessionCache<Tonight>('haulween.wx.');
  constructor(private fetchFn: Fetch = (...a) => fetch(...a)) {}

  /** Weather between startHour and endHour (24h) on date, e.g. "2026-10-31". */
  async tonight(lat: number, lng: number, date: string, startHour: number, endHour: number): Promise<Tonight> {
    const la = lat.toFixed(2), lo = lng.toFixed(2);
    const key = `${la},${lo},${date},${startHour},${endHour}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const q = new URLSearchParams({
      latitude: la, longitude: lo, daily: 'sunset',
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability',
      temperature_unit: 'fahrenheit', timezone: 'auto', start_date: date, end_date: date,
    });
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.open-meteo.com/v1/forecast?${q}`);
    } catch {
      throw new ServiceError("Couldn't get the weather.");
    }
    if (!res.ok) throw new ServiceError('No weather forecast for that night yet.', res.status);
    const body = (await res.json()) as {
      daily: { sunset: string[] };
      hourly: { time: string[]; temperature_2m: number[]; apparent_temperature: number[]; precipitation_probability: number[] };
    };
    const sunset = body.daily.sunset[0].slice(11, 16);
    const hours = body.hourly.time
      .map((time, i) => ({
        time: time.slice(11, 16),
        tempF: Math.round(body.hourly.temperature_2m[i]),
        feelsF: Math.round(body.hourly.apparent_temperature[i]),
        rainChance: body.hourly.precipitation_probability[i] ?? 0,
      }))
      .filter((h) => {
        const hr = Number(h.time.slice(0, 2));
        return hr >= startHour && hr <= endHour;
      });
    const out: Tonight = { date, sunset, dark: addMinutes(sunset, 30), hours };
    this.cache.set(key, out);
    return out;
  }
}
