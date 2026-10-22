import { describe, expect, it } from 'vitest';
import { paceForAge } from './schedule';

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
