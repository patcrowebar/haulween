// Night Mode: which row of the schedule the family is on, from GPS and taps.
// Plain logic, no React and no browser APIs, so it's tested with made-up positions.
//
// GPS only ever moves forward one row, and only once the family reaches the end of the row
// they're on (two good readings in a row there, so one stray reading can't do it). It never
// skips a street. A tap on a row's check-off button always wins over GPS.

import { Geo, dist, type XY } from './geo';
import type { Segment } from './optimize';
import type { Pt } from './types';

/** Readings less accurate than this (in meters) are ignored. */
export const GPS_ACCURACY_M = 30;
/** Farther than this from the row's street line, a reading isn't on the row. */
const OFF_ROW_FT = 130;
/** This close to the end of the row counts as reaching it. */
const END_FT = 80;
/** Good readings in a row at the end before moving on. */
const READINGS_AT_END = 2;
/** How far back along the row a reading may land (GPS jitters backwards too). */
const BACK_FT = 150;

export type Reading = { lat: number; lng: number; accuracy: number };

export type Track = {
  /** The row the family is on; rows.length once they're done. */
  current: number;
  done: boolean[];
  /** Farthest point reached along the current row, in feet. */
  progressFt: number;
  /** Good readings in a row near the end of the current row. */
  atEnd: number;
};

export const startTrack = (rows: number): Track => ({ current: 0, done: Array(rows).fill(false), progressFt: 0, atEnd: 0 });

const nextOpen = (done: boolean[], after: number) => {
  for (let i = after + 1; i < done.length; i++) if (!done[i]) return i;
  return done.length;
};

/** Where a point lands on a row: how far along (ft) and how far off the line (ft). */
export function project(points: Pt[], at: Pt, minAlongFt = -Infinity): { alongFt: number; offFt: number; lengthFt: number } {
  const geo = new Geo(points[0]);
  const xy = points.map((p) => geo.xy(p));
  const P = geo.xy(at);
  let acc = 0, best = { alongFt: 0, offFt: Infinity };
  for (let i = 0; i < xy.length - 1; i++) {
    const A = xy[i], B = xy[i + 1];
    const len = dist(A, B);
    if (acc + len >= minAlongFt) {
      const t = len ? Math.max(0, Math.min(1, ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) / (len * len))) : 0;
      const along = Math.max(acc + t * len, minAlongFt);
      const Q: XY = [A[0] + ((B[0] - A[0]) * (along - acc)) / (len || 1), A[1] + ((B[1] - A[1]) * (along - acc)) / (len || 1)];
      const off = dist(P, Q);
      if (off < best.offFt - 1e-9) best = { alongFt: along, offFt: off };
    }
    acc += len;
  }
  return { ...best, lengthFt: acc };
}

export type ReadingResult = {
  track: Track;
  /** False when the reading was too rough to use. */
  used: boolean;
  /** True when the reading is on the current row's street. */
  onRow: boolean;
  /** How far along the current row, 0 to 1, when the reading is on it. */
  fraction: number | null;
};

/** Take one GPS reading. Moves on at most one row, and only at the end of the current one. */
export function onReading(t: Track, segments: Segment[], r: Reading): ReadingResult {
  if (!(r.accuracy <= GPS_ACCURACY_M) || t.current >= segments.length) return { track: t, used: false, onRow: false, fraction: null };
  const row = segments[t.current];
  if (row.points.length < 2) return { track: t, used: true, onRow: false, fraction: null };
  const p = project(row.points, [r.lat, r.lng], t.progressFt - BACK_FT);
  if (p.offFt > OFF_ROW_FT) return { track: { ...t, atEnd: 0 }, used: true, onRow: false, fraction: null };
  const progressFt = Math.max(t.progressFt, p.alongFt);
  const nearEnd = p.lengthFt - p.alongFt <= END_FT && p.alongFt >= p.lengthFt / 2;
  const atEnd = nearEnd ? t.atEnd + 1 : 0;
  if (atEnd >= READINGS_AT_END) {
    const done = [...t.done];
    done[t.current] = true;
    return { track: { current: nextOpen(done, t.current), done, progressFt: 0, atEnd: 0 }, used: true, onRow: true, fraction: 1 };
  }
  return {
    track: { ...t, progressFt, atEnd }, used: true, onRow: true,
    fraction: p.lengthFt ? Math.min(1, progressFt / p.lengthFt) : 1,
  };
}

/** A tap on a row's check-off button: done, and on to the next row not done yet. */
export function checkOff(t: Track, i: number): Track {
  const done = [...t.done];
  done[i] = true;
  const current = i >= t.current ? nextOpen(done, i) : t.current;
  return { current, done, progressFt: current === t.current ? t.progressFt : 0, atEnd: 0 };
}

/** A tap on a row that's checked off: not done after all, and back to it. */
export function uncheck(t: Track, i: number): Track {
  const done = [...t.done];
  done[i] = false;
  return { current: Math.min(i, t.current), done, progressFt: 0, atEnd: 0 };
}

/** The point a given fraction of the way along a row, by distance (for the demo walk). */
export function pointAlong(points: Pt[], fraction: number): Pt {
  const geo = new Geo(points[0]);
  const xy = points.map((p) => geo.xy(p));
  const legs = xy.slice(1).map((P, i) => dist(xy[i], P));
  let goal = legs.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, fraction));
  for (let i = 0; i < legs.length; i++) {
    if (goal <= legs[i] && legs[i] > 0) {
      const f = goal / legs[i];
      return geo.ll(xy[i][0] + f * (xy[i + 1][0] - xy[i][0]), xy[i][1] + f * (xy[i + 1][1] - xy[i][1]));
    }
    goal -= legs[i];
  }
  return points[points.length - 1];
}
