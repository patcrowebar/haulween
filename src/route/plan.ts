// One call from street data to a checked plan. The screens use this, not the parts.
// Hard rule 3: a route that fails the check is never returned as a plan.

import { checkRoute } from './check';
import { buildGraph } from './graph';
import { Planner, toSegments, type Segment } from './optimize';
import { findPocket, type Pocket } from './pocket';
import { budgetFor, makeSchedule, paceFor, type Schedule, type ScheduleOptions } from './schedule';
import type { OsmData, Pt } from './types';

export type PlanOptions = ScheduleOptions & {
  /** Lot width in feet; houses per side = usable frontage / this. */
  frontageFt?: number;
  /** Street names to leave out. */
  exclude?: string[];
};

export type Plan = {
  pocket: Pocket;
  segments: Segment[];
  schedule: Schedule;
  estimate: { minutes: number; budget: number; houses: number; housesInPocket: number };
  /** Houses left out, by street. */
  skipped: Record<string, number>;
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; problems: string[] };

export function planRoute(data: OsmData, home: Pt, o: PlanOptions): PlanResult {
  const frontageFt = o.frontageFt ?? 55;
  const pocket = findPocket(data, home, frontageFt);
  const drop = new Set(o.exclude ?? []);
  const kept = { ...pocket, pocket: pocket.pocket.filter((s) => !drop.has(s.name)) };
  const graph = buildGraph(data, kept, home, frontageFt);
  const pace = paceFor(o);
  const budget = budgetFor(o);
  const planner = new Planner(graph, { ...pace, budget });
  const { worked, minutes } = planner.optimize();
  const segments = toSegments(planner.tour(worked));

  const problems = checkRoute(pocket, segments, home);
  if (problems.length) return { ok: false, problems };

  const workedIds = new Set(worked.map((e) => e.id));
  const skipped: Record<string, number> = {};
  for (const e of planner.edges) {
    if (!workedIds.has(e.id) && planner.houses(e)) skipped[e.name] = (skipped[e.name] ?? 0) + planner.houses(e);
  }
  return {
    ok: true,
    plan: {
      pocket,
      segments,
      schedule: makeSchedule(segments, o),
      estimate: {
        minutes: Math.round(minutes),
        budget: Math.round(budget),
        houses: worked.reduce((s, e) => s + planner.houses(e), 0),
        housesInPocket: planner.edges.reduce((s, e) => s + planner.houses(e), 0),
      },
      skipped,
    },
  };
}
