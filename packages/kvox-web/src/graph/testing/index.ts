// Test helpers for the graph slice. jsdom has no WebGL, so a screen that draws
// the graph is tested against a stand-in canvas.

import { createElement } from 'react';
import type { ComponentType, ReactElement } from 'react';

import { overrideCanvasLoaders } from '../ui/components/explorer/canvasLoaders.js';
import type { GraphCanvasProps } from '../ui/components/explorer/GraphCanvas.js';
import type { NeighborhoodCanvasProps } from '../ui/components/explorer/NeighborhoodCanvas.js';
import { overrideWebGLAvailability } from '../ui/components/explorer/webgl.js';

/**
 * Options of {@link mockGraphCanvas}.
 *
 * @stability experimental
 */
export interface MockGraphCanvasOptions {
  /** Whether the screens see WebGL. Default `true`: they draw the canvas rather than the list fallback. */
  webgl?: boolean;
  /** The stand-in for the explorer's and the overview's canvas. Default: {@link StubGraphCanvas}. */
  GraphCanvas?: ComponentType<GraphCanvasProps>;
  /** The stand-in for the neighbourhood widget's canvas. Default: a plain element. */
  NeighborhoodCanvas?: ComponentType<NeighborhoodCanvasProps>;
}

/**
 * A canvas stand-in: one button per visible node and one per edge, plus a
 * "stage" button, so a test can drive the screen's rules without WebGL.
 *
 * @param props - The canvas props the real `GraphCanvas` takes.
 * @returns The stand-in element.
 *
 * @stability experimental
 */
export function StubGraphCanvas(props: GraphCanvasProps): ReactElement {
  const nodes = [...props.visibleIds].sort().map((id) =>
    createElement(
      'button',
      {
        key: id,
        type: 'button',
        'data-selected': String(props.selectedId === id),
        // Like the real canvas, activating a "+N more" stub expands it instead of selecting it.
        onClick: () =>
          props.graph.getNodeAttribute(id, 'isStub') === true
            ? props.onNodeDoubleClick(id)
            : props.onNodeClick(id),
        onDoubleClick: () => props.onNodeDoubleClick(id),
      },
      String(props.graph.getNodeAttribute(id, 'label')),
    ),
  );
  const edges = props.graph.edges().map((id) =>
    createElement(
      'button',
      { key: id, type: 'button', onClick: () => props.onEdgeClick?.(id) },
      `edge ${id}`,
    ),
  );
  const stage = createElement(
    'button',
    { key: '__stage__', type: 'button', onClick: props.onStageClick },
    'stage',
  );
  return createElement(
    'div',
    { 'data-testid': 'fake-canvas', 'data-layout': props.layout },
    ...nodes,
    ...edges,
    stage,
  );
}

function StubNeighborhoodCanvas(props: NeighborhoodCanvasProps): ReactElement {
  return createElement('div', {
    'data-testid': 'fake-canvas',
    'data-interactive': String(props.interactive),
    'data-layout': props.layout,
  });
}

/**
 * Replaces the graph canvases and the WebGL probe with stand-ins, for a host's
 * tests of the explorer, the overview and the entity page.
 *
 * @remarks
 * Call it BEFORE the screen first renders: the screens load their canvas with
 * `React.lazy`, which resolves once per module. It does not use `vi.mock`, so
 * it works against the built package.
 *
 * @param options - See {@link MockGraphCanvasOptions}.
 * @returns A function that restores the real canvases and the real probe.
 *
 * @stability experimental
 */
export function mockGraphCanvas(options: MockGraphCanvasOptions = {}): () => void {
  const restoreLoaders = overrideCanvasLoaders({
    graphCanvas: () => Promise.resolve({ default: options.GraphCanvas ?? StubGraphCanvas }),
    neighborhoodCanvas: () =>
      Promise.resolve({ default: options.NeighborhoodCanvas ?? StubNeighborhoodCanvas }),
  });
  overrideWebGLAvailability(options.webgl ?? true);
  return () => {
    restoreLoaders();
    overrideWebGLAvailability(null);
  };
}
