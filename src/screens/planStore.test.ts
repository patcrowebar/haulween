// A route is kept as soon as it's planned, and comes back after a reload with no street-data
// fetch. localStorage here is an in-memory stand-in, and fetch fails the test if it's called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEHOLDER_ADDRESS } from '../config';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { parseClock } from '../route/schedule';
import { freshProgress, loadNight, loadNightData, saveNight, type NightPlan } from './nightStore';
import { loadPlanned, loadStreets, plannedFor, savePlanned, updatePlanned, type Planned } from './planStore';
import { DEFAULT_FORM, planOnce } from './planning';

function memoryStorage(limit = Infinity): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => {
      const used = [...m].reduce((t, [kk, vv]) => t + (kk === k ? 0 : vv.length), 0);
      if (used + v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      m.set(k, v);
    },
  };
}

const form = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, date: '2026-10-31', start: '17:00', end: '21:00' };
const planned: Planned = { v: 1, form, home: HOME, title: 'Your route from Elm St, Springwood', tonight: null };
const fetchSpy = vi.fn(() => { throw new Error('no network calls in these tests'); });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a planned route, kept on this phone', () => {
  it('is kept when planned and comes back after a reload, the same route, with no fetch', () => {
    const first = planOnce(SPRINGWOOD, HOME, form);
    if (!first.result.ok) throw new Error('plan failed');
    expect(savePlanned(planned, SPRINGWOOD)).toBe(true);

    // A reload: nothing in memory, only what's in localStorage.
    const back = loadPlanned();
    expect(back).not.toBeNull();
    expect(back!.planned.form).toEqual(form);
    expect(back!.planned.title).toBe(planned.title);
    const again = planOnce(back!.data, back!.planned.home, back!.planned.form);
    if (!again.result.ok) throw new Error('plan failed');
    expect(again.result.plan.segments).toEqual(first.result.plan.segments);
    expect(again.result.plan.schedule.rows).toEqual(first.result.plan.schedule.rows);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('planning again for the same address reuses the kept streets', () => {
    savePlanned(planned, SPRINGWOOD);
    expect(plannedFor('  1428 elm st,  Springwood, OH ')?.data.streets.length).toBe(SPRINGWOOD.streets.length);
    expect(plannedFor('12 Other Rd, Springwood, OH')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the newest answers and forecast with the route', () => {
    savePlanned(planned, SPRINGWOOD);
    updatePlanned({ form: { ...form, doorSeconds: 35 } });
    const tonight = { date: '2026-10-31', sunset: '18:31', dark: '19:01', hours: [] };
    updatePlanned({ tonight });
    expect(loadPlanned()!.planned).toMatchObject({ form: { doorSeconds: 35 }, tonight });
  });

  it('only gives back street data for the home it was fetched for', () => {
    savePlanned(planned, SPRINGWOOD);
    expect(loadStreets(HOME)).not.toBeNull();
    expect(loadStreets([HOME[0] + 0.01, HOME[1]])).toBeNull();
  });

  it("keeps nothing half-written when the phone has no room", () => {
    vi.stubGlobal('localStorage', memoryStorage(1000));
    expect(savePlanned(planned, SPRINGWOOD)).toBe(false);
    expect(loadPlanned()).toBeNull();
    expect(loadStreets(HOME)).toBeNull();
  });

  it('Night Mode replans from the same kept streets, with no second copy and no fetch', () => {
    savePlanned(planned, SPRINGWOOD);
    const p = planOnce(SPRINGWOOD, HOME, form);
    if (!p.result.ok) throw new Error('plan failed');
    const night: NightPlan = {
      v: 1, title: planned.title, demo: false, date: form.date, home: HOME, start: parseClock(form.start),
      options: { startTime: form.start, endTime: form.end, paceMph: 2.5, doorSeconds: 60 },
      segments: p.result.plan.segments, schedule: p.result.plan.schedule,
      lines: { streetLines: [], busyRoads: [], areas: [] },
    };
    expect(saveNight(night, SPRINGWOOD, freshProgress(night, false))).toBe(true);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys.filter((k) => k?.includes('streets') || k?.endsWith('.data'))).toEqual(['haulween.streets']);
    expect(loadNightData(loadNight()!)?.streets.length).toBe(SPRINGWOOD.streets.length);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still finds street data an earlier version kept for Night Mode", () => {
    localStorage.setItem('haulween.night.data', JSON.stringify(SPRINGWOOD));
    expect(loadStreets(HOME)?.streets.length).toBe(SPRINGWOOD.streets.length);
  });
});
