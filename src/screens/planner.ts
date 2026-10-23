// Runs planOnce in a Web Worker (inline if workers aren't available). A new plan cancels the
// old one by restarting the worker, so a slow plan for stale inputs never blocks the next.
// Nothing here can hang: a worker that fails to load or crashes hands its plans to the main
// thread once, and every plan has a time limit. Failures come back as plain-words errors.

import type { OsmData, Pt } from '../route/types';
import type { PlanRequest } from './plan.worker';
import { planOnce, type PlanForm, type PlanOnce } from './planning';

type Reply = { id: number; ok: true; value: PlanOnce } | { id: number; ok: false; error: string };
type Args = [data: OsmData, home: Pt, form: PlanForm, doorSeconds: number];
type Waiting = { args: Args; resolve: (v: PlanOnce) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export const PLAN_TIMEOUT_MS = 90_000;
export const PLAN_FAILED = "Something went wrong while planning. Try again, or try a nearby address.";
const KNOWN: Record<string, string> = {
  'No streets near home': "We couldn't find any streets near that address. Check it and try again.",
  'No safe streets to walk': "We couldn't find a street near home that's safe to walk. Check the address.",
};

/** Turns an internal error into something a parent can act on. */
export function friendlyPlanError(message: string): string {
  if (message === 'cancelled' || message.startsWith('Add the kids')) return message;
  return KNOWN[message] ?? PLAN_FAILED;
}

const defaultWorker = (): Worker | null =>
  typeof Worker === 'undefined' ? null : new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });

export class Planner {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();

  constructor(private makeWorker: () => Worker | null = defaultWorker, private timeoutMs = PLAN_TIMEOUT_MS) {}

  private start(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = this.makeWorker();
    } catch {
      this.worker = null;
    }
    if (!this.worker) return null;
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = this.take(e.data.id);
      if (!w) return;
      if (e.data.ok) w.resolve(e.data.value);
      else w.reject(new Error(friendlyPlanError(e.data.error)));
    };
    // The worker failed to load, crashed, or sent something unreadable: plan on the main thread.
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.crashed();
    };
    this.worker.onmessageerror = () => this.crashed();
    return this.worker;
  }

  private take(id: number): Waiting | undefined {
    const w = this.waiting.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiting.delete(id);
    }
    return w;
  }

  private crashed(): void {
    this.worker?.terminate();
    this.worker = null;
    const stranded = [...this.waiting.keys()];
    for (const id of stranded) {
      const w = this.take(id)!;
      inline(w.args).then(w.resolve, w.reject);
    }
  }

  run(data: OsmData, home: Pt, form: PlanForm, doorSeconds: number): Promise<PlanOnce> {
    const args: Args = [data, home, form, doorSeconds];
    const worker = this.start();
    if (!worker) return inline(args);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.take(id)) return;
        // Restart the worker so a stuck plan doesn't hold up the next one.
        this.worker?.terminate();
        this.worker = null;
        reject(new Error('Planning took too long. Try a shorter time window, then try again.'));
      }, this.timeoutMs);
      this.waiting.set(id, { args, resolve, reject, timer });
      try {
        worker.postMessage({ id, data, home, form, doorSeconds } satisfies PlanRequest);
      } catch {
        this.crashed();
      }
    });
  }

  /** Drop everything in progress. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.waiting.keys()]) this.take(id)!.reject(new Error('cancelled'));
  }
}

/** Plan on the main thread, with the same plain-words errors. */
function inline(args: Args): Promise<PlanOnce> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(planOnce(...args));
      } catch (e) {
        reject(new Error(friendlyPlanError(e instanceof Error ? e.message : '')));
      }
    }, 0); // let "Planning your route…" paint first
  });
}
