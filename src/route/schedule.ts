// Pace, door time, crossings, times, head-home and latest times.
// Ported from reference/plan_route.py (pace_for_age, parse_clock, segment_cost, plan, maps_links).
//
// Every segment here comes from the optimizer, so its pattern is already set (Hard rule 6) and
// it is a through street left from the far end. The reference's hand-planning paths (guessing a
// pattern, dead-end "exit: same" rows, trimming "optional" streets) aren't needed and aren't ported.

import { pyRound } from './geo';
import type { Segment } from './optimize';
import type { Pt } from './types';

// Youngest walker -> walking pace in mph, between doors (not counting door stops).
// Deliberately slow: costumes, dark, excitement, stopping to compare candy.
const PACE_BY_AGE: ReadonlyArray<[maxAge: number, mph: number]> = [
  [3, 1.2], // 3 and under (walking, not riding)
  [5, 1.5], // 4-5
  [8, 2.0], // 6-8
  [12, 2.5], // 9-12
  [99, 3.0], // 13+
];

/** A stroller or wagon caps the pace. */
export const STROLLER_MAX_MPH = 2.0;
export const FT_PER_MILE = 5280;

export function paceForAge(age: number, stroller = false): number {
  const row = PACE_BY_AGE.find(([maxAge]) => age <= maxAge);
  const mph = row ? row[1] : 3.0;
  return stroller ? Math.min(mph, STROLLER_MAX_MPH) : mph;
}

/** Reads "17:00", "5:00pm", "5pm" or "5:30 PM" as minutes after midnight. */
export function parseClock(text: string): number {
  const s = text.trim().toUpperCase().replace(/[\s.]/g, '');
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m && +m[1] <= 23 && +m[2] <= 59) return +m[1] * 60 + +m[2];
  m = /^(\d{1,2})(?::(\d{2}))?(AM|PM)$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +(m[2] ?? 0) <= 59) {
    return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +(m[2] ?? 0);
  }
  throw new Error(`Can't read the time "${text}". Try 5:00pm or 17:00.`);
}

/** Minutes after midnight -> "5:07" (12-hour, no am/pm), dropping seconds like the reference. */
export function fmtClock(minutes: number): string {
  const total = Math.floor(minutes + 1e-9);
  const m = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after midnight -> "17:07". */
export function fmt24(minutes: number): string {
  const m = ((Math.floor(minutes + 1e-9) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export type ScheduleOptions = {
  startTime: string;
  endTime: string;
  youngestAge: number;
  stroller?: boolean;
  paceMph?: number;
  doorSeconds?: number;
  crossSeconds?: number;
  majorCrossSeconds?: number;
  housesPerCrossing?: number;
  bufferMin?: number;
};

export type ScheduleRow = {
  time: string;
  t24: string;
  street: string;
  pattern: string;
  why: string;
  houses: number;
  minutes: number;
};

export type Schedule = {
  pace: { mph: number; doorSeconds: number };
  rows: ScheduleRow[];
  headHome: string;
  latestHeadHome: string;
  homeBy: string;
  windowEnd: string;
  minutesOverWindow: number;
  minutesSpare: number;
  totals: {
    distanceMiles: number;
    housesEstimate: number;
    walkingMinutes: number;
    doorMinutes: number;
    totalMinutes: number;
    streetCrossings: number;
  };
};

export type Pace = { mph: number; ftPerMin: number; doorMin: number; crossMin: number; housesPerCrossing: number };

export function paceFor(o: ScheduleOptions): Pace {
  let mph = o.paceMph || paceForAge(o.youngestAge);
  if (o.stroller) mph = Math.min(mph, STROLLER_MAX_MPH);
  return {
    mph,
    ftPerMin: (mph * FT_PER_MILE) / 60,
    doorMin: (o.doorSeconds ?? 60) / 60,
    crossMin: (o.crossSeconds ?? 20) / 60,
    housesPerCrossing: o.housesPerCrossing ?? 2,
  };
}

/** Start and end in minutes after midnight; a window past midnight ends the next day. */
export function windowOf(o: ScheduleOptions): [start: number, end: number] {
  const start = parseClock(o.startTime);
  let end = parseClock(o.endTime);
  if (end <= start) end += 1440;
  return [start, end];
}

/** Minutes the walk may take: the window minus the buffer. */
export function budgetFor(o: ScheduleOptions): number {
  const [start, end] = windowOf(o);
  return end - start - (o.bufferMin ?? 10);
}

/** Walk feet, door count, crossings and minutes for one row. */
export function segmentCost(seg: Segment, p: Pace) {
  const { housesLeft: left, housesRight: right, lengthFt: walk } = seg;
  let doors = 0, crossings = 0;
  if (seg.pattern === 'zigzag') {
    doors = left + right;
    crossings = Math.ceil(doors / p.housesPerCrossing);
  } else if (seg.pattern === 'one_side') {
    doors = Math.max(left, right);
  }
  const minutes = walk / p.ftPerMin + doors * p.doorMin + crossings * p.crossMin;
  return { walk, doors, crossings, minutes };
}

export function patternLabel(seg: Segment): string {
  if (seg.label) return seg.label;
  if (seg.pattern === 'walk_through') return 'walk through, skip the houses';
  if (seg.pattern === 'zigzag') return 'zigzag';
  return `${seg.housesLeft >= seg.housesRight ? 'left' : 'right'} side only`;
}

export function makeSchedule(segments: Segment[], o: ScheduleOptions): Schedule {
  const p = paceFor(o);
  const [startMin, endMin] = windowOf(o);
  // Keep time in whole microseconds, as Python's timedelta does, so clock times match the reference.
  const US = 60e6;
  let t = startMin * US;
  let walkFt = 0, doors = 0, crossings = 0;
  const rows = segments.map((seg) => {
    const c = segmentCost(seg, p);
    const row: ScheduleRow = {
      time: fmtClock(t / US), t24: fmt24(t / US), street: seg.name, pattern: patternLabel(seg),
      why: seg.why, houses: c.doors, minutes: pyRound(c.minutes),
    };
    t += Math.round(c.minutes * US);
    walkFt += c.walk;
    doors += c.doors;
    crossings += c.crossings;
    return row;
  });
  const headHome = t / US;
  const over = headHome - endMin; // a loop: head-home is home
  return {
    pace: { mph: p.mph, doorSeconds: o.doorSeconds ?? 60 },
    rows,
    headHome: fmtClock(headHome),
    latestHeadHome: fmtClock(endMin),
    homeBy: fmtClock(headHome),
    windowEnd: fmtClock(endMin),
    minutesOverWindow: over > 0 ? pyRound(over) : 0,
    minutesSpare: over < 0 ? pyRound(-over) : 0,
    totals: {
      distanceMiles: pyRound(walkFt / FT_PER_MILE, 2),
      housesEstimate: doors,
      walkingMinutes: pyRound(walkFt / p.ftPerMin),
      doorMinutes: pyRound(doors * p.doorMin),
      totalMinutes: pyRound(headHome - startMin),
      streetCrossings: crossings,
    },
  };
}

/**
 * Google Maps walking links: one waypoint per street (its far end), split into legs over the
 * waypoint limit. Coordinates only, never the address.
 */
export function mapsLinks(home: Pt, segments: Segment[], maxWaypoints = 9): string[] {
  const wps: Pt[] = [];
  for (const s of segments) {
    const pt = s.points[s.points.length - 1];
    const last = wps[wps.length - 1];
    if (pt && (!last || Math.abs(last[0] - pt[0]) > 1e-5 || Math.abs(last[1] - pt[1]) > 1e-5)) wps.push(pt);
  }
  const loc = (p: Pt) => `${p[0]},${p[1]}`;
  const stops = [home, ...wps, home];
  const links: string[] = [];
  for (let i = 0; i < stops.length - 1; ) {
    const chunk = stops.slice(i, i + maxWaypoints + 2);
    const q = new URLSearchParams({
      api: '1', origin: loc(chunk[0]), destination: loc(chunk[chunk.length - 1]), travelmode: 'walking',
    });
    const mids = chunk.slice(1, -1);
    if (mids.length) q.set('waypoints', mids.map(loc).join('|'));
    links.push(`https://www.google.com/maps/dir/?${q.toString().replace(/%2C/g, ',').replace(/%7C/g, '|')}`);
    i += chunk.length - 1;
  }
  return links;
}
