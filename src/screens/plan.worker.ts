// Plans off the main thread, so the screen stays responsive while the optimizer works.

import { runJob, type Job } from './planning';

export type PlanRequest = { id: number; job: Job };

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const { id, job } = e.data;
  try {
    self.postMessage({ id, ok: true, value: runJob(job) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'Planning failed.' });
  }
};
