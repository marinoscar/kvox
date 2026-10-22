import { describe, expect, it } from 'vitest';

import {
  LASSO_MIN_AREA_PX,
  LASSO_MIN_STEP_PX,
  appendLassoPoint,
  isLassoSelection,
  nodeAtPoint,
  nodesInPolygon,
  pointInPolygon,
  polygonArea,
  type LassoPoint,
} from '../../src/graph/ui/components/explorer/connect/lassoGeometry.js';

const SQUARE: LassoPoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

// A "C" shape: the notch (x 40..100, y 40..60) is outside.
const C_SHAPE: LassoPoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 40 },
  { x: 40, y: 40 },
  { x: 40, y: 60 },
  { x: 100, y: 60 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('pointInPolygon', () => {
  it('is true inside and false outside a square', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ x: 101, y: 50 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 50 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: 50, y: 150 }, SQUARE)).toBe(false);
  });

  it('respects a concave polygon: the notch of a C is outside', () => {
    expect(pointInPolygon({ x: 70, y: 50 }, C_SHAPE)).toBe(false);
    expect(pointInPolygon({ x: 20, y: 50 }, C_SHAPE)).toBe(true);
    expect(pointInPolygon({ x: 70, y: 20 }, C_SHAPE)).toBe(true);
  });

  it('contains nothing when it has fewer than three points', () => {
    expect(pointInPolygon({ x: 1, y: 1 }, [])).toBe(false);
    expect(pointInPolygon({ x: 1, y: 1 }, SQUARE.slice(0, 2))).toBe(false);
  });
});

describe('nodesInPolygon', () => {
  const nodes = [
    { id: 'inside-a', x: 10, y: 10 },
    { id: 'outside', x: 200, y: 10 },
    { id: 'inside-b', x: 90, y: 90 },
    { id: 'notch', x: 70, y: 50 },
  ];

  it('returns exactly the nodes inside, in the order given', () => {
    expect(nodesInPolygon(nodes, SQUARE)).toEqual(['inside-a', 'inside-b', 'notch']);
    expect(nodesInPolygon(nodes, C_SHAPE)).toEqual(['inside-a', 'inside-b']);
  });

  it('selects nothing for a degenerate polygon', () => {
    expect(nodesInPolygon(nodes, [])).toEqual([]);
    expect(nodesInPolygon(nodes, SQUARE.slice(0, 2))).toEqual([]);
  });

  it('accepts any iterable of nodes', () => {
    expect(nodesInPolygon(new Set(nodes), SQUARE)).toHaveLength(3);
  });
});

describe('polygonArea and isLassoSelection', () => {
  it('computes the shoelace area whatever the winding', () => {
    expect(polygonArea(SQUARE)).toBe(10_000);
    expect(polygonArea([...SQUARE].reverse())).toBe(10_000);
    expect(polygonArea(C_SHAPE)).toBe(10_000 - 60 * 20);
    expect(polygonArea(SQUARE.slice(0, 2))).toBe(0);
  });

  it('treats a click or a wobble as no selection', () => {
    expect(isLassoSelection(SQUARE)).toBe(true);
    expect(isLassoSelection([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }])).toBe(false);
    expect(isLassoSelection([{ x: 5, y: 5 }])).toBe(false);
    expect(LASSO_MIN_AREA_PX).toBeGreaterThan(0);
  });
});

describe('appendLassoPoint', () => {
  it('skips a point closer than the minimum step and keeps the same array', () => {
    const start = [{ x: 0, y: 0 }];
    expect(appendLassoPoint(start, { x: LASSO_MIN_STEP_PX - 1, y: 0 })).toBe(start);
  });

  it('adds a point that moved far enough, without mutating the input', () => {
    const start = [{ x: 0, y: 0 }];
    const next = appendLassoPoint(start, { x: 10, y: 0 });
    expect(next).toHaveLength(2);
    expect(start).toHaveLength(1);
  });
});

describe('nodeAtPoint', () => {
  const nodes = [
    { id: 'big', x: 50, y: 50, radius: 12 },
    { id: 'small', x: 60, y: 50, radius: 4 },
  ];

  it('finds the nearest node within its radius plus the margin', () => {
    expect(nodeAtPoint(nodes, { x: 50, y: 50 })).toBe('big');
    expect(nodeAtPoint(nodes, { x: 61, y: 50 })).toBe('small');
    expect(nodeAtPoint(nodes, { x: 50, y: 66 })).toBe('big');
  });

  it('is null on empty stage', () => {
    expect(nodeAtPoint(nodes, { x: 300, y: 300 })).toBeNull();
    expect(nodeAtPoint([], { x: 1, y: 1 })).toBeNull();
  });
});
