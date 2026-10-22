import { act, fireEvent, render, screen } from '@testing-library/react';
import { MultiDirectedGraph } from 'graphology';
import { createRef, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ExplorerMinimap, MINIMAP_HEIGHT, MINIMAP_WIDTH, minimapFrame } from '../../src/graph/ui/components/explorer/ExplorerMinimap.js';
import type { ExplorerGraph } from '../../src/graph/ui/components/explorer/explorerModel.js';
import { MINIMAP_MIN_NODES, minimapVisible } from '../../src/graph/ui/components/explorer/shell/explorerBudgets.js';
import type { CanvasViewport, GraphCanvasControls } from '../../src/graph/ui/components/explorer/GraphCanvas.js';

function graphOf(points: [string, number, number][]): { graph: ExplorerGraph; ids: Set<string> } {
  const graph = new MultiDirectedGraph() as ExplorerGraph;
  for (const [id, x, y] of points) graph.addNode(id, { x, y, color: '#336699', label: id } as never);
  return { graph, ids: new Set(points.map(([id]) => id)) };
}

const VIEWPORT: CanvasViewport = { topLeft: { x: 0, y: 0 }, bottomRight: { x: 50, y: 50 } };

describe('minimapVisible', () => {
  it('follows the shell: never compact, on request medium, above 150 nodes expanded, never in the list', () => {
    const base = { nodeCount: 400, mediumOn: true, listView: false } as const;
    expect(minimapVisible({ ...base, windowClass: 'compact' })).toBe(false);
    expect(minimapVisible({ ...base, windowClass: 'medium' })).toBe(true);
    expect(minimapVisible({ ...base, windowClass: 'medium', mediumOn: false })).toBe(false);
    expect(minimapVisible({ ...base, windowClass: 'expanded', nodeCount: MINIMAP_MIN_NODES })).toBe(false);
    expect(minimapVisible({ ...base, windowClass: 'expanded', nodeCount: MINIMAP_MIN_NODES + 1 })).toBe(true);
    expect(minimapVisible({ ...base, windowClass: 'expanded', listView: true })).toBe(false);
  });
});

describe('minimapFrame', () => {
  it('places every node inside the box and the viewport rectangle over the nodes it covers', () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 100, 0], ['c', 100, 100]]);
    const frame = minimapFrame(graph, ids, VIEWPORT);
    expect(frame.dots).toHaveLength(3);
    for (const dot of frame.dots) {
      expect(dot.x).toBeGreaterThanOrEqual(0);
      expect(dot.x).toBeLessThanOrEqual(MINIMAP_WIDTH);
      expect(dot.y).toBeGreaterThanOrEqual(0);
      expect(dot.y).toBeLessThanOrEqual(MINIMAP_HEIGHT);
    }
    const a = frame.dots.find((d) => d.id === 'a')!;
    expect(frame.rect!.x).toBeCloseTo(a.x, 5);
    expect(frame.rect!.y).toBeCloseTo(a.y, 5);
    // Half the graph's width on each axis.
    const b = frame.dots.find((d) => d.id === 'b')!;
    expect(frame.rect!.width).toBeCloseTo((b.x - a.x) / 2, 5);
  });

  it('maps a minimap point back to the graph point it shows', () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 100, 100]]);
    const frame = minimapFrame(graph, ids, VIEWPORT);
    const b = frame.dots.find((d) => d.id === 'b')!;
    const back = frame.toGraph!(b.x, b.y);
    expect(back.x).toBeCloseTo(100, 5);
    expect(back.y).toBeCloseTo(100, 5);
  });

  it('follows a canvas whose y axis points up', () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 0, 100]]);
    const up: CanvasViewport = { topLeft: { x: 0, y: 100 }, bottomRight: { x: 50, y: 50 } };
    const frame = minimapFrame(graph, ids, up);
    const a = frame.dots.find((d) => d.id === 'a')!;
    const b = frame.dots.find((d) => d.id === 'b')!;
    // Higher graph y is drawn nearer the top.
    expect(b.y).toBeLessThan(a.y);
    expect(frame.rect!.y).toBeCloseTo(b.y, 5);
  });

  it('is empty without nodes and has no rectangle before the canvas has a size', () => {
    expect(minimapFrame(graphOf([]).graph, new Set(), VIEWPORT).dots).toEqual([]);
    const { graph, ids } = graphOf([['a', 1, 1]]);
    expect(minimapFrame(graph, ids, null).rect).toBeNull();
  });
});

function controls(extra: Partial<GraphCanvasControls> = {}): {
  ref: RefObject<GraphCanvasControls | null>;
  emit: () => void;
  panToGraph: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<() => void>();
  const panToGraph = vi.fn();
  const ref = createRef<GraphCanvasControls | null>() as { current: GraphCanvasControls | null };
  ref.current = {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    relayoutAll: vi.fn(),
    togglePin: vi.fn(),
    unpinAll: vi.fn(),
    isPinned: () => false,
    getViewport: () => VIEWPORT,
    panToGraph,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...extra,
  };
  return { ref, emit: () => listeners.forEach((l) => l()), panToGraph };
}

describe('ExplorerMinimap', () => {
  it('draws a dot per node and the viewport, and is hidden from assistive technology', async () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 100, 100], ['c', 50, 20]]);
    const { ref } = controls();
    const { container } = render(<ExplorerMinimap graph={graph} version={1} visibleIds={ids} controlsRef={ref} />);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(screen.getByTestId('minimap-viewport')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-minimap')).toHaveAttribute('aria-hidden', 'true');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('tracks the camera: the rectangle moves when the canvas draws a new frame', async () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 100, 100]]);
    let viewport: CanvasViewport = VIEWPORT;
    const { ref, emit } = controls({ getViewport: () => viewport });
    render(<ExplorerMinimap graph={graph} version={1} visibleIds={ids} controlsRef={ref} />);
    const before = Number(screen.getByTestId('minimap-viewport').getAttribute('x'));

    viewport = { topLeft: { x: 40, y: 40 }, bottomRight: { x: 90, y: 90 } };
    await act(async () => {
      emit();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(Number(screen.getByTestId('minimap-viewport').getAttribute('x'))).toBeGreaterThan(before);
  });

  it('pans the camera on press and while dragging, and stops on release', () => {
    const { graph, ids } = graphOf([['a', 0, 0], ['b', 100, 100]]);
    const { ref, panToGraph } = controls();
    const { container } = render(<ExplorerMinimap graph={graph} version={1} visibleIds={ids} controlsRef={ref} />);
    const svg = container.querySelector('svg')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT, right: MINIMAP_WIDTH, bottom: MINIMAP_HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerMove(svg, { clientX: 10, clientY: 10 });
    expect(panToGraph).not.toHaveBeenCalled();

    fireEvent.pointerDown(svg, { clientX: MINIMAP_WIDTH / 2, clientY: MINIMAP_HEIGHT / 2, pointerId: 1 });
    expect(panToGraph).toHaveBeenCalledTimes(1);
    const [x, y] = panToGraph.mock.calls[0] as [number, number];
    expect(x).toBeCloseTo(50, 0);
    expect(y).toBeCloseTo(50, 0);

    fireEvent.pointerMove(svg, { clientX: MINIMAP_WIDTH * 0.75, clientY: MINIMAP_HEIGHT / 2 });
    expect(panToGraph).toHaveBeenCalledTimes(2);
    expect((panToGraph.mock.calls[1] as [number, number])[0]).toBeGreaterThan(x);

    fireEvent.pointerUp(svg);
    fireEvent.pointerMove(svg, { clientX: 10, clientY: 10 });
    expect(panToGraph).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes from the canvas when it goes away', () => {
    const { graph, ids } = graphOf([['a', 0, 0]]);
    const off = vi.fn();
    const { ref } = controls({ onFrame: () => off });
    const { unmount } = render(<ExplorerMinimap graph={graph} version={1} visibleIds={ids} controlsRef={ref} />);
    unmount();
    expect(off).toHaveBeenCalled();
  });
});
