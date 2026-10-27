import { describe, it, expect, vi } from 'vitest';

/**
 * The drawing libraries are optional peers of the `graph/ui` entry ONLY, and
 * G6 is reached only through the lazy canvas.
 *
 * `@antv/g6` (about 410 KB gzipped) is not installed by a host that uses just
 * `graph/headless` (KVox Desktop's main process, a CLI), and `graphology` is
 * not either, so that entry has to load with both missing. The `ui` entry needs
 * `graphology` (the explorer and overview models) but not G6 until a screen
 * draws a canvas: only the lazy `GraphCanvas` chunk imports it.
 *
 * "Not installed" is simulated by making each module throw the error a missing
 * package throws when it is imported.
 */

function missing(name: string): never {
  throw new Error(`Cannot find package '${name}'`);
}

vi.mock('@antv/g6', () => missing('@antv/g6'));

describe('graph/headless without the drawing libraries', () => {
  it('loads and exports its client and hooks', async () => {
    const headless = await import('../../src/graph/headless/index.js');

    expect(headless.getGraphEntity).toBeTypeOf('function');
    expect(headless.listGraphEntities).toBeTypeOf('function');
    expect(headless.useGraphEntity).toBeTypeOf('function');
    expect(headless.useGraphEntities).toBeTypeOf('function');
    expect(headless.useGraphBrief).toBeTypeOf('function');
    expect(headless.useGraphTimeline).toBeTypeOf('function');
    expect(headless.useGraphMentions).toBeTypeOf('function');
    expect(headless.useGraphEvidence).toBeTypeOf('function');
    expect(headless.useGraphOverview).toBeTypeOf('function');
    expect(headless.useGraphProposal).toBeTypeOf('function');
    expect(headless.useGraphOntology).toBeTypeOf('function');
    expect(headless.useGraphPreferences).toBeTypeOf('function');
    expect(headless.useGraphAttributeDefs).toBeTypeOf('function');
    expect(headless.useGraphExport).toBeTypeOf('function');
    expect(headless.useGraphImport).toBeTypeOf('function');
    expect(headless.useGraphExtractEstimate).toBeTypeOf('function');
    expect(headless.useGraphTranscriptPeople).toBeTypeOf('function');
  });
});

describe('graph/ui without G6', () => {
  it('loads: the canvas is a lazy chunk that only a screen drawing a graph pulls in', async () => {
    const ui = await import('../../src/graph/ui/index.js');

    expect(ui.GraphExplorerPage).toBeTypeOf('function');
    expect(ui.GraphOverviewPage).toBeTypeOf('function');
    expect(ui.NeighborhoodWidget).toBeTypeOf('function');
    expect(ui.GraphEntityPage).toBeTypeOf('function');
    expect(ui.kvoxGraphRoutes.length).toBeGreaterThan(0);
  });
});
