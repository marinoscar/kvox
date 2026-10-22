import { act } from '@testing-library/react';
import { http, HttpResponse } from './msw-compat.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FOCUS_TRAIL_LIMIT,
  EMPTY_TRAIL,
  followFocus,
  pushFocus,
} from '../../src/graph/ui/components/explorer/history/useFocusTrail.js';
import {
  HISTORY_LIMIT,
  emptyHistory,
  pushStep,
  stepBack,
  stepForward,
  takeSnapshot,
} from '../../src/graph/ui/components/explorer/history/snapshot.js';
import { createExplorerState, realNodeCount } from '../../src/graph/ui/components/explorer/explorerModel.js';
import { useGraphExplorer } from '../../src/graph/ui/hooks/useGraphExplorer.js';
import { ACME_ID, ANA_ID, JOE_ID, expandFixture, type ExpandFixtureRequest } from './graphData.js';
import { server } from './msw-compat.js';
import { renderHook as renderHookWithProviders } from './helpers.js';

/**
 * Explorer history (GIC-17, #678): the bounded Undo / Redo stack of `useGraphExplorer`, its pure
 * stack rules, and the focus trail's rules. The page wiring (URL, shortcuts) is in
 * `GraphExplorerHistory.test.tsx`.
 */

const NODE_TYPES = ['Person', 'Organization', 'Meeting', 'Project', 'commitment', 'decision', 'claim'];
const RELATION_TYPES = ['WORKS_FOR', 'REPORTS_TO', 'ATTENDED', 'ASSIGNED_TO', 'DECIDED_IN', 'PART_OF'];

let bodies: ExpandFixtureRequest[];
let failExpand = false;

beforeEach(() => {
  bodies = [];
  failExpand = false;
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      bodies.push(body);
      if (failExpand) return HttpResponse.json({ message: 'boom', statusCode: 500 }, { status: 500 });
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 });
    }),
  );
});

function renderExplorer() {
  return renderHookWithProviders(() => useGraphExplorer({ nodeTypes: NODE_TYPES, relationTypes: RELATION_TYPES }));
}

describe('history stack rules', () => {
  const snapshot = (n: number) => {
    const state = createExplorerState();
    state.asOf = `2026-01-${String(n).padStart(2, '0')}`;
    return takeSnapshot(state);
  };

  it('is bounded: the oldest of more than 50 steps is dropped', () => {
    let history = emptyHistory();
    for (let i = 1; i <= HISTORY_LIMIT + 5; i += 1) history = pushStep(history, snapshot(i % 28 || 1));
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });

  it('a new step clears Redo; stepping back then forward returns to where it started', () => {
    let history = pushStep(emptyHistory(), snapshot(1));
    history = pushStep(history, snapshot(2));
    const back = stepBack(history, snapshot(3))!;
    expect(back.restore.asOf).toBe('2026-01-02');
    expect(back.history.future).toHaveLength(1);
    const forward = stepForward(back.history, snapshot(2))!;
    expect(forward.restore.asOf).toBe('2026-01-03');
    expect(pushStep(back.history, snapshot(4)).future).toEqual([]);
  });

  it('has nothing to step to when empty', () => {
    expect(stepBack(emptyHistory(), snapshot(1))).toBeNull();
    expect(stepForward(emptyHistory(), snapshot(1))).toBeNull();
  });
});

describe('focus trail rules', () => {
  it('appends a new focus and cuts the forward part', () => {
    let trail = pushFocus(pushFocus(pushFocus(EMPTY_TRAIL, 'a'), 'b'), 'c');
    expect(trail).toEqual({ ids: ['a', 'b', 'c'], cursor: 2 });
    trail = followFocus(trail, 'b');
    expect(trail.cursor).toBe(1);
    trail = pushFocus(trail, 'd');
    expect(trail).toEqual({ ids: ['a', 'b', 'd'], cursor: 2 });
  });

  it('follows the browser: a neighbour moves the cursor, a stranger is a new push', () => {
    const trail = { ids: ['a', 'b', 'c'], cursor: 1 };
    expect(followFocus(trail, 'a').cursor).toBe(0);
    expect(followFocus(trail, 'c').cursor).toBe(2);
    expect(followFocus(trail, 'z')).toEqual({ ids: ['a', 'b', 'z'], cursor: 2 });
  });

  it('is bounded', () => {
    let trail = EMPTY_TRAIL;
    for (let i = 0; i < FOCUS_TRAIL_LIMIT + 10; i += 1) trail = pushFocus(trail, `n${i}`);
    expect(trail.ids).toHaveLength(FOCUS_TRAIL_LIMIT);
    expect(trail.cursor).toBe(FOCUS_TRAIL_LIMIT - 1);
  });
});

describe('useGraphExplorer — undo and redo', () => {
  it('has nothing to undo after the first load', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.undo()).toBeNull();
  });

  it('Undo restores the graph after Hide, and Redo hides it again', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const before = realNodeCount(result.current.state);
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(true);

    act(() => result.current.hide(ACME_ID));
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(false);
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(true);
    expect(realNodeCount(result.current.state)).toBe(before);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.redo();
    });
    expect(result.current.state.graph.hasNode(ACME_ID)).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('Undo restores the graph after Expand', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    const before = realNodeCount(result.current.state);
    const edgesBefore = result.current.state.graph.size;

    await act(() => result.current.expand(ACME_ID));
    expect(realNodeCount(result.current.state)).toBeGreaterThan(before);
    expect(result.current.state.expanded.has(ACME_ID)).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(realNodeCount(result.current.state)).toBe(before);
    expect(result.current.state.graph.size).toBe(edgesBefore);
    expect(result.current.state.expanded.has(ACME_ID)).toBe(false);
  });

  it('a failed expand is not a step', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    failExpand = true;
    await act(() => result.current.expand(ACME_ID));
    expect(result.current.error).not.toBeNull();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.undoDepth()).toBe(0);
  });

  it('a new step after Undo clears Redo', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.hide(ACME_ID));
    act(() => {
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.hide(ANA_ID));
    expect(result.current.canRedo).toBe(false);
  });

  it('a filter change is a step, and Undo hands back the filters for the URL', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.setHiddenTypes(['Meeting']));
    act(() => result.current.setHiddenRelationTypes(['ATTENDED']));
    expect(result.current.undoDepth()).toBe(2);

    let view: ReturnType<typeof result.current.undo> = null;
    act(() => {
      view = result.current.undo();
    });
    expect(view).toEqual({ seedIds: [JOE_ID], hiddenTypes: ['Meeting'], hiddenRelationTypes: [], asOf: null });
    expect([...result.current.state.hiddenRelationTypes]).toEqual([]);

    act(() => {
      view = result.current.undo();
    });
    expect(view).toEqual({ seedIds: [JOE_ID], hiddenTypes: [], hiddenRelationTypes: [], asOf: null });
  });

  it('setting the filters the explorer already has is not a step', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    act(() => result.current.setHiddenTypes([]));
    act(() => result.current.setHiddenRelationTypes([]));
    expect(result.current.undoDepth()).toBe(0);
  });

  it('keeps at most 50 steps', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    for (let i = 0; i < HISTORY_LIMIT + 8; i += 1) {
      act(() => result.current.setHiddenRelationTypes(i % 2 === 0 ? ['ATTENDED'] : []));
    }
    // Let the refetches that re-enabling a relation starts settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(result.current.undoDepth()).toBe(HISTORY_LIMIT);
  });

  it('a snapshot taken before a seed change is restored with the old seeds', async () => {
    const { result } = renderExplorer();
    await act(() => result.current.load([JOE_ID]));
    await act(() => result.current.load([ACME_ID]));
    expect(result.current.state.seedIds).toEqual([ACME_ID]);
    let view: ReturnType<typeof result.current.undo> = null;
    act(() => {
      view = result.current.undo();
    });
    expect(view!.seedIds).toEqual([JOE_ID]);
    expect(result.current.state.seedIds).toEqual([JOE_ID]);
    expect(result.current.state.graph.hasNode(JOE_ID)).toBe(true);
  });
});
