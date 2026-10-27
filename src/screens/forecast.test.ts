// A kept plan's forecast: reused while it's under 3 hours old, asked for again after that, and
// kept as it was when asking fails. Open-Meteo is mocked; localStorage and sessionStorage are
// in-memory stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEHOLDER_ADDRESS } from '../config';
import { WeatherClient, updatedText, type Tonight } from '../data/weather';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { fresherForecast, loadPlanned, savePlanned, updatePlanned, type Planned } from './planStore';
import { DEFAULT_FORM, planOnce } from './planning';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

const HOUR = 60 * 60 * 1000;
/** Tue Oct 27 2026, 4:10 pm, local time. */
const NOW = new Date(2026, 9, 27, 16, 10).getTime();
const form = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, date: '2026-10-31', start: '17:00', end: '20:00' };

const forecastAt = (fetchedAt: number, tempF: number): Tonight => ({
  date: '2026-10-31', sunset: '18:31', dark: '19:01', fetchedAt,
  hours: [{ time: '17:00', tempF, feelsF: tempF - 2, rainChance: 10 }],
});

/** What Open-Meteo answers for Oct 31, at the given temperature. */
const openMeteo = (tempF: number) => new Response(JSON.stringify({
  daily: { sunset: ['2026-10-31T18:31'] },
  hourly: {
    time: ['2026-10-31T17:00', '2026-10-31T18:00'],
    temperature_2m: [tempF, tempF - 3],
    apparent_temperature: [tempF - 2, tempF - 5],
    precipitation_probability: [10, 20],
  },
}), { status: 200 });

const keep = (tonight: Tonight | null) => {
  const p: Planned = { v: 1, form, home: HOME, title: 'Your route from Elm St', tonight };
  expect(savePlanned(p, SPRINGWOOD)).toBe(true);
};

/** What Plan does when it shows a kept plan: show it now, then take a fresher forecast if one comes. */
async function showKept(fetchFn: typeof fetch, now: number) {
  const kept = loadPlanned()!;
  const shown = kept.planned.tonight;
  const route = planOnce(kept.data, kept.planned.home, kept.planned.form);
  const wx = new WeatherClient(fetchFn, 1000, () => now);
  const fresh = await fresherForecast(shown, now, () =>
    wx.tonight(kept.planned.home[0], kept.planned.home[1], form.date, 17, 20));
  if (fresh) updatePlanned({ tonight: fresh });
  return { shown, route, fresh };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no real network in these tests'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the forecast with a kept plan', () => {
  it('is reused with no request while it is under 3 hours old', async () => {
    keep(forecastAt(NOW - 2 * HOUR, 55));
    const fetchFn = vi.fn(async () => openMeteo(40));
    const { shown, fresh } = await showKept(fetchFn, NOW);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(fresh).toBeNull();
    expect(shown!.hours[0].tempF).toBe(55);
    expect(loadPlanned()!.planned.tonight!.fetchedAt).toBe(NOW - 2 * HOUR);
  });

  it('is asked for once when over 3 hours old, and the new one replaces the kept one', async () => {
    keep(forecastAt(NOW - 3 * HOUR - 60_000, 55));
    const fetchFn = vi.fn(async () => openMeteo(48));
    const { shown, fresh } = await showKept(fetchFn, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown as [string])[0])).toContain('api.open-meteo.com');
    expect(shown!.hours[0].tempF).toBe(55); // shown at once, before the new one comes in
    expect(fresh!.hours[0].tempF).toBe(48);
    expect(fresh!.fetchedAt).toBe(NOW);
    expect(loadPlanned()!.planned.tonight).toEqual(fresh);
  });

  it('a forecast kept by an older version, with no time on it, is asked for again', async () => {
    const { fetchedAt: _, ...old } = forecastAt(0, 55);
    keep(old);
    const fetchFn = vi.fn(async () => openMeteo(48));
    const { fresh } = await showKept(fetchFn, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fresh!.fetchedAt).toBe(NOW);
  });

  it.each([
    ['no signal', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server error', async () => new Response('oops', { status: 500 })],
    ['a night too far ahead', async () => new Response(JSON.stringify({ error: true, reason: 'out of allowed range' }), { status: 400 })],
  ])('keeps the kept forecast, and the route still shows, after %s', async (_, answer) => {
    const kept = forecastAt(NOW - 5 * HOUR, 55);
    keep(kept);
    const fetchFn = vi.fn(answer as typeof fetch);
    const { shown, route, fresh } = await showKept(fetchFn, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fresh).toBeNull();
    expect(shown).toEqual(kept);
    expect(loadPlanned()!.planned.tonight).toEqual(kept);
    expect(route.result.ok).toBe(true);
  });

  it('a stale copy from earlier this visit is not reused in place of asking', async () => {
    const fetchFn = vi.fn(async () => openMeteo(55));
    let now = NOW - 4 * HOUR;
    const wx = new WeatherClient(fetchFn, 1000, () => now);
    await wx.tonight(HOME[0], HOME[1], form.date, 17, 20);
    await wx.tonight(HOME[0], HOME[1], form.date, 17, 20);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = NOW;
    expect((await wx.tonight(HOME[0], HOME[1], form.date, 17, 20)).fetchedAt).toBe(NOW);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('the "Updated" line', () => {
  it('gives the time when the forecast is from today', () => {
    expect(updatedText(NOW, NOW + 20 * 60_000)).toBe('Updated 4:10 pm');
    expect(updatedText(new Date(2026, 9, 27, 0, 5).getTime(), NOW)).toBe('Updated 12:05 am');
  });

  it('adds the day when it is from an earlier day', () => {
    expect(updatedText(new Date(2026, 9, 22, 9, 3).getTime(), NOW)).toBe('Updated Thu 9:03 am');
    expect(updatedText(new Date(2026, 9, 26, 23, 59).getTime(), NOW)).toBe('Updated Mon 11:59 pm');
  });
});
