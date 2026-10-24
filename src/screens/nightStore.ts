// Tonight's plan and progress, kept in this browser only (localStorage), so a reload or a
// dropped connection never loses them and Night Mode reopens with no network at all.
// "Replan from here" uses the street data kept with the planned route (planStore.ts). If the
// phone had no room for it, the plan is still kept and only replanning is off.

import type { Segment } from '../route/optimize';
import type { PlanOptions } from '../route/plan';
import { fmt24, type Schedule } from '../route/schedule';
import { startTrack, type Track } from '../route/track';
import type { NamedLine, OsmData, Pt } from '../route/types';
import { isNum, withDefaults } from '../stored';
import { loadStreets, saveStreets } from './planStore';

const PLAN_KEY = 'haulween.night.plan';
const PROGRESS_KEY = 'haulween.night.progress';

export type NightPlan = {
  v: 1;
  title: string;
  demo: boolean;
  /** The plan's night, "2026-10-31". Times are minutes after midnight of this day. */
  date: string;
  options: PlanOptions;
  /** Home as planned from (coordinates only). */
  home: Pt;
  /** When this schedule starts: the plan's start time, or the time of the last replan. */
  start: number;
  segments: Segment[];
  schedule: Schedule;
  lines: { streetLines: NamedLine[]; busyRoads: NamedLine[]; areas: NamedLine[] };
};

export type NightProgress = {
  track: Track;
  /** The turn-around alert has fired. */
  alerted: boolean;
  /** Play a sound with the turn-around alert (the parent's choice when starting). */
  sound: boolean;
  /** Houses and streets done before the last replan. */
  earlier: { houses: number; streets: number };
  /** The demo's own clock (minutes), so the demo walk can run at 10x. */
  demoClock: number | null;
  /** They set off before the planned start (moved along the route or checked off a street). */
  startedEarly: boolean;
};

function read<T>(k: string): T | null {
  try {
    const s = localStorage.getItem(k);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function write(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/**
 * A saved plan, from any version of the app. The route itself (its streets, schedule, home and
 * start) can't be made up, so without those there's no plan; everything else gets a default.
 */
export function toNightPlan(saved: unknown): NightPlan | null {
  const p = withDefaults(saved, {
    v: 1, title: 'Your route', demo: false, date: '', home: [] as unknown as Pt, start: NaN,
    segments: [] as Segment[], schedule: null as unknown as Schedule, options: {} as PlanOptions,
    lines: { streetLines: [], busyRoads: [], areas: [] } as NightPlan['lines'],
  });
  const s = (saved ?? {}) as { schedule?: unknown };
  const schedule = typeof s.schedule === 'object' && s.schedule !== null ? (s.schedule as Schedule) : null;
  if (!p.segments.length || !schedule || !Array.isArray(schedule.rows) || schedule.rows.length !== p.segments.length
    || p.home.length !== 2 || !isNum(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return null;
  const options = withDefaults(p.options, {
    startTime: fmt24(p.start), endTime: typeof schedule.windowEnd24 === 'string' ? schedule.windowEnd24 : '20:00',
    youngestAge: 8, stroller: false, doorSeconds: 60, exclude: [] as string[],
  });
  const lines = withDefaults(p.lines, { streetLines: [] as NamedLine[], busyRoads: [] as NamedLine[], areas: [] as NamedLine[] });
  return { ...p, v: 1, schedule, options, lines };
}

/** Saved progress, from any version of the app; null if it doesn't fit this plan. */
export function toProgress(saved: unknown, plan: NightPlan): NightProgress | null {
  const fresh = freshProgress(plan, false);
  const p = withDefaults(saved, { ...fresh, demoClock: plan.demo ? plan.start : (null as number | null) });
  const t = withDefaults(p.track, fresh.track);
  if (t.done.length !== plan.segments.length || !isNum(t.current)) return null;
  return {
    ...p,
    track: { ...t, current: Math.max(0, Math.min(t.current, t.done.length)) },
    earlier: withDefaults(p.earlier, fresh.earlier),
    demoClock: plan.demo ? (isNum(p.demoClock) ? p.demoClock : plan.start) : null,
  };
}

export const loadNight = (): NightPlan | null => toNightPlan(read<unknown>(PLAN_KEY));
/** Street data for this plan's replans, from the copy kept with the planned route. */
export const loadNightData = (plan: NightPlan): OsmData | null => loadStreets(plan.home);
export const loadProgress = (plan: NightPlan): NightProgress | null => toProgress(read<unknown>(PROGRESS_KEY), plan);
export const saveProgress = (p: NightProgress): boolean => write(PROGRESS_KEY, p);

export const freshProgress = (plan: NightPlan, sound: boolean): NightProgress => ({
  track: startTrack(plan.segments.length), alerted: false, sound,
  earlier: { houses: 0, streets: 0 }, demoClock: plan.demo ? plan.start : null, startedEarly: false,
});

/** Keep a plan for tonight. Returns false if it couldn't be kept at all. */
export function saveNight(plan: NightPlan, data: OsmData | null, progress: NightProgress): boolean {
  if (!write(PLAN_KEY, plan)) return false;
  if (data && !loadStreets(plan.home)) saveStreets(plan.home, data); // usually kept already, when planned
  return saveProgress(progress);
}

export function forgetNight(): void {
  try {
    // The street data stays: it belongs to the planned route too.
    for (const k of [PLAN_KEY, PROGRESS_KEY]) localStorage.removeItem(k);
  } catch {
    // no storage: nothing kept
  }
}

/** Minutes after midnight of `date`, by this phone's clock. */
export function minutesOn(date: string, nowMs = Date.now()): number {
  const [y, m, d] = date.split('-').map(Number);
  return (nowMs - new Date(y, m - 1, d).getTime()) / 60000;
}
