// Data saved by older versions of the app must still work. The bug this pins: an address
// looked up before road and town existed came back from the cache as { label }, and planning
// crashed with "Cannot read properties of undefined (reading 'trim')".
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_ADDRESS } from '../config';
import { ServiceError } from '../data/cache';
import { FallbackGeocoder, type Geocoder } from '../data/geocoder';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { checkRoute } from '../route/check';
import { planRoute } from '../route/plan';
import { replanFromHere } from '../route/replan';
import { parseClock } from '../route/schedule';
import { freshProgress, toNightPlan, toProgress, type NightPlan } from './nightStore';
import { PLAN_FAILED, PlainError, plainMessage } from './planner';
import { DEFAULT_FORM, makePlan, routeTitle, toForm } from './planning';

/** An in-memory Storage, holding what an older version saved. */
function storage(items: Record<string, unknown>): Storage {
  const m = new Map(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

/** A geocoder that must not be asked: the answer should come from the cache. */
const offline: Geocoder = {
  name: 'Nominatim', credit: '',
  search: () => { throw new Error('should have used the cache'); },
};

describe('settings saved by an older version', () => {
  // The form as the deployed site had it: 5 to 9 pm, age 10, nothing to avoid, no stroller.
  const oldForm = { address: PLACEHOLDER_ADDRESS, start: '17:00', end: '21:00', ages: '10' };

  it('plans from an address cached before road and town existed', async () => {
    const key = PLACEHOLDER_ADDRESS.toLowerCase();
    const geo = new FallbackGeocoder([offline], storage({
      [`haulween.geo.${key}`]: { lat: 41.8, lng: -82.1, label: 'Elm Street, Lakeview', source: 'Nominatim' },
    }));
    const place = await geo.search(PLACEHOLDER_ADDRESS);
    expect(place).toEqual({ lat: 41.8, lng: -82.1, road: 'Elm Street', town: '', source: 'Nominatim' });
    // The old label's town might be a small local area name ("Lakeview"), so it isn't used.
    expect(routeTitle(place!)).toBe('Your route from Elm St');
    const out = makePlan(SPRINGWOOD, HOME, toForm(oldForm));
    expect(out.result.ok).toBe(true);
  });

  it('fills in every field a saved form is missing, then plans', () => {
    const f = toForm(oldForm);
    expect(f).toEqual({ ...DEFAULT_FORM, ...oldForm });
    expect(f.avoid).toBe('');
    expect(f.stroller).toBe(false);
    const out = makePlan(SPRINGWOOD, HOME, f);
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.estimates?.[0].houses).toBeGreaterThan(0);
  });

  it('replaces fields saved as null or the wrong type', () => {
    const f = toForm({ ...oldForm, avoid: null, stroller: 'no', doorSeconds: 999, ages: 10 });
    expect(f).toMatchObject({ avoid: '', stroller: false, doorSeconds: 60, ages: DEFAULT_FORM.ages });
    for (const junk of [null, 'oops', 42, [1, 2]]) expect(toForm(junk)).toEqual(DEFAULT_FORM);
  });

  it('skips a cached address with no usable point, and looks it up again', async () => {
    const key = PLACEHOLDER_ADDRESS.toLowerCase();
    const fresh: Geocoder = {
      name: 'Nominatim', credit: '',
      search: async () => ({ lat: 41.8, lng: -82.1, road: 'Elm Street', town: 'Springwood', source: 'Nominatim' }),
    };
    const geo = new FallbackGeocoder([fresh], storage({ [`haulween.geo.${key}`]: { label: 'Elm Street' } }));
    expect(await geo.search(PLACEHOLDER_ADDRESS)).toMatchObject({ town: 'Springwood' });
  });
});

describe('a Night Mode plan saved by an older version', () => {
  const opts = { startTime: '17:00', endTime: '21:00', youngestAge: 10 };
  const r = planRoute(SPRINGWOOD, HOME, opts);
  if (!r.ok) throw new Error('plan failed');
  const night: NightPlan = {
    v: 1, title: 'Your route from Elm St', demo: false, date: '2026-10-31', options: opts, home: HOME,
    start: parseClock(opts.startTime), segments: r.plan.segments, schedule: r.plan.schedule,
    lines: { streetLines: r.plan.pocket.streetLines, busyRoads: r.plan.pocket.busyRoads, areas: r.plan.pocket.areas },
  };

  it('fills in missing settings, and a replan from it still passes the route check', () => {
    const { options: _o, lines: _l, title: _t, ...old } = night;
    const p = toNightPlan(JSON.parse(JSON.stringify(old)))!;
    expect(p.options).toMatchObject({ startTime: '17:00', endTime: '21:00', exclude: [] });
    expect(p.lines.streetLines).toEqual([]);
    const res = replanFromHere(SPRINGWOOD, p.home, { ...p.options, now: 19 * 60 }, { row: p.segments[2], at: null }, []);
    if (!res.ok) throw new Error(res.problems.join('; '));
    expect(checkRoute(res.plan.pocket, res.plan.segments, HOME)).toEqual([]);
  });

  it("drops a saved plan that's missing the route itself", () => {
    for (const broken of [null, {}, { ...night, segments: [] }, { ...night, schedule: undefined }, { ...night, start: '5pm' }]) {
      expect(toNightPlan(JSON.parse(JSON.stringify(broken ?? null)))).toBeNull();
    }
  });

  it('fills in missing progress fields, and drops progress for another plan', () => {
    const { track } = freshProgress(night, true);
    const p = toProgress({ track: { ...track, current: 3 } }, night)!;
    expect(p).toMatchObject({ alerted: false, sound: false, earlier: { houses: 0, streets: 0 }, demoClock: null });
    expect(p.track.current).toBe(3);
    expect(toProgress({ track: { ...track, done: [true] } }, night)).toBeNull();
    // Unreadable progress starts the night fresh rather than failing.
    expect(toProgress('junk', night)!.track).toEqual(freshProgress(night, false).track);
  });
});

describe('error messages on screen', () => {
  it('never shows a raw JavaScript error', () => {
    expect(plainMessage(new TypeError("Cannot read properties of undefined (reading 'trim')"))).toBe(PLAN_FAILED);
    expect(plainMessage('oops')).toBe(PLAN_FAILED);
    expect(PLAN_FAILED).toBe('Something went wrong planning that. Try again.');
  });

  it('shows messages written for a parent as they are', () => {
    expect(plainMessage(new ServiceError('The street map service is busy.'))).toBe('The street map service is busy.');
    expect(plainMessage(new PlainError('Planning took too long.'))).toBe('Planning took too long.');
  });
});
