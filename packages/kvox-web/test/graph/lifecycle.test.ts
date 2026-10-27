import { describe, expect, it, vi } from 'vitest';

import { isLive, markDrawn, syncSize, zoomOf } from '../../src/graph/ui/components/explorer/g6/lifecycle.js';

/** The G6 lifecycle guards (#775): no camera call before the first draw or after destroy. */

function instance(zoom = 1.5) {
  return {
    destroyed: false,
    size: [800, 600] as [number, number],
    getZoom: vi.fn(() => zoom),
    getSize() {
      return this.size;
    },
    resize: vi.fn(function (this: { size: [number, number] }, width: number, height: number) {
      this.size = [width, height];
    }),
  };
}

describe('G6 lifecycle guards', () => {
  it('an instance is live only once drawn, and never after destroy', () => {
    const graph = instance();
    expect(isLive(graph)).toBe(false);
    expect(isLive(null)).toBe(false);
    markDrawn(graph);
    expect(isLive(graph)).toBe(true);
    graph.destroyed = true;
    expect(isLive(graph)).toBe(false);
  });

  it('zoomOf never reaches a missing viewport, and survives a throwing one', () => {
    const graph = instance(2);
    expect(zoomOf(graph)).toBe(1);
    expect(graph.getZoom).not.toHaveBeenCalled();
    markDrawn(graph);
    expect(zoomOf(graph)).toBe(2);
    graph.getZoom.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'getZoom')");
    });
    expect(zoomOf(graph, 0.5)).toBe(0.5);
    graph.destroyed = true;
    expect(zoomOf(graph, 0.7)).toBe(0.7);
  });

  it('syncSize resizes a drawn instance only when the size changed and is not empty', () => {
    const graph = instance();
    expect(syncSize(graph, 390, 700)).toBe(false);
    expect(graph.resize).not.toHaveBeenCalled();
    markDrawn(graph);
    expect(syncSize(graph, 800, 600)).toBe(false);
    expect(syncSize(graph, 0, 600)).toBe(false);
    expect(syncSize(graph, 390, 700)).toBe(true);
    expect(graph.size).toEqual([390, 700]);
    graph.destroyed = true;
    expect(syncSize(graph, 100, 100)).toBe(false);
  });
});
