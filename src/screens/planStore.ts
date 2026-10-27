// The last route planned, kept in this browser (localStorage) as soon as it's planned, so
// reopening Haulween the next day shows it again with "Start the night" ready and fetches no
// street data. What's kept is what the plan was made from (the answers, the home point, the
// street data and the forecast); the route itself is worked out again on this phone, which
// gives the same route.
//
// The street data is kept once, with the home point it's for, and Night Mode's replans use the
// same copy. Phones give each site a few MB, so two copies could crowd out the plan.

import { forecastIsFresh, type Tonight } from '../data/weather';
import type { OsmData, Pt } from '../route/types';
import { isNum, withDefaults } from '../stored';
import { streetOnlyTitle, toForm, type PlanForm } from './planning';

const PLANNED_KEY = 'haulween.planned';
const STREETS_KEY = 'haulween.streets';
/** Where an earlier version kept Night Mode's street data. */
const OLD_NIGHT_DATA_KEY = 'haulween.night.data';

export type Planned = {
  v: 1;
  form: PlanForm;
  /** Home as planned from (coordinates only; the address is in the form, as typed). */
  home: Pt;
  title: string;
  tonight: Tonight | null;
};

function read(k: string): unknown {
  try {
    const s = localStorage.getItem(k);
    return s ? JSON.parse(s) : null;
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

function remove(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    // no storage: nothing kept
  }
}

/** One field of something saved, whatever its type, to check on its own. */
const field = (saved: unknown, k: string): unknown =>
  typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>)[k] : undefined;

const samePoint = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const toPt = (v: unknown): Pt | null =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null;
const toData = (v: unknown): OsmData | null => {
  const d = withDefaults(v, { streets: [] as OsmData['streets'], areas: [] as OsmData['areas'], sidewalks: [] as OsmData['sidewalks'] });
  return d.streets.length ? d : null;
};

/** Keep the street data for a home point. Sidewalks only shade the map, so they're left out. */
export function saveStreets(home: Pt, data: OsmData): boolean {
  if (write(STREETS_KEY, { home, data: { ...data, sidewalks: [] } })) {
    remove(OLD_NIGHT_DATA_KEY);
    return true;
  }
  remove(STREETS_KEY); // half-written or full: keep nothing rather than the wrong streets
  return false;
}

/** The kept street data, only if it's for this home point. */
export function loadStreets(home: Pt): OsmData | null {
  const s = read(STREETS_KEY);
  const at = toPt(field(s, 'home'));
  if (at && samePoint(at, home)) return toData(field(s, 'data'));
  return toData(read(OLD_NIGHT_DATA_KEY)); // an earlier version kept just one night's streets
}

export function toPlanned(saved: unknown): Planned | null {
  const home = toPt(field(saved, 'home'));
  const title = field(saved, 'title');
  if (!home || typeof title !== 'string' || !title) return null;
  const form = toForm(field(saved, 'form'));
  if (!form.address.trim()) return null;
  const t = field(saved, 'tonight');
  const tonight = typeof t === 'object' && t !== null && Array.isArray(field(t, 'hours')) ? (t as Tonight) : null;
  // An older version's title could name a town or neighborhood too: keep just the street.
  return { v: 1, form, home, title: streetOnlyTitle(title), tonight };
}

/** Keep a route just planned, and the streets it came from. False if the phone has no room. */
export function savePlanned(p: Planned, data: OsmData): boolean {
  return saveStreets(p.home, data) && write(PLANNED_KEY, p);
}

/** Update what's kept with the planned route: a new door time, or the forecast once it's in. */
export function updatePlanned(patch: Partial<Pick<Planned, 'form' | 'tonight'>>): void {
  const p = toPlanned(read(PLANNED_KEY));
  if (p) write(PLANNED_KEY, { ...p, ...patch });
}

/** The last planned route and its streets, ready to show again with no network at all. */
export function loadPlanned(): { planned: Planned; data: OsmData } | null {
  const planned = toPlanned(read(PLANNED_KEY));
  const data = planned && loadStreets(planned.home);
  return planned && data ? { planned, data } : null;
}

/** "1428 Elm St, Springwood, OH" and "1428 elm st,  springwood, oh" are the same address. */
const sameAddress = (a: string, b: string) => {
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return n(a) === n(b);
};

/** The kept route, when it's for this address: planning again then needs no lookups at all. */
export function plannedFor(address: string): { planned: Planned; data: OsmData } | null {
  const hit = loadPlanned();
  return hit && sameAddress(hit.planned.form.address, address) ? hit : null;
}

/**
 * A fresher forecast for a kept plan, when its own is over 3 hours old (or missing). Null when
 * it's fresh enough, or when asking fails (no signal, an error, too far ahead): keep showing the
 * kept one. Never waited on before showing the route.
 */
export async function fresherForecast(kept: Tonight | null, now: number, get: () => Promise<Tonight>): Promise<Tonight | null> {
  if (kept && forecastIsFresh(kept, now)) return null;
  try {
    return await get();
  } catch {
    return null;
  }
}
