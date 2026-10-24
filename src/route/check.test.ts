import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD, SPRINGWOOD_MILL_RD, ft } from './__fixtures__/springwood';
import { checkRoute } from './check';
import type { Segment } from './optimize';
import { findPocket } from './pocket';
import type { Pt } from './types';

const pocket = findPocket(SPRINGWOOD, HOME);
const seg = (name: string, points: Pt[]): Segment => ({
  name, street: name, points, lengthFt: 0, housesLeft: 0, housesRight: 0, pattern: 'walk_through', why: '',
});

describe('checkRoute', () => {
  it('passes a stretch that follows a real street', () => {
    expect(checkRoute(pocket, [seg('Elm St to Cedar St', [ft(-700, 0), ft(-350, 0), ft(0, 0)])], HOME)).toEqual([]);
  });

  it('fails a straight line cut across the park', () => {
    const p = checkRoute(pocket, [seg('Shortcut', [ft(-700, 0), ft(0, 600)])], HOME);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^Shortcut: a 922 ft stretch is not on any street/);
  });

  it('fails a stretch along a busy road', () => {
    const p = checkRoute(pocket, [seg('Main St to Maple Ave', [ft(-1400, 0), ft(-1400, 300), ft(-1400, 600)])], HOME);
    expect(p).toEqual(['Main St to Maple Ave: runs along a busy road for about 600 ft.']);
  });

  it('fails a jump between streets that do not connect', () => {
    const p = checkRoute(pocket, [
      seg('Willow Ct to the dead end', [ft(350, 0), ft(350, -400)]),
      seg('Lakeview Dr to Spruce St', [ft(100, -600), ft(-350, -600)]),
    ], HOME);
    expect(p).toEqual(['Getting to Lakeview Dr to Spruce St: starts 320 ft from where the last street ended.']);
  });
});

describe('checkRoute: every stretch follows a street line', () => {
  // Both of these stay within 40 ft of a street the whole way, so the reference's check let them through.
  it('fails a stretch across the 40 ft yard between the two pieces of Spruce St', () => {
    const p = checkRoute(pocket, [
      seg('Spruce St to Lakeview Dr', [ft(-350, 0), ft(-350, -300), ft(-350, -340), ft(-350, -600)]),
    ], HOME);
    expect(p).toEqual(['Spruce St to Lakeview Dr: a 40 ft stretch is not on any street (a gap in the data '
      + 'is probably a real gap: dead end, park or yard). Cut it from real street pieces.']);
  });

  it('fails a corner cut across a front yard', () => {
    const p = checkRoute(pocket, [seg('Walnut St to Elm St', [ft(-700, 600), ft(-700, 30), ft(-670, 0), ft(0, 0)])], HOME);
    expect(p).toEqual(['Walnut St to Elm St: a 42 ft stretch is not on any street (a gap in the data '
      + 'is probably a real gap: dead end, park or yard). Cut it from real street pieces.']);
  });

  it('fails a street that starts anywhere but where the last one ended', () => {
    const p = checkRoute(pocket, [
      seg('Elm St to Walnut St', [ft(0, 0), ft(-700, 0)]),
      seg('Walnut St to Maple Ave', [ft(-700, 20), ft(-700, 600)]),
    ], HOME);
    expect(p).toEqual(['Getting to Walnut St to Maple Ave: starts 20 ft from where the last street ended.']);
  });
});

describe('checkRoute: never crosses a busy road', () => {
  const mill = findPocket(SPRINGWOOD_MILL_RD, HOME);

  it('fails a walk from Birch St across Mill Rd onto Oak St', () => {
    const p = checkRoute(mill, [
      seg('Birch St to Oak St', [ft(700, 0), ft(700, 300)]),
      seg('Oak St to Maple Ave', [ft(700, 300), ft(700, 600)]),
    ], HOME);
    expect(p).toEqual(['Getting to Oak St to Maple Ave: crosses Mill Rd. Turn back before it instead.']);
  });

  it('passes a walk that reaches Mill Rd and turns back', () => {
    expect(checkRoute(mill, [
      seg('Birch St to Mill Rd (stop before it)', [ft(700, 0), ft(700, 300)]),
      seg('Birch St to Elm St', [ft(700, 300), ft(700, 0)]),
    ], HOME)).toEqual([]);
  });
});
