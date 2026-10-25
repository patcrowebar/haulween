// The planning worker can't leave the screen hanging. A fake worker stands in for the real one.
import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from '../route/__fixtures__/springwood';
import { DEFAULT_FORM } from './planning';
import { PLAN_FAILED, Planner } from './planner';

type Behaviour = 'crash' | 'silent' | { error: string };

function fakeWorker(behaviour: Behaviour) {
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    terminated: false,
    postMessage(msg: { id: number }) {
      setTimeout(() => {
        if (behaviour === 'crash') w.onerror?.({ preventDefault() {} } as ErrorEvent);
        else if (behaviour !== 'silent') w.onmessage?.({ data: { id: msg.id, ok: false, error: behaviour.error } } as MessageEvent);
      }, 0);
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

const form = { ...DEFAULT_FORM, start: '17:00', end: '18:00' };

describe('Planner', () => {
  it('plans on the main thread when the worker crashes or fails to load', async () => {
    const p = new Planner(() => fakeWorker('crash') as unknown as Worker);
    const out = await p.run(SPRINGWOOD, HOME, form);
    expect(out.result.ok).toBe(true);
  });

  it('plans on the main thread when a worker can’t be created at all', async () => {
    const p = new Planner(() => { throw new Error('no workers here'); });
    expect((await p.run(SPRINGWOOD, HOME, form)).result.ok).toBe(true);
  });

  it('turns an error inside the worker into a message a parent can read', async () => {
    const p = new Planner(() => fakeWorker({ error: 'No streets near home' }) as unknown as Worker);
    await expect(p.run(SPRINGWOOD, HOME, form)).rejects.toThrow("We couldn't find any streets near that address.");
    const q = new Planner(() => fakeWorker({ error: 'TypeError: x is undefined' }) as unknown as Worker);
    await expect(q.run(SPRINGWOOD, HOME, form)).rejects.toThrow(PLAN_FAILED);
  });

  it('gives up with a message when the worker never answers', async () => {
    const worker = fakeWorker('silent');
    const p = new Planner(() => worker as unknown as Worker, 30);
    await expect(p.run(SPRINGWOOD, HOME, form)).rejects.toThrow('Planning took too long.');
    expect(worker.terminated).toBe(true);
  });
});
