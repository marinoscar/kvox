import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { EXPLORER_NODE_CAP } from '../../components/graph/explorer/explorerModel';
import { useGraphExplorer } from '../../hooks/useGraphExplorer';
import {
  ACME_ID,
  ANA_ID,
  BEN_ID,
  JOE_ID,
  Q3_MEETING_ID,
  expandFixture,
  gid,
  manyNodesSlice,
  type ExpandFixtureRequest,
} from '../mocks/graphData';
import { server } from '../mocks/server';
import { renderHookWithProviders } from '../utils/hook-utils';

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

  it('sends NO request at the cap and says so', async () => {
    server.use(
      http.post('*/api/graph/explore/expand', async ({ request }) => {
        bodies.push((await request.json()) as ExpandFixtureRequest);
        return HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) });
      }),
    );
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    expect(result.current.state.graph.order).toBe(EXPLORER_NODE_CAP);
    expect(result.current.capped).toBe(true);

    act(() => result.current.dismissCap());
    expect(result.current.capped).toBe(false);

    const kept = result.current.state.graph.nodes().find((id) => id !== JOE_ID)!;
    await act(() => result.current.expand(kept));
    expect(bodies).toHaveLength(1);
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

    // Re-enabling does not refetch retroactively.
    act(() => result.current.setHiddenTypes([]));
    expect(bodies).toHaveLength(1);
    expect(result.current.state.graph.hasNode(Q3_MEETING_ID)).toBe(false);
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
