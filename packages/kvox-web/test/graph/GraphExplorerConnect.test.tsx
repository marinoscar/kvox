import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import type { GraphConnectResponse } from '../../src/graph/headless/clients/graph.js';
import { GraphExplorerPage } from '../../src/graph/ui/pages/GraphExplorerPage.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { ACME_ID, ANA_ID, JOE_ID, expandFixture, gid, type ExpandFixtureRequest } from './graphData.js';
import { HttpResponse, http, server } from './msw-compat.js';
import { mockTouchInput } from './shellMedia.js';
import { graphReader } from './graphTestUsers.js';
import { render } from './helpers.js';

/**
 * Multi-select, lasso and "What connects these" in the explorer (GIC-14, #675). The canvas is a fake that
 * draws one button per visible node: a click reports Shift when the button is clicked with it held, and
 * a "lasso all" button reports a lasso over every visible node. The geometry itself is `lassoGeometry.test.ts`.
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
      <div data-testid="fake-canvas" data-select-tool={String(props.selectTool === true)}>
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-selected={props.selectedId === id}
            data-marked={props.markedIds?.has(id) ?? false}
            onClick={(event) => props.onNodeClick(id, { shiftKey: event.shiftKey })}
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
          </button>
        ))}
        <button type="button" onClick={() => props.onLasso?.([...props.visibleIds].filter((id) => id !== JOE_ID))}>
          lasso all but Joe
        </button>
        <button type="button" onClick={props.onStageClick}>
          stage
        </button>
      </div>
    );
  },
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const N1 = gid(951);
const N2 = gid(952);

let connectBodies: unknown[];
let expandBodies: ExpandFixtureRequest[];

function connectAnswer(over: Partial<GraphConnectResponse> = {}): GraphConnectResponse {
  const slice = expandFixture({ nodeIds: [JOE_ID], cap: 300 })!;
  return {
    inputs: [
      { kind: 'entity', id: ANA_ID, title: 'Ana Diaz', entityIds: [ANA_ID, ACME_ID] },
      { kind: 'entity', id: JOE_ID, title: 'Joe Rivera', entityIds: [JOE_ID, ACME_ID] },
    ],
    shared: [{ entityId: ACME_ID, inputIds: [ANA_ID, JOE_ID], mentionCount: 3 }],
    paths: [{ fromInput: ANA_ID, toInput: JOE_ID, nodeIds: [ANA_ID, ACME_ID, JOE_ID], edgeIds: ['e1', 'e2'], score: 0.8 }],
    slice,
    truncated: false,
    ...over,
  };
}

function useConnect(respond: (body: unknown) => HttpResponse | Promise<HttpResponse>) {
  server.use(
    http.post('*/api/graph/connect', async ({ request }) => {
      const body = await request.json();
      connectBodies.push(body);
      return respond(body);
    }),
  );
}

beforeEach(() => {
  connectBodies = [];
  expandBodies = [];
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      expandBodies.push(body);
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }),
  );
  useConnect(() => HttpResponse.json({ data: connectAnswer() }));
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const currentUrl = () => new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');

function renderExplorer(route = `/graph/explore?seed=${JOE_ID}`) {
  return render(
    <>
      <Routes>
        <Route path="/graph/explore" element={<GraphExplorerPage />} />
        <Route path="/notes" element={<h1>Notes</h1>} />
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

describe('multi-select', () => {
  it('Shift-click toggles membership, and two marks open the Selection view', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();

    await user.keyboard('{Shift>}');
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true');
    // A plain click on a node would have opened it; a shift-click only marks.
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-selected', 'false');
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.keyboard('{/Shift}');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Selection' })).toBeInTheDocument();

    // Shift-click again removes it.
    await user.keyboard('{Shift>}');
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.keyboard('{/Shift}');
    expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-marked', 'false');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('a lasso adds the nodes inside it to the marked ones', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'lasso all but Joe' }));
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true');
    expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-marked', 'true');
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toHaveAttribute('data-marked', 'false');
  });

  it('offers the Select tool to a pointer; on, a drag on the stage lassos', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    expect(canvas).toHaveAttribute('data-select-tool', 'false');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(canvas).toHaveAttribute('data-select-tool', 'true');
  });

  it('on touch, Select mode taps build the selection and the lasso tool stays off', async () => {
    mockTouchInput();
    act(() => setViewportWidth(820));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(canvas).toHaveAttribute('data-select-tool', 'false');
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('keyboard: in Select mode Space marks the focused node, without a pointer', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const surface = screen.getByRole('application');
    surface.focus();
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    const focused = within(canvas).getAllByRole('button', { pressed: undefined }).find(
      (button) => button.getAttribute('data-selected') === 'true',
    );
    expect(focused).toBeDefined();
    fireEvent.keyDown(surface, { key: ' ' });
    expect(focused).toHaveAttribute('data-marked', 'true');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.keyDown(surface, { key: ' ' });
    expect(focused).toHaveAttribute('data-marked', 'false');
  });

  it('Space does nothing outside Select mode', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    const surface = screen.getByRole('application');
    surface.focus();
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    fireEvent.keyDown(surface, { key: ' ' });
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(user).toBeDefined();
  });
});

describe('Find connections', () => {
  async function markTwo(user: ReturnType<typeof userEvent.setup>) {
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    return canvas;
  }

  it('asks the API with the marked entities and shows the sentence, the shared list and the bridges', async () => {
    const user = userEvent.setup();
    const { container } = renderExplorer();
    const canvas = await markTwo(user);

    const inspector = await screen.findByRole('region', { name: 'Inspector' });
    await user.click(within(inspector).getByRole('button', { name: 'Find connections' }));

    const results = await within(inspector).findByRole('region', { name: 'What connects these' });
    expect(connectBodies).toHaveLength(1);
    expect((connectBodies[0] as { entityIds: string[] }).entityIds.sort()).toEqual([ANA_ID, JOE_ID].sort());
    expect(within(results).getByRole('heading', { name: '1 organization in common' })).toBeInTheDocument();
    const shared = within(results).getByRole('region', { name: 'Shared by these' });
    expect(within(shared).getByRole('button', { name: /Acme Corp, .*in 2 of 2/ })).toBeInTheDocument();
    const bridges = within(results).getByRole('region', { name: 'Bridges between them' });
    expect(within(bridges).getByText('Ana Diaz and Joe Rivera')).toBeInTheDocument();
    // The shared entity is ringed on the canvas.
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no Selection view, so no Find connections, with a single mark', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    // One mark shows no Selection view at all: nothing to ask about.
    expect(screen.queryByRole('button', { name: 'Find connections' })).not.toBeInTheDocument();
  });

  it('says what went wrong and can try again', async () => {
    let calls = 0;
    useConnect(() => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json({ message: 'boom', statusCode: 500 }, { status: 500 })
        : HttpResponse.json({ data: connectAnswer({ shared: [], paths: [] }) });
    });
    const user = userEvent.setup();
    renderExplorer();
    await markTwo(user);
    const inspector = await screen.findByRole('region', { name: 'Inspector' });
    await user.click(within(inspector).getByRole('button', { name: 'Find connections' }));
    expect(await within(inspector).findByRole('alert')).toBeInTheDocument();
    await user.click(within(inspector).getByRole('button', { name: 'Retry' }));
    expect(await within(inspector).findByRole('heading', { name: 'Nothing in common yet' })).toBeInTheDocument();
    expect(within(inspector).getByText(/no entity in common/)).toBeInTheDocument();
  });

  it('closing the results clears the rings', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await markTwo(user);
    const inspector = await screen.findByRole('region', { name: 'Inspector' });
    await user.click(within(inspector).getByRole('button', { name: 'Find connections' }));
    await within(inspector).findByRole('region', { name: 'What connects these' });
    await user.click(within(inspector).getByRole('button', { name: 'Close connections' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'What connects these' })).not.toBeInTheDocument(),
    );
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'false');
  });
});

describe('?connectNotes=', () => {
  const NOTES = `${N1},${N2}`;

  it('asks about the notes, seeds the canvas from the answer and rings what they share', async () => {
    renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    const canvas = await canvasReady();

    expect(connectBodies[0]).toEqual({ noteIds: [N1, N2] });
    // Shared first, then each input's strongest.
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe([ACME_ID, ANA_ID, JOE_ID].join(',')));
    expect(currentUrl().searchParams.get('connectNotes')).toBe(NOTES);
    expect(expandBodies[0].nodeIds).toEqual([ACME_ID, ANA_ID, JOE_ID]);
    expect(await screen.findByRole('region', { name: 'What connects these' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true'),
    );
  });

  it('keeps the seeds the URL already names (a reload), and still rings the shared entities', async () => {
    renderExplorer(`/graph/explore?connectNotes=${NOTES}&seed=${JOE_ID}`);
    await canvasReady();
    await screen.findByRole('region', { name: 'What connects these' });
    expect(currentUrl().searchParams.get('seed')).toBe(JOE_ID);
    expect(expandBodies[0].nodeIds).toEqual([JOE_ID]);
  });

  it('does not fall back to the recently viewed entities', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => seen.push(request.url));
    renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    await canvasReady();
    expect(seen.some((url) => url.includes('sort=viewed'))).toBe(false);
    server.events.removeAllListeners();
  });

  it('a single note asks about "what this note touches"', async () => {
    useConnect(() =>
      HttpResponse.json({
        data: connectAnswer({
          inputs: [{ kind: 'note', id: N1, title: 'Alone', entityIds: [JOE_ID, ANA_ID] }],
          shared: [],
          paths: [],
        }),
      }),
    );
    renderExplorer(`/graph/explore?connectNotes=${N1}`);
    await canvasReady();
    expect(connectBodies[0]).toEqual({ noteIds: [N1] });
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe([JOE_ID, ANA_ID].join(',')));
  });

  it('says so when the notes touch nothing in the graph', async () => {
    useConnect(() =>
      HttpResponse.json({
        data: connectAnswer({ inputs: [{ kind: 'note', id: N1, title: 'Empty', entityIds: [] }], shared: [], paths: [] }),
      }),
    );
    renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    expect(await screen.findByRole('heading', { name: 'Nothing from these notes is in your graph yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to notes' })).toBeInTheDocument();
  });

  it('a note that is not yours is an error with the same wording, not a canvas', async () => {
    useConnect(() => HttpResponse.json({ message: 'not found', statusCode: 404 }, { status: 404 }));
    renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    expect(await screen.findByRole('heading', { name: "Couldn't connect these notes" })).toBeInTheDocument();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
  });

  it('closing the results leaves ?connectNotes', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    await canvasReady();
    const results = await screen.findByRole('region', { name: 'What connects these' });
    await user.click(within(results).getByRole('button', { name: 'Close connections' }));
    await waitFor(() => expect(currentUrl().searchParams.has('connectNotes')).toBe(false));
  });

  it('has no axe violations on a phone with the results in the sheet', async () => {
    act(() => setViewportWidth(390));
    const { container } = renderExplorer(`/graph/explore?connectNotes=${NOTES}`);
    await canvasReady();
    await screen.findByRole('region', { name: 'What connects these' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
