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
import { avoidEntries, matchRoad } from './roadNames';
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

export type AvoidResult = {
  /** Street names to leave out of the route. */
  exclude: string[];
  /** Busy roads: off-limits already. */
  alreadyOff: string[];
  /** Typed names we couldn't match to one road near home (no match, or more than one fits). */
  notFound: string[];
  /** Each typed entry and what it matched, for the line under the field. */
  entries: AvoidEntry[];
};

/** One typed entry: the road it matched (as people say it), or what we might suggest. */
export type AvoidEntry = { typed: string } & (
  | { kind: 'match'; road: string; busy: boolean }
  | { kind: 'unsure'; suggestions: string[] }
  | { kind: 'none' }
);

/** The street names loaded for a plan, by where they are. Worked out once per plan. */
export type RoadNames = { pocket: string[]; busy: string[]; outside: string[] };

export function roadNamesNear(data: OsmData, home: Pt): RoadNames {
  const p = findPocket(data, home);
  return { pocket: [...new Set(p.pocket.map((s) => s.name))], busy: p.busyNames, outside: p.outside };
}

/** Match "roads to avoid" against the street names near home (see roadNames.ts). */
export function readAvoid(text: string, names: RoadNames): AvoidResult {
  const all = [...names.pocket, ...names.busy, ...names.outside];
  const out: AvoidResult = { exclude: [], alreadyOff: [], notFound: [], entries: [] };
  for (const typed of avoidEntries(text)) {
    const m = matchRoad(typed, all);
    if (m.kind !== 'match') {
      out.notFound.push(typed);
      out.entries.push({ typed, ...m });
      continue;
    }
    const busy = names.busy.includes(m.name) && !names.pocket.includes(m.name);
    if (busy) out.alreadyOff.push(shortName(m.name));
    else if (names.pocket.includes(m.name) && !out.exclude.includes(m.name)) out.exclude.push(m.name);
    out.entries.push({ typed, kind: 'match', road: shortName(m.name), busy });
  }
  return out;
}

/** "Avoiding: Oak St, Maple Ave": the roads typed entries matched, busy ones aside. Null when none. */
export function avoidingText(avoid: AvoidResult): string | null {
  const roads = [...new Set(avoid.entries.flatMap((e) => (e.kind === 'match' && !e.busy ? [e.road] : [])))];
  return roads.length ? `Avoiding: ${roads.join(', ')}` : null;
}

export function matchAvoid(text: string, data: OsmData, home: Pt): AvoidResult {
  return readAvoid(text, roadNamesNear(data, home));
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

/** "Your route from Elm St": the street only, never a town or neighborhood. "Your route" with no street. */
export function routeTitle(place: { road: string }): string {
  const street = shortName(place.road.trim());
  return street ? `Your route from ${street}` : 'Your route';
}

/**
 * A title saved by an older version, which could add a town or neighborhood after a comma
 * ("Your route from Elm St, Lakeview"): the street only, keeping a "(demo)" mark.
 */
export function streetOnlyTitle(saved: string): string {
  const m = /^Your route from ([^,(]*[^,(\s])(?:\s*,[^(]*)?(\s*\(demo\))?\s*$/.exec(saved.trim());
  if (!m || m[1].trim() === 'home') return `Your route${m?.[2] ?? ''}`;
  return `Your route from ${shortName(m[1].trim())}${m[2] ? ' (demo)' : ''}`;
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
