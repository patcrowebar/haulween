import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { planRoute } from '../route/plan';
import { replanFromHere } from '../route/replan';
import { findPocket } from '../route/pocket';
import { Geo, segDist } from '../route/geo';
import type { Segment } from '../route/optimize';
import { placeLabels, placePins, placePinsOnScreen, pointAt, routeLine, type Pin } from './pins';

/** Feet from each pin to its own row's street line. */
const offLine = (pins: Pin[], segs: Segment[], home: [number, number]) => {
  const geo = new Geo(home);
  return pins.map((p) => segDist(geo.xy([p.lat, p.lng]), segs[p.n - 1].points.map((q) => geo.xy(q))));
};

describe('placePins', () => {
  const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 });
  if (!r.ok) throw new Error('plan failed');
  const segs = r.plan.segments;
  const home = routeLine(segs)[0];
  const pins = placePins(segs, home);

  it('numbers one pin per schedule row', () => {
    expect(pins.map((p) => p.n)).toEqual(segs.map((_, i) => i + 1));
  });

  it('never stacks a pin on Home or on another pin', () => {
    for (const p of pins) expect(Math.hypot(p.lat - home[0], p.lng - home[1])).toBeGreaterThanOrEqual(0.00045);
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        expect(Math.hypot(pins[i].lat - pins[j].lat, pins[i].lng - pins[j].lng)).toBeGreaterThanOrEqual(0.00025 - 1e-12);
      }
    }
  });

  it('puts every pin on its own street line', () => {
    for (const d of offLine(pins, segs, home)) expect(d).toBeLessThan(1);
  });

  it('starts the walk at Home snapped onto Elm St, not at the doorstep', () => {
    expect(home).not.toEqual(HOME);
    expect(Math.abs(home[0] - 41.8)).toBeLessThan(1e-6); // Elm St runs along 41.8
  });
});

describe('pointAt', () => {
  it('finds a point part way along a line', () => {
    expect(pointAt([[0, 0], [0, 2], [2, 2]], 0.75)).toEqual([1, 2]);
  });
});

describe('placeLabels', () => {
  // A simple flat projection: 1 px per ~4 ft.
  const project = (p: [number, number]): [number, number] => [(p[1] + 82.1) * 70000 + 200, (41.8 - p[0]) * 90000 + 200];

  it('names each street once, inside the map, without touching a pin or another label', () => {
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 });
    if (!r.ok) throw new Error('plan failed');
    const home = routeLine(r.plan.segments)[0];
    const pins = placePins(r.plan.segments, home).map((p) => project([p.lat, p.lng]));
    const taken = pins.map(([x, y]): [number, number, number, number] => [x - 16, y - 16, x + 16, y + 16]);
    const pocket = findPocket(SPRINGWOOD, HOME);
    const labels = placeLabels([...pocket.streetLines, ...pocket.busyRoads], taken, project, [400, 400]);
    expect(new Set(labels.map((l) => l.name)).size).toBe(labels.length);
    expect(labels.length).toBeGreaterThan(5);
    const boxes = labels.map((l) => {
      const [x, y] = project([l.lat, l.lng]);
      const w = l.name.length * 7 + 8;
      return [x - w / 2, y - 8, x + w / 2, y + 8];
    });
    for (const b of boxes) {
      expect(b[0]).toBeGreaterThanOrEqual(4);
      expect(b[2]).toBeLessThanOrEqual(396);
      for (const t of [...taken, ...boxes.filter((o) => o !== b)]) {
        expect(b[0] < t[2] && t[0] < b[2] && b[1] < t[3] && t[1] < b[3]).toBe(false);
      }
    }
  });
});

describe('placePinsOnScreen', () => {
  it('keeps every pin off Home and off each other at the zoom the map opens at', () => {
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 });
    if (!r.ok) throw new Error('plan failed');
    const route = routeLine(r.plan.segments);
    const home = route[0];
    // The map fits the route into a phone-width map (358 x 380 px) with 40 px padding. At this
    // latitude a degree north is about 1.34 times as many pixels as a degree east (Web Mercator).
    const ky = 1 / Math.cos((41.8 * Math.PI) / 180);
    const spanX = Math.max(...route.map((p) => p[1])) - Math.min(...route.map((p) => p[1]));
    const spanY = (Math.max(...route.map((p) => p[0])) - Math.min(...route.map((p) => p[0]))) * ky;
    const k = Math.min((358 - 80) / spanX, (380 - 80) / spanY);
    const project = (p: [number, number]): [number, number] => [(p[1] + 82.1) * k + 200, (41.8 - p[0]) * k * ky + 200];
    const unproject = ([x, y]: [number, number]): [number, number] => [41.8 - (y - 200) / (k * ky), (x - 200) / k - 82.1];
    const pins = placePinsOnScreen(r.plan.segments, home, project, unproject);
    const [hx, hy] = project(home);
    const boxes = pins.map((p) => { const [x, y] = project([p.lat, p.lng]); return [x - 16, y - 16, x + 16, y + 16]; });
    const hit = (a: number[], b: number[]) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
    for (const b of boxes) expect(hit(b, [hx - 36, hy - 47, hx + 36, hy - 17])).toBe(false);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i], boxes[j])).toBe(false);
    expect(pins.map((p) => p.n)).toEqual(r.plan.segments.map((_, i) => i + 1));
  });

  it('keeps every pin on its own street line, even when that street is crowded near Home', () => {
    // Pin 15 on a real route sat off the route near Home: its street had no clear spot, so it
    // was pushed onto a ring around the street's middle. Now it stays on the street.
    const r = planRoute(SPRINGWOOD, HOME, { startTime: '5:00pm', endTime: '8:00pm', youngestAge: 10 });
    if (!r.ok) throw new Error('plan failed');
    const home = routeLine(r.plan.segments)[0];
    for (const k of [8000, 15000, 40000, 90000]) {
      const project = (p: [number, number]): [number, number] => [(p[1] + 82.1) * k + 200, (41.8 - p[0]) * k + 200];
      const unproject = ([x, y]: [number, number]): [number, number] => [41.8 - (y - 200) / k, (x - 200) / k - 82.1];
      const pins = placePinsOnScreen(r.plan.segments, home, project, unproject);
      // On screen, within a pixel of the line.
      const ftPerPx = 364000 / k;
      for (const d of offLine(pins, r.plan.segments, home)) expect(d / ftPerPx).toBeLessThan(1);
    }
  });

  it('keeps a replan\'s short last stretch home on its street and off Home', () => {
    const opts = { startTime: '17:00', endTime: '20:00', youngestAge: 10, doorSeconds: 45 };
    const r = planRoute(SPRINGWOOD, HOME, opts);
    if (!r.ok) throw new Error('plan failed');
    const s = r.plan.segments;
    const res = replanFromHere(SPRINGWOOD, HOME, { ...opts, now: 19 * 60 }, { row: s[1], at: null },
      [{ points: s[0].points, pattern: s[0].pattern }]);
    if (!res.ok) throw new Error('replan failed');
    const segs = res.plan.segments;
    const route = routeLine(segs);
    const home = route[route.length - 1];
    const ky = 1 / Math.cos((41.8 * Math.PI) / 180);
    const spanX = Math.max(...route.map((p) => p[1])) - Math.min(...route.map((p) => p[1]));
    const spanY = (Math.max(...route.map((p) => p[0])) - Math.min(...route.map((p) => p[0]))) * ky;
    const k = Math.min((358 - 80) / spanX, (380 - 80) / spanY);
    const project = (p: [number, number]): [number, number] => [(p[1] + 82.1) * k + 200, (41.8 - p[0]) * k * ky + 200];
    const unproject = ([x, y]: [number, number]): [number, number] => [41.8 - (y - 200) / (k * ky), (x - 200) / k - 82.1];
    const pins = placePinsOnScreen(segs, home, project, unproject);
    const [hx, hy] = project(home);
    for (const p of pins) {
      const [x, y] = project([p.lat, p.lng]);
      const overHome = x - 16 < hx + 36 && hx - 36 < x + 16 && y - 16 < hy - 17 && hy - 47 < y + 16;
      expect(overHome).toBe(false);
    }
    const ftPerPx = 364000 / (k * ky);
    for (const d of offLine(pins, segs, home)) expect(d / ftPerPx).toBeLessThan(1);
  });
});
