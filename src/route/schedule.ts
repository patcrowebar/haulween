// Pace, door time, crossings, times, head-home and latest times.
// Ported from reference/plan_route.py.

// Youngest walker -> walking pace in mph, between doors (not counting door stops).
// Deliberately slow: costumes, dark, excitement, stopping to compare candy.
const PACE_BY_AGE: ReadonlyArray<[maxAge: number, mph: number]> = [
  [3, 1.2], // 3 and under (walking, not riding)
  [5, 1.5], // 4-5
  [8, 2.0], // 6-8
  [12, 2.5], // 9-12
  [99, 3.0], // 13+
];

/** A stroller or wagon caps the pace. */
export const STROLLER_MAX_MPH = 2.0;

export function paceForAge(age: number, stroller = false): number {
  const row = PACE_BY_AGE.find(([maxAge]) => age <= maxAge);
  const mph = row ? row[1] : 3.0;
  return stroller ? Math.min(mph, STROLLER_MAX_MPH) : mph;
}
