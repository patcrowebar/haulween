// Night Mode: on track or behind, the head-home countdown, and the turn-around alert.
// Plain logic, no React. All times are minutes after midnight of the plan's day (past 1440
// after midnight), so a window that runs past midnight still adds up.

import { fmtClock, type Schedule } from './schedule';
import type { Track } from './track';

/** Minutes -> "5:07 pm". */
export const clock12 = (min: number) => `${fmtClock(min)} ${Math.floor((((min % 1440) + 1440) % 1440) / 60) >= 12 ? 'pm' : 'am'}`;

/** Behind by less than this is still on track. */
export const ON_TRACK_MIN = 3;

/**
 * Setting off up to this long before the planned start counts as starting the night early.
 * Earlier than that (the evening before, say), moving or tapping doesn't start it: that's a
 * look around, not the walk.
 */
export const EARLY_START_MIN = 120;

/** Moving this far along the first street counts as setting off (GPS wobbles less than this). */
export const SET_OFF_FT = 100;

/** Could the night start now, ahead of plan, if they set off? */
export const canStartEarly = (tl: Timeline, now: number) => now >= tl.start - EARLY_START_MIN;

/**
 * Has the night started? At the planned start, or earlier once they set off (within
 * EARLY_START_MIN of it). Until then nothing is tracked and the bar says when it starts.
 */
export const hasStarted = (tl: Timeline, now: number, startedEarly: boolean) =>
  now >= tl.start || (startedEarly && canStartEarly(tl, now));

/** Before the start: did this GPS reading show them setting off along the route, early enough to count? */
export const setsOffEarly = (tl: Timeline, now: number, before: Track, after: Track) =>
  canStartEarly(tl, now) && (after.current > before.current || after.progressFt >= SET_OFF_FT);

export type Timeline = {
  start: number;
  /** When each row is planned to start and end. */
  rows: Array<{ start: number; end: number }>;
  /** When to start the walk home (the last row), and the latest that still gets home on time. */
  headHome: number | null;
  latest: number | null;
  homeBy: number;
  windowEnd: number;
  /** The plan's night, "2026-10-31", for saying when it starts. */
  date?: string;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-31" -> "Oct 31". */
const dayText = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : 'on the night,';
};

/** "17:07" -> minutes, placed on or after `from` (minus a minute for rounding). */
const at = (hhmm: string, from: number) => {
  const [h, m] = hhmm.split(':').map(Number);
  let t = h * 60 + m + Math.floor(from / 1440) * 1440;
  while (t < from - 1) t += 1440;
  return t;
};

export function timeline(s: Schedule, start: number, date?: string): Timeline {
  const starts = s.rows.map((r) => at(r.t24, start));
  const homeBy = at(s.homeBy24, start);
  return {
    start,
    rows: starts.map((t, i) => ({ start: t, end: starts[i + 1] ?? homeBy })),
    headHome: s.lastLeg ? at(s.lastLeg.start24, start) : null,
    latest: s.lastLeg ? at(s.lastLeg.latest24, start) : null,
    homeBy,
    windowEnd: at(s.windowEnd24, start),
    date,
  };
}

export type StatusKind = 'before' | 'on_track' | 'behind' | 'turn_around' | 'done';

export type Status = {
  kind: StatusKind;
  /** "On track", "6 min behind", "Turn around now". */
  text: string;
  behindMin: number;
  /** Minutes until it's time to head home (negative once it's past). */
  headHomeIn: number | null;
  headingHome: boolean;
};

/**
 * Where the family stands. `fraction` is how far along the current row GPS puts them; without
 * it they get the benefit of the doubt: behind only once the row's planned end has passed.
 */
export function nightStatus(tl: Timeline, current: number, fraction: number | null, now: number, started = now >= tl.start): Status {
  const n = tl.rows.length;
  const headHomeIn = tl.headHome === null ? null : tl.headHome - now;
  if (current >= n) return { kind: 'done', text: 'Home! Nice haul.', behindMin: 0, headHomeIn, headingHome: false };
  if (!started) {
    // now < 0 means the plan's day hasn't come yet.
    const when = now < -1440 ? `${tl.date ? dayText(tl.date) : 'on the night,'} at` : now < 0 ? 'tomorrow at' : 'at';
    return { kind: 'before', text: `Starts ${when} ${clock12(tl.start)}`, behindMin: 0, headHomeIn, headingHome: false };
  }
  const row = tl.rows[current];
  const planned = fraction === null ? row.end : row.start + fraction * (row.end - row.start);
  const behindMin = Math.max(0, Math.round(now - planned));
  const headingHome = tl.headHome !== null && current === n - 1;
  if (!headingHome && tl.latest !== null && now >= tl.latest) {
    return { kind: 'turn_around', text: 'Turn around now', behindMin, headHomeIn, headingHome };
  }
  if (behindMin >= ON_TRACK_MIN) return { kind: 'behind', text: `${behindMin} min behind`, behindMin, headHomeIn, headingHome };
  return { kind: 'on_track', text: headingHome ? 'On track, heading home' : 'On track', behindMin, headHomeIn, headingHome };
}

/** Fire the turn-around alert once, at the latest safe time, unless they're already heading home. */
export function turnAroundDue(tl: Timeline, current: number, now: number, alerted: boolean): boolean {
  if (alerted || tl.latest === null || now < tl.latest) return false;
  return current < tl.rows.length - 1;
}

/** 72 -> "1 h 12 min", 5 -> "5 min". */
export function minutesText(min: number): string {
  const m = Math.max(0, Math.ceil(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** "Head home in 42 min", "Head home now", or nothing when there's no walk home. */
export function countdownText(s: Status): string | null {
  if (s.kind === 'done' || s.headHomeIn === null) return null;
  if (s.kind === 'before' && s.headHomeIn > 12 * 60) return null; // not tonight yet
  if (s.headingHome) return 'Walking home';
  return s.headHomeIn > 0.5 ? `Head home in ${minutesText(s.headHomeIn)}` : 'Head home now';
}
