// Jack, the optional AI guide, in Night Mode: one short question to Claude with the visitor's own
// key, and at most one suggested change back. Jack never changes anything himself. The app checks
// the suggestion, replans with its own optimizer, runs the route check again, and only then offers
// it; the parent taps "Use this" or "No thanks".
//
// What Claude gets (and nothing else): the remaining streets in order with house counts and
// planned times, the time now, the head-home and home-by times, minutes behind, the walking pace,
// what the app allows Jack to suggest, and the parent's message. Never the address, coordinates,
// the plan's title, or the home street: the walk home is "the walk home" and the home street,
// wherever it shows up in a row's name, is "your street".

import { CLAUDE_MODEL, PACE_CHOICES, type PaceId } from '../config';
import { checkRoute } from '../route/check';
import { Geo, segDist, shortName } from '../route/geo';
import type { Segment } from '../route/optimize';
import type { Plan, PlanOptions } from '../route/plan';
import { findPocket } from '../route/pocket';
import { fmt24, parseClock, type Schedule } from '../route/schedule';
import { clock12, type Timeline } from '../route/status';
import type { NamedLine, OsmData, Pt } from '../route/types';

export const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
/** Sent as anthropic-version. */
export const CLAUDE_API_VERSION = '2026-10-21';
export const JACK_MAX_TOKENS = 400;
export const JACK_TIMEOUT_MS = 15_000;
/** The longest message a parent can send, and the longest reply shown. */
export const MAX_MESSAGE = 300;
export const MAX_REPLY = 280;

export const HOME_LABEL = 'your street';
const WALK_HOME = 'the walk home';

/** What Claude sees. Nothing outside this type is ever sent. */
export type JackContext = {
  now: string;
  headHome: string | null;
  homeBy: string;
  minutesBehind: number;
  pace: string;
  streets: Array<{ name: string; houses: number; planned: string; current?: true }>;
  /** Streets Jack may suggest skipping. */
  canSkip: string[];
  /** Paces Jack may suggest (slower ones only). */
  slowerPaces: string[];
  message: string;
};

/** A question ready to send, and the rules its answer is checked against (kept on the phone). */
export type JackQuestion = {
  context: JackContext;
  rules: { now: number; homeBy: number; canSkip: string[]; slower: PaceId[] };
};

export type Suggestion =
  | { kind: 'none'; reply: string }
  | { kind: 'skip'; reply: string; streets: string[] }
  | { kind: 'home_by'; reply: string; at: number }
  | { kind: 'pace'; reply: string; pace: PaceId };

export type JackAnswer = { ok: true; suggestion: Suggestion } | { ok: false; message: string };

export const MESSAGES = {
  noKey: 'Add your Claude key in Settings to ask Jack.',
  garbled: "Jack didn't get that one. Your route is unchanged.",
  refused: "Jack can't help with that one. Your route is unchanged.",
  badKey: "Claude didn't accept your key. Check it in Settings.",
  forbidden: "Your key isn't allowed to use Claude. Check it in the Claude Console.",
  noCredit: 'Your Claude account is out of credit. Add some in the Claude Console.',
  rateLimited: "Jack's had a lot of questions. Try again in a minute.",
  busy: 'Claude is busy right now. Try again in a minute.',
  offline: 'No signal for Jack right now. Your route still works.',
  slow: 'Jack took too long to answer. Try again in a bit.',
  noSafeRoute: "That change wouldn't make a safe route, so your route stays as it is.",
} as const;

// ---------- The question ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The home street, by name, from the plan's title ("Your route from Elm St") and from the street
 * line nearest home. Worked out on the phone so it can be kept out of the question.
 */
export function homeStreets(title: string, home: Pt, streetLines: NamedLine[]): string[] {
  const out = new Set<string>();
  const m = /^Your route from (.+?)(?: \(demo\))?$/.exec(title.trim());
  if (m) out.add(shortName(m[1]));
  const geo = new Geo(home);
  let best: string | null = null, bestD = 200; // feet: home is snapped onto its street
  for (const s of streetLines) {
    if (!s.name) continue;
    const d = segDist([0, 0], s.points.map((p) => geo.xy(p)));
    if (d < bestD) { bestD = d; best = s.name; }
  }
  if (best) out.add(shortName(best));
  return [...out];
}

/** "Maple Ave to Elm St" -> "Maple Ave to your street", when Elm St is home. */
function hideHome(name: string, home: string[]): string {
  return home.reduce((s, h) => s.replace(new RegExp(`\\b${esc(h)}\\b`, 'gi'), HOME_LABEL), name);
}

const paceOf = (mph: number) =>
  PACE_CHOICES.reduce((a, b) => (Math.abs(b.mph - mph) < Math.abs(a.mph - mph) ? b : a));

export type QuestionInput = {
  title: string;
  home: Pt;
  lines: { streetLines: NamedLine[] };
  segments: Segment[];
  schedule: Schedule;
  tl: Timeline;
  done: boolean[];
  current: number;
  now: number;
  minutesBehind: number;
  paceMph: number;
  message: string;
};

/** The question for Claude, built only from what Jack needs. */
export function makeQuestion(q: QuestionInput): JackQuestion {
  const home = homeStreets(q.title, q.home, q.lines.streetLines);
  const isHome = (street: string) => home.some((h) => h.toLowerCase() === street.toLowerCase());
  const last = q.schedule.rows.length - 1;
  const walkHome = (i: number) => q.schedule.lastLeg !== null && i === last;

  const streets: JackContext['streets'] = [];
  const canSkip = new Set<string>();
  const currentStreet = q.segments[q.current]?.street.toLowerCase();
  q.schedule.rows.forEach((row, i) => {
    if (i < q.current || q.done[i]) return;
    streets.push({
      name: walkHome(i) ? WALK_HOME : hideHome(row.street, home),
      houses: row.houses,
      planned: clock12(q.tl.rows[i].start),
      ...(i === q.current ? { current: true as const } : {}),
    });
    const street = q.segments[i].street;
    // Not where they are now, not the way home, not their own street, and only streets with houses.
    if (i > q.current && !walkHome(i) && row.houses > 0 && !isHome(street) && street.toLowerCase() !== currentStreet) {
      canSkip.add(street);
    }
  });

  const pace = paceOf(q.paceMph);
  const slower = PACE_CHOICES.filter((p) => p.mph < pace.mph);
  return {
    context: {
      now: clock12(q.now),
      headHome: q.tl.headHome === null ? null : clock12(q.tl.headHome),
      homeBy: clock12(q.tl.windowEnd),
      minutesBehind: Math.max(0, Math.round(q.minutesBehind)),
      pace: pace.label,
      streets,
      canSkip: [...canSkip],
      slowerPaces: slower.map((p) => p.label),
      message: q.message.trim().slice(0, MAX_MESSAGE),
    },
    rules: { now: q.now, homeBy: q.tl.windowEnd, canSkip: [...canSkip], slower: slower.map((p) => p.id) },
  };
}

const SYSTEM = `You are Jack, a friendly neighbor who knows every street. You're helping a parent who is out trick-or-treating with kids right now and reads your answer on a phone, in the dark.

You get JSON: the time now, when they should head home (headHome), when they must be home (homeBy), how many minutes behind plan they are, their walking pace, the streets left in order (the first is where they are now), what you may suggest (canSkip, slowerPaces), and their message. If the time now is before the first planned time, they haven't set off yet.

Answer in one or two short, friendly sentences (under 200 characters), plain text. Then choose at most one change:
- "skip": leave out one or more streets, using exact names from canSkip only.
- "home_by": an earlier time to be home, like "7:30 pm": later than now and earlier than homeBy.
- "pace": a slower pace, from slowerPaces only.
- "none": no change, just an answer.
Fill the fields for the change you chose; use [] and null for the others.

The app works out the new route and its order itself, checks it is safe, and the parent decides whether to use it, so say "you could", not "I've changed". House counts are estimates. Never promise which houses give candy. Never ask about addresses or locations. If the message isn't about tonight's walk, answer briefly and choose "none".`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'change', 'skip', 'homeBy', 'pace'],
  properties: {
    reply: { type: 'string' },
    change: { type: 'string', enum: ['none', 'skip', 'home_by', 'pace'] },
    skip: { type: 'array', items: { type: 'string' } },
    homeBy: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    pace: { anyOf: [{ type: 'string', enum: PACE_CHOICES.map((p) => p.label) }, { type: 'null' }] },
  },
} as const;

/** The request body. One short call: no history, small max_tokens, low effort, no thinking. */
export function requestBody(q: JackQuestion) {
  return {
    model: CLAUDE_MODEL,
    max_tokens: JACK_MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(q.context) }],
  };
}

// ---------- The answer ----------

/** Minutes for "7:30 pm", placed on the night nearest `now`. */
function timeNear(text: string, now: number): number | null {
  let t: number;
  try {
    t = parseClock(text);
  } catch {
    return null;
  }
  return t + Math.round((now - t) / 1440) * 1440;
}

/**
 * Claude's answer, checked against the rules. Anything off (not JSON, a field of the wrong kind,
 * a street not offered, a later home time, a faster pace) is refused whole.
 */
export function readAnswer(body: unknown, rules: JackQuestion['rules']): JackAnswer {
  const garbled = { ok: false, message: MESSAGES.garbled } as const;
  const b = body as { stop_reason?: unknown; content?: unknown } | null;
  if (b?.stop_reason === 'refusal') return { ok: false, message: MESSAGES.refused };
  if (b?.stop_reason !== 'end_turn' || !Array.isArray(b.content)) return garbled;
  const text = b.content.find((c: { type?: unknown }) => c?.type === 'text')?.text;
  if (typeof text !== 'string') return garbled;
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(text);
  } catch {
    return garbled;
  }
  if (typeof a !== 'object' || a === null) return garbled;

  const reply = typeof a.reply === 'string' ? a.reply.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  if (!reply || reply.length > MAX_REPLY) return garbled;

  switch (a.change) {
    case 'none':
      return { ok: true, suggestion: { kind: 'none', reply } };
    case 'skip': {
      if (!Array.isArray(a.skip) || a.skip.length === 0) return garbled;
      const streets: string[] = [];
      for (const s of a.skip) {
        const match = typeof s === 'string' ? rules.canSkip.find((c) => c.toLowerCase() === s.trim().toLowerCase()) : undefined;
        if (!match) return garbled;
        if (!streets.includes(match)) streets.push(match);
      }
      return { ok: true, suggestion: { kind: 'skip', reply, streets } };
    }
    case 'home_by': {
      const at = typeof a.homeBy === 'string' ? timeNear(a.homeBy, rules.now) : null;
      if (at === null || at <= rules.now || at >= rules.homeBy) return garbled;
      return { ok: true, suggestion: { kind: 'home_by', reply, at } };
    }
    case 'pace': {
      const pace = PACE_CHOICES.find((p) => p.label === a.pace);
      if (!pace || !rules.slower.includes(pace.id)) return garbled;
      return { ok: true, suggestion: { kind: 'pace', reply, pace: pace.id } };
    }
    default:
      return garbled;
  }
}

/** A failed call, in plain words. */
async function failure(res: Response): Promise<string> {
  if (res.status === 401) return MESSAGES.badKey;
  if (res.status === 403) return MESSAGES.forbidden;
  if (res.status === 429) return MESSAGES.rateLimited;
  if (res.status >= 500) return MESSAGES.busy;
  if (res.status === 400 || res.status === 402) {
    let text = '';
    try {
      text = String((await res.json())?.error?.message ?? '');
    } catch {
      // no body
    }
    if (/credit|billing|balance/i.test(text)) return MESSAGES.noCredit;
  }
  return MESSAGES.garbled;
}

export type AskOptions = { fetch?: typeof fetch; timeoutMs?: number; online?: boolean };

/**
 * Ask Jack. One request, no retry. Never throws: every failure comes back as a message, and the
 * route is untouched. The key goes only in a header, only to Claude's API.
 */
export async function askJack(key: string | null, q: JackQuestion, o: AskOptions = {}): Promise<JackAnswer> {
  if (!key) return { ok: false, message: MESSAGES.noKey };
  const online = o.online ?? (typeof navigator === 'undefined' || navigator.onLine !== false);
  if (!online) return { ok: false, message: MESSAGES.offline };
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? JACK_TIMEOUT_MS);
  try {
    const res = await doFetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': CLAUDE_API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(requestBody(q)),
      signal: abort.signal,
    });
    if (!res.ok) return { ok: false, message: await failure(res) };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, message: MESSAGES.garbled };
    }
    return readAnswer(body, q.rules);
  } catch {
    return { ok: false, message: abort.signal.aborted ? MESSAGES.slow : MESSAGES.offline };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Trying the change ----------

/** The plan options with Jack's change made. Skipped streets go by their full map names. */
export function changedOptions(s: Suggestion, options: PlanOptions, data: OsmData, home: Pt): PlanOptions {
  switch (s.kind) {
    case 'skip': {
      const names = findPocket(data, home).pocket.map((p) => p.name)
        .filter((n) => s.streets.some((x) => x.toLowerCase() === shortName(n).toLowerCase()));
      return { ...options, exclude: [...new Set([...(options.exclude ?? []), ...names])] };
    }
    case 'home_by':
      return { ...options, endTime: fmt24(s.at) };
    case 'pace':
      return { ...options, paceMph: PACE_CHOICES.find((p) => p.id === s.pace)!.mph };
    case 'none':
      return options;
  }
}

export type Tried = { ok: true; plan: Plan; options: PlanOptions } | { ok: false; message: string };

/**
 * Replan with Jack's change, using the app's own replan. Hard rule 3: the result goes through the
 * route check here as well, against the plan's own street lines, and is refused if it fails.
 */
export async function tryChange(
  s: Suggestion,
  at: { options: PlanOptions; data: OsmData; home: Pt; lines: { streetLines: NamedLine[]; busyRoads: NamedLine[] } },
  replan: (options: PlanOptions) => Promise<{ ok: true; plan: Plan } | { ok: false; problems: string[] }>,
): Promise<Tried> {
  if (s.kind === 'none') return { ok: false, message: MESSAGES.garbled };
  const options = changedOptions(s, at.options, at.data, at.home);
  if (s.kind === 'skip' && (options.exclude?.length ?? 0) === (at.options.exclude?.length ?? 0)) {
    return { ok: false, message: MESSAGES.garbled }; // no street of that name to leave out
  }
  // A replan that couldn't run at all (cancelled, timed out) throws, for the screen to explain.
  const res = await replan(options);
  if (!res.ok || checkRoute(at.lines, res.plan.segments, at.home).length) return { ok: false, message: MESSAGES.noSafeRoute };
  return { ok: true, plan: res.plan, options };
}
