// Runs planOnce in a Web Worker (inline if workers aren't available). A new plan cancels the
// old one by restarting the worker, so a slow plan for stale inputs never blocks the next.
// Nothing here can hang: a worker that fails to load or crashes hands its plans to the main
// thread once, and every plan has a time limit. Failures come back as plain-words errors.

import { ServiceError } from '../data/cache';
import type { Here, ReplanOptions, ReplanResult, Visited } from '../route/replan';
import type { OsmData, Pt } from '../route/types';
import type { PlanRequest } from './plan.worker';
import { runJob, type Job, type PlanForm, type PlanOnce } from './planning';

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
type Waiting = { job: Job; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export const PLAN_TIMEOUT_MS = 90_000;
export const PLAN_FAILED = 'Something went wrong planning that. Try again.';

/** An error whose message was written for a parent, so it's safe to show. */
export class PlainError extends Error {}

export const isCancelled = (e: unknown) => e instanceof Error && e.message === 'cancelled';

/**
 * The words to show for any failure. Only messages written for a parent (service failures and
 * planning errors) are shown as they are; a raw JavaScript error never reaches the screen.
 */
export function plainMessage(e: unknown): string {
  return e instanceof ServiceError || e instanceof PlainError ? e.message : PLAN_FAILED;
}
const KNOWN: Record<string, string> = {
  'No streets near home': "We couldn't find any streets near that address. Check it and try again.",
  'No safe streets to walk': "We couldn't find a street near home that's safe to walk. Check the address.",
};

/** Turns an internal error into something a parent can act on. */
export function friendlyPlanError(message: string): string {
  if (message === 'cancelled') return message;
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
      else w.reject(new PlainError(friendlyPlanError(e.data.error)));
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
      inline(w.job).then(w.resolve, w.reject);
    }
  }

  /** A plan at the form's door time and pace. */
  run(data: OsmData, home: Pt, form: PlanForm): Promise<PlanOnce> {
    return this.call({ kind: 'plan', data, home, form }) as Promise<PlanOnce>;
  }

  /** Night Mode's "Replan from here". */
  replan(data: OsmData, home: Pt, options: ReplanOptions, here: Here, visited: Visited[]): Promise<ReplanResult> {
    return this.call({ kind: 'replan', data, home, options, here, visited }) as Promise<ReplanResult>;
  }

  private call(job: Job): Promise<unknown> {
    const worker = this.start();
    if (!worker) return inline(job);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.take(id)) return;
        // Restart the worker so a stuck plan doesn't hold up the next one.
        this.worker?.terminate();
        this.worker = null;
        reject(new PlainError('Planning took too long. Try a shorter time window, then try again.'));
      }, this.timeoutMs);
      this.waiting.set(id, { job, resolve, reject, timer });
      try {
        worker.postMessage({ id, job } satisfies PlanRequest);
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
function inline(job: Job): Promise<unknown> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(runJob(job));
      } catch (e) {
        reject(new PlainError(friendlyPlanError(e instanceof Error ? e.message : '')));
      }
    }, 0); // let "Planning your route…" paint first
  });
}
