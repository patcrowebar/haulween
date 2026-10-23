// What the Plan screen does with the visitor's answers once it has the street data.
// No React and no network here, so it's tested on its own.

import { ASK_DOOR_TIME_FROM_AGE, DEFAULT_DOOR_SECONDS, DOOR_SECONDS_CHOICES } from '../config';
import { shortName } from '../route/geo';
import { planRoute, type PlanResult } from '../route/plan';
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
export type DoorEstimate = { seconds: number; houses: number | null | undefined };

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
      const r = s === doorSeconds ? main.result : planOnce(data, home, form, s).result;
      return { seconds: s, houses: r.ok ? r.plan.estimate.houses : null };
    })
    : null;
  return { ...main, estimates };
}

/** "17:07" -> "5:07 pm" */
export function ampm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
