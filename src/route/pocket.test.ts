import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from './__fixtures__/springwood';
import { findPocket, isBusy } from './pocket';

const road = (highway: string, lanes = '', maxspeed = '') => ({ highway, lanes, maxspeed });

describe('isBusy', () => {
  it('flags primary, secondary and trunk roads and their links', () => {
    for (const hw of ['primary', 'secondary', 'trunk', 'motorway', 'primary_link', 'secondary_link', 'trunk_link']) {
      expect(isBusy(road(hw))).toBe(true);
    }
    expect(isBusy(road('residential'))).toBe(false);
    expect(isBusy(road('tertiary'))).toBe(false);
  });

  it('flags 3 or more lanes', () => {
    expect(isBusy(road('residential', '3'))).toBe(true);
    expect(isBusy(road('residential', '2'))).toBe(false);
    expect(isBusy(road('residential', '3;2'))).toBe(false); // unreadable, like the reference
  });

  it('flags a posted 35 mph or more', () => {
    expect(isBusy(road('tertiary', '', '35 mph'))).toBe(true);
    expect(isBusy(road('tertiary', '', '25 mph'))).toBe(false);
  });
});

describe('findPocket on Springwood', () => {
  const p = findPocket(SPRINGWOOD, HOME);

  it('finds the home street and the busy roads around it', () => {
    expect(p.homeStreet).toBe('Elm St');
    expect(p.busyNames).toEqual(['Main St', 'Park Rd', 'Ridge Rd']);
  });

  it('matches the reference house estimates for every safe street', () => {
    expect(p.pocket.map((s) => [s.name, s.lengthFt, s.housesLeft, s.housesRight, s.distanceFt])).toEqual([
      ['Elm St', 2800, 32, 31, 104],
      ['Cedar St', 1201, 10, 19, 104],
      ['Park Ln', 601, 0, 0, 252],
      ['Spruce St', 298, 4, 4, 252],
      ['Willow Ct', 400, 6, 6, 451],
      ['Maple Ave', 2800, 43, 34, 579],
      ['Walnut St', 1201, 19, 10, 601],
      ['Birch St', 1201, 19, 19, 801],
    ]);
    expect(p.pocket.find((s) => s.name === 'Elm St')!.sidewalkShare).toBe(0.23);
    expect(p.pocket.find((s) => s.name === 'Elm St')!.touchesBusy).toEqual(['Main St', 'Park Rd']);
  });

  it('leaves out streets you can only reach by crossing a busy road', () => {
    expect(p.outside).toContain('Pine St'); // across Main St (primary)
    expect(p.outside).toContain('Ash St'); // across Park Rd (3 lanes)
    expect(p.outside).toContain('Hill St'); // across Ridge Rd (35 mph)
  });

  it('never bridges the yard between the two pieces of Spruce St', () => {
    // The far piece of Spruce St ends 40 ft from the near one. The reference joined them
    // (it allowed 50 ft) and pulled in Lakeview Dr, which you can't walk to.
    expect(p.outside).toContain('Lakeview Dr');
    expect(p.pocket.find((s) => s.name === 'Spruce St')!.pieces).toHaveLength(1);
  });

  it('counts no houses facing the park', () => {
    expect(p.pocket.find((s) => s.name === 'Park Ln')).toMatchObject({ housesLeft: 0, housesRight: 0 });
  });
});
