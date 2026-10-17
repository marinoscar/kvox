import type { ComponentType } from 'react';

import type { GraphCanvasProps } from './GraphCanvas.js';
import type { NeighborhoodCanvasProps } from './NeighborhoodCanvas.js';

/**
 * How the explorer, the overview and the entity page's neighbourhood widget
 * load their canvases.
 *
 * @remarks
 * This file holds the two dynamic `import()` calls that pull `GraphCanvas.tsx`
 * (the one file that imports sigma and graphology's layout) into its own
 * chunk, so a screen that never draws a graph never downloads either. The
 * loaders are replaceable because jsdom has no WebGL: a host's tests swap in a
 * stand-in with `mockGraphCanvas` from `@marinoscar/kvox-web/graph/testing`.
 *
 * @stability experimental
 */
export interface GraphCanvasLoaders {
  /** Loads the explorer's and the overview's canvas. */
  graphCanvas: () => Promise<{ default: ComponentType<GraphCanvasProps> }>;
  /** Loads the neighbourhood widget's canvas. */
  neighborhoodCanvas: () => Promise<{ default: ComponentType<NeighborhoodCanvasProps> }>;
}

const defaultLoaders: GraphCanvasLoaders = {
  graphCanvas: () => import('./GraphCanvas.js').then((module) => ({ default: module.GraphCanvas })),
  neighborhoodCanvas: () =>
    import('./NeighborhoodCanvas.js').then((module) => ({ default: module.NeighborhoodCanvas })),
};

/** The loaders in force. Read at the moment a screen first renders a canvas. */
export const canvasLoaders: GraphCanvasLoaders = { ...defaultLoaders };

/**
 * Replaces the canvas loaders (a test seam).
 *
 * @param next - The loaders to use; a member left out keeps the real one.
 * @returns A function that restores the previous loaders.
 *
 * @stability experimental
 */
export function overrideCanvasLoaders(next: Partial<GraphCanvasLoaders>): () => void {
  const previous = { ...canvasLoaders };
  Object.assign(canvasLoaders, next);
  return () => {
    Object.assign(canvasLoaders, previous);
  };
}
