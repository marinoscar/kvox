/**
 * Starts a layout run in the same-origin module worker, or on the main thread
 * when no worker can be built (GIC-07, #668).
 *
 * @remarks
 * The `new Worker(new URL('./layout.worker.js', import.meta.url), { type: 'module' })`
 * expression below is the exact shape Vite and electron-vite recognise: they
 * emit `layout.worker` as its own same-origin file. NEVER a `blob:` URL (CSP
 * `worker-src 'self'`). If construction throws, or the worker errors, the same
 * engine runs on the main thread in 8 ms slices, one per animation frame.
 */

import { FALLBACK_SLICE_MS } from './layoutBudgets.js';
import { runLayout } from './layoutEngine.js';
import type { LayoutRequest, LayoutResult, LayoutWorkerInbound, LayoutWorkerOutbound } from './protocol.js';

/** The part of `Worker` the client uses; a test can supply a stand-in. */
export interface LayoutWorkerLike {
  postMessage: (message: LayoutWorkerInbound) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<LayoutWorkerOutbound>) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Builds the worker, or throws when this runtime cannot. */
export function createLayoutWorker(): LayoutWorkerLike {
  if (typeof Worker === 'undefined') throw new Error('Worker is not available');
  return new Worker(new URL('./layout.worker.js', import.meta.url), {
    type: 'module',
  }) as unknown as LayoutWorkerLike;
}

/** Callbacks of a run. */
export interface LayoutHandlers {
  /** A progress frame: `x0, y0, ...` in `request.nodes` order. */
  onFrame: (positions: Float32Array) => void;
  /** The run finished (or hit its time box). */
  onDone: (result: LayoutResult) => void;
}

/** Options of `startLayout`. */
export interface StartLayoutOptions {
  /** Worker factory; defaults to `createLayoutWorker`. Throwing selects the fallback. */
  createWorker?: () => LayoutWorkerLike;
  /** Yield between fallback slices; defaults to an animation frame. */
  yieldFrame?: () => Promise<void>;
  /** Fallback slice length in milliseconds. */
  fallbackSliceMs?: number;
}

/** A started run. */
export interface LayoutHandle {
  /** `worker` or `main-thread`; the latter after a failed construction or a worker error. */
  readonly mode: 'worker' | 'main-thread';
  /** Stops the run; no further callback fires. */
  cancel: () => void;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Runs a layout request.
 *
 * @param request - The run.
 * @param handlers - Progress and completion callbacks.
 * @param options - Test seams.
 * @returns A handle to cancel the run.
 */
export function startLayout(
  request: LayoutRequest,
  handlers: LayoutHandlers,
  options: StartLayoutOptions = {},
): LayoutHandle {
  let cancelled = false;
  let worker: LayoutWorkerLike | null = null;
  let mode: 'worker' | 'main-thread' = 'main-thread';

  const runOnMainThread = () => {
    mode = 'main-thread';
    void runLayout(request, {
      sliceMs: options.fallbackSliceMs ?? FALLBACK_SLICE_MS,
      yieldToHost: options.yieldFrame ?? nextFrame,
      isCancelled: () => cancelled,
      onFrame: (positions) => {
        if (!cancelled) handlers.onFrame(positions);
      },
    }).then((result) => {
      if (result && !cancelled) handlers.onDone(result);
    });
  };

  const teardownWorker = () => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  };

  try {
    worker = (options.createWorker ?? createLayoutWorker)();
    mode = 'worker';
    worker.onmessage = (event) => {
      if (cancelled) return;
      const message = event.data;
      if (message.type === 'frame') {
        handlers.onFrame(message.positions);
      } else if (message.type === 'done') {
        teardownWorker();
        handlers.onDone({
          positions: message.positions,
          iterations: message.iterations,
          timedOut: message.timedOut,
        });
      } else {
        teardownWorker();
        runOnMainThread();
      }
    };
    worker.onerror = () => {
      if (cancelled) return;
      teardownWorker();
      runOnMainThread();
    };
    worker.postMessage({ type: 'run', request });
  } catch {
    teardownWorker();
    runOnMainThread();
  }

  return {
    get mode() {
      return mode;
    },
    cancel() {
      cancelled = true;
      if (worker) {
        worker.postMessage({ type: 'cancel' });
        teardownWorker();
      }
    },
  };
}
