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
import { timeline } from '../route/status';
import { freshProgress, makeNightPlan, toNightPlan, toProgress, type NightPlan } from './nightStore';
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
    expect(place).toEqual({ lat: 41.8, lng: -82.1, road: 'Elm Street', source: 'Nominatim' });
    // The old label's area name ("Lakeview") isn't kept or shown.
    expect(routeTitle(place!)).toBe('Your route from Elm St');
  });

  it('a cached address from the version that kept a town loads with the street only', async () => {
    const key = PLACEHOLDER_ADDRESS.toLowerCase();
    const geo = new FallbackGeocoder([offline], storage({
      [`haulween.geo.${key}`]: { lat: 41.8, lng: -82.1, road: 'Elm Street', town: 'Springwood', source: 'Photon' },
    }));
    const place = await geo.search(PLACEHOLDER_ADDRESS);
    expect(place).toEqual({ lat: 41.8, lng: -82.1, road: 'Elm Street', source: 'Photon' });
    expect(routeTitle(place!)).toBe('Your route from Elm St');
    const out = makePlan(SPRINGWOOD, HOME, toForm(oldForm));
    expect(out.result.ok).toBe(true);
  });

  it('fills in every field a saved form is missing, drops the ages, then plans', () => {
    const f = toForm(oldForm);
    const { ages: _ages, ...rest } = oldForm;
    expect(f).toEqual({ ...DEFAULT_FORM, ...rest });
    expect(f).not.toHaveProperty('ages');
    expect(f).not.toHaveProperty('stroller');
    const out = makePlan(SPRINGWOOD, HOME, f);
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.doors[0].houses).toBeGreaterThan(0);
  });

  it('an old stroller becomes Slow; otherwise Steady', () => {
    expect(toForm({ ...oldForm, ages: '3, 6', stroller: true }).pace).toBe('slow');
    expect(toForm({ ...oldForm, ages: '3, 6', stroller: false }).pace).toBe('steady');
    expect(toForm({ ...oldForm, ages: '15' }).pace).toBe('steady');
  });

  it("keeps an old door time only where the parent could pick one (youngest 10 or older)", () => {
    expect(toForm({ ...oldForm, ages: '6', doorSeconds: 60 }).doorSeconds).toBe(45); // 60 was forced, not chosen
    expect(toForm({ ...oldForm, ages: '12', doorSeconds: 35 }).doorSeconds).toBe(35);
    expect(toForm({ ...oldForm, ages: '12', doorSeconds: 60 }).doorSeconds).toBe(60);
  });

  it('keeps a pace and door time saved by this version', () => {
    expect(toForm({ ...DEFAULT_FORM, pace: 'quick', doorSeconds: 30 })).toMatchObject({ pace: 'quick', doorSeconds: 30 });
  });

  it('replaces fields saved as null or the wrong type', () => {
    const f = toForm({ ...oldForm, avoid: null, stroller: 'no', doorSeconds: 999, ages: 10, pace: 'sprint' });
    expect(f).toMatchObject({ avoid: '', doorSeconds: 45, pace: 'steady' });
    for (const junk of [null, 'oops', 42, [1, 2]]) expect(toForm(junk)).toEqual(DEFAULT_FORM);
  });

  it('skips a cached address with no usable point, and looks it up again', async () => {
    const key = PLACEHOLDER_ADDRESS.toLowerCase();
    const fresh: Geocoder = {
      name: 'Nominatim', credit: '',
      search: async () => ({ lat: 41.8, lng: -82.1, road: 'Maple Avenue', source: 'Nominatim' }),
    };
    const geo = new FallbackGeocoder([fresh], storage({ [`haulween.geo.${key}`]: { label: 'Elm Street' } }));
    expect(await geo.search(PLACEHOLDER_ADDRESS)).toMatchObject({ road: 'Maple Avenue' });
  });
});

describe('a Night Mode plan saved by an older version', () => {
  const opts = { startTime: '17:00', endTime: '21:00', paceMph: 2.5, doorSeconds: 60 };
  const r = planRoute(SPRINGWOOD, HOME, opts);
  if (!r.ok) throw new Error('plan failed');
  const night: NightPlan = {
    v: 1, title: 'Your route from Elm St', demo: false, date: '2026-10-31', options: opts, home: HOME,
    start: parseClock(opts.startTime), segments: r.plan.segments, schedule: r.plan.schedule,
    lines: { streetLines: r.plan.pocket.streetLines, busyRoads: r.plan.pocket.busyRoads, areas: r.plan.pocket.areas },
  };

  it('turns an old saved age and stroller into a pace, and replans at that pace', () => {
    const old = JSON.parse(JSON.stringify({ ...night, options: { startTime: '17:00', endTime: '21:00', youngestAge: 4, stroller: true } }));
    const p = toNightPlan(old)!;
    expect(p.options).toMatchObject({ paceMph: 1.5, doorSeconds: 60 }); // door time from the saved schedule
    expect(p.options).not.toHaveProperty('youngestAge');
    const res = replanFromHere(SPRINGWOOD, p.home, { ...p.options, now: 19 * 60 }, { row: p.segments[2], at: null }, []);
    if (!res.ok) throw new Error(res.problems.join('; '));
    expect(res.plan.schedule.pace).toEqual({ mph: 1.5, doorSeconds: 60 });
    const steady = toNightPlan(JSON.parse(JSON.stringify({ ...night, options: { startTime: '17:00', endTime: '21:00', youngestAge: 13 } })))!;
    expect(steady.options.paceMph).toBe(2.0);
  });

  it('an older title with a town or neighborhood shows the street only', () => {
    const p = toNightPlan(JSON.parse(JSON.stringify({ ...night, title: 'Your route from Elm St, Lakeview' })))!;
    expect(p.title).toBe('Your route from Elm St');
  });

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

describe('Night Mode uses the chosen pace and door time', () => {
  const base = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, date: '2026-10-31', start: '17:00', end: '20:00' };
  const nightFor = (pace: 'slow' | 'fast', doorSeconds: number) => {
    const f = { ...base, pace, doorSeconds };
    const out = makePlan(SPRINGWOOD, HOME, f);
    if (!out.result.ok) throw new Error('plan failed');
    return makeNightPlan({ title: 'Your route from Elm St', demo: false, home: HOME }, f, out.result.plan, out.avoid.exclude);
  };

  it("Night Mode's timing is the chosen plan's", () => {
    const slow = nightFor('slow', 60), fast = nightFor('fast', 30);
    expect(slow.options).toMatchObject({ paceMph: 1.5, doorSeconds: 60 });
    expect(fast.options).toMatchObject({ paceMph: 3.0, doorSeconds: 30 });
    expect(slow.schedule.pace).toEqual({ mph: 1.5, doorSeconds: 60 });
    // The street-by-street times Night Mode tracks against come from that schedule.
    const tl = timeline(slow.schedule, slow.start);
    expect(tl.rows[1].start).toBe(parseClock(slow.schedule.rows[1].t24));
  });

  it('"Replan from here" keeps the chosen pace and door time', () => {
    for (const night of [nightFor('slow', 60), nightFor('fast', 30)]) {
      const res = replanFromHere(SPRINGWOOD, night.home, { ...night.options, now: 18 * 60 }, { row: night.segments[1], at: null },
        [{ points: night.segments[0].points, pattern: night.segments[0].pattern }]);
      if (!res.ok) throw new Error(res.problems.join('; '));
      expect(res.plan.schedule.pace).toEqual({ mph: night.options.paceMph, doorSeconds: night.options.doorSeconds });
      expect(checkRoute(res.plan.pocket, res.plan.segments, HOME)).toEqual([]);
    }
  });
});
