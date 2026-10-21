/**
 * Position tween (GIC-07, #668): moves nodes to their targets over at most
 * `LAYOUT_TWEEN_MS`, ease-out. Under `prefers-reduced-motion` positions jump.
 *
 * Retargeting restarts the tween from the current positions, so a stream of
 * progress frames reads as smooth following rather than as steps.
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

import { LAYOUT_TWEEN_MS } from './layoutBudgets.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/** A position tweener over one graph. */
export interface PositionTweener {
  /** Moves the given nodes to `x, y`; a node missing from the graph is skipped. */
  retarget: (targets: ReadonlyMap<string, { x: number; y: number }>) => void;
  /** Jumps to the last targets now. */
  flush: () => void;
  /** Stops without moving anything further. */
  cancel: () => void;
}

/** Options of `createPositionTweener`. */
export interface TweenOptions {
  /** `true`: no animation, positions jump. */
  reducedMotion: boolean;
  durationMs?: number;
  /** Animation-frame scheduler; injectable for tests. */
  raf?: (callback: (time: number) => void) => number;
  cancelRaf?: (handle: number) => void;
  now?: () => number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * Creates a tweener.
 *
 * @param graph - The graph whose `x`/`y` attributes are written.
 * @param options - Motion preference and test seams.
 * @returns The tweener.
 */
export function createPositionTweener(graph: AnyGraph, options: TweenOptions): PositionTweener {
  const duration = options.durationMs ?? LAYOUT_TWEEN_MS;
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((h) => cancelAnimationFrame(h));
  const now = options.now ?? (() => performance.now());

  let handle: number | null = null;
  let from = new Map<string, { x: number; y: number }>();
  let to = new Map<string, { x: number; y: number }>();
  let started = 0;

  const stop = () => {
    if (handle !== null) cancelRaf(handle);
    handle = null;
  };

  const write = (progress: number) => {
    const eased = easeOut(progress);
    for (const [id, target] of to) {
      const start = from.get(id);
      if (!start || !graph.hasNode(id)) continue;
      graph.mergeNodeAttributes(id, {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
    }
  };

  const tick = () => {
    handle = null;
    const progress = Math.min(1, (now() - started) / duration);
    write(progress);
    if (progress < 1) handle = raf(tick);
  };

  return {
    retarget(targets) {
      stop();
      to = new Map(targets);
      if (options.reducedMotion || duration <= 0) {
        from = new Map(to);
        write(1);
        return;
      }
      from = new Map();
      for (const id of to.keys()) {
        if (!graph.hasNode(id)) continue;
        const attrs = graph.getNodeAttributes(id);
        from.set(id, { x: attrs.x as number, y: attrs.y as number });
      }
      started = now();
      handle = raf(tick);
    },
    flush() {
      stop();
      write(1);
    },
    cancel: stop,
  };
}
