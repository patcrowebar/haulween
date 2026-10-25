import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import {
  DEFAULT_FORM, ampm, choiceKey, estimatesFor, leftOut, makePlan, matchAvoid, nextHalloween, routeTitle,
} from './planning';
import { planRoute } from '../route/plan';
import { PACE_CHOICES, PLACEHOLDER_ADDRESS } from '../config';

const form = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, start: '17:00', end: '20:00' };
/** The default route on Springwood, 5 to 8 pm. Before ages were dropped (60 sec, 2.5 mph) it was ~124 houses, home 7:46 pm. */
const DEFAULT_HOUSES = 144;
const DEFAULT_HOME_BY = '19:44';

describe('reading the form', () => {
  it('defaults to 45 seconds a door and a Steady pace, with no ages asked', () => {
    expect(DEFAULT_FORM).toMatchObject({ doorSeconds: 45, pace: 'steady' });
    expect(Object.keys(DEFAULT_FORM)).not.toContain('ages');
    expect(Object.keys(DEFAULT_FORM)).not.toContain('stroller');
  });

  it('plans for the next Halloween', () => {
    expect(nextHalloween(new Date(2026, 9, 23))).toBe('2026-10-31');
    expect(nextHalloween(new Date(2026, 10, 2))).toBe('2027-10-31');
  });

  it('shows times with am/pm', () => {
    expect(ampm('17:07')).toBe('5:07 pm');
    expect(ampm('00:15')).toBe('12:15 am');
  });
});

describe('roads to avoid', () => {
  it('matches the way people type street names', () => {
    expect(matchAvoid('Maple Avenue, birch st, Main Street, Nowhere Ln', SPRINGWOOD, HOME)).toEqual({
      exclude: ['Maple Ave', 'Birch St'],
      alreadyOff: ['Main St'],
      notFound: ['Nowhere Ln'],
    });
  });
});

describe('makePlan', () => {
  it('plans the default route on Springwood: 45 sec a door, Steady pace', () => {
    const out = makePlan(SPRINGWOOD, HOME, form);
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.result.plan.schedule.pace).toEqual({ mph: 2.0, doorSeconds: 45 });
    expect(out.result.plan.estimate.houses).toBe(DEFAULT_HOUSES);
    expect(out.result.plan.schedule.homeBy24).toBe(DEFAULT_HOME_BY);
  });

  it('always shows all four door times and all four paces, each with a house estimate', () => {
    for (const f of [form, { ...form, pace: 'slow' as const, doorSeconds: 60 }, { ...form, pace: 'fast' as const, doorSeconds: 30 }]) {
      const out = makePlan(SPRINGWOOD, HOME, f);
      expect(out.doors.map((e) => e.seconds)).toEqual([60, 45, 35, 30]);
      expect(out.paces.map((e) => e.pace)).toEqual(['slow', 'steady', 'quick', 'fast']);
      for (const e of [...out.doors, ...out.paces]) {
        expect(e.houses).toBeGreaterThan(0);
        expect(e.homeBy24).toMatch(/^\d\d:\d\d$/);
      }
    }
  });

  it('each section shows its choices at the other section\'s current choice', () => {
    const at = (paceMph: number, doorSeconds: number) => {
      const r = planRoute(SPRINGWOOD, HOME, { startTime: '17:00', endTime: '20:00', paceMph, doorSeconds });
      if (!r.ok) throw new Error('plan failed');
      return { houses: r.plan.estimate.houses, crossings: r.plan.schedule.totals.streetCrossings, homeBy24: r.plan.schedule.homeBy24 };
    };
    const fast = makePlan(SPRINGWOOD, HOME, { ...form, pace: 'fast' });
    for (const e of fast.doors) expect(e).toEqual({ seconds: e.seconds, ...at(3.0, e.seconds) });
    const quickDoors = makePlan(SPRINGWOOD, HOME, { ...form, doorSeconds: 30 });
    for (const e of quickDoors.paces) {
      const mph = PACE_CHOICES.find((p) => p.id === e.pace)!.mph;
      expect(e).toEqual({ pace: e.pace, ...at(mph, 30) });
    }
  });

  it('more time at the door or a slower pace never fits more houses', () => {
    const out = makePlan(SPRINGWOOD, HOME, form);
    const doors = out.doors.map((e) => e.houses!);
    for (let i = 1; i < doors.length; i++) expect(doors[i]).toBeGreaterThanOrEqual(doors[i - 1]);
    const paces = out.paces.map((e) => e.houses!);
    for (let i = 1; i < paces.length; i++) expect(paces[i]).toBeGreaterThanOrEqual(paces[i - 1]);
  });

  it('shows "tap to see" for a choice not worked out yet, then its number', () => {
    const known = new Map<string, Parameters<typeof estimatesFor>[1] extends (k: string) => infer R ? R : never>();
    const out = makePlan(SPRINGWOOD, HOME, form);
    known.set(choiceKey(form), out.result);
    const first = estimatesFor(form, (k) => known.get(k));
    expect(first.doors.find((e) => e.seconds === 45)!.houses).toBe(DEFAULT_HOUSES);
    expect(first.doors.find((e) => e.seconds === 60)!.houses).toBeUndefined();
    expect(first.paces.find((e) => e.pace === 'fast')!.houses).toBeUndefined();
  });

  it('leaves out a street the parent wants to avoid', () => {
    const out = makePlan(SPRINGWOOD, HOME, { ...form, avoid: 'Maple Ave' });
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.result.plan.segments.some((s) => s.name.includes('Maple'))).toBe(false);
  });
});

describe('the results title', () => {
  it('uses the street and the town, short street names', () => {
    expect(routeTitle({ road: 'Elm Street', town: 'Springwood' })).toBe('Your route from Elm St, Springwood');
  });

  it('falls back to the street alone when there is no town', () => {
    expect(routeTitle({ road: 'Walnut Street', town: '' })).toBe('Your route from Walnut St');
    expect(routeTitle({ road: '', town: '' })).toBe('Your route from home');
  });
});

describe('the left-out list', () => {
  it('uses short street names, and says "part of" for a street also on the route', () => {
    const out = leftOut({ 'Birch Avenue': 12, 'Maple Avenue': 6, 'Maple Ave': 2, 'Oak Court': 3 }, ['Maple Avenue', 'Elm Street']);
    expect(out).toEqual([
      { text: 'Birch Ave', houses: 12 },
      { text: 'part of Maple Ave', houses: 8 },
      { text: 'Oak Ct', houses: 3 },
    ]);
  });

  it('on the Springwood plan, every left-out street on the route says "part of"', () => {
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '17:00', endTime: '18:30', paceMph: 2.0, doorSeconds: 60 });
    if (!r.ok) throw new Error('plan failed');
    const list = leftOut(r.plan.skipped, r.plan.walked);
    expect(list.length).toBeGreaterThan(0);
    const walked = new Set(r.plan.walked);
    for (const name of Object.keys(r.plan.skipped)) {
      const text = list.find((l) => l.text.endsWith(name))!.text;
      expect(text).toBe(walked.has(name) ? `part of ${name}` : name);
    }
  });
});
