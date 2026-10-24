// What the Plan screen does with the visitor's answers once it has the street data.
// No React and no network here, so it's tested on its own.

import { ASK_DOOR_TIME_FROM_AGE, DEFAULT_DOOR_SECONDS, DOOR_SECONDS_CHOICES } from '../config';
import { shortName } from '../route/geo';
import { planRoute, type PlanResult } from '../route/plan';
import { replanFromHere, type Here, type ReplanOptions, type ReplanResult, type Visited } from '../route/replan';
import { findPocket } from '../route/pocket';
import type { OsmData, Pt } from '../route/types';

export type PlanForm = {
  address: string;
  date: string;
  start: string;
  end: string;
  ages: string;
  stroller: boolean;
  avoid: string;
  doorSeconds: number;
};

/** Halloween this year, or next year once it has passed. */
export function nextHalloween(today = new Date()): string {
  const y = today.getMonth() === 10 || today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  return `${y}-10-31`;
}

export const DEFAULT_FORM: PlanForm = {
  address: '',
  date: nextHalloween(),
  start: '17:00',
  end: '20:00',
  ages: '',
  stroller: false,
  avoid: '',
  doorSeconds: DEFAULT_DOOR_SECONDS,
};

/** "4, 7 and 10" -> [4, 7, 10]. Only whole ages from 1 to 99. */
export function parseAges(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 99);
}

export function youngestAge(text: string): number | null {
  const ages = parseAges(text);
  return ages.length ? Math.min(...ages) : null;
}

export const asksDoorTime = (youngest: number | null) => youngest !== null && youngest >= ASK_DOOR_TIME_FROM_AGE;

const norm = (s: string) => shortName(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
/** "Maple Avenue" matches "Maple Ave"; "maple" matches too, when only one street starts that way. */
const sameStreet = (typed: string, name: string) => {
  const a = norm(typed), b = norm(name);
  return a === b || (a.length >= 3 && b.split(' ')[0] === a);
};

export type AvoidResult = {
  /** Street names to leave out of the route. */
  exclude: string[];
  /** Busy roads: off-limits already. */
  alreadyOff: string[];
  /** Typed names we couldn't find near home. */
  notFound: string[];
};

/** Match "roads to avoid" against the streets near home. */
export function matchAvoid(text: string, data: OsmData, home: Pt): AvoidResult {
  const typed = text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const pocket = findPocket(data, home);
  const out: AvoidResult = { exclude: [], alreadyOff: [], notFound: [] };
  for (const t of typed) {
    const safe = pocket.pocket.filter((s) => sameStreet(t, s.name)).map((s) => s.name);
    const busy = pocket.busyNames.filter((n) => sameStreet(t, n));
    const outside = pocket.outside.filter((n) => sameStreet(t, n));
    if (safe.length) out.exclude.push(...safe);
    else if (busy.length) out.alreadyOff.push(...busy.map(shortName));
    else if (!outside.length) out.notFound.push(t);
  }
  return out;
}

/** houses: null when no route fits; undefined while it's still being worked out. */
export type DoorEstimate = { seconds: number; houses: number | null | undefined; crossings?: number };

/** Houses and street crossings for one door time's plan, for the door-time choices. */
export function doorEstimate(seconds: number, r: PlanResult): DoorEstimate {
  return r.ok
    ? { seconds, houses: r.plan.estimate.houses, crossings: r.plan.schedule.totals.streetCrossings }
    : { seconds, houses: null };
}

export type PlanOutcome = {
  result: PlanResult;
  avoid: AvoidResult;
  youngest: number;
  /** House estimates for each door time, when the youngest is old enough to ask. */
  estimates: DoorEstimate[] | null;
};

export type PlanOnce = { result: PlanResult; avoid: AvoidResult; youngest: number };

/** One plan at one door time. This is the slow part (seconds on a big neighborhood). */
export function planOnce(data: OsmData, home: Pt, form: PlanForm, doorSeconds: number): PlanOnce {
  const youngest = youngestAge(form.ages);
  if (youngest === null) throw new Error('Add the kids’ ages first.');
  const avoid = matchAvoid(form.avoid, data, home);
  const result = planRoute(data, home, {
    startTime: form.start, endTime: form.end, youngestAge: youngest, stroller: form.stroller,
    doorSeconds, exclude: avoid.exclude,
  });
  return { result, avoid, youngest };
}

/** Work for the planning worker: a plan at one door time, or a Night Mode replan. */
export type Job =
  | { kind: 'plan'; data: OsmData; home: Pt; form: PlanForm; doorSeconds: number }
  | { kind: 'replan'; data: OsmData; home: Pt; options: ReplanOptions; here: Here; visited: Visited[] };

export function runJob(job: Job): PlanOnce | ReplanResult {
  if (job.kind === 'plan') return planOnce(job.data, job.home, job.form, job.doorSeconds);
  return replanFromHere(job.data, job.home, job.options, job.here, job.visited);
}

/** The door time to plan with: the visitor's pick when we ask, otherwise the default. */
export function doorSecondsFor(form: PlanForm): number {
  return asksDoorTime(youngestAge(form.ages)) ? form.doorSeconds : DEFAULT_DOOR_SECONDS;
}

/** Everything at once: the plan, plus estimates for each door time when the youngest is 10+. */
export function makePlan(data: OsmData, home: Pt, form: PlanForm): PlanOutcome {
  const doorSeconds = doorSecondsFor(form);
  const main = planOnce(data, home, form, doorSeconds);
  const estimates = asksDoorTime(main.youngest)
    ? DOOR_SECONDS_CHOICES.map((s) => {
      return doorEstimate(s, s === doorSeconds ? main.result : planOnce(data, home, form, s).result);
    })
    : null;
  return { ...main, estimates };
}

/** "Your route from Elm St, Springwood", or "Your route from Elm St" when there's no town. */
export function routeTitle(place: { road: string; town: string }): string {
  const where = [shortName(place.road.trim()), place.town.trim()].filter(Boolean).join(', ');
  return `Your route from ${where || 'home'}`;
}

export type LeftOut = { text: string; houses: number };

/**
 * The "left out to fit the time" list: short street names, and "part of Maple Ave" for a
 * street that's also on the route. Most houses first.
 */
export function leftOut(skipped: Record<string, number>, walked: string[]): LeftOut[] {
  const onRoute = new Set(walked.map(shortName));
  const byName = new Map<string, number>();
  for (const [name, houses] of Object.entries(skipped)) {
    const n = shortName(name);
    byName.set(n, (byName.get(n) ?? 0) + houses);
  }
  return [...byName]
    .map(([n, houses]) => ({ text: onRoute.has(n) ? `part of ${n}` : n, houses }))
    .sort((a, b) => b.houses - a.houses);
}

const PATTERN_TEXT: Record<string, string> = {
  zigzag: 'Zigzag: both sides as you go',
  'walk through, skip the houses': 'Walk through, skip the houses',
};
/** A schedule row's pattern, as a sentence. */
export const patternText = (p: string) => PATTERN_TEXT[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

/** "17:07" -> "5:07 pm" */
export function ampm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
