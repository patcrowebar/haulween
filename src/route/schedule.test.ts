import { describe, expect, it } from 'vitest';
import { fmtClock, paceFor, parseClock } from './schedule';

describe('pace and door defaults', () => {
  it('plans at Steady (2.0 mph) and 45 seconds a door unless told otherwise', () => {
    expect(paceFor({ startTime: '17:00', endTime: '20:00' })).toMatchObject({ mph: 2.0, doorMin: 0.75 });
    expect(paceFor({ startTime: '17:00', endTime: '20:00', paceMph: 1.5, doorSeconds: 30 })).toMatchObject({ mph: 1.5, doorMin: 0.5 });
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
