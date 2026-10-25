// Pace, door time, crossings, times, head-home and latest times.
// Ported from reference/plan_route.py (pace_for_age, parse_clock, segment_cost, plan, maps_links).
//
// Every segment here comes from the optimizer, so its pattern is already set (Hard rule 6) and
// it is a through street left from the far end. The reference's hand-planning paths (guessing a
// pattern, dead-end "exit: same" rows, trimming "optional" streets) aren't needed and aren't ported.

import { pyRound } from './geo';
import type { Segment } from './optimize';
import type { Pt } from './types';

// Walking pace is a setting the parent picks (Slow, Steady, Quick, Fast), in mph between doors,
// not counting door stops. The reference guessed it from the youngest walker's age; Haulween no
// longer asks ages. Deliberately slow: costumes, dark, excitement, stopping to compare candy.

/** Steady: most kids. */
export const DEFAULT_PACE_MPH = 2.0;
/** 45 seconds a door. */
export const DEFAULT_DOOR_SECONDS = 45;
export const FT_PER_MILE = 5280;

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
  /** Walking pace between doors. */
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
  /** The same times as "17:46", for showing with am/pm. */
  homeBy24: string;
  windowEnd24: string;
  /**
   * The last row, the walk back home: when the plan starts it, and the latest it can start
   * and still be home by the end of the window.
   */
  lastLeg: { street: string; start24: string; latest24: string } | null;
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
  const mph = o.paceMph || DEFAULT_PACE_MPH;
  return {
    mph,
    ftPerMin: (mph * FT_PER_MILE) / 60,
    doorMin: (o.doorSeconds ?? DEFAULT_DOOR_SECONDS) / 60,
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
  let walkFt = 0, doors = 0, crossings = 0, lastMin = 0;
  const rows = segments.map((seg) => {
    const c = segmentCost(seg, p);
    lastMin = c.minutes;
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
    pace: { mph: p.mph, doorSeconds: o.doorSeconds ?? DEFAULT_DOOR_SECONDS },
    rows,
    headHome: fmtClock(headHome),
    latestHeadHome: fmtClock(endMin),
    homeBy: fmtClock(headHome),
    windowEnd: fmtClock(endMin),
    homeBy24: fmt24(headHome),
    windowEnd24: fmt24(endMin),
    lastLeg: rows.length && segments[segments.length - 1].name.endsWith(' back home')
      ? { street: rows[rows.length - 1].street, start24: rows[rows.length - 1].t24, latest24: fmt24(endMin - lastMin) }
      : null,
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

/** Google Maps' limit on stops after the start, on phones. */
export const MAPS_MAX_STOPS = 9;

/**
 * One Google Maps walking link for the next stretch: from the start of row `from`, through the far
 * end of each row after it, up to `maxStops` stops. Street points only, never the address.
 * null once the route is done.
 */
export function nextStretchLink(segments: Segment[], from = 0, maxStops = MAPS_MAX_STOPS): string | null {
  const rows = segments.slice(Math.max(0, from)).filter((s) => s.points.length >= 2);
  if (!rows.length) return null;
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
  const origin = rows[0].points[0];
  const stops: Pt[] = [];
  for (const s of rows) {
    const pt = s.points[s.points.length - 1];
    if (!same(stops[stops.length - 1] ?? origin, pt)) stops.push(pt);
    if (stops.length === maxStops) break;
  }
  if (!stops.length) return null;
  const loc = (p: Pt) => `${Number(p[0].toFixed(6))},${Number(p[1].toFixed(6))}`;
  const q = new URLSearchParams({
    api: '1', origin: loc(origin), destination: loc(stops[stops.length - 1]), travelmode: 'walking',
  });
  if (stops.length > 1) q.set('waypoints', stops.slice(0, -1).map(loc).join('|'));
  return `https://www.google.com/maps/dir/?${q.toString().replace(/%2C/g, ',').replace(/%7C/g, '|')}`;
}
