import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD, ft } from './__fixtures__/springwood';
import { checkRoute } from './check';
import type { Segment } from './optimize';
import { findPocket } from './pocket';
import type { Pt } from './types';

const pocket = findPocket(SPRINGWOOD, HOME);
const seg = (name: string, points: Pt[]): Segment => ({
  name, points, lengthFt: 0, housesLeft: 0, housesRight: 0, pattern: 'walk_through', why: '',
});

describe('checkRoute', () => {
  it('passes a stretch that follows a real street', () => {
    expect(checkRoute(pocket, [seg('Elm St to Cedar St', [ft(-700, 0), ft(-350, 0), ft(0, 0)])], HOME)).toEqual([]);
  });

  it('fails a straight line cut across the park', () => {
    const p = checkRoute(pocket, [seg('Shortcut', [ft(-700, 0), ft(0, 600)])], HOME);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^Shortcut: about \d+ ft of it is not on any street/);
  });

  it('fails a stretch along a busy road', () => {
    const p = checkRoute(pocket, [seg('Main St to Maple Ave', [ft(-1400, 0), ft(-1400, 300), ft(-1400, 600)])], HOME);
    expect(p).toEqual(['Main St to Maple Ave: runs along a busy road for about 420 ft.']);
  });

  it('fails a jump between streets that do not connect', () => {
    const p = checkRoute(pocket, [
      seg('Willow Ct to the dead end', [ft(350, 0), ft(350, -400)]),
      seg('Lakeview Dr to Spruce St', [ft(100, -600), ft(-350, -600)]),
    ], HOME);
    expect(p).toEqual(['Getting to Lakeview Dr to Spruce St: jumps 320 ft from the previous street with no street connecting them.']);
  });
});
