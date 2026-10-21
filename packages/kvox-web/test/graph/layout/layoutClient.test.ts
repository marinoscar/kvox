import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLayoutWorker,
  startLayout,
  type LayoutWorkerLike,
} from '../../../src/graph/ui/components/explorer/layout/layoutClient.js';
import { buildLayoutRequest, planLayout } from '../../../src/graph/ui/components/explorer/layout/incremental.js';
import { runLayout } from '../../../src/graph/ui/components/explorer/layout/layoutEngine.js';
import type {
  LayoutRequest,
  LayoutResult,
  LayoutWorkerInbound,
  LayoutWorkerOutbound,
} from '../../../src/graph/ui/components/explorer/layout/protocol.js';
import { seededGraph } from './fixtures.js';

function fixtureRequest(): LayoutRequest {
  const graph = seededGraph(40, 11);
  return buildLayoutRequest(graph, planLayout(graph, new Set()), 60_000);
}

const immediate = () => Promise.resolve();

function runClient(
  request: LayoutRequest,
  createWorker?: () => LayoutWorkerLike,
  fallbackSliceMs = 8,
): Promise<LayoutResult> {
  return new Promise((resolve) => {
    startLayout(
      request,
      { onFrame: () => undefined, onDone: resolve },
      { createWorker, yieldFrame: immediate, fallbackSliceMs },
    );
  });
}

/** A worker stand-in that runs the real engine, the way `layout.worker.ts` does, and answers asynchronously. */
function engineWorker(): LayoutWorkerLike {
  const worker: LayoutWorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    postMessage(message: LayoutWorkerInbound) {
      if (message.type !== 'run') return;
      void runLayout(message.request, {
        sliceMs: 16,
        yieldToHost: () => new Promise((r) => setTimeout(r, 0)),
        isCancelled: () => false,
        onFrame: (positions) =>
          worker.onmessage?.({ data: { type: 'frame', positions } as LayoutWorkerOutbound } as MessageEvent<LayoutWorkerOutbound>),
      }).then((result) => {
        worker.onmessage?.({ data: { type: 'done', ...result! } } as MessageEvent<LayoutWorkerOutbound>);
      });
    },
  };
  return worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startLayout', () => {
  it('falls back to the main thread when Worker construction throws, with the same final positions', async () => {
    const request = fixtureRequest();
    const fromWorker = await runClient(request, engineWorker);
    const fromMainThread = await runClient(request, () => {
      throw new Error('Worker is not available');
    });

    expect(fromWorker.timedOut).toBe(false);
    expect(fromMainThread.timedOut).toBe(false);
    expect(fromMainThread.iterations).toBe(fromWorker.iterations);
    expect(Array.from(fromMainThread.positions)).toEqual(Array.from(fromWorker.positions));
    expect(fromMainThread.positions.some((value) => Number.isNaN(value))).toBe(false);
  });

  it('is deterministic for a seeded fixture', async () => {
    const a = await runClient(fixtureRequest(), () => {
      throw new Error('no worker');
    });
    const b = await runClient(fixtureRequest(), () => {
      throw new Error('no worker');
    });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it('reports the mode: worker, or main thread after a failed construction', () => {
    const request = fixtureRequest();
    const worker = startLayout(request, { onFrame: () => undefined, onDone: () => undefined }, { createWorker: engineWorker });
    expect(worker.mode).toBe('worker');
    worker.cancel();
    const fallback = startLayout(
      request,
      { onFrame: () => undefined, onDone: () => undefined },
      {
        createWorker: () => {
          throw new Error('no');
        },
        yieldFrame: immediate,
      },
    );
    expect(fallback.mode).toBe('main-thread');
    fallback.cancel();
  });

  it('falls back when the worker errors, and stops calling back after cancel', async () => {
    const request = fixtureRequest();
    const broken: LayoutWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: vi.fn(),
      postMessage() {
        queueMicrotask(() => broken.onerror?.(new Error('boom')));
      },
    };
    const result = await runClient(request, () => broken);
    expect(result.iterations).toBeGreaterThan(0);
    expect(broken.terminate).toHaveBeenCalled();

    const onDone = vi.fn();
    const handle = startLayout(request, { onFrame: () => undefined, onDone }, { yieldFrame: immediate, createWorker: () => { throw new Error('x'); } });
    handle.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('stops at the time box and keeps the layout', async () => {
    const request = { ...fixtureRequest(), budgetMs: 0 };
    // A zero-length slice runs one chunk, so the budget check always gets a turn.
    const result = await runClient(
      request,
      () => {
        throw new Error('no worker');
      },
      0,
    );
    expect(result.timedOut).toBe(true);
    expect(result.iterations).toBeLessThan(request.settings.iterations);
  });
});

describe('createLayoutWorker', () => {
  it('builds a same-origin module worker, never a blob: URL', () => {
    const calls: Array<{ url: URL; options: WorkerOptions | undefined }> = [];
    class FakeWorker {
      constructor(url: URL, options?: WorkerOptions) {
        calls.push({ url, options });
      }
    }
    vi.stubGlobal('Worker', FakeWorker);

    createLayoutWorker();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ type: 'module' });
    expect(calls[0]!.url.protocol).not.toBe('blob:');
    // Vite rewrites the expression into its same-origin worker-file URL (`?worker_file&type=module`).
    expect(String(calls[0]!.url)).toMatch(/layout\.worker\.(js|ts)/);
  });

  it('throws without Worker, which selects the fallback', () => {
    vi.stubGlobal('Worker', undefined);
    expect(() => createLayoutWorker()).toThrow();
  });
});
