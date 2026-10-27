// "Roads to avoid", matched forgivingly against the street names already loaded for the plan.
// No React and no network here, so it's tested on its own.
//
// Both sides are normalized first: case, periods, commas and extra spaces don't count, and
// "Street" and "St" (and the other street types and directions below) are the same word. A
// name typed without its type ("Oak") finds the one street with that name. Small typos are
// forgiven when there's exactly one clear best match; otherwise nothing is guessed, and the
// closest names come back as suggestions.

import { shortName } from '../route/geo';

/** Street types and directions, each spelling mapped to one form. */
const SAME_WORD: Record<string, string> = {
  street: 'st', st: 'st',
  road: 'rd', rd: 'rd',
  avenue: 'ave', ave: 'ave', av: 'ave',
  lane: 'ln', ln: 'ln',
  drive: 'dr', dr: 'dr',
  court: 'ct', ct: 'ct', crt: 'ct',
  place: 'pl', pl: 'pl',
  boulevard: 'blvd', blvd: 'blvd',
  terrace: 'ter', ter: 'ter',
  circle: 'cir', cir: 'cir',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  way: 'way',
  north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
};
const TYPES = new Set(['st', 'rd', 'ave', 'ln', 'dr', 'ct', 'pl', 'blvd', 'ter', 'cir', 'pkwy', 'hwy', 'way']);
/** Long spellings of the types, to forgive a typo in one ("Stret"). */
const LONG_TYPES = Object.keys(SAME_WORD).filter((w) => w.length >= 5 && TYPES.has(SAME_WORD[w]));

/**
 * Typos forgiven in the name part (the type aside): none up to 2 letters, 1 for 3 to 5 letters
 * ("Oak", "Maple"), 2 for 6 or more ("Walnut", "Lakeview").
 */
export const typosAllowed = (letters: number) => (letters <= 2 ? 0 : letters <= 5 ? 1 : 2);

/** Letters changed, added, dropped or swapped side by side to get from a to b. */
export function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** A name split into its name part and its street type: "Oak Street" -> { name: "oak", type: "st" }. */
export type Parsed = { name: string; type: string | null };

export function parseName(s: string): Parsed {
  const words = s.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => SAME_WORD[w] ?? w);
  const last = words[words.length - 1];
  if (words.length > 1 && TYPES.has(last)) return { name: words.slice(0, -1).join(' '), type: last };
  // A typo in a long type ("Stret", "Avenu") still counts as that type.
  if (words.length > 1 && last.length >= 4) {
    const near = LONG_TYPES.filter((t) => typoDistance(last, t) === 1);
    if (near.length === 1) return { name: words.slice(0, -1).join(' '), type: SAME_WORD[near[0]] };
  }
  return { name: words.join(' '), type: null };
}

/** What one typed entry matched. Names are as the street data has them. */
export type RoadMatch =
  | { kind: 'match'; name: string }
  | { kind: 'unsure'; suggestions: string[] }
  | { kind: 'none' };

/**
 * One typed entry against the names loaded for the plan. Exact (after normalizing) wins;
 * then a missing type or a small typo, only when exactly one street is the best fit.
 */
export function matchRoad(typed: string, names: string[]): RoadMatch {
  const t = parseName(typed);
  if (!t.name) return { kind: 'none' };
  const scored = [...new Set(names)].map((name) => {
    const n = parseName(name);
    // A different type counts as one more typo; a missing one costs nothing.
    const typeCost = t.type && n.type && t.type !== n.type ? 1 : t.type && !n.type ? 1 : 0;
    return { name, cost: typoDistance(t.name, n.name) + typeCost };
  });
  const best = Math.min(...scored.map((s) => s.cost));
  if (!Number.isFinite(best)) return { kind: 'none' };
  const top = scored.filter((s) => s.cost === best).map((s) => s.name).sort();
  const allowed = typosAllowed(t.name.replace(/\s/g, '').length);
  if (best <= allowed) return top.length === 1 ? { kind: 'match', name: top[0] } : { kind: 'unsure', suggestions: top.map(shortName) };
  // Just past what's forgiven: offer it, don't take it.
  if (best === allowed + 1 && top.length <= 3) return { kind: 'unsure', suggestions: top.map(shortName) };
  return { kind: 'none' };
}

/** The entries in the field: split on commas, semicolons and new lines. */
export const avoidEntries = (text: string) => text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

/** The field's text with one entry swapped for a suggestion. */
export function withSuggestion(text: string, typed: string, suggestion: string): string {
  return avoidEntries(text).map((e) => (e === typed ? suggestion : e)).join(', ');
}
