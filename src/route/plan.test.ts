// The optimizer, schedule and check together, pinned to the reference on the Springwood fixture.
// Expected values come from reference/run_fixture.py.

import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD, SPRINGWOOD_MILL_RD, ft } from './__fixtures__/springwood';
import { checkRoute } from './check';
import { key } from './geo';
import { buildGraph } from './graph';
import { Planner, toSegments } from './optimize';
import { findPocket } from './pocket';
import { planRoute, type PlanOptions } from './plan';
import { budgetFor, paceFor } from './schedule';

function plan(o: PlanOptions) {
  const r = planRoute(SPRINGWOOD, HOME, o);
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.plan;
}
const rows = (p: ReturnType<typeof plan>) => p.schedule.rows.map((r) => [r.time, r.street, r.pattern, r.houses, r.minutes]);
const segs = (p: ReturnType<typeof plan>) =>
  p.segments.map((s) => [s.name, s.pattern, s.lengthFt, s.housesLeft, s.housesRight]);

describe('one hour with a 6-year-old (5 to 6 pm)', () => {
  const p = plan({ startTime: '5:00pm', endTime: '6:00pm', youngestAge: 6 });

  it('matches the reference walk', () => {
    expect(segs(p)).toEqual([
      ['Elm St to Walnut St', 'zigzag', 600, 9, 0],
      ['Walnut St to Maple Ave', 'zigzag', 601, 10, 0],
      ['Maple Ave to Cedar St', 'zigzag', 700, 10, 0],
      ['Cedar St back home', 'walk_through', 701, 0, 0],
    ]);
    expect(p.estimate).toMatchObject({ minutes: 49, budget: 50, houses: 29 });
  });

  it('matches the reference schedule', () => {
    expect(rows(p)).toEqual([
      ['5:00', 'Elm St to Walnut St', 'zigzag', 9, 14],
      ['5:14', 'Walnut St to Maple Ave', 'zigzag', 10, 15],
      ['5:29', 'Maple Ave to Cedar St', 'zigzag', 10, 16],
      ['5:44', 'Cedar St back home', 'walk through, skip the houses', 0, 4],
    ]);
    expect(p.schedule).toMatchObject({ headHome: '5:48', latestHeadHome: '6:00', homeBy: '5:48', minutesSpare: 11 });
    expect(p.schedule.totals).toEqual({
      distanceMiles: 0.49, housesEstimate: 29, walkingMinutes: 15, doorMinutes: 29, totalMinutes: 49, streetCrossings: 15,
    });
  });
});

describe('three hours with a 10-year-old (5 to 8 pm)', () => {
  const p = plan({ startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 });

  it('matches the reference walk and schedule', () => {
    expect(segs(p)).toEqual([
      ['Elm St to Walnut St', 'zigzag', 600, 9, 0],
      ['Walnut St to Maple Ave', 'zigzag', 601, 10, 0],
      ['Walnut St to Ridge Rd (stop before it)', 'one_side', 601, 0, 10],
      ['Walnut St to Maple Ave', 'one_side', 601, 0, 10],
      ['Maple Ave to Birch St', 'zigzag', 1400, 21, 11],
      ['Birch St to Elm St', 'zigzag', 601, 10, 10],
      ['Elm St to Willow Ct', 'zigzag', 350, 5, 5],
      ['Willow Ct to the dead end', 'one_side', 400, 0, 6],
      ['Willow Ct to Elm St', 'one_side', 400, 0, 6],
      ['Elm St back home', 'zigzag', 450, 6, 5],
    ]);
    expect(rows(p).map((r) => [r[0], r[3], r[4]])).toEqual([
      ['5:00', 9, 13], ['5:13', 10, 14], ['5:27', 10, 13], ['5:40', 10, 13], ['5:53', 32, 44],
      ['6:36', 20, 26], ['7:03', 10, 13], ['7:16', 6, 8], ['7:24', 6, 8], ['7:31', 11, 15],
    ]);
    expect(p.schedule).toMatchObject({ headHome: '7:46', latestHeadHome: '8:00', homeBy24: '19:46', windowEnd24: '20:00' });
    // Start the walk home at 7:31; the latest that still gets everyone home by 8:00 is 7:44
    // (the walk home takes a little over 15 min; times round down, the safe way).
    expect(p.schedule.lastLeg).toEqual({ street: 'Elm St back home', start24: '19:31', latest24: '19:44' });
    expect(p.schedule.totals).toMatchObject({ distanceMiles: 1.14, housesEstimate: 124, totalMinutes: 167, streetCrossings: 47 });
    expect(p.estimate).toMatchObject({ minutes: 168, budget: 170, houses: 124, housesInPocket: 259 });
  });

  it('walks a street twice as one side out and the other side back', () => {
    const willow = p.schedule.rows.filter((r) => r.street.startsWith('Willow Ct'));
    expect(willow.map((r) => r.pattern)).toEqual([
      'right side now, the other side on the way back',
      'back along the other side',
    ]);
  });
});

describe('one hour at 30 seconds a door', () => {
  it('matches the reference, with more houses than at 60 seconds', () => {
    const p = plan({ startTime: '5:00pm', endTime: '6:00pm', youngestAge: 10, doorSeconds: 30 });
    expect(rows(p)).toEqual([
      ['5:00', 'Elm St to Walnut St', 'zigzag', 9, 9],
      ['5:08', 'Walnut St to Maple Ave', 'zigzag', 10, 9],
      ['5:18', 'Maple Ave to Cedar St', 'zigzag', 10, 10],
      ['5:28', 'Maple Ave to Birch St', 'right side now, the other side on the way back', 11, 9],
      ['5:36', 'Maple Ave to Cedar St', 'back along the other side', 11, 9],
      ['5:45', 'Cedar St back home', 'walk through, skip the houses', 0, 3],
    ]);
    expect(p.estimate.houses).toBe(51);
  });
});

describe('45 minutes with a 4-year-old, skipping Maple Ave', () => {
  it('matches the reference and never uses Maple Ave', () => {
    const p = plan({ startTime: '5:00pm', endTime: '5:45pm', youngestAge: 4, exclude: ['Maple Ave'] });
    expect(rows(p)).toEqual([
      ['5:00', 'Elm St to Birch St', 'right side now, the other side on the way back', 11, 17],
      ['5:17', 'Elm St back home', 'back along the other side', 10, 16],
    ]);
    expect(p.schedule.headHome).toBe('5:33');
    expect(p.segments.some((s) => s.name.includes('Maple'))).toBe(false);
  });
});

describe('rules every plan keeps', () => {
  const windows: PlanOptions[] = [
    { startTime: '5:00pm', endTime: '6:00pm', youngestAge: 6 },
    { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 },
    { startTime: '6:00pm', endTime: '7:30pm', youngestAge: 3, stroller: true },
    { startTime: '17:00', endTime: '21:00', youngestAge: 13, doorSeconds: 35 },
  ];

  it.each(windows)('fits the window and passes the route check (%o)', (o) => {
    const r = planRoute(SPRINGWOOD, HOME, o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.estimate.minutes).toBeLessThanOrEqual(r.plan.estimate.budget);
    expect(r.plan.schedule.minutesOverWindow).toBe(0);
    expect(checkRoute(r.plan.pocket, r.plan.segments, HOME)).toEqual([]);
  });

  it.each(windows)('names every row by where it goes (%o)', (o) => {
    const r = planRoute(SPRINGWOOD, HOME, o);
    if (!r.ok) throw new Error('plan failed');
    for (const s of r.plan.segments) expect(s.name).toMatch(/ to .+| back home$/);
  });

  it.each(windows)('starts and ends at home, each street joining the next (%o)', (o) => {
    const r = planRoute(SPRINGWOOD, HOME, o);
    if (!r.ok) throw new Error('plan failed');
    const s = r.plan.segments;
    for (let i = 1; i < s.length; i++) expect(s[i].points[0]).toEqual(s[i - 1].points[s[i - 1].points.length - 1]);
    const homeNode = s[0].points[0];
    const lastPts = s[s.length - 1].points;
    expect(lastPts[lastPts.length - 1]).toEqual(homeNode);
    expect(Math.hypot(homeNode[0] - HOME[0], homeNode[1] - HOME[1])).toBeLessThan(0.0002); // snapped onto Elm St
  });

  it('never reaches Lakeview Dr, which is only past a yard', () => {
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '10:00pm', youngestAge: 13 });
    if (!r.ok) throw new Error('plan failed');
    expect(r.plan.segments.some((s) => s.name.startsWith('Lakeview'))).toBe(false);
  });

  it('turns a no-house connector into a walk-through', () => {
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '6:00pm', youngestAge: 6 });
    if (!r.ok) throw new Error('plan failed');
    const back = r.plan.segments[r.plan.segments.length - 1];
    expect(back).toMatchObject({ pattern: 'walk_through', housesLeft: 0, housesRight: 0 });
  });
});

describe('a street the walk cannot reach', () => {
  it('is ignored instead of breaking the plan (the reference returned a 6-hour route here)', () => {
    // Rebuild the reference's looser safe area: Lakeview Dr and the far piece of Spruce St,
    // which only touch the rest across a 40 ft yard.
    const pocket = findPocket(SPRINGWOOD, HOME);
    const far = SPRINGWOOD.streets.filter(
      (s) => s.name === 'Lakeview Dr' || (s.name === 'Spruce St' && s.points[0][0] < ft(0, -320)[0]),
    );
    expect(far).toHaveLength(2);
    const loose = {
      ...pocket,
      pocket: [
        ...pocket.pocket,
        ...far.map((s) => ({ ...pocket.pocket[0], name: s.name, pieces: [s.points] })),
      ],
    };
    const o = { startTime: '5:00pm', endTime: '6:00pm', youngestAge: 6 };
    const planner = new Planner(buildGraph(SPRINGWOOD, loose, HOME), { ...paceFor(o), budget: budgetFor(o) });
    const { worked, minutes } = planner.optimize();
    expect(minutes).toBeLessThanOrEqual(50);
    expect(worked.reduce((s, e) => s + planner.houses(e), 0)).toBe(29);
    expect(checkRoute(pocket, toSegments(planner.tour(worked)), HOME)).toEqual([]);
  });
});

describe('Mill Rd: two safe streets that meet across a busy road', () => {
  const mill = findPocket(SPRINGWOOD_MILL_RD, HOME);
  const MILL_RD = ft(700, 300);
  const windows: PlanOptions[] = [
    { startTime: '5:00pm', endTime: '10:00pm', youngestAge: 13 },
    { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 },
    { startTime: '5:00pm', endTime: '6:30pm', youngestAge: 6 },
  ];

  it('keeps both streets in the safe area', () => {
    expect(mill.busyNames).toContain('Mill Rd');
    expect(mill.pocket.map((s) => s.name)).toEqual(expect.arrayContaining(['Birch St', 'Oak St']));
  });

  it.each(windows)('only ever turns back at Mill Rd, never walks through it (%o)', (o) => {
    const r = planRoute(SPRINGWOOD_MILL_RD, HOME, o);
    if (!r.ok) throw new Error(r.problems.join('\n'));
    const walk = r.plan.segments.flatMap((s, i) => (i ? s.points.slice(1) : s.points));
    for (let i = 1; i < walk.length - 1; i++) {
      if (key(walk[i]) === key(MILL_RD)) expect(key(walk[i + 1])).toBe(key(walk[i - 1]));
    }
  });

  it('goes around to Oak St by Maple Ave and skips the stretch of Birch St that only leads to Mill Rd', () => {
    const r = planRoute(SPRINGWOOD_MILL_RD, HOME, windows[1]);
    if (!r.ok) throw new Error(r.problems.join('\n'));
    const names = r.plan.segments.map((s) => s.name);
    expect(names).toContain('Maple Ave to Oak St');
    expect(names.some((n) => n.startsWith('Oak St'))).toBe(true);
    expect(names.some((n) => n.startsWith('Birch St'))).toBe(false);
    expect(Object.keys(r.plan.skipped)).toContain('Birch St');
  });
});
