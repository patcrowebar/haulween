import { describe, expect, it } from 'vitest';
import { fmtClock, mapsLinks, paceForAge, parseClock } from './schedule';
import type { Segment } from './optimize';

describe('paceForAge', () => {
  it('matches the reference pace table', () => {
    expect(paceForAge(2)).toBe(1.2);
    expect(paceForAge(3)).toBe(1.2);
    expect(paceForAge(4)).toBe(1.5);
    expect(paceForAge(5)).toBe(1.5);
    expect(paceForAge(8)).toBe(2.0);
    expect(paceForAge(9)).toBe(2.5);
    expect(paceForAge(12)).toBe(2.5);
    expect(paceForAge(13)).toBe(3.0);
    expect(paceForAge(40)).toBe(3.0);
  });

  it('caps the pace at 2 mph with a stroller', () => {
    expect(paceForAge(13, true)).toBe(2.0);
    expect(paceForAge(4, true)).toBe(1.5);
  });
});

describe('parseClock and fmtClock', () => {
  it('reads the same formats as the reference', () => {
    expect(parseClock('17:00')).toBe(17 * 60);
    expect(parseClock('5:00pm')).toBe(17 * 60);
    expect(parseClock('5pm')).toBe(17 * 60);
    expect(parseClock('5:30 PM')).toBe(17 * 60 + 30);
    expect(parseClock('12:15am')).toBe(15);
    expect(parseClock('12pm')).toBe(12 * 60);
    expect(() => parseClock('dusk')).toThrow(/Can't read the time/);
  });

  it('shows 12-hour times without am/pm, dropping seconds', () => {
    expect(fmtClock(17 * 60 + 7.9)).toBe('5:07');
    expect(fmtClock(12 * 60)).toBe('12:00');
    expect(fmtClock(24 * 60 + 5)).toBe('12:05');
  });
});

describe('mapsLinks', () => {
  const seg = (end: [number, number]): Segment => ({
    name: 'x', points: [[41.8, -82.1], end], lengthFt: 0, housesLeft: 0, housesRight: 0, pattern: 'zigzag', why: '',
  });

  it('uses coordinates only and ends back home', () => {
    const [link] = mapsLinks([41.8001, -82.1004], [seg([41.801, -82.1]), seg([41.802, -82.1])]);
    expect(link).toBe('https://www.google.com/maps/dir/?api=1&origin=41.8001,-82.1004&destination=41.8001,-82.1004'
      + '&travelmode=walking&waypoints=41.801,-82.1|41.802,-82.1');
  });

  it('splits into legs over the waypoint limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => seg([41.8 + i / 1000, -82.1]));
    expect(mapsLinks([41.8001, -82.1004], many)).toHaveLength(2);
  });
});
