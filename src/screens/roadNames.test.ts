// "Roads to avoid", matched forgivingly. Springwood street names only.
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_ADDRESS } from '../config';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { DEFAULT_FORM, avoidingText, makePlan, matchAvoid } from './planning';
import { matchRoad, parseName, typoDistance, typosAllowed, withSuggestion } from './roadNames';

const form = { ...DEFAULT_FORM, address: PLACEHOLDER_ADDRESS, date: '2026-10-31', start: '17:00', end: '20:00' };
const match = (typed: string, names: string[]) => matchRoad(typed, names);

describe('matching a typed road name', () => {
  it('treats "Street" and "St", and "Road" and "Rd", as the same, both ways', () => {
    expect(match('Elm Street', ['Elm St', 'Ash St'])).toEqual({ kind: 'match', name: 'Elm St' });
    expect(match('Elm St', ['Elm Street', 'Ash Street'])).toEqual({ kind: 'match', name: 'Elm Street' });
    expect(match('Ridge Road', ['Ridge Rd', 'Park Ln'])).toEqual({ kind: 'match', name: 'Ridge Rd' });
    expect(match('Ridge Rd', ['Ridge Road', 'Park Lane'])).toEqual({ kind: 'match', name: 'Ridge Road' });
  });

  it('treats the other street types and directions the same both ways', () => {
    const pairs: Array<[string, string]> = [
      ['Maple Av', 'Maple Avenue'], ['Maple Ave', 'Maple Avenue'], ['Park Lane', 'Park Ln'], ['Lakeview Drive', 'Lakeview Dr'],
      ['Willow Court', 'Willow Ct'], ['Cedar Place', 'Cedar Pl'], ['Pine Boulevard', 'Pine Blvd'], ['Hill Terrace', 'Hill Ter'],
      ['Ash Circle', 'Ash Cir'], ['Spruce Parkway', 'Spruce Pkwy'], ['Ridge Highway', 'Ridge Hwy'], ['N Elm St', 'North Elm Street'],
      ['South Elm St', 'S Elm St'], ['E Walnut St', 'East Walnut St'], ['West Birch Way', 'W Birch Way'],
    ];
    for (const [a, b] of pairs) {
      expect(match(a, [b, 'Main St'])).toEqual({ kind: 'match', name: b });
      expect(match(b, [a, 'Main St'])).toEqual({ kind: 'match', name: a });
    }
  });

  it('ignores case, periods, commas and extra spaces', () => {
    expect(parseName('  MAPLE   Ave. ')).toEqual({ name: 'maple', type: 'ave' });
    expect(match('maple ave.', ['Maple Ave'])).toEqual({ kind: 'match', name: 'Maple Ave' });
    expect(match('N. ELM  st.', ['North Elm Street'])).toEqual({ kind: 'match', name: 'North Elm Street' });
  });

  it('finds a name typed without its type when only one street has that name', () => {
    expect(match('Lakeview', ['Lakeview Dr', 'Park Rd', 'Park Ln'])).toEqual({ kind: 'match', name: 'Lakeview Dr' });
    expect(match('park', ['Lakeview Dr', 'Park Rd', 'Park Ln'])).toEqual({ kind: 'unsure', suggestions: ['Park Ln', 'Park Rd'] });
  });

  it('forgives one wrong letter in a short name and two in a longer one', () => {
    expect([2, 3, 5, 6, 8].map(typosAllowed)).toEqual([0, 1, 1, 2, 2]);
    expect(match('Mapel Ave', ['Maple Ave', 'Ash St'])).toEqual({ kind: 'match', name: 'Maple Ave' });
    expect(match('Spruse St', ['Spruce St', 'Pine St'])).toEqual({ kind: 'match', name: 'Spruce St' });
    expect(match('Lakevew Driv', ['Lakeview Dr', 'Elm St'])).toEqual({ kind: 'match', name: 'Lakeview Dr' });
    expect(match('Wilow Crt', ['Willow Ct', 'Walnut St'])).toEqual({ kind: 'match', name: 'Willow Ct' });
    expect(match('Elm Stret', ['Elm St', 'Ash St'])).toEqual({ kind: 'match', name: 'Elm St' });
    expect(typoDistance('mapel', 'maple')).toBe(1);
  });

  it("doesn't guess when a typo is as close to two streets, and offers both", () => {
    expect(match('Parl', ['Park Rd', 'Park Ln', 'Pine St'])).toEqual({ kind: 'unsure', suggestions: ['Park Ln', 'Park Rd'] });
  });

  it('takes one typo in a short name, and offers, but does not take, two', () => {
    expect(match('Elmm St', ['Elm St', 'Walnut St'])).toEqual({ kind: 'match', name: 'Elm St' });
    expect(match('Ekm Ave', ['Elm St', 'Walnut St'])).toEqual({ kind: 'unsure', suggestions: ['Elm St'] });
  });

  it('matches nothing for a name nowhere near', () => {
    expect(match('Zzyzx Blvd', ['Elm St', 'Maple Ave'])).toEqual({ kind: 'none' });
    expect(match('', ['Elm St'])).toEqual({ kind: 'none' });
  });

  it('swaps a typed entry for the suggestion tapped', () => {
    expect(withSuggestion('Maple Ave, Parl', 'Parl', 'Park Rd')).toBe('Maple Ave, Park Rd');
  });
});

describe('roads to avoid on Springwood', () => {
  it('still takes exact names, and busy roads are off-limits already', () => {
    const a = matchAvoid('Maple Ave, Main St', SPRINGWOOD, HOME);
    expect(a.exclude).toEqual(['Maple Ave']);
    expect(a.alreadyOff).toEqual(['Main St']);
    expect(a.notFound).toEqual([]);
  });

  it('avoids forgiving matches, and asks about the rest', () => {
    const a = matchAvoid('maple avenue., Spruse St, Parl, Zzyzx Blvd', SPRINGWOOD, HOME);
    expect(a.exclude).toEqual(['Maple Ave', 'Spruce St']);
    expect(a.notFound).toEqual(['Parl', 'Zzyzx Blvd']);
    expect(a.entries).toEqual([
      { typed: 'maple avenue.', kind: 'match', road: 'Maple Ave', busy: false },
      { typed: 'Spruse St', kind: 'match', road: 'Spruce St', busy: false },
      { typed: 'Parl', kind: 'unsure', suggestions: ['Park Ln', 'Park Rd'] },
      { typed: 'Zzyzx Blvd', kind: 'none' },
    ]);
  });

  it('the "Avoiding:" line lists the roads matched', () => {
    expect(avoidingText(matchAvoid('Maple Avenue, spruse st, Main Street, Zzyzx Blvd', SPRINGWOOD, HOME))).toBe('Avoiding: Maple Ave, Spruce St');
    expect(avoidingText(matchAvoid('Zzyzx Blvd', SPRINGWOOD, HOME))).toBeNull();
  });

  it('nonsense matches nothing, and the route still plans, without the roads that did match', () => {
    const out = makePlan(SPRINGWOOD, HOME, { ...form, avoid: 'Zzyzx Blvd, Mapel Ave' });
    if (!out.result.ok) throw new Error('plan failed');
    expect(out.avoid.exclude).toEqual(['Maple Ave']);
    expect(out.result.plan.segments.some((s) => s.street === 'Maple Ave')).toBe(false);
    expect(out.result.plan.estimate.houses).toBeGreaterThan(0);
  });
});
