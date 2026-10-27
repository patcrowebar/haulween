// Night Mode logic with made-up GPS positions on the Springwood fixture. No real location, ever.
import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from './__fixtures__/springwood';
import { checkRoute } from './check';
import { Geo, key } from './geo';
import { planRoute } from './plan';
import { replanFromHere } from './replan';
import { nextStretchLink, parseClock } from './schedule';
import { countdownText, hasStarted, nightStatus, replanTime, setsOffEarly, timeline, turnAroundDue } from './status';
import { GPS_ACCURACY_M, checkOff, onReading, pointAlong, startTrack, uncheck, type Reading, type Track } from './track';
import type { Pt } from './types';

const opts = { startTime: '17:00', endTime: '20:00', paceMph: 2.5, doorSeconds: 60 };
const r = planRoute(SPRINGWOOD, HOME, opts);
if (!r.ok) throw new Error('plan failed');
const plan = r.plan;
const segs = plan.segments;
const tl = timeline(plan.schedule, parseClock(opts.startTime));

const reading = (p: Pt, accuracy = 5): Reading => ({ lat: p[0], lng: p[1], accuracy });
/** A point `ft` feet east and `north` feet north of p. */
const nudge = (p: Pt, east: number, north: number): Pt => new Geo(p).ll(east, north);
const feed = (t: Track, pts: Reading[]) => pts.reduce((acc, p) => onReading(acc, segs, p).track, t);
/** Readings every few feet along a row, start to end. */
const walkRow = (i: number, steps = 20) => Array.from({ length: steps + 1 }, (_, k) => reading(pointAlong(segs[i].points, k / steps)));

describe('GPS street detection', () => {
  it('moves to the next street once the family reaches the end of this one', () => {
    let t = startTrack(segs.length);
    t = feed(t, walkRow(0).slice(0, 10));
    expect(t.current).toBe(0);
    t = feed(t, walkRow(0).slice(10));
    expect(t.current).toBe(1);
    expect(t.done[0]).toBe(true);
  });

  it('follows the whole walk street by street, never skipping one', () => {
    let t = startTrack(segs.length);
    const seen = [t.current];
    for (let i = 0; i < segs.length; i++) {
      for (const p of walkRow(i)) {
        t = onReading(t, segs, p).track;
        if (t.current !== seen[seen.length - 1]) seen.push(t.current);
      }
    }
    expect(seen).toEqual(Array.from({ length: segs.length + 1 }, (_, i) => i));
    expect(t.done.every(Boolean)).toBe(true);
  });

  it('ignores readings rougher than about 30 m', () => {
    const end = segs[0].points[segs[0].points.length - 1];
    const res = onReading(startTrack(segs.length), segs, reading(end, GPS_ACCURACY_M + 5));
    expect(res.used).toBe(false);
    expect(feed(startTrack(segs.length), [reading(end, 60), reading(end, 45), reading(end, 31)]).current).toBe(0);
  });

  it("doesn't move on for one stray reading at the end of the street", () => {
    const end = segs[0].points[segs[0].points.length - 1];
    const start = segs[0].points[0];
    // Standing at the start, one jumpy reading lands at the far end, then back to the start.
    const t = feed(startTrack(segs.length), [reading(start), reading(end, 25), reading(start)]);
    expect(t.current).toBe(0);
  });

  it('never skips ahead, even when GPS puts them on a later street', () => {
    const later = pointAlong(segs[4].points, 0.9);
    const t = feed(startTrack(segs.length), [reading(later), reading(later), reading(later), reading(later)]);
    expect(t.current).toBe(0);
  });

  it('holds steady through noisy readings along the street', () => {
    let t = startTrack(segs.length);
    const pts = walkRow(0, 30).slice(0, 25);
    const noisy = pts.map((p, i) => reading(nudge([p.lat, p.lng], ((i * 37) % 23) - 11, ((i * 53) % 29) - 14), 20));
    t = feed(t, noisy);
    expect(t.current).toBe(0);
    t = feed(t, walkRow(0).slice(-3));
    expect(t.current).toBe(1);
  });

  it('a tap always overrides GPS, both ways', () => {
    let t = checkOff(startTrack(segs.length), 0);
    expect(t.current).toBe(1);
    t = checkOff(t, 2); // they skipped row 1 and did row 2
    expect(t.current).toBe(3);
    expect(t.done[1]).toBe(false);
    t = checkOff(t, 1); // went back for it after all
    expect(t.current).toBe(3);
    t = uncheck(t, 1);
    expect(t.current).toBe(1);
    expect(t.done.slice(0, 3)).toEqual([true, false, true]);
    // GPS at the end of row 0 (already done) doesn't undo the tap or move anything.
    const end = segs[0].points[segs[0].points.length - 1];
    expect(feed(t, [reading(end), reading(end)]).current).toBe(1);
  });
});

describe('on track or behind', () => {
  const row = 3;

  it('is on track at the planned time', () => {
    const now = tl.rows[row].start + 0.5 * (tl.rows[row].end - tl.rows[row].start);
    expect(nightStatus(tl, row, 0.5, now)).toMatchObject({ kind: 'on_track', text: 'On track' });
  });

  it('says how many minutes behind', () => {
    const now = tl.rows[row].start + 6;
    expect(nightStatus(tl, row, 0, now)).toMatchObject({ kind: 'behind', text: '6 min behind', behindMin: 6 });
  });

  it('without GPS, is behind only once the street should be finished', () => {
    expect(nightStatus(tl, row, null, tl.rows[row].end - 1).kind).toBe('on_track');
    expect(nightStatus(tl, row, null, tl.rows[row].end + 6).text).toBe('6 min behind');
  });

  it('a couple of minutes behind is still on track', () => {
    expect(nightStatus(tl, row, 0, tl.rows[row].start + 2).kind).toBe('on_track');
  });

  it('counts down to the head-home time', () => {
    const s = nightStatus(tl, 0, 0, tl.start);
    expect(s.headHomeIn).toBe(tl.headHome! - tl.start);
    expect(countdownText(s)).toMatch(/^Head home in \d+ h \d+ min$/);
  });

  it('before the start, says when it starts', () => {
    expect(nightStatus(tl, 0, null, tl.start - 30).text).toBe('Starts at 5:00 pm');
  });
});

describe('turn-around alert', () => {
  const last = tl.rows.length - 1;

  it('fires at the latest safe time, once', () => {
    expect(turnAroundDue(tl, 5, tl.latest! - 1, false)).toBe(false);
    expect(turnAroundDue(tl, 5, tl.latest!, false)).toBe(true);
    expect(turnAroundDue(tl, 5, tl.latest! + 3, true)).toBe(false);
    expect(nightStatus(tl, 5, null, tl.latest!)).toMatchObject({ kind: 'turn_around', text: 'Turn around now' });
  });

  it("doesn't fire once they're on the way home", () => {
    expect(turnAroundDue(tl, last, tl.latest! + 1, false)).toBe(false);
    expect(nightStatus(tl, last, 0.5, tl.latest!).kind).not.toBe('turn_around');
  });
});

describe('replan from here', () => {
  const end = parseClock(opts.endTime);
  const mid = 5;
  const visited = segs.slice(0, mid).map((s) => ({ points: s.points, pattern: s.pattern }));

  it('starts where they are, ends at home, fits the time left and passes the route check', () => {
    const now = tl.rows[mid].start + 25; // 25 minutes behind
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now }, { row: segs[mid], at: null }, visited);
    if (!res.ok) throw new Error(res.problems.join('; '));
    const s = res.plan.segments;
    expect(checkRoute(res.plan.pocket, s, HOME)).toEqual([]);
    expect(s[0].points[0]).toEqual(segs[mid].points[0]);
    const homeNode = segs[segs.length - 1].points[segs[segs.length - 1].points.length - 1];
    expect(s[s.length - 1].points[s[s.length - 1].points.length - 1]).toEqual(homeNode);
    expect(s[s.length - 1].name).toMatch(/back home$/);
    for (let i = 1; i < s.length; i++) expect(s[i].points[0]).toEqual(s[i - 1].points[s[i - 1].points.length - 1]);
    expect(res.plan.estimate.minutes).toBeLessThanOrEqual(end - now - 10);
    // Fewer houses than the rest of the old plan would have given, since there's less time.
    const restOld = plan.schedule.rows.slice(mid).reduce((t, x) => t + x.houses, 0);
    expect(res.plan.estimate.houses).toBeLessThan(restOld);
    expect(res.plan.estimate.houses).toBeGreaterThan(0);
  });

  it("doesn't count houses already visited again", () => {
    const now = tl.rows[mid].start;
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now }, { row: segs[mid], at: null }, visited);
    if (!res.ok) throw new Error(res.problems.join('; '));
    const before = new Set(visited.filter((v) => v.pattern === 'zigzag').flatMap((v) =>
      v.points.slice(1).map((p, i) => `${key(v.points[i])}>${key(p)}`)));
    for (const row of res.plan.segments.filter((x) => x.pattern === 'zigzag')) {
      const pairs = row.points.slice(1).map((p, i) => `${key(row.points[i])}>${key(p)}`);
      expect(pairs.some((p) => before.has(p) || before.has(p.split('>').reverse().join('>')))).toBe(false);
    }
  });

  it('drops more streets the less time is left, and says which', () => {
    const roomy = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: tl.rows[mid].start }, { row: segs[mid], at: null }, visited);
    const tight = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: end - 45 }, { row: segs[mid], at: null }, visited);
    if (!roomy.ok || !tight.ok) throw new Error('replan failed');
    expect(tight.plan.estimate.houses).toBeLessThan(roomy.plan.estimate.houses);
    expect(tight.plan.estimate.minutes).toBeLessThanOrEqual(35);
    const left = (p: typeof tight.plan) => Object.values(p.skipped).reduce((a, b) => a + b, 0);
    expect(left(tight.plan)).toBeGreaterThan(left(roomy.plan));
    // Houses kept plus houses left out add up to every house not visited yet.
    expect(tight.plan.estimate.houses + left(tight.plan)).toBe(roomy.plan.estimate.houses + left(roomy.plan));
  });

  it('with no time left, walks straight home on real streets', () => {
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: end - 5 }, { row: segs[mid], at: null }, visited);
    if (!res.ok) throw new Error(res.problems.join('; '));
    expect(res.plan.estimate.houses).toBe(0);
    expect(checkRoute(res.plan.pocket, res.plan.segments, HOME)).toEqual([]);
    expect(res.plan.segments.every((s) => s.pattern === 'walk_through')).toBe(true);
  });

  it('before the night starts, replans from the planned start, not from now', () => {
    const start = parseClock(opts.startTime);
    const eveningBefore = start - 1440 + 120;
    expect(replanTime(tl, eveningBefore, false)).toBe(start);
    expect(replanTime(tl, start - 30, false)).toBe(start);
    expect(replanTime(tl, start + 30, true)).toBe(start + 30);
    expect(replanTime(tl, start - 15, true)).toBe(start - 15); // set off early: from now
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: replanTime(tl, eveningBefore, false) }, { row: segs[0], at: null }, []);
    if (!res.ok) throw new Error(res.problems.join('; '));
    expect(res.plan.schedule.rows[0].t24).toBe(opts.startTime);
    expect(res.plan.estimate.minutes).toBeLessThanOrEqual(end - start - 10);
    expect(checkRoute(res.plan.pocket, res.plan.segments, HOME)).toEqual([]);
  });

  it('from a GPS point mid-street, starts at the next corner ahead', () => {
    const at = pointAlong(segs[mid].points, 0.6);
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: tl.rows[mid].start + 10 }, { row: segs[mid], at }, visited);
    if (!res.ok) throw new Error(res.problems.join('; '));
    const i = segs[mid].points.findIndex((p) => p[0] === res.start![0] && p[1] === res.start![1]);
    expect(i).toBeGreaterThan(0);
    expect(res.plan.segments[0].points[0]).toEqual(res.start);
    expect(checkRoute(res.plan.pocket, res.plan.segments, HOME)).toEqual([]);
  });
});

describe('next stretch in Google Maps', () => {
  const stops = (url: string) => {
    const q = new URL(url).searchParams;
    return [...(q.get('waypoints')?.split('|') ?? []), q.get('destination')!];
  };
  const loc = (p: Pt) => `${Number(p[0].toFixed(6))},${Number(p[1].toFixed(6))}`;

  it('is one walking link covering at most 9 stops, street points only', () => {
    const url = nextStretchLink(segs, 0)!;
    const q = new URL(url).searchParams;
    expect(q.get('travelmode')).toBe('walking');
    expect(q.get('origin')).toBe(loc(segs[0].points[0]));
    expect(stops(url).length).toBeLessThanOrEqual(9);
    expect(stops(url)[0]).toBe(loc(segs[0].points[segs[0].points.length - 1]));
    expect(url).not.toMatch(/Elm|1428|Springwood/);
  });

  it('moves forward as streets are finished, and ends at home', () => {
    const later = nextStretchLink(segs, segs.length - 2)!;
    expect(new URL(later).searchParams.get('origin')).toBe(loc(segs[segs.length - 2].points[0]));
    const homeNode = segs[segs.length - 1].points[segs[segs.length - 1].points.length - 1];
    expect(stops(later)[stops(later).length - 1]).toBe(loc(homeNode));
    expect(nextStretchLink(segs, segs.length)).toBeNull();
  });
});

describe('starting the night early', () => {
  const start = tl.start; // 5:00 pm on the plan's day
  const t0 = startTrack(segs.length);
  const along = (ft: number) => onReading(t0, segs, reading(pointAlong(segs[0].points, ft / segs[0].lengthFt))).track;

  it('the evening before, says when it starts and never shows "behind"', () => {
    const eveningBefore = start - 1440 + 120; // 7:00 pm the day before
    for (const fraction of [null, 0, 0.5]) {
      const s = nightStatus(tl, 0, fraction, eveningBefore, hasStarted(tl, eveningBefore, false));
      expect(s).toMatchObject({ kind: 'before', text: 'Starts tomorrow at 5:00 pm', behindMin: 0 });
      expect(countdownText(s)).toBeNull();
    }
  });

  it('days ahead, says which night', () => {
    const tlDated = timeline(plan.schedule, start, '2026-10-31');
    expect(nightStatus(tlDated, 0, null, start - 7 * 1440, false).text).toBe('Starts Oct 31 at 5:00 pm');
  });

  it('that morning, says when it starts', () => {
    const morning = 9 * 60;
    expect(nightStatus(tl, 0, null, morning, hasStarted(tl, morning, false)).text).toBe('Starts at 5:00 pm');
  });

  it("walking the route the evening before doesn't start the night", () => {
    const eveningBefore = start - 1440 + 120;
    expect(setsOffEarly(tl, eveningBefore, t0, along(300))).toBe(false);
    expect(hasStarted(tl, eveningBefore, true)).toBe(false);
  });

  it('setting off along the route a little early starts the night, on track', () => {
    const early = start - 15;
    expect(setsOffEarly(tl, early, t0, along(300))).toBe(true);
    expect(hasStarted(tl, early, true)).toBe(true);
    expect(nightStatus(tl, 0, 0.3, early, true)).toMatchObject({ kind: 'on_track', behindMin: 0 });
  });

  it("standing at home with GPS wobbling doesn't count as setting off", () => {
    const wobble = onReading(t0, segs, reading(nudge(segs[0].points[0], 8, 12), 15)).track;
    expect(setsOffEarly(tl, start - 15, t0, wobble)).toBe(false);
  });

  it('starts at the start time on its own, without anyone moving', () => {
    expect(hasStarted(tl, start, false)).toBe(true);
    expect(nightStatus(tl, 0, null, start, true)).toMatchObject({ kind: 'on_track', text: 'On track' });
  });
});
