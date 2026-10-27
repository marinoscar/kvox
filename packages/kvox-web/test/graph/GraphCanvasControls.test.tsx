import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphCanvasControls } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import { FakeGraph, FakeResizeObserver } from './fakeG6.js';
import { ORG_ALPHA, PERSON_A, PERSON_B, canvasGraph } from './canvasFixtures.js';

/**
 * The controls contract of `GraphCanvas` (#775) over a fake G6 `Graph`: the toolbar's and the keyboard's
 * zoom and fit, path mode's `fitTo`, the minimap's `getViewport` / `panToGraph` / `onFrame`, the camera
 * snapshot, the on-screen zoom cluster, and the rule that a layout refits the view only until the user
 * moves the camera.
 */

vi.mock('@antv/g6', () => ({ Graph: FakeGraph }));

const { GraphCanvas } = await import('../../src/graph/ui/components/explorer/GraphCanvas.js');
type Props = Parameters<typeof GraphCanvas>[0];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let width = 800;
let height = 600;

async function mount(over: Partial<Props> = {}) {
  const graph = canvasGraph();
  const controlsRef = createRef<GraphCanvasControls>();
  const props: Props = {
    graph,
    version: 1,
    visibleIds: new Set(graph.nodes()),
    selectedId: null,
    layout: 'static',
    onNodeClick: vi.fn(),
    onNodeDoubleClick: vi.fn(),
    onStageClick: vi.fn(),
    height: 400,
    controlsRef,
    ...over,
  };
  const result = render(<GraphCanvas {...props} />);
  await flush();
  return { props, graph, controls: () => controlsRef.current!, ...result };
}

beforeEach(() => {
  FakeGraph.reset();
  width = 800;
  height = 600;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GraphCanvas controls', () => {
  it('fits the visible nodes after the first draw', async () => {
    await mount();
    const g6 = FakeGraph.last();
    expect(g6.size).toEqual([800, 600]);
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(true);
    expect(g6.calls.some((call) => call.startsWith('zoomTo:'))).toBe(true);
  });

  it('zoomIn and zoomOut step the zoom by 1.5, clamped to the range', async () => {
    const { controls } = await mount();
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(1);
    });
    await act(async () => controls().zoomIn());
    expect(g6.getZoom()).toBeCloseTo(1.5);
    await act(async () => controls().zoomOut());
    await act(async () => controls().zoomOut());
    expect(g6.getZoom()).toBeCloseTo(1 / 1.5);
    for (let i = 0; i < 20; i += 1) await act(async () => controls().zoomIn());
    expect(g6.getZoom()).toBe(6);
  });

  it('fitTo frames only the given nodes and ignores ids that are not drawn', async () => {
    const { controls } = await mount();
    const g6 = FakeGraph.last();
    g6.calls = [];
    await act(async () => controls().fitTo!([PERSON_A, ORG_ALPHA, 'not-drawn']));
    await flush();
    expect(g6.calls).toContain(`focus:${PERSON_A},${ORG_ALPHA}`);
    // The pair's centre is now in the middle of the canvas.
    const [x, y] = g6.getViewportByCanvas([50, 0]);
    expect(x).toBeCloseTo(400);
    expect(y).toBeCloseTo(300);
  });

  it('getViewport, panToGraph and getCamera/setCamera agree with the camera', async () => {
    const { controls } = await mount();
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(2);
    });
    act(() => controls().panToGraph!(400, 400));
    await flush();
    const viewport = controls().getViewport!()!;
    expect((viewport.topLeft.x + viewport.bottomRight.x) / 2).toBeCloseTo(400);
    expect((viewport.topLeft.y + viewport.bottomRight.y) / 2).toBeCloseTo(400);
    expect(viewport.bottomRight.x - viewport.topLeft.x).toBeCloseTo(400);

    const camera = controls().getCamera!();
    expect(camera).toMatchObject({ ratio: 0.5 });
    expect(camera.x).toBeCloseTo(400);
    act(() => controls().panToGraph!(0, 0));
    act(() => controls().setCamera!(camera));
    await flush();
    expect(controls().getCamera!().x).toBeCloseTo(400);
    expect(controls().getCamera!().y).toBeCloseTo(400);
  });

  it('onFrame calls its listener after every camera change until unsubscribed', async () => {
    const { controls } = await mount();
    const listener = vi.fn();
    const off = controls().onFrame!(listener);
    act(() => controls().panToGraph!(10, 10));
    await flush();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    off();
    act(() => controls().panToGraph!(20, 20));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('a layout refits only until the user moves the camera; Fit resets that', async () => {
    const { rerender, props, controls } = await mount({ layout: 'forceatlas' });
    const g6 = FakeGraph.last();
    // The user pans (a transform the canvas did not make).
    await act(async () => {
      await g6.translateBy([30, 0]);
    });
    g6.calls = [];
    props.graph.addNode('person-c', { ...props.graph.getNodeAttributes(PERSON_B), label: 'Person C' });
    rerender(<GraphCanvas {...props} version={2} visibleIds={new Set(props.graph.nodes())} />);
    await flush();
    expect(g6.calls).toContain('render');
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(false);

    act(() => controls().fit());
    await flush();
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(true);
    g6.calls = [];
    props.graph.addNode('person-d', { ...props.graph.getNodeAttributes(PERSON_B), label: 'Person D' });
    rerender(<GraphCanvas {...props} version={3} visibleIds={new Set(props.graph.nodes())} />);
    await flush();
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(true);
  });

  it('follows the element size, and refits when the user has not moved the camera', async () => {
    await mount();
    const g6 = FakeGraph.last();
    g6.calls = [];
    width = 390;
    height = 700;
    act(() => FakeResizeObserver.trigger());
    await flush();
    expect(g6.calls[0]).toBe('resize:390x700');
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(true);
  });
});

describe('GraphCanvas zoom cluster', () => {
  it('has named buttons that zoom and fit', async () => {
    await mount();
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await flush();
    expect(g6.getZoom()).toBeCloseTo(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await flush();
    expect(g6.getZoom()).toBeCloseTo(1);
    g6.calls = [];
    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    await flush();
    expect(g6.calls.some((call) => call.startsWith('focus:'))).toBe(true);
    expect(screen.getByRole('group', { name: 'Canvas zoom' })).toBeInTheDocument();
  });

  it('hides Full screen where the Fullscreen API is missing, and the whole cluster on a static canvas', async () => {
    const { unmount } = await mount();
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument();
    unmount();
    await mount({ interactive: false });
    expect(screen.queryByRole('group', { name: 'Canvas zoom' })).not.toBeInTheDocument();
  });

  it('offers Full screen where the API exists', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
    try {
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      expect(request).toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
    }
  });
});
