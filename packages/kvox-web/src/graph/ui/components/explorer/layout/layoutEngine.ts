/**
 * The layout maths, shared verbatim by `layout.worker.ts` and the main-thread
 * fallback (GIC-07, #668): ForceAtlas2 iterations with fixed nodes, then a
 * noverlap pass. No DOM, no sigma, no React, so a worker can import it.
 *
 * DETERMINISM. The result depends only on the request and on the iteration
 * count: FA2 runs in fixed chunks (`FA2_CHUNK_ITERATIONS`) and the clock only
 * decides WHEN a run stops, never what a chunk computes. A run that is not cut
 * short by its time box therefore gives the same positions in a worker and on
 * the main thread.
 */

import { MultiDirectedGraph } from 'graphology';
import forceAtlas2Module, { inferSettings } from 'graphology-layout-forceatlas2';
import noverlapModule from 'graphology-layout-noverlap';

import { FA2_CHUNK_ITERATIONS, NOVERLAP_MAX_ITERATIONS } from './layoutBudgets.js';
import type { LayoutRequest, LayoutResult } from './protocol.js';

// Both libraries are CommonJS with `module.exports` set to the function; the
// typings declare it as a property, so it is read through a cast (see GraphCanvas).
const forceAtlas2 = forceAtlas2Module as unknown as typeof forceAtlas2Module.default;
const noverlap = noverlapModule as unknown as typeof noverlapModule.default;

/** A run in progress. */
export interface LayoutRun {
  /** Runs ForceAtlas2 chunks until `sliceMs` has passed or the iterations are done. Returns whether it is done. */
  step: (sliceMs: number, now?: () => number) => boolean;
  /** The current positions (`x0, y0, ...`). */
  snapshot: () => Float32Array;
  /** The overlap pass; fixed nodes are restored. Returns the final positions. */
  finish: () => Float32Array;
  /** Iterations performed so far. */
  readonly iterations: number;
}

/**
 * Builds a run from a request.
 *
 * @param request - Nodes, edges and settings.
 * @returns The run.
 */
export function createLayoutRun(request: LayoutRequest): LayoutRun {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const node of request.nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y, size: node.size, fixed: node.fixed });
  }
  for (const edge of request.edges) {
    if (edge.s === edge.t || !graph.hasNode(edge.s) || !graph.hasNode(edge.t)) continue;
    graph.addEdge(edge.s, edge.t, { weight: edge.w });
  }

  const { settings } = request;
  const fa2Settings = {
    ...inferSettings(graph),
    adjustSizes: true,
    linLogMode: settings.linLogMode,
    barnesHutOptimize: graph.order > settings.barnesHutThreshold,
  };

  let iterations = 0;
  const snapshot = (): Float32Array => {
    const out = new Float32Array(request.nodes.length * 2);
    request.nodes.forEach((node, index) => {
      out[index * 2] = graph.getNodeAttribute(node.id, 'x') as number;
      out[index * 2 + 1] = graph.getNodeAttribute(node.id, 'y') as number;
    });
    return out;
  };

  return {
    get iterations() {
      return iterations;
    },
    step(sliceMs, now = () => performance.now()) {
      const start = now();
      while (iterations < settings.iterations) {
        const chunk = Math.min(FA2_CHUNK_ITERATIONS, settings.iterations - iterations);
        forceAtlas2.assign(graph, { iterations: chunk, settings: fa2Settings });
        iterations += chunk;
        if (now() - start >= sliceMs) break;
      }
      return iterations >= settings.iterations;
    },
    snapshot,
    finish() {
      if (settings.removeOverlap && graph.order > 1) {
        noverlap.assign(graph, { maxIterations: NOVERLAP_MAX_ITERATIONS });
        // noverlap has no notion of a fixed node: put those back.
        for (const node of request.nodes) {
          if (node.fixed) graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
        }
      }
      return snapshot();
    },
  };
}

/** Everything `runLayout` needs from its host thread. */
export interface RunLayoutOptions {
  /** Called with each progress frame. */
  onFrame: (positions: Float32Array) => void;
  /** Yields to the thread's event loop between slices. */
  yieldToHost: () => Promise<void>;
  /** Milliseconds of work per slice. */
  sliceMs: number;
  /** Returns `true` once the run was cancelled. */
  isCancelled: () => boolean;
  /** Clock; injectable for tests. */
  now?: () => number;
}

/**
 * Runs a request to completion in time-sliced chunks, honouring `budgetMs`.
 *
 * @param request - The run.
 * @param options - Slice length, frame callback and cancellation.
 * @returns The result, or `null` when cancelled.
 */
export async function runLayout(
  request: LayoutRequest,
  options: RunLayoutOptions,
): Promise<LayoutResult | null> {
  const now = options.now ?? (() => performance.now());
  const run = createLayoutRun(request);
  const started = now();
  let done = request.settings.iterations <= 0;
  let timedOut = false;
  while (!done) {
    if (options.isCancelled()) return null;
    done = run.step(options.sliceMs, now);
    if (done) break;
    if (now() - started >= request.budgetMs) {
      timedOut = true;
      break;
    }
    options.onFrame(run.snapshot());
    await options.yieldToHost();
  }
  if (options.isCancelled()) return null;
  return { positions: run.finish(), iterations: run.iterations, timedOut };
}
