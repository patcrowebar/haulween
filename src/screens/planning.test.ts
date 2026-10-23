import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { DEFAULT_FORM, ampm, asksDoorTime, makePlan, matchAvoid, nextHalloween, parseAges, youngestAge } from './planning';
import { PLACEHOLDER_ADDRESS } from '../config';

const form = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, start: '17:00', end: '20:00' };

describe('reading the form', () => {
  it('reads ages however they are typed', () => {
    expect(parseAges('4, 7 and 10')).toEqual([4, 7, 10]);
    expect(youngestAge('12 9')).toBe(9);
    expect(youngestAge('')).toBeNull();
  });

  it('asks about door time from age 10', () => {
    expect(asksDoorTime(9)).toBe(false);
    expect(asksDoorTime(10)).toBe(true);
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
  it('skips nothing and asks nothing for a 6-year-old', () => {
    const out = makePlan(SPRINGWOOD, HOME, { ...form, ages: '6, 9' });
    expect(out.youngest).toBe(6);
    expect(out.estimates).toBeNull();
    expect(out.result.ok).toBe(true);
  });

  it('estimates houses at 60, 45, 35 and 30 seconds a door once the youngest is 10', () => {
    const out = makePlan(SPRINGWOOD, HOME, { ...form, ages: '10, 13' });
    const houses = out.estimates!.map((e) => e.houses!);
    expect(out.estimates!.map((e) => e.seconds)).toEqual([60, 45, 35, 30]);
    expect(houses[0]).toBe(124); // matches the reference at 60 seconds
    for (let i = 1; i < houses.length; i++) expect(houses[i]).toBeGreaterThanOrEqual(houses[i - 1]);
  });

  it('leaves out a street the parent wants to avoid', () => {
    const out = makePlan(SPRINGWOOD, HOME, { ...form, ages: '10', avoid: 'Maple Ave' });
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.result.plan.segments.some((s) => s.name.includes('Maple'))).toBe(false);
  });
});
