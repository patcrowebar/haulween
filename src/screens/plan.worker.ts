// Plans off the main thread, so the screen stays responsive while the optimizer works.

import type { OsmData, Pt } from '../route/types';
import { planOnce, type PlanForm } from './planning';

export type PlanRequest = { id: number; data: OsmData; home: Pt; form: PlanForm; doorSeconds: number };

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const { id, data, home, form, doorSeconds } = e.data;
  try {
    self.postMessage({ id, ok: true, value: planOnce(data, home, form, doorSeconds) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'Planning failed.' });
  }
};
