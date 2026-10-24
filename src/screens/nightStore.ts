// Tonight's plan and progress, kept in this browser only (localStorage), so a reload or a
// dropped connection never loses them and Night Mode reopens with no network at all.
// The street data comes along too, for "Replan from here". If the phone has no room for it,
// the plan is still kept and only replanning is off.

import type { Segment } from '../route/optimize';
import type { PlanOptions } from '../route/plan';
import type { Schedule } from '../route/schedule';
import { startTrack, type Track } from '../route/track';
import type { NamedLine, OsmData, Pt } from '../route/types';

const PLAN_KEY = 'haulween.night.plan';
const DATA_KEY = 'haulween.night.data';
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

export const loadNight = (): NightPlan | null => {
  const p = read<NightPlan>(PLAN_KEY);
  return p && p.v === 1 && Array.isArray(p.segments) ? p : null;
};
export const loadNightData = (): OsmData | null => read<OsmData>(DATA_KEY);
export const loadProgress = (rows: number): NightProgress | null => {
  const p = read<NightProgress>(PROGRESS_KEY);
  return p && p.track?.done?.length === rows ? p : null;
};
export const saveProgress = (p: NightProgress): boolean => write(PROGRESS_KEY, p);

export const freshProgress = (plan: NightPlan, sound: boolean): NightProgress => ({
  track: startTrack(plan.segments.length), alerted: false, sound,
  earlier: { houses: 0, streets: 0 }, demoClock: plan.demo ? plan.start : null,
});

/** Keep a plan for tonight. Returns false if it couldn't be kept at all. */
export function saveNight(plan: NightPlan, data: OsmData | null, progress: NightProgress): boolean {
  if (!write(PLAN_KEY, plan)) return false;
  if (data) {
    // Busy roads and streets are all the replan needs; sidewalks only shade the map.
    if (!write(DATA_KEY, { ...data, sidewalks: [] })) {
      try { localStorage.removeItem(DATA_KEY); } catch { /* nothing kept */ }
    }
  }
  return saveProgress(progress);
}

export function forgetNight(): void {
  try {
    for (const k of [PLAN_KEY, DATA_KEY, PROGRESS_KEY]) localStorage.removeItem(k);
  } catch {
    // no storage: nothing kept
  }
}

/** Minutes after midnight of `date`, by this phone's clock. */
export function minutesOn(date: string, nowMs = Date.now()): number {
  const [y, m, d] = date.split('-').map(Number);
  return (nowMs - new Date(y, m - 1, d).getTime()) / 60000;
}
