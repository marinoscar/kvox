import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import type { GraphEntityAskPanelProps } from '../../src/graph/ui/pages/GraphEntityPage.js';
import { GraphExplorerPage, type GraphExplorerPageSlots } from '../../src/graph/ui/pages/GraphExplorerPage.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import type { GraphSlice } from '../../src/graph/headless/clients/graph.js';
import {
  ACME_ID,
  ANA_ID,
  EV_EDGE_NOTE,
  JOE_ID,
  expandFixture,
  gid,
  type ExpandFixtureRequest,
} from './graphData.js';
import { graphReader } from './graphTestUsers.js';
import { HttpResponse, http, server } from './msw-compat.js';
import { render } from './helpers.js';
import { mockTouchInput } from './shellMedia.js';

/**
 * Lenses, URL state, history and "Ask about this selection" inside `/graph/explore`
 * (GIC-17, #678). jsdom has no WebGL: the canvas is a fake with one button per node and edge.
 */

const mocks = vi.hoisted(() => ({
  controls: {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    relayoutAll: vi.fn(),
    togglePin: vi.fn(),
    unpinAll: vi.fn(),
    isPinned: vi.fn(() => false),
  },
}));

vi.mock('../../src/graph/ui/components/explorer/webgl.js', () => ({
  isWebGLAvailable: () => true,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../src/graph/ui/components/explorer/GraphCanvas.js', () => ({
  GraphCanvas: function FakeGraphCanvas(props: GraphCanvasProps) {
    useImperativeHandle(props.controlsRef, () => mocks.controls, []);
    return (
      <div data-testid="fake-canvas" data-layout={props.layout} data-pins-key={props.pinsKey ?? ''}>
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-selected={props.selectedId === id}
            onClick={() =>
              props.graph.getNodeAttribute(id, 'isStub') === true ? props.onNodeDoubleClick(id) : props.onNodeClick(id)
            }
            onContextMenu={(event) => {
              event.preventDefault();
              props.onNodeContextMenu?.({ id, clientX: 12, clientY: 34, source: 'right-click' });
            }}
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
          </button>
        ))}
        {props.graph.edges().map((id) => (
          <button
            key={id}
            type="button"
            data-stance={String(props.graph.getEdgeAttribute(id, 'stance') ?? '')}
            onClick={() => props.onEdgeClick?.(id)}
          >
            {`edge ${props.graph.getEdgeAttribute(id, 'relationType')} ${id}`}
          </button>
        ))}
      </div>
    );
  },
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const REPORTS_TO_EDGE_NAME = `edge REPORTS_TO ${gid(411)}`;

let bodies: ExpandFixtureRequest[];
let askProps: GraphEntityAskPanelProps[];
let settingsPatches: Array<Record<string, unknown>>;
let storedLenses: unknown[];

function AskStub(props: GraphEntityAskPanelProps) {
  askProps.push(props);
  return props.open ? <div data-testid="ask-stub">{props.entityLabel}</div> : null;
}
const SLOTS: GraphExplorerPageSlots = { AskPanel: AskStub };

function useExpand(respond?: (body: ExpandFixtureRequest) => GraphSlice | null) {
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      bodies.push(body);
      const slice = respond ? respond(body) : expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Not found', statusCode: 404 }, { status: 404 });
    }),
  );
}

beforeEach(() => {
  bodies = [];
  askProps = [];
  settingsPatches = [];
  storedLenses = [];
  useExpand();
  server.use(
    http.get('*/api/user-settings', () =>
      HttpResponse.json({
        data: { theme: 'system', version: 1, ...(storedLenses.length ? { graph: { explorer: { lenses: storedLenses } } } : {}) },
      }),
    ),
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as { graph: { explorer: { lenses: unknown[] } } };
      settingsPatches.push(body);
      storedLenses = body.graph.explorer.lenses;
      return HttpResponse.json({ data: { theme: 'system', version: 2, graph: { explorer: { lenses: storedLenses } } } });
    }),
  );
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');
}

function renderExplorer(route = `/graph/explore?seed=${JOE_ID}`, slots?: GraphExplorerPageSlots) {
  return render(
    <>
      <Routes>
        <Route path="/graph/explore" element={<GraphExplorerPage slots={slots} />} />
        <Route path="/graph/entities/:id" element={<h1>Entity page</h1>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user: graphReader } },
  );
}

async function canvasReady() {
  const canvas = await screen.findByTestId('fake-canvas');
  await within(canvas).findByRole('button', { name: 'Acme Corp' });
  return canvas;
}

const ctrlZ = (shift = false) => fireEvent.keyDown(document.body, { key: shift ? 'Z' : 'z', ctrlKey: true, shiftKey: shift });

/** A slice with a stance edge and a plain one, honouring `relationTypes` the way the API does. */
function stanceSlice(body: ExpandFixtureRequest): GraphSlice {
  const copilot = gid(700);
  const nodes = [
    { id: JOE_ID, nodeKind: 'entity' as const, type: 'Person', label: 'Joe Rivera', status: null, occurredAt: null, depth: 0, degree: 2 },
    { id: copilot, nodeKind: 'entity' as const, type: 'Project', label: 'Copilot rollout', status: null, occurredAt: null, depth: 1, degree: 1 },
    { id: ACME_ID, nodeKind: 'entity' as const, type: 'Organization', label: 'Acme Corp', status: null, occurredAt: null, depth: 1, degree: 1 },
  ];
  const edges = [
    {
      id: gid(710),
      type: 'INVOLVED_IN',
      source: JOE_ID,
      target: copilot,
      valid: null,
      confidence: 0.9,
      virtual: false,
      props: { role: 'sponsor', stance: 'supportive' },
    },
    { id: gid(711), type: 'WORKS_FOR', source: JOE_ID, target: ACME_ID, valid: null, confidence: 0.9, virtual: false },
  ].filter((edge) => !body.relationTypes || body.relationTypes.includes(edge.type));
  const kept = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  return {
    seedIds: [JOE_ID],
    asOf: '2026-09-26T00:00:00.000Z',
    nodes: nodes.filter((node) => node.id === JOE_ID || kept.has(node.id)),
    edges,
    truncated: false,
    cap: 300,
  } as GraphSlice;
}

describe('URL state — relation types (GIC-17)', () => {
  it('a hidden relation type survives a reload: ?relTypes= is sent with the first request', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&relTypes=WORKS_FOR`);
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Acme Corp' });
    expect(bodies[0].relationTypes).toEqual(['WORKS_FOR']);
    expect(within(canvas).queryByRole('button', { name: REPORTS_TO_EDGE_NAME })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Relations \(\d+ hidden\)/ })).toBeInTheDocument();
  });

  it('toggling a relation type writes ?relTypes=, and turning it back on drops the parameter', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    expect(currentUrl().searchParams.has('relTypes')).toBe(false);

    await user.click(await screen.findByRole('button', { name: 'Relations' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Reports to' }));
    await waitFor(() => expect(currentUrl().searchParams.get('relTypes')?.split(',')).not.toContain('REPORTS_TO'));
    expect(currentUrl().searchParams.get('relTypes')?.split(',')).toContain('WORKS_FOR');

    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Reports to' }));
    await waitFor(() => expect(currentUrl().searchParams.has('relTypes')).toBe(false));
  });

  it('writes types and relTypes together when a domain chip is toggled', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(await screen.findByRole('button', { name: 'Work domain', pressed: true }));
    await waitFor(() => expect(currentUrl().searchParams.has('types')).toBe(true));
    expect(currentUrl().searchParams.has('relTypes')).toBe(true);
  });

  it('leaves the keys other stories write alone', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}&from=2026-01-01&to=2026-02-01&pathFrom=a&pathTo=b`);
    await canvasReady();
    await user.click(await screen.findByRole('button', { name: 'Relations' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Reports to' }));
    await waitFor(() => expect(currentUrl().searchParams.has('relTypes')).toBe(true));
    const params = currentUrl().searchParams;
    expect([params.get('from'), params.get('to'), params.get('pathFrom'), params.get('pathTo')]).toEqual([
      '2026-01-01',
      '2026-02-01',
      'a',
      'b',
    ]);
  });
});

describe('lenses (GIC-17)', () => {
  async function openLensMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Lens' }));
    return screen.findByRole('dialog', { name: 'Lenses' });
  }

  it('the built-in "Stakeholders & stance" lens shows only INVOLVED_IN edges, with the stance encoding', async () => {
    useExpand(stanceSlice);
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: /edge WORKS_FOR/ });

    const panel = await openLensMenu(user);
    await user.click(within(panel).getByText('Stakeholders & stance'));

    await within(canvas).findByRole('button', { name: /edge INVOLVED_IN/ });
    await waitFor(() => expect(within(canvas).queryByRole('button', { name: /edge WORKS_FOR/ })).not.toBeInTheDocument());
    expect(within(canvas).getAllByRole('button', { name: /^edge / })).toHaveLength(1);
    expect(within(canvas).getByRole('button', { name: /edge INVOLVED_IN/ })).toHaveAttribute('data-stance', 'supportive');
    expect(currentUrl().searchParams.get('relTypes')).toBe('INVOLVED_IN');
    expect(currentUrl().searchParams.get('lens')).toBe('builtin:stakeholders-stance');
  });

  it('saves the current view as a lens through the settings API and marks it active', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}&relTypes=WORKS_FOR&layout=concentric`);
    await canvasReady();

    const panel = await openLensMenu(user);
    await user.click(await within(panel).findByRole('button', { name: /Save current view as a lens/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a lens' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Joe at Acme');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(settingsPatches).toHaveLength(1));
    const [saved] = (settingsPatches[0] as { graph: { explorer: { lenses: Array<Record<string, unknown>> } } }).graph.explorer.lenses;
    expect(saved).toMatchObject({ name: 'Joe at Acme', seeds: [JOE_ID], relTypes: ['WORKS_FOR'], layout: 'concentric', types: null });
    await waitFor(() => expect(currentUrl().searchParams.get('lens')).toBe(saved.id));
    expect(await screen.findByRole('button', { name: 'Joe at Acme' })).toBeInTheDocument();
  });

  it('applies a saved lens: its seeds, filters and layout go to the URL, its pins to the layout key', async () => {
    storedLenses = [
      {
        id: 'saved-1',
        name: 'Anas view',
        seeds: [ANA_ID],
        types: ['Person'],
        relTypes: null,
        layout: 'force',
        pins: { [ANA_ID]: { x: 1, y: 2 } },
      },
    ];
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();

    const panel = await openLensMenu(user);
    await user.click(await within(panel).findByText('Anas view'));

    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(ANA_ID));
    expect(currentUrl().searchParams.get('types')).toBe('Person');
    expect(currentUrl().searchParams.get('layout')).toBe('force');
    expect(currentUrl().searchParams.get('lens')).toBe('saved-1');
    // The pins ride in the layout's per-view key, never the URL.
    await waitFor(() => expect(screen.getByTestId('fake-canvas')).toHaveAttribute('data-pins-key', `explore:${ANA_ID}::saved-1`));
    expect(currentUrl().search).not.toContain('1,2');
  });

  it('on a phone the overflow menu opens the lens list full-screen', async () => {
    mockTouchInput();
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    expect(screen.queryByRole('button', { name: 'Lens' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Lenses' }));
    const list = await screen.findByRole('dialog', { name: 'Lenses' });
    expect(within(list).getByText('People network')).toBeInTheDocument();
  });
});

describe('history (GIC-17)', () => {
  async function hideNode(name: string) {
    const canvas = await canvasReady();
    fireEvent.contextMenu(within(canvas).getByRole('button', { name }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    await waitFor(() => expect(within(canvas).queryByRole('button', { name })).not.toBeInTheDocument());
    return canvas;
  }

  it('Ctrl+Z undoes a Hide and Shift+Ctrl+Z redoes it', async () => {
    renderExplorer();
    const canvas = await hideNode('Acme Corp');

    ctrlZ();
    await within(canvas).findByRole('button', { name: 'Acme Corp' });

    ctrlZ(true);
    await waitFor(() => expect(within(canvas).queryByRole('button', { name: 'Acme Corp' })).not.toBeInTheDocument());
  });

  it('Undo of a filter change puts the URL back too', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(await screen.findByRole('button', { name: 'Relations' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Reports to' }));
    await waitFor(() => expect(currentUrl().searchParams.has('relTypes')).toBe(true));
    await user.keyboard('{Escape}');

    ctrlZ();
    await waitFor(() => expect(currentUrl().searchParams.has('relTypes')).toBe(false));
    expect(await screen.findByRole('button', { name: 'Relations' })).toBeInTheDocument();
  });

  it('does not steal Ctrl+Z from a text field', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await hideNode('Acme Corp');
    await user.click(await screen.findByRole('button', { name: 'Lens' }));
    await screen.findByRole('dialog', { name: 'Lenses' });
    await user.click(await screen.findByRole('button', { name: /Save current view as a lens/ }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.keyDown(name, { key: 'z', ctrlKey: true });
    expect(within(canvas).queryByRole('button', { name: 'Acme Corp' })).not.toBeInTheDocument();
  });

  it('on a phone, Hide is followed by a snackbar with Undo', async () => {
    mockTouchInput();
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await hideNode('Acme Corp');

    const snackbar = await screen.findByText('Node hidden');
    expect(snackbar).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await within(canvas).findByRole('button', { name: 'Acme Corp' });
  });

  it('focus changes add a history entry; [ and ] walk the focus trail and the breadcrumbs follow', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();

    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    await waitFor(() => expect(currentUrl().searchParams.get('focus')).toBe(JOE_ID));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(currentUrl().searchParams.get('focus')).toBe(ANA_ID));
    expect(currentUrl().searchParams.get('sel')).toBe(`n:${ANA_ID}`);

    const trail = await screen.findByRole('navigation', { name: 'Focus trail' });
    expect(within(trail).getByRole('button', { name: 'Joe Rivera' })).toBeInTheDocument();
    expect(within(trail).getByText('Ana Diaz')).toHaveAttribute('aria-current', 'location');

    fireEvent.keyDown(document.body, { key: '[' });
    await waitFor(() => expect(currentUrl().searchParams.get('focus')).toBe(JOE_ID));
    await waitFor(() => expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toHaveAttribute('data-selected', 'true'));

    fireEvent.keyDown(document.body, { key: ']' });
    await waitFor(() => expect(currentUrl().searchParams.get('focus')).toBe(ANA_ID));
    await waitFor(() => expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-selected', 'true'));
  });

  it('a crumb jumps back to that focus', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const trail = await screen.findByRole('navigation', { name: 'Focus trail' });
    await user.click(within(trail).getByRole('button', { name: 'Joe Rivera' }));
    await waitFor(() => expect(currentUrl().searchParams.get('focus')).toBe(JOE_ID));
  });

  it('a shared ?focus= link selects that node once the graph is there', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&focus=${ANA_ID}`);
    const canvas = await canvasReady();
    await waitFor(() => expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-selected', 'true'));
  });

  it('the back and forward arrows are disabled until there is somewhere to go', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });
});

describe('keyboard shortcuts dialog (GIC-17)', () => {
  it('"?" lists every shortcut, and Escape closes it', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const text of ['Undo the last change', 'Redo', 'Back to the previous focus', 'Forward to the next focus', 'Fit the graph', 'Expand the selected node', 'Switch between graph and list']) {
      expect(within(dialog).getByText(new RegExp(text))).toBeInTheDocument();
    }
    expect(await axe(dialog, AXE_OPTIONS)).toHaveNoViolations();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
  });
});

describe('Ask about this selection (GIC-17)', () => {
  it('the context menu opens the Ask slot scoped to the node', async () => {
    renderExplorer(undefined, SLOTS);
    const canvas = await canvasReady();
    fireEvent.contextMenu(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ask about this/ }));

    expect(await screen.findByTestId('ask-stub')).toHaveTextContent('Joe Rivera');
    const open = askProps.filter((p) => p.open).pop()!;
    expect(open).toMatchObject({ entityId: JOE_ID, entityType: 'Person', scope: { entityIds: [JOE_ID], evidenceIds: [] } });
  });

  it('the Selection view offers it for the marked nodes', async () => {
    mockTouchInput();
    act(() => setViewportWidth(820));
    const user = userEvent.setup();
    renderExplorer(undefined, SLOTS);
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const group = await screen.findByRole('group', { name: 'Selection' });

    await user.click(within(group).getByRole('button', { name: 'Ask about this selection' }));
    await screen.findByTestId('ask-stub');
    const open = askProps.filter((p) => p.open).pop()!;
    expect([...open.scope!.entityIds].sort()).toEqual([ACME_ID, ANA_ID].sort());
    expect(open.entityLabel).toMatch(/and 1 more$/);
  });

  it('an edge sends its ends and the ids of its evidence', async () => {
    const user = userEvent.setup();
    renderExplorer(undefined, SLOTS);
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: REPORTS_TO_EDGE_NAME }));
    await user.click(await screen.findByRole('button', { name: 'Ask about this selection' }));

    await screen.findByTestId('ask-stub');
    const open = askProps.filter((p) => p.open).pop()!;
    expect([...open.scope!.entityIds].sort()).toEqual([ANA_ID, JOE_ID].sort());
    expect(open.scope!.evidenceIds).toContain(EV_EDGE_NOTE);
    expect(open.entityLabel).toContain('→');
  });

  it('is not offered without the host slot', async () => {
    renderExplorer();
    const canvas = await canvasReady();
    fireEvent.contextMenu(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    await screen.findByRole('menuitem', { name: 'Hide' }).catch(() => undefined);
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: /Ask about this/ })).not.toBeInTheDocument();
  });
});
