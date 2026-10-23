// Runs planOnce in a Web Worker (inline if workers aren't available). A new plan cancels the
// old one by restarting the worker, so a slow plan for stale inputs never blocks the next.

import type { OsmData, Pt } from '../route/types';
import type { PlanRequest } from './plan.worker';
import { planOnce, type PlanForm, type PlanOnce } from './planning';

type Reply = { id: number; ok: true; value: PlanOnce } | { id: number; ok: false; error: string };

export class Planner {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: PlanOnce) => void; reject: (e: Error) => void }>();

  private start(): Worker | null {
    if (this.worker || typeof Worker === 'undefined') return this.worker;
    try {
      this.worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<Reply>) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        if (e.data.ok) w.resolve(e.data.value);
        else w.reject(new Error(e.data.error));
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  run(data: OsmData, home: Pt, form: PlanForm, doorSeconds: number): Promise<PlanOnce> {
    const worker = this.start();
    if (!worker) return Promise.resolve().then(() => planOnce(data, home, form, doorSeconds));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, data, home, form, doorSeconds } satisfies PlanRequest);
    });
  }

  /** Drop everything in progress. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('cancelled'));
    this.waiting.clear();
  }
}
