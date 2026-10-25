// What the Plan screen does with the visitor's answers once it has the street data.
// No React and no network here, so it's tested on its own.

import {
  DEFAULT_DOOR_SECONDS, DEFAULT_PACE, DOOR_SECONDS_CHOICES, PACE_CHOICES, isPaceId, paceChoice, type PaceId,
} from '../config';
import { shortName } from '../route/geo';
import { planRoute, type PlanResult } from '../route/plan';
import { replanFromHere, type Here, type ReplanOptions, type ReplanResult, type Visited } from '../route/replan';
import { findPocket } from '../route/pocket';
import { withDefaults } from '../stored';
import type { OsmData, Pt } from '../route/types';

export type PlanForm = {
  address: string;
  date: string;
  start: string;
  end: string;
  avoid: string;
  doorSeconds: number;
  pace: PaceId;
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
  avoid: '',
  doorSeconds: DEFAULT_DOOR_SECONDS,
  pace: DEFAULT_PACE,
};

const isDoorChoice = (n: unknown): n is number => DOOR_SECONDS_CHOICES.some((c) => c === n);

/**
 * A form saved by any version of the app, with defaults for anything missing or unreadable.
 * Older versions asked the kids' ages and about a stroller instead of a pace: a stroller means
 * Slow, otherwise Steady, and the ages are dropped. Those versions only let the parent pick a
 * door time when the youngest was 10 or older; below that the saved 60 seconds wasn't a choice,
 * so it becomes today's default.
 */
export function toForm(saved: unknown): PlanForm {
  const f = withDefaults(saved, DEFAULT_FORM);
  const raw = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>;
  const old = !('pace' in raw) && ('ages' in raw || 'stroller' in raw);
  const pace: PaceId = isPaceId(raw.pace) ? raw.pace : old && raw.stroller === true ? 'slow' : DEFAULT_PACE;
  const ages = typeof raw.ages === 'string' ? (raw.ages.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 99) : [];
  const choseDoor = !old || (ages.length > 0 && Math.min(...ages) >= 10);
  const doorSeconds = choseDoor && isDoorChoice(f.doorSeconds) ? f.doorSeconds : DEFAULT_DOOR_SECONDS;
  return { ...f, pace, doorSeconds };
}

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

/**
 * What one choice would give, with the other setting as it is now. houses: null when no route
 * fits; undefined while it's still being worked out (until it's tapped).
 */
export type Estimate = { houses: number | null | undefined; crossings?: number; homeBy24?: string };
export type DoorEstimate = Estimate & { seconds: number };
export type PaceEstimate = Estimate & { pace: PaceId };

export function estimateOf(r: PlanResult): Estimate {
  return r.ok
    ? { houses: r.plan.estimate.houses, crossings: r.plan.schedule.totals.streetCrossings, homeBy24: r.plan.schedule.homeBy24 }
    : { houses: null };
}

export type PlanOutcome = {
  result: PlanResult;
  avoid: AvoidResult;
  /** Every door time, always, at the chosen pace. */
  doors: DoorEstimate[];
  /** Every pace, always, at the chosen door time. */
  paces: PaceEstimate[];
};

export type PlanOnce = { result: PlanResult; avoid: AvoidResult };

/** The settings that change the route: a key for plans already worked out. */
export const choiceKey = (f: Pick<PlanForm, 'doorSeconds' | 'pace'>) => `${f.doorSeconds}s|${f.pace}`;

/** One plan at the form's door time and pace. This is the slow part (seconds on a big neighborhood). */
export function planOnce(data: OsmData, home: Pt, form: PlanForm): PlanOnce {
  const avoid = matchAvoid(form.avoid, data, home);
  const result = planRoute(data, home, {
    startTime: form.start, endTime: form.end, paceMph: paceChoice(form.pace).mph,
    doorSeconds: form.doorSeconds, exclude: avoid.exclude,
  });
  return { result, avoid };
}

/** Work for the planning worker: a plan for one door time and pace, or a Night Mode replan. */
export type Job =
  | { kind: 'plan'; data: OsmData; home: Pt; form: PlanForm }
  | { kind: 'replan'; data: OsmData; home: Pt; options: ReplanOptions; here: Here; visited: Visited[] };

export function runJob(job: Job): PlanOnce | ReplanResult {
  if (job.kind === 'plan') return planOnce(job.data, job.home, job.form);
  return replanFromHere(job.data, job.home, job.options, job.here, job.visited);
}

/**
 * The estimates for every choice, from the plans worked out so far (by choiceKey). Each door
 * time is shown at the chosen pace, and each pace at the chosen door time.
 */
export function estimatesFor(form: PlanForm, known: (key: string) => PlanResult | undefined): Pick<PlanOutcome, 'doors' | 'paces'> {
  const at = (f: PlanForm): Estimate => {
    const r = known(choiceKey(f));
    return r ? estimateOf(r) : { houses: undefined };
  };
  return {
    doors: DOOR_SECONDS_CHOICES.map((seconds) => ({ seconds, ...at({ ...form, doorSeconds: seconds }) })),
    paces: PACE_CHOICES.map((p) => ({ pace: p.id, ...at({ ...form, pace: p.id }) })),
  };
}

/** Everything at once: the plan, plus every door time and every pace worked out (for tests). */
export function makePlan(data: OsmData, home: Pt, form: PlanForm): PlanOutcome {
  const plans = new Map<string, PlanResult>();
  const main = planOnce(data, home, form);
  plans.set(choiceKey(form), main.result);
  for (const f of [
    ...DOOR_SECONDS_CHOICES.map((doorSeconds) => ({ ...form, doorSeconds })),
    ...PACE_CHOICES.map((p) => ({ ...form, pace: p.id })),
  ]) {
    if (!plans.has(choiceKey(f))) plans.set(choiceKey(f), planOnce(data, home, f).result);
  }
  return { ...main, ...estimatesFor(form, (k) => plans.get(k)) };
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
