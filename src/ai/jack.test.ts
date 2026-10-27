// Jack, with Claude mocked: no real key and no network, ever. The Springwood fixture only.
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODEL, PLACEHOLDER_ADDRESS } from '../config';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { checkRoute } from '../route/check';
import type { PlanOptions } from '../route/plan';
import { planRoute } from '../route/plan';
import { replanFromHere } from '../route/replan';
import { parseClock } from '../route/schedule';
import { timeline } from '../route/status';
import {
  CLAUDE_URL, HOME_LABEL, JACK_MAX_TOKENS, MESSAGES, askJack, changedOptions, makeQuestion, readAnswer, requestBody, tryChange,
  type JackQuestion, type Suggestion,
} from './jack';

// Steady pace, 45 s doors, 5 to 8 pm: the app's defaults.
const opts: PlanOptions = { startTime: '17:00', endTime: '20:00', paceMph: 2.0, doorSeconds: 45, exclude: [] };
const r = planRoute(SPRINGWOOD, HOME, opts);
if (!r.ok) throw new Error('plan failed');
const plan = r.plan;
const segs = plan.segments;
const tl = timeline(plan.schedule, parseClock(opts.startTime), '2026-10-31');
const lines = { streetLines: plan.pocket.streetLines, busyRoads: plan.pocket.busyRoads };
const TITLE = 'Your route from Elm St';
/** Made up, the right shape only. */
const KEY = 'sk-ant-test-0000000000000000';

/** The family is on Maple Ave (the row that reaches Birch St), 15 minutes behind. */
const current = segs.findIndex((s) => s.street === 'Maple Ave');
const now = tl.rows[current].start + 15;
const done = segs.map((_, i) => i < current);

const question = (message = "we're 15 minutes behind", at = now): JackQuestion => makeQuestion({
  title: TITLE, home: HOME, lines, segments: segs, schedule: plan.schedule, tl, done, current, now: at,
  minutesBehind: 15, paceMph: opts.paceMph!, message,
});

/** A Claude reply, as the Messages API sends it. */
const reply = (answer: unknown, stop_reason = 'end_turn') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: CLAUDE_MODEL, stop_reason,
  content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
});
const answer = (a: Partial<{ reply: string; change: string; skip: string[]; homeBy: string | null; pace: string | null }>) =>
  ({ reply: 'You could skip Willow Ct and still get the best streets.', change: 'none', skip: [], homeBy: null, pace: null, ...a });

/** A mocked fetch that answers once with this. */
const mockFetch = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/** The app's own replan from where the family is, as Night Mode runs it. */
const replan = async (options: PlanOptions) => replanFromHere(
  SPRINGWOOD, HOME, { ...options, now }, { row: segs[current], at: null },
  segs.slice(0, current).map((s) => ({ points: s.points, pattern: s.pattern })),
);
const at = { options: opts, data: SPRINGWOOD, home: HOME, lines };

describe('no key, no Jack', () => {
  it("doesn't call Claude without a key", async () => {
    const f = mockFetch(200, reply(answer({})));
    expect(await askJack(null, question(), { fetch: f, online: true })).toEqual({ ok: false, message: MESSAGES.noKey });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('what Claude is sent', () => {
  const q = question();
  const sent = JSON.stringify(requestBody(q));

  it('never the address, coordinates, title or home street', () => {
    expect(sent).not.toContain(PLACEHOLDER_ADDRESS);
    expect(sent).not.toMatch(/1428|Springwood|\bOH\b/);
    expect(sent).not.toMatch(/Elm/i); // the home street, wherever a row names it
    expect(sent).not.toContain(TITLE);
    expect(sent).not.toMatch(/-?\d+\.\d{3,}/); // no coordinates, at any precision worth having
    expect(sent).not.toContain(String(HOME[0]).slice(0, 5));
  });

  it('only the remaining streets in order, with houses and times, the walk home last', () => {
    const { context } = q;
    expect(Object.keys(context).sort()).toEqual(
      ['canSkip', 'headHome', 'homeBy', 'message', 'minutesBehind', 'now', 'pace', 'slowerPaces', 'streets'].sort());
    expect(context.streets).toHaveLength(segs.length - current);
    expect(context.streets[0]).toMatchObject({ name: plan.schedule.rows[current].street, current: true });
    expect(context.streets[context.streets.length - 1].name).toBe('the walk home');
    // "Birch St to Elm St" goes as "Birch St to your street".
    expect(context.streets.some((s) => s.name.includes(HOME_LABEL))).toBe(true);
    expect(context).toMatchObject({ now: '6:01 pm', homeBy: '8:00 pm', minutesBehind: 15, pace: 'Steady', slowerPaces: ['Slow'] });
    expect(context.headHome).toMatch(/^\d{1,2}:\d{2} pm$/);
    expect(context.message).toBe("we're 15 minutes behind");
  });

  it("can't skip the street they're on, the walk home, or their own street", () => {
    const { canSkip } = q.context;
    expect(canSkip.length).toBeGreaterThan(0);
    expect(canSkip).not.toContain('Maple Ave');
    expect(canSkip).not.toContain('Elm St');
    expect(canSkip).toContain('Willow Ct');
  });

  it('one short call to Claude only, the key in a header and nowhere else', async () => {
    const f = mockFetch(200, reply(answer({})));
    await askJack(KEY, q, { fetch: f, online: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(CLAUDE_URL);
    expect(String(url)).not.toContain(KEY);
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(String(init!.body)).not.toContain(KEY);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: JACK_MAX_TOKENS, output_config: { effort: 'low' } });
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages).toHaveLength(1);
    expect(body).not.toHaveProperty('temperature');
  });
});

describe('a good suggestion', () => {
  it('skipping a street replans, passes the route check and leaves the street out', async () => {
    const a = readAnswer(reply(answer({ change: 'skip', skip: ['willow ct'] })), question().rules);
    expect(a).toMatchObject({ ok: true, suggestion: { kind: 'skip', streets: ['Willow Ct'] } });
    if (!a.ok) return;
    const t = await tryChange(a.suggestion, at, replan);
    if (!t.ok) throw new Error(t.message);
    expect(checkRoute(lines, t.plan.segments, HOME)).toEqual([]);
    expect(t.plan.segments.some((s) => s.street === 'Willow Ct')).toBe(false);
    expect(t.options.exclude).toEqual(['Willow Ct']);
    expect(opts.exclude).toEqual([]); // the plan as it was is untouched until the parent says yes
  });

  it('an earlier home time replans to be home by then', async () => {
    const a = readAnswer(reply(answer({ change: 'home_by', homeBy: '7:30 pm' })), question().rules);
    expect(a).toMatchObject({ ok: true, suggestion: { kind: 'home_by', at: 19 * 60 + 30 } });
    if (!a.ok) return;
    const t = await tryChange(a.suggestion, at, replan);
    if (!t.ok) throw new Error(t.message);
    expect(t.options.endTime).toBe('19:30');
    expect(checkRoute(lines, t.plan.segments, HOME)).toEqual([]);
    expect(parseClock(t.plan.schedule.homeBy24)).toBeLessThanOrEqual(19 * 60 + 30);
  });

  it('a slower pace replans at that pace', async () => {
    const a = readAnswer(reply(answer({ change: 'pace', pace: 'Slow' })), question().rules);
    if (!a.ok) throw new Error(a.message);
    const t = await tryChange(a.suggestion, at, replan);
    if (!t.ok) throw new Error(t.message);
    expect(t.options.paceMph).toBe(1.5);
    expect(checkRoute(lines, t.plan.segments, HOME)).toEqual([]);
  });

  it('just an answer changes nothing', () => {
    const a = readAnswer(reply(answer({ reply: 'Look for porch lights!' })), question().rules);
    expect(a).toEqual({ ok: true, suggestion: { kind: 'none', reply: 'Look for porch lights!' } });
  });
});

describe('a route that fails the check is refused', () => {
  const skip: Suggestion = { kind: 'skip', reply: 'Skip Willow Ct.', streets: ['Willow Ct'] };

  it('when the replan finds no safe route', async () => {
    const t = await tryChange(skip, at, async () => ({ ok: false, problems: ['no route'] }));
    expect(t).toEqual({ ok: false, message: MESSAGES.noSafeRoute });
  });

  it('when a route comes back that cuts across yards', async () => {
    const good = await replan(changedOptions(skip, opts, SPRINGWOOD, HOME));
    if (!good.ok) throw new Error('replan failed');
    // A straight line from the first corner to home: not on any street.
    const first = good.plan.segments[0];
    const shortcut = { ...first, name: 'Shortcut', points: [first.points[0], HOME] };
    const bad = { ...good.plan, segments: [shortcut] };
    expect(checkRoute(lines, bad.segments, HOME).length).toBeGreaterThan(0);
    const t = await tryChange(skip, at, async () => ({ ok: true, plan: bad }));
    expect(t).toEqual({ ok: false, message: MESSAGES.noSafeRoute });
  });
});

describe('a failed or garbled reply leaves the route unchanged', () => {
  const rules = question().rules;
  const bad: Array<[string, unknown]> = [
    ['not JSON', reply('Sure! Skip Willow Ct.')],
    ['an unknown change', reply(answer({ change: 'reorder' }))],
    ['a street that was never offered', reply(answer({ change: 'skip', skip: ['Main St'] }))],
    ["the street they're on", reply(answer({ change: 'skip', skip: ['Maple Ave'] }))],
    ['their own street', reply(answer({ change: 'skip', skip: ['Elm St'] }))],
    ['a skip with no streets', reply(answer({ change: 'skip', skip: [] }))],
    ['a later home time', reply(answer({ change: 'home_by', homeBy: '9:00 pm' }))],
    ['a home time already past', reply(answer({ change: 'home_by', homeBy: '5:30 pm' }))],
    ['a home time that is not a time', reply(answer({ change: 'home_by', homeBy: 'soon' }))],
    ['a faster pace', reply(answer({ change: 'pace', pace: 'Fast' }))],
    ['no reply', reply(answer({ reply: '' }))],
    ['a reply far too long', reply(answer({ reply: 'Boo! '.repeat(80) }))],
    ['cut off at max_tokens', reply(answer({}), 'max_tokens')],
    ['no content', { stop_reason: 'end_turn', content: [] }],
    ['nothing at all', null],
  ];
  for (const [what, body] of bad) {
    it(`refuses ${what}`, () => {
      expect(readAnswer(body, rules)).toEqual({ ok: false, message: MESSAGES.garbled });
    });
  }

  it('says so plainly when Claude declines', () => {
    expect(readAnswer(reply(answer({}), 'refusal'), rules)).toEqual({ ok: false, message: MESSAGES.refused });
  });

  const calls: Array<[string, number, unknown, string]> = [
    ['a bad key', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, MESSAGES.badKey],
    ['a key without access', 403, { type: 'error', error: { type: 'permission_error', message: 'nope' } }, MESSAGES.forbidden],
    ['no credit', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, MESSAGES.noCredit],
    ['a rate limit', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, MESSAGES.rateLimited],
    ['Claude overloaded', 529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, MESSAGES.busy],
    ['another bad request', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'something' } }, MESSAGES.garbled],
    ['a body that is not JSON', 200, '<html>oops</html>', MESSAGES.garbled],
  ];
  for (const [what, status, body, message] of calls) {
    it(`explains ${what} in one line`, async () => {
      expect(await askJack(KEY, question(), { fetch: mockFetch(status, body), online: true })).toEqual({ ok: false, message });
    });
  }

  it('explains no signal, without trying', async () => {
    const f = mockFetch(200, reply(answer({})));
    expect(await askJack(KEY, question(), { fetch: f, online: false })).toEqual({ ok: false, message: MESSAGES.offline });
    expect(f).not.toHaveBeenCalled();
  });

  it('explains a dropped connection', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await askJack(KEY, question(), { fetch: f, online: true })).toEqual({ ok: false, message: MESSAGES.offline });
  });

  it('gives up after the time limit', async () => {
    const f = vi.fn((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    expect(await askJack(KEY, question(), { fetch: f, online: true, timeoutMs: 10 })).toEqual({ ok: false, message: MESSAGES.slow });
  });
});
