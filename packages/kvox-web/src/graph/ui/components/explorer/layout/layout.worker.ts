/**
 * The layout worker (GIC-07, #668): a SAME-ORIGIN MODULE worker.
 *
 * Started with `new Worker(new URL('./layout.worker.js', import.meta.url), { type: 'module' })`
 * (see `layoutClient.ts`), which Vite and electron-vite both emit as a separate
 * file next to the app's own assets, so production's `worker-src 'self'` allows
 * it. It is NOT `graphology-layout-forceatlas2/worker`, which builds a `blob:`
 * URL and is refused by that CSP.
 *
 * Protocol: `protocol.ts`. One run at a time; a new `run` or a `cancel` stops the
 * previous one at its next slice boundary.
 */

import { WORKER_SLICE_MS } from './layoutBudgets.js';
import { runLayout } from './layoutEngine.js';
import type { LayoutWorkerInbound, LayoutWorkerOutbound } from './protocol.js';

interface WorkerScope {
  postMessage: (message: LayoutWorkerOutbound, transfer: Transferable[]) => void;
  onmessage: ((event: MessageEvent<LayoutWorkerInbound>) => void) | null;
}

const scope = self as unknown as WorkerScope;
let generation = 0;

scope.onmessage = (event) => {
  const message = event.data;
  generation += 1;
  if (message.type !== 'run') return;
  const mine = generation;
  void runLayout(message.request, {
    sliceMs: WORKER_SLICE_MS,
    isCancelled: () => mine !== generation,
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    onFrame: (positions) => scope.postMessage({ type: 'frame', positions }, [positions.buffer]),
  })
    .then((result) => {
      if (!result) return;
      scope.postMessage({ type: 'done', ...result }, [result.positions.buffer]);
    })
    .catch((error: unknown) => {
      scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }, []);
    });
};
