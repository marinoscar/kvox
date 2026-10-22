import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from './msw-compat.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  EXPLORER_NEIGHBOUR_LIMIT,
  EXPLORER_NODE_CAP,
  realNodeCount,
  remainingCapacity,
  stubId,
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import { useGraphExplorer } from '../../src/graph/ui/hooks/useGraphExplorer.js';
import {
  ACME_ID,
  ANA_ID,
  BEN_ID,
  JOE_ID,
  Q3_MEETING_ID,
  expandFixture,
  gid,
  hubFixture,
  manyNodesSlice,
  type ExpandFixtureRequest,
} from './graphData.js';
import { server } from './msw-compat.js';
import { renderHook as renderHookWithProviders } from './helpers.js';

/**
 * `useGraphExplorer` (#374) — WHEN the explorer asks the API, and what it
 * asks for. The rules about what the graph may hold are `explorerModel`'s and
 * tested there.
 */

const NODE_TYPES = ['Person', 'Organization', 'Meeting', 'Project', 'commitment', 'decision', 'claim'];
const RELATION_TYPES = ['WORKS_FOR', 'REPORTS_TO', 'ATTENDED', 'ASSIGNED_TO', 'DECIDED_IN', 'PART_OF'];

let bodies: ExpandFixtureRequest[];

beforeEach(() => {
  bodies = [];
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      bodies.push(body);
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 });
    }),
  );
});

function renderExplorer() {
  return renderHookWithProviders(() =>
    useGraphExplorer({ nodeTypes: NODE_TYPES, relationTypes: RELATION_TYPES }),
  );
}

describe('useGraphExplorer — load', () => {
  it('expands the seeds with the full cap and no filters while nothing is hidden', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));

    expect(bodies).toEqual([{ nodeIds: [JOE_ID], cap: EXPLORER_NODE_CAP }]);
    expect(result.current.state.seedIds).toEqual([JOE_ID]);
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(true);
    expect(result.current.state.expanded.has(JOE_ID)).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.version).toBeGreaterThan(0);
  });

  it('reports a 404 seed as notFound', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([gid(424242)]));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toMatch(/does not exist/);
    expect(result.current.state.graph.order).toBe(0);
  });

  it('retries the last action', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    await act(() => result.current.retry());
    expect(bodies).toHaveLength(2);
    expect(bodies[1].nodeIds).toEqual([JOE_ID]);
  });

  it('aborts a superseded request, and only the newer answer lands', async () => {
    const signals: AbortSignal[] = [];
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        signals.push(request.signal);
        const body = (await request.json()) as ExpandFixtureRequest;
        if (body.nodeIds[0] === ACME_ID) await delay(200);
        return HttpResponse.json({ data: expandFixture(body) });
      }),
    );
    const { result } = renderExplorer();
    let first!: Promise<void>;
    act(() => {
      first = result.current.load([ACME_ID]);
    });
    await act(() => result.current.load([JOE_ID]));
    await act(() => first);

    expect(signals[0].aborted).toBe(true);
    expect(result.current.state.seedIds).toEqual([JOE_ID]);
  });
});

describe('useGraphExplorer — expand', () => {
  it('asks for at most the remaining capacity, from the one node', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const count = result.current.state.graph.order;
    await act(() => result.current.expand(ACME_ID));

    expect(bodies[1]).toEqual({ nodeIds: [ACME_ID], cap: EXPLORER_NODE_CAP - count });
    expect(result.current.state.expanded.has(ACME_ID)).toBe(true);
    expect(result.current.state.graph.order).toBeGreaterThan(count);
  });

  it('carries the allowed types and relation types once something is hidden', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => {
      result.current.setHiddenTypes(['Meeting']);
      result.current.setHiddenRelationTypes(['PART_OF']);
    });
    await act(() => result.current.expand(ACME_ID));

    expect(bodies[1].types).toEqual(NODE_TYPES.filter((t) => t !== 'Meeting'));
    expect(bodies[1].relationTypes).toEqual(RELATION_TYPES.filter((t) => t !== 'PART_OF'));
  });

  it('asks for the budget cap and holds to it when told a smaller `nodeCap` (GIC-08)', async () => {
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        bodies.push((await request.json()) as ExpandFixtureRequest);
        return HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useGraphExplorer({ nodeTypes: NODE_TYPES, relationTypes: RELATION_TYPES, nodeCap: 120 }),
    );
    await act(() => result.current.load([JOE_ID]));
    expect(bodies[0]!.cap).toBe(120);
    // DOI truncation shows the best 30; the budget's cap (not 300) is what the stub expansions run into.
    expect(realNodeCount(result.current.state)).toBe(1 + EXPLORER_NEIGHBOUR_LIMIT);
    expect(result.current.capped).toBe(false);
    const more = stubId(JOE_ID, 'Person');
    for (let i = 0; i < 6 && !result.current.capped; i += 1) {
      await act(() => result.current.expand(more));
    }
    expect(realNodeCount(result.current.state)).toBe(120);
    expect(result.current.capped).toBe(true);

    const sent = bodies.length;
    const kept = result.current.state.graph
      .nodes()
      .find((id) => id !== JOE_ID && !result.current.state.graph.getNodeAttribute(id, 'isStub'))!;
    await act(() => result.current.expand(kept));
    expect(bodies).toHaveLength(sent);
  });

  it('follows a changing `nodeCap` without dropping nodes', async () => {
    const { result, rerender } = renderHookWithProviders(
      (props: { cap: number }) =>
        useGraphExplorer({ nodeTypes: NODE_TYPES, relationTypes: RELATION_TYPES, nodeCap: props.cap }),
      { initialProps: { cap: 300 } },
    );
    await act(() => result.current.load([JOE_ID]));
    const before = result.current.state.graph.order;
    rerender({ cap: 120 });
    expect(result.current.state.cap).toBe(120);
    expect(result.current.state.graph.order).toBe(before);
  });

  it('narrows an expand to one relation type, and adds only that relation\'s neighbours (GIC-11)', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    await act(() => result.current.expand(ACME_ID, { relationTypes: ['PART_OF'] }));

    expect(bodies[1].nodeIds).toEqual([ACME_ID]);
    expect(bodies[1].relationTypes).toEqual(['PART_OF']);
    expect(bodies[1].types).toBeUndefined();
    const graph = result.current.state.graph;
    expect(graph.hasNode(gid(6))).toBe(true); // Project Atlas, PART_OF Acme
    expect(graph.hasNode(gid(12))).toBe(false); // Dana Li WORKS_FOR Acme
  });

  it('narrows an expand to one entity type', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    await act(() => result.current.expand(ACME_ID, { types: ['Person'] }));

    expect(bodies[1].types).toEqual(['Person']);
    expect(bodies[1].relationTypes).toBeUndefined();
    expect(result.current.state.graph.hasNode(gid(12))).toBe(true);
    expect(result.current.state.graph.hasNode(gid(6))).toBe(false);
  });

  it('intersects a narrowed expand with the filters in force, and sends nothing for a type the user hid', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => {
      result.current.setHiddenRelationTypes(['PART_OF']);
      result.current.setHiddenTypes(['Person']);
    });
    const before = bodies.length;
    await act(() => result.current.expand(ACME_ID, { relationTypes: ['PART_OF'] }));
    await act(() => result.current.expand(ACME_ID, { types: ['Person'] }));
    expect(bodies).toHaveLength(before);

    await act(() => result.current.expand(ACME_ID, { relationTypes: ['PART_OF', 'WORKS_FOR'] }));
    expect(bodies.at(-1)!.relationTypes).toEqual(['WORKS_FOR']);
  });

  it('sends NO request at the cap and says so', async () => {
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        bodies.push((await request.json()) as ExpandFixtureRequest);
        return HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) });
      }),
    );
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    // An open shows the best 30 neighbours; the other 370 wait behind one "+N more" stub.
    expect(realNodeCount(result.current.state)).toBe(1 + EXPLORER_NEIGHBOUR_LIMIT);
    expect(result.current.capped).toBe(false);

    // Expand the stub until the cap stops it.
    const more = stubId(JOE_ID, 'Person');
    for (let i = 0; i < 12 && !result.current.capped; i += 1) {
      await act(() => result.current.expand(more));
    }
    expect(realNodeCount(result.current.state)).toBe(EXPLORER_NODE_CAP);
    expect(result.current.capped).toBe(true);

    act(() => result.current.dismissCap());
    expect(result.current.capped).toBe(false);

    const sent = bodies.length;
    const kept = result.current.state.graph.nodes().find((id) => id !== JOE_ID && !result.current.state.graph.getNodeAttribute(id, 'isStub'))!;
    await act(() => result.current.expand(kept));
    expect(bodies).toHaveLength(sent);
    expect(result.current.capped).toBe(true);

    // Hiding a node frees a slot and lifts the refusal.
    act(() => result.current.hide(kept));
    expect(result.current.capped).toBe(false);
  });

  it('keeps the graph on an expand failure and reports it', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    server.use(
      http.post('*/api/graph/explore/expand', () =>
        HttpResponse.json({ message: 'Graph query timed out', statusCode: 503 }, { status: 503 }),
      ),
    );
    await act(() => result.current.expand(ACME_ID));
    expect(result.current.error).toBe('Graph query timed out');
    expect(result.current.notFound).toBe(false);
    expect(result.current.state.graph.hasNode(JOE_ID)).toBe(true);
  });
});

describe('useGraphExplorer — a 200-neighbour hub (#667)', () => {
  beforeEach(() => {
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        const body = (await request.json()) as ExpandFixtureRequest;
        bodies.push(body);
        return HttpResponse.json({ data: hubFixture(body) });
      }),
    );
  });

  const stub = (type: string) => stubId(JOE_ID, type);

  it('opens with at most 30 neighbours and one "+N more" stub per type', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));

    const graph = result.current.state.graph;
    const neighbours = graph.filterNodes((id, a) => id !== JOE_ID && !a.isStub);
    expect(neighbours).toHaveLength(EXPLORER_NEIGHBOUR_LIMIT);
    expect(graph.filterNodes((_id, a) => Boolean(a.isStub)).sort()).toEqual(
      ['Meeting', 'Organization', 'Person'].map(stub).sort(),
    );
    expect(graph.getNodeAttribute(stub('Person'), 'stubCount')).toBeGreaterThan(0);
  });

  it('expanding a stub asks for types=[that type] of its parent, and replaces the stub with nodes', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const shownBefore = result.current.state.graph.filterNodes(
      (_id, a) => a.entityType === 'Organization' && !a.isStub,
    ).length;
    const remaining = result.current.state.graph.getNodeAttribute(stub('Organization'), 'stubCount') as number;
    expect(shownBefore + remaining).toBe(50);

    await act(() => result.current.expand(stub('Organization')));

    expect(bodies[1]).toMatchObject({ nodeIds: [JOE_ID], types: ['Organization'] });
    const graph = result.current.state.graph;
    const shownAfter = graph.filterNodes((_id, a) => a.entityType === 'Organization' && !a.isStub).length;
    expect(shownAfter).toBe(Math.min(50, shownBefore + EXPLORER_NEIGHBOUR_LIMIT));
    // The other types' stubs are untouched.
    expect(graph.hasNode(stub('Person'))).toBe(true);
    expect(graph.hasNode(stub('Meeting'))).toBe(true);
    // 50 organizations: 30 + 20 more fit under one stub's expansion, so the stub is gone when none remain.
    expect(graph.hasNode(stub('Organization'))).toBe(shownAfter < 50);
  });

  it('expanding a stub repeatedly shows every neighbour of that type, then no stub', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    for (let i = 0; i < 6 && result.current.state.graph.hasNode(stub('Meeting')); i += 1) {
      await act(() => result.current.expand(stub('Meeting')));
    }
    const graph = result.current.state.graph;
    expect(graph.hasNode(stub('Meeting'))).toBe(false);
    expect(graph.filterNodes((_id, a) => a.entityType === 'Meeting' && !a.isStub)).toHaveLength(30);
  });

  it('carries the active filters and the remaining capacity on a stub expansion', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.setHiddenRelationTypes(['PART_OF']));
    const room = EXPLORER_NODE_CAP - realNodeCount(result.current.state);
    await act(() => result.current.expand(stub('Person')));
    const body = bodies[bodies.length - 1];
    expect(body.types).toEqual(['Person']);
    expect(body.relationTypes).toEqual(RELATION_TYPES.filter((t) => t !== 'PART_OF'));
    expect(body.cap).toBe(room);
  });

  it('the stubs do not count toward the node cap', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const state = result.current.state;
    expect(state.graph.order).toBeGreaterThan(realNodeCount(state));
    expect(remainingCapacity(state)).toBe(EXPLORER_NODE_CAP - 1 - EXPLORER_NEIGHBOUR_LIMIT);
  });
});

describe('useGraphExplorer — as_of', () => {
  it('rebuilds from the seeds and every expanded node, at that date', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    await act(() => result.current.expand(ACME_ID));
    // Today: Joe reports to Ana.
    const reportsTo = () =>
      result.current.state.graph
        .filterEdges((_e, attrs) => attrs.relationType === 'REPORTS_TO')
        .map((e) => result.current.state.graph.target(e));
    expect(reportsTo()).toEqual([ANA_ID]);

    await act(() => result.current.setAsOf('2026-06-01'));

    expect(bodies[2]).toEqual({ nodeIds: [JOE_ID, ACME_ID], as_of: '2026-06-01', cap: EXPLORER_NODE_CAP });
    expect(result.current.state.asOf).toBe('2026-06-01');
    // In June, Joe reported to Ben.
    expect(reportsTo()).toEqual([BEN_ID]);
    expect(result.current.state.seedIds).toEqual([JOE_ID]);
  });

  it('caps the rebuild at fifty seed ids', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const many = Array.from({ length: 60 }, (_, i) => gid(7000 + i));
    act(() => {
      for (const id of many) result.current.state.expanded.add(id);
    });
    await act(() => result.current.setAsOf('2026-06-01'));
    expect(bodies[1].nodeIds).toHaveLength(50);
    expect(bodies[1].nodeIds[0]).toBe(JOE_ID);
  });

  it('only records the date before anything is loaded', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.setAsOf('2026-06-01'));
    expect(bodies).toHaveLength(0);
    await act(() => result.current.load([JOE_ID]));
    expect(bodies[0].as_of).toBe('2026-06-01');
  });

  it('keeps positions of the nodes that survive', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const before = result.current.state.graph.getNodeAttributes(ACME_ID);
    await act(() => result.current.setAsOf('2026-06-01'));
    const after = result.current.state.graph.getNodeAttributes(ACME_ID);
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });
});

describe('useGraphExplorer — filters, hide, seeds, hand-off', () => {
  it('prunes already-loaded nodes that no longer qualify, never a seed', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(true);
    act(() => result.current.setHiddenTypes(['Meeting', 'Person']));
    expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(false);
    expect(result.current.state.graph.hasNode(ANA_ID)).toBe(false);
    expect(result.current.state.graph.hasNode(JOE_ID)).toBe(true);

    // Hiding is local: no request. Re-enabling refetches what the filter removed (#667).
    expect(bodies).toHaveLength(1);
    const before = result.current.state.graph.getNodeAttributes(JOE_ID);
    await act(async () => result.current.setHiddenTypes([]));
    await waitFor(() => expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(true));
    expect(result.current.state.graph.hasNode(ANA_ID)).toBe(true);
    expect(bodies).toHaveLength(2);
    // The seeds and expanded nodes are asked again, with no type filter now that nothing is hidden.
    expect(bodies[1]).toEqual({ nodeIds: [JOE_ID], cap: expect.any(Number) });
    // Nothing that stayed moved.
    const after = result.current.state.graph.getNodeAttributes(JOE_ID);
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });

  it('re-enabling a relation type refetches too; hiding more does not', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.setHiddenRelationTypes(['ATTENDED']));
    expect(bodies).toHaveLength(1);
    expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(false);

    await act(async () => result.current.setHiddenRelationTypes([]));
    await waitFor(() => expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(true));
    expect(bodies).toHaveLength(2);
  });

  it('hides nodes and promotes seeds', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.hide(JOE_ID));
    expect(result.current.state.graph.hasNode(JOE_ID)).toBe(true);
    act(() => result.current.makeSeed(ACME_ID));
    expect(result.current.state.seedIds).toEqual([JOE_ID, ACME_ID]);
    act(() => result.current.hide(ANA_ID));
    expect(result.current.state.graph.hasNode(ANA_ID)).toBe(false);
  });

  it('renders the hand-off nodes before the expand answers, then merges it', async () => {
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        const body = (await request.json()) as ExpandFixtureRequest;
        bodies.push(body);
        await delay(100);
        return HttpResponse.json({ data: expandFixture(body) });
      }),
    );
    const { result } = renderExplorer();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadHandoff({
        seedIds: [JOE_ID, BEN_ID],
        title: 'Cluster 3',
        nodes: [
          { id: JOE_ID, label: 'Joe Rivera', type: 'Person', x: 40, y: 40, degree: 6 },
          { id: BEN_ID, label: 'Ben Okafor', type: 'Person', x: -40, y: 10, degree: 2 },
        ],
      });
    });
    expect(result.current.state.graph.order).toBe(2);
    expect(result.current.state.graph.getNodeAttributes(JOE_ID)).toMatchObject({ x: 40, y: 40 });
    expect(result.current.isLoading).toBe(true);

    await act(() => pending);
    expect(bodies).toEqual([{ nodeIds: [JOE_ID, BEN_ID], cap: EXPLORER_NODE_CAP }]);
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(true);
    expect(result.current.state.graph.getNodeAttributes(JOE_ID)).toMatchObject({ x: 40, y: 40 });
  });

  it('resets to an empty graph, keeping the filters', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.setHiddenTypes(['Meeting']));
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.state.graph.order).toBe(0));
    expect(result.current.state.hiddenTypes).toEqual(new Set(['Meeting']));
  });
});
