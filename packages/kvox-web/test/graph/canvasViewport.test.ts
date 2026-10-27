import { describe, expect, it } from 'vitest';

import {
  AUTO_FIT_MAX_ZOOM,
  FIT_PADDING_PX,
  ZOOM_RANGE,
  clampZoom,
  createCameraTracker,
  fitTransform,
  unionBounds,
  zoomBucket,
} from '../../src/graph/ui/components/explorer/g6/viewport.js';
import {
  FORCE_MIN_ITERATIONS,
  FORCE_SETTLE_ITERATIONS,
  LABEL_CLEARANCE_PX,
  collideRadius,
  forceIterations,
  forceLayoutOptions,
  movableNodes,
  movesEverything,
  radialLayoutOptions,
  shouldRunLayout,
} from '../../src/graph/ui/components/explorer/layout/canvasLayouts.js';
import { ORG_ALPHA, PERSON_A, PERSON_B, canvasGraph } from './canvasFixtures.js';

/** The camera rules and the layout options of the G6 canvas (#775), pure. */

describe('framing', () => {
  it('unions render bounds and skips missing or broken ones', () => {
    expect(unionBounds([])).toBeNull();
    expect(
      unionBounds([
        { min: [0, 0], max: [10, 10] },
        null,
        { min: [Number.NaN, 0], max: [1, 1] },
        { min: [-5, 4], max: [3, 20] },
      ]),
    ).toEqual({ min: [-5, 0], max: [10, 20] });
  });

  it('frames a box with 48px to spare and centres it', () => {
    const fit = fitTransform({ min: [0, 0], max: [800, 400] }, [800, 600]);
    expect(fit.center).toEqual([400, 200]);
    expect(fit.zoom).toBeCloseTo((800 - 2 * FIT_PADDING_PX) / 800);
  });

  it('never blows a small graph up past 1.25 (it is centred), and stays inside the zoom range', () => {
    expect(fitTransform({ min: [10, 10], max: [12, 12] }, [800, 600]).zoom).toBe(AUTO_FIT_MAX_ZOOM);
    expect(AUTO_FIT_MAX_ZOOM).toBe(1.25);
    expect(fitTransform({ min: [10, 10], max: [12, 12] }, [800, 600], { maxZoom: 4 }).zoom).toBe(4);
    expect(fitTransform({ min: [0, 0], max: [1e6, 1e6] }, [800, 600]).zoom).toBe(ZOOM_RANGE[0]);
    expect(clampZoom(100)).toBe(6);
    expect(clampZoom(0.01)).toBe(0.1);
  });

  it('buckets the zoom so a pinch recomputes states a few times, not every frame', () => {
    expect(zoomBucket(1)).toBe(0);
    expect(zoomBucket(1.05)).toBe(zoomBucket(1));
    expect(zoomBucket(0.5)).toBeLessThan(zoomBucket(0.6));
  });
});

describe('the camera-moved flag', () => {
  it('counts only the transforms the canvas did not make, until reset', async () => {
    const tracker = createCameraTracker();
    await tracker.programmatic(() => tracker.onTransform());
    expect(tracker.moved()).toBe(false);
    tracker.onTransform();
    expect(tracker.moved()).toBe(true);
    tracker.reset();
    expect(tracker.moved()).toBe(false);
  });

  it('an async camera change stays the canvas\'s until it settles, even if it throws', async () => {
    const tracker = createCameraTracker();
    await tracker.programmatic(async () => {
      await Promise.resolve();
      tracker.onTransform();
    });
    expect(tracker.moved()).toBe(false);
    await expect(
      tracker.programmatic(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    tracker.onTransform();
    expect(tracker.moved()).toBe(true);
  });
});

describe('layout options', () => {
  it('d3-force: collide by size plus label room, no centring, no worker, time-boxed', () => {
    const options = forceLayoutOptions(3000);
    expect(options).toMatchObject({ type: 'd3-force', animation: false, center: false });
    expect(options).not.toHaveProperty('enableWorker');
    expect(collideRadius({ data: { diameter: 40 } })).toBe(20 + LABEL_CLEARANCE_PX);
    expect(collideRadius({})).toBeGreaterThan(LABEL_CLEARANCE_PX);
    expect(forceIterations(3000)).toBe(FORCE_SETTLE_ITERATIONS);
    expect(forceIterations(1500)).toBe(FORCE_SETTLE_ITERATIONS / 2);
    expect(forceIterations(10)).toBe(FORCE_MIN_ITERATIONS);
  });

  it('radial: centred on the first seed the graph has', () => {
    const graph = canvasGraph();
    expect(radialLayoutOptions(graph, ['gone', PERSON_A])).toMatchObject({ type: 'radial', focusNode: PERSON_A });
    expect(radialLayoutOptions(graph, [])).toMatchObject({ focusNode: null });
    expect(radialLayoutOptions(graph, [])).not.toHaveProperty('enableWorker');
  });

  it('moves only new, unpinned nodes unless everything is asked for', () => {
    const graph = canvasGraph();
    graph.setNodeAttribute(PERSON_B, 'fixed', true);
    const known = new Set([PERSON_A, ORG_ALPHA]);
    const some = movableNodes(graph, known);
    expect(some.has(PERSON_A)).toBe(false);
    expect(some.has(PERSON_B)).toBe(false);
    const all = movableNodes(graph, known, { all: true });
    expect(all.has(PERSON_A)).toBe(true);
    expect(all.has(PERSON_B)).toBe(false);
  });

  it('decides when a run moves everything, and never runs for static', () => {
    expect(movesEverything({ layout: 'forceatlas', previous: 'forceatlas', relayout: false })).toBe(false);
    expect(movesEverything({ layout: 'forceatlas', previous: 'forceatlas', relayout: true })).toBe(true);
    expect(movesEverything({ layout: 'forceatlas', previous: 'concentric', relayout: false })).toBe(true);
    expect(movesEverything({ layout: 'concentric', previous: null, relayout: false })).toBe(true);
    expect(shouldRunLayout({ layout: 'static', previous: null, relayout: true, movable: 5 })).toBe(false);
    expect(shouldRunLayout({ layout: 'forceatlas', previous: null, relayout: false, movable: 0 })).toBe(false);
    expect(shouldRunLayout({ layout: 'forceatlas', previous: null, relayout: false, movable: 2 })).toBe(true);
  });
});
