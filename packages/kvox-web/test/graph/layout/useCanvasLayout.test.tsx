import { render } from '@testing-library/react';
import type { MultiDirectedGraph } from 'graphology';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LayoutWorkerLike } from '../../../src/graph/ui/components/explorer/layout/layoutClient.js';
import type {
  LayoutWorkerInbound,
  LayoutWorkerOutbound,
} from '../../../src/graph/ui/components/explorer/layout/protocol.js';
import {
  useCanvasLayout,
  type CanvasLayout,
  type CanvasLayoutControls,
} from '../../../src/graph/ui/components/explorer/layout/useCanvasLayout.js';
import { useReducedMotion } from '../../../src/graph/ui/components/explorer/shell/useReducedMotion.js';
import { seededGraph } from './fixtures.js';

let rafQueue: Array<() => void> = [];
let clock = 0;
let controls: CanvasLayoutControls | null = null;

/**
 * A worker stand-in: it answers a run at once with one progress frame and the
 * final positions, each movable node moved by a known offset.
 */
function fakeWorker(runs: Array<{ movable: string[] }>): () => LayoutWorkerLike {
  return () => {
    const worker: LayoutWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => undefined,
      postMessage(message: LayoutWorkerInbound) {
        if (message.type !== 'run') return;
        const { nodes } = message.request;
        runs.push({ movable: nodes.filter((n) => !n.fixed).map((n) => n.id) });
        const frame = new Float32Array(nodes.length * 2);
        const done = new Float32Array(nodes.length * 2);
        nodes.forEach((n, i) => {
          frame[i * 2] = n.x + 500;
          frame[i * 2 + 1] = n.y;
          done[i * 2] = n.x + 1000;
          done[i * 2 + 1] = n.y;
        });
        worker.onmessage?.({ data: { type: 'frame', positions: frame } as LayoutWorkerOutbound } as MessageEvent<LayoutWorkerOutbound>);
        worker.onmessage?.({
          data: { type: 'done', positions: done, iterations: 1, timedOut: false } as LayoutWorkerOutbound,
        } as MessageEvent<LayoutWorkerOutbound>);
      },
    };
    return worker;
  };
}

function Harness(props: {
  graph: MultiDirectedGraph;
  version: number;
  layout: CanvasLayout;
  runs: Array<{ movable: string[] }>;
  seeds?: string[];
}) {
  const reducedMotion = useReducedMotion();
  controls = useCanvasLayout({
    graph: props.graph,
    version: props.version,
    layout: props.layout,
    seedIds: props.seeds,
    budgetMs: 3000,
    reducedMotion,
    pinsKey: 'test-view',
    startOptions: { createWorker: fakeWorker(props.runs) },
  });
  return null;
}

function mockReducedMotion(reduce: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

beforeEach(() => {
  rafQueue = [];
  clock = 0;
  controls = null;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => rafQueue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafQueue = [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function tick(ms: number) {
  clock += ms;
  const callbacks = rafQueue;
  rafQueue = [];
  callbacks.forEach((cb) => cb());
}

describe('useCanvasLayout and prefers-reduced-motion', () => {
  it('jumps to the final positions without a tween when reduced motion is on', () => {
    const restore = mockReducedMotion(true);
    const graph = seededGraph(8);
    const before = graph.getNodeAttributes('n3').x as number;
    render(<Harness graph={graph} version={1} layout="forceatlas" runs={[]} />);

    expect(graph.getNodeAttribute('n3', 'x')).toBeCloseTo(before + 1000, 2);
    expect(rafQueue).toHaveLength(0);
    restore();
  });

  it('tweens towards the final positions otherwise', () => {
    const restore = mockReducedMotion(false);
    const graph = seededGraph(8);
    const before = graph.getNodeAttributes('n3').x as number;
    render(<Harness graph={graph} version={1} layout="forceatlas" runs={[]} />);

    expect(graph.getNodeAttribute('n3', 'x')).toBe(before); // nothing yet: a frame is pending
    expect(rafQueue.length).toBeGreaterThan(0);
    tick(100);
    const mid = graph.getNodeAttribute('n3', 'x') as number;
    expect(mid).toBeGreaterThan(before);
    expect(mid).toBeLessThan(before + 1000);
    tick(300);
    expect(graph.getNodeAttribute('n3', 'x')).toBeCloseTo(before + 1000, 3);
    restore();
  });
});

describe('useCanvasLayout incremental runs', () => {
  it('lays everything out the first time and only the new nodes after an expand', () => {
    const restore = mockReducedMotion(true);
    const graph = seededGraph(6);
    const runs: Array<{ movable: string[] }> = [];
    const { rerender } = render(<Harness graph={graph} version={1} layout="forceatlas" runs={runs} />);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.movable).toHaveLength(6);
    const settled = new Map(graph.mapNodes((id, a) => [id, a.x as number]));

    graph.addNode('extra', { x: 5, y: 5, size: 5, degree: 1, fixed: false });
    graph.addDirectedEdge('n2', 'extra', { weight: 1 });
    rerender(<Harness graph={graph} version={2} layout="forceatlas" runs={runs} />);

    expect(runs).toHaveLength(2);
    expect(runs[1]!.movable).toEqual(['extra']);
    for (const [id, x] of settled) expect(graph.getNodeAttribute(id, 'x')).toBe(x);

    // A version bump with nothing new starts no run.
    rerender(<Harness graph={graph} version={3} layout="forceatlas" runs={runs} />);
    expect(runs).toHaveLength(2);
    restore();
  });

  it('"Re-layout all" starts a full run that leaves a pinned node alone', async () => {
    const restore = mockReducedMotion(true);
    const graph = seededGraph(6);
    const runs: Array<{ movable: string[] }> = [];
    const { rerender } = render(<Harness graph={graph} version={1} layout="forceatlas" runs={runs} />);

    const { act } = await import('@testing-library/react');
    act(() => controls!.togglePin('n1'));
    expect(controls!.pinnedCount).toBe(1);
    expect(JSON.parse(sessionStorage.getItem('kvox.graph.pins:test-view')!)).toHaveProperty('n1');

    act(() => controls!.relayoutAll());
    rerender(<Harness graph={graph} version={1} layout="forceatlas" runs={runs} />);
    expect(runs.at(-1)!.movable.sort()).toEqual(['n0', 'n2', 'n3', 'n4', 'n5']);

    act(() => controls!.unpinAll());
    expect(controls!.pinnedCount).toBe(0);
    expect(sessionStorage.getItem('kvox.graph.pins:test-view')).toBeNull();
    restore();
  });

  it('restores persisted pins onto their nodes and keeps them out of the run', () => {
    const restore = mockReducedMotion(true);
    sessionStorage.setItem('kvox.graph.pins:test-view', JSON.stringify({ n2: { x: 42, y: -7 } }));
    const graph = seededGraph(6);
    const runs: Array<{ movable: string[] }> = [];
    render(<Harness graph={graph} version={1} layout="forceatlas" runs={runs} />);

    expect(graph.getNodeAttribute('n2', 'x')).toBe(42);
    expect(graph.getNodeAttribute('n2', 'fixed')).toBe(true);
    expect(runs[0]!.movable).not.toContain('n2');
    restore();
  });

  it('static never starts a run; concentric places the seed at the centre', () => {
    const restore = mockReducedMotion(true);
    const graph = seededGraph(6);
    const runs: Array<{ movable: string[] }> = [];
    const { rerender } = render(<Harness graph={graph} version={1} layout="static" runs={runs} />);
    expect(runs).toHaveLength(0);

    rerender(<Harness graph={graph} version={1} layout="concentric" seeds={['n0']} runs={runs} />);
    expect(runs).toHaveLength(0);
    expect(graph.getNodeAttribute('n0', 'x')).toBe(0);
    expect(graph.getNodeAttribute('n0', 'y')).toBe(0);
    expect(Math.hypot(graph.getNodeAttribute('n1', 'x') as number, graph.getNodeAttribute('n1', 'y') as number)).toBeGreaterThan(50);
    restore();
  });
});
