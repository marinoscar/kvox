import { MultiDirectedGraph } from 'graphology';
import { describe, expect, it } from 'vitest';

import { createPositionTweener } from '../../../src/graph/ui/components/explorer/layout/tween.js';

function setup(reducedMotion: boolean) {
  const graph = new MultiDirectedGraph();
  graph.addNode('a', { x: 0, y: 0 });
  graph.addNode('b', { x: 10, y: 10 });
  let time = 0;
  const queue: Array<(t: number) => void> = [];
  const tween = createPositionTweener(graph, {
    reducedMotion,
    now: () => time,
    raf: (cb) => queue.push(cb),
    cancelRaf: () => {
      queue.length = 0;
    },
  });
  const advance = (ms: number) => {
    time += ms;
    const callbacks = queue.splice(0);
    callbacks.forEach((cb) => cb(time));
  };
  return { graph, tween, advance, queue };
}

describe('position tween', () => {
  it('moves over time and lands exactly on the target within 300 ms', () => {
    const { graph, tween, advance } = setup(false);
    tween.retarget(new Map([['a', { x: 100, y: 50 }]]));

    expect(graph.getNodeAttribute('a', 'x')).toBe(0); // nothing has moved yet
    advance(100);
    const mid = graph.getNodeAttribute('a', 'x') as number;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    advance(250);
    expect(graph.getNodeAttribute('a', 'x')).toBe(100);
    expect(graph.getNodeAttribute('a', 'y')).toBe(50);
    expect(graph.getNodeAttribute('b', 'x')).toBe(10); // not a target: untouched
  });

  it('jumps straight to the target under reduced motion, scheduling no frame', () => {
    const { graph, tween, queue } = setup(true);
    tween.retarget(new Map([['a', { x: 100, y: 50 }]]));

    expect(graph.getNodeAttribute('a', 'x')).toBe(100);
    expect(graph.getNodeAttribute('a', 'y')).toBe(50);
    expect(queue).toHaveLength(0);
  });

  it('flush jumps to the last targets and cancel stops further movement', () => {
    const { graph, tween, advance } = setup(false);
    tween.retarget(new Map([['a', { x: 40, y: 0 }]]));
    advance(50);
    tween.cancel();
    const stopped = graph.getNodeAttribute('a', 'x');
    advance(500);
    expect(graph.getNodeAttribute('a', 'x')).toBe(stopped);
    tween.flush();
    expect(graph.getNodeAttribute('a', 'x')).toBe(40);
  });
});
