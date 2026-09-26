import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { CAP_WARNING_TEXT } from '../../components/graph/explorer/CapWarning';
import type { GraphCanvasProps } from '../../components/graph/explorer/GraphCanvas';
import { SEED_SEARCH_LABEL } from '../../components/graph/explorer/SeedSearch';
import { setExplorerHandoff } from '../../components/graph/explorer/explorerHandoff';
import GraphExplorerPage, {
  CLUSTER_HINT,
  NOT_IN_GRAPH_TITLE,
  NO_WEBGL_TEXT,
  parseSeeds,
} from '../../pages/GraphExplorerPage';
import {
  ACME_ID,
  ANA_ID,
  BEN_ID,
  JOE_ID,
  expandFixture,
  gid,
  graphEntitySummaries,
  manyNodesSlice,
  type ExpandFixtureRequest,
} from '../mocks/graphData';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { graphReader } from '../utils/graphTestUsers';
import { render } from '../utils/test-utils';

/**
 * `/graph/explore` (#374). jsdom has no WebGL, so the canvas is a FAKE that
 * renders one button per visible node (and per edge) — every rule is tested
 * outside the canvas, which is the point of keeping them in `explorerModel`.
 */

const mocks = vi.hoisted(() => ({
  webgl: true,
  controls: { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn() },
}));

vi.mock('../../components/graph/explorer/webgl', () => ({
  isWebGLAvailable: () => mocks.webgl,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../components/graph/explorer/GraphCanvas', () => ({
  default: function FakeGraphCanvas(props: GraphCanvasProps) {
    useImperativeHandle(props.controlsRef, () => mocks.controls, []);
    return (
      <div data-testid="fake-canvas" data-layout={props.layout}>
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-selected={props.selectedId === id}
            onClick={() => props.onNodeClick(id)}
            onDoubleClick={() => props.onNodeDoubleClick(id)}
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
          </button>
        ))}
        {props.graph.edges().map((id) => (
          <button key={id} type="button" onClick={() => props.onEdgeClick?.(id)}>
            {`edge ${id}`}
          </button>
        ))}
        <button type="button" onClick={props.onStageClick}>
          stage
        </button>
      </div>
    );
  },
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let bodies: ExpandFixtureRequest[];

function useExpand(respond?: (body: ExpandFixtureRequest) => Promise<Response> | Response) {
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      bodies.push(body);
      if (respond) return respond(body);
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }),
  );
}

beforeEach(() => {
  mocks.webgl = true;
  mocks.controls.zoomIn.mockClear();
  mocks.controls.zoomOut.mockClear();
  mocks.controls.fit.mockClear();
  bodies = [];
  useExpand();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');
}

function renderExplorer(route = `/graph/explore?seed=${JOE_ID}`) {
  return render(
    <>
      <Routes>
        <Route path="/graph/explore" element={<GraphExplorerPage />} />
        <Route path="/graph/entities/:id" element={<h1>Entity page</h1>} />
        <Route path="/graph" element={<h1>Knowledge index</h1>} />
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

describe('parseSeeds', () => {
  it('keeps at most ten distinct uuids and drops anything else', () => {
    const many = Array.from({ length: 12 }, (_, i) => gid(i + 1));
    expect(parseSeeds([...many, 'nope', gid(1)].join(','))).toEqual(many.slice(0, 10));
    expect(parseSeeds(null)).toEqual([]);
  });
});

describe('GraphExplorerPage — seeding', () => {
  it('seeds from ?seed= and shows the slice with a node count', async () => {
    renderExplorer();
    const canvas = await canvasReady();
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toBeInTheDocument();
    expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toBeInTheDocument();
    expect(bodies[0]).toEqual({ nodeIds: [JOE_ID], cap: 300 });
    const count = expandFixture({ nodeIds: [JOE_ID], cap: 300 })!.nodes.length;
    expect(screen.getByLabelText(`${count} of 300 nodes`)).toHaveTextContent(`${count} / 300`);
    expect(
      screen.getByRole('application', { name: `Graph explorer, ${count} nodes. Press L for list view.` }),
    ).toBeInTheDocument();
  });

  it('seeds a bare visit from the recently viewed entities', async () => {
    const seen: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/graph/entities?')) seen.push(new URL(request.url));
    });
    renderExplorer('/graph/explore');
    await canvasReady();

    expect(seen[0].searchParams.get('sort')).toBe('viewed');
    expect(seen[0].searchParams.get('limit')).toBe('5');
    const recent = graphEntitySummaries.slice(0, 5).map((s) => s.id);
    expect(currentUrl().searchParams.get('seed')).toBe(recent.join(','));
    expect(bodies[0].nodeIds).toEqual(recent);
    server.events.removeAllListeners();
  });

  it('offers a seed search when nothing was viewed, and choosing sets ?seed=', async () => {
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('sort') === 'viewed') {
          return HttpResponse.json({ data: { items: [], nextCursor: null } });
        }
        const q = url.searchParams.get('q')?.toLowerCase();
        const items = q
          ? graphEntitySummaries.filter((s) => s.label.toLowerCase().includes(q))
          : graphEntitySummaries;
        return HttpResponse.json({ data: { items, nextCursor: null } });
      }),
    );
    const user = userEvent.setup();
    const { container } = renderExplorer('/graph/explore');

    const input = await screen.findByRole('combobox', { name: SEED_SEARCH_LABEL });
    // "Recently updated": the first six.
    expect(await screen.findByRole('button', { name: 'Joe Rivera' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.type(input, 'Ana');
    await user.click(await screen.findByRole('option', { name: /Ana Diaz/ }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(ANA_ID));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ANA_ID]));
  });

  it('starts from a recently updated chip', async () => {
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        const viewed = new URL(request.url).searchParams.get('sort') === 'viewed';
        return HttpResponse.json({ data: { items: viewed ? [] : graphEntitySummaries, nextCursor: null } });
      }),
    );
    const user = userEvent.setup();
    renderExplorer('/graph/explore');
    await user.click(await screen.findByRole('button', { name: 'Acme Corp' }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(ACME_ID));
  });

  it('renders an overview hand-off at once, before the expand returns', async () => {
    useExpand(async (body) => {
      await delay(150);
      return HttpResponse.json({ data: expandFixture(body) });
    });
    setExplorerHandoff({
      seedIds: [JOE_ID, BEN_ID],
      title: 'Engineering cluster',
      nodes: [
        { id: JOE_ID, label: 'Joe Rivera', type: 'Person', x: 10, y: 10, degree: 6 },
        { id: BEN_ID, label: 'Ben Okafor', type: 'Person', x: -10, y: 5, degree: 2 },
      ],
    });
    renderExplorer('/graph/explore?cluster=c-7');

    const canvas = await screen.findByTestId('fake-canvas');
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toBeInTheDocument();
    expect(within(canvas).queryByRole('button', { name: 'Acme Corp' })).not.toBeInTheDocument();
    expect(screen.getByText('Engineering cluster')).toBeInTheDocument();

    await within(canvas).findByRole('button', { name: 'Acme Corp' });
    expect(bodies).toEqual([{ nodeIds: [JOE_ID, BEN_ID], cap: 300 }]);
  });

  it('falls back to the seed search with a hint when ?cluster= has no hand-off (a reload)', async () => {
    renderExplorer('/graph/explore?cluster=c-7');
    expect(await screen.findByText(CLUSTER_HINT)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: SEED_SEARCH_LABEL })).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('says so when the seed is not in the graph', async () => {
    renderExplorer(`/graph/explore?seed=${gid(424242)}`);
    expect(await screen.findByRole('heading', { name: NOT_IN_GRAPH_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Knowledge' })).toHaveAttribute('href', '/graph');
  });

  it('shows an error with Retry for any other failure', async () => {
    let fail = true;
    useExpand((body) =>
      fail
        ? HttpResponse.json({ message: 'Graph query timed out', statusCode: 503 }, { status: 503 })
        : HttpResponse.json({ data: expandFixture(body) }),
    );
    const user = userEvent.setup();
    renderExplorer();
    expect(await screen.findByText('Graph query timed out')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await canvasReady();
  });
});

describe('GraphExplorerPage — selection and the side panel', () => {
  it('selects on click, and offers Expand, Open page, Hide and Make seed', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();

    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    const panel = await screen.findByRole('complementary', { name: 'Acme Corp' });
    expect(within(panel).getByText('Organization')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      `/graph/entities/${ACME_ID}`,
    );

    await user.click(within(panel).getByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ACME_ID]));
    expect(await within(canvas).findByRole('button', { name: 'Dana Li' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Make seed' }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(`${JOE_ID},${ACME_ID}`));
    // Writing the new seed list to the URL does not reload the graph.
    expect(within(canvas).getByRole('button', { name: 'Dana Li' })).toBeInTheDocument();
    // A seed can no longer be hidden.
    expect(within(panel).queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();

    // Click the stage to deselect.
    await user.click(within(canvas).getByRole('button', { name: 'stage' }));
    expect(screen.queryByRole('complementary', { name: 'Acme Corp' })).not.toBeInTheDocument();
  });

  it('hides a node', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const panel = await screen.findByRole('complementary', { name: 'Ana Diaz' });
    await user.click(within(panel).getByRole('button', { name: 'Hide' }));
    expect(within(canvas).queryByRole('button', { name: 'Ana Diaz' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Ana Diaz' })).not.toBeInTheDocument();
  });

  it('expands on double-click', async () => {
    renderExplorer();
    const canvas = await canvasReady();
    fireEvent.doubleClick(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ANA_ID]));
  });

  it('shows an edge with its validity and confidence', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: `edge ${gid(411)}` }));
    const panel = await screen.findByRole('complementary', { name: 'Reports to' });
    expect(within(panel).getByText('Joe Rivera → Ana Diaz')).toBeInTheDocument();
    expect(within(panel).getByText('Since Sep 2026')).toBeInTheDocument();
    expect(within(panel).getByText('Confidence 90%')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Evidence on Joe Rivera's page/ })).toHaveAttribute(
      'href',
      `/graph/entities/${JOE_ID}`,
    );
  });

  it('renders the panel as a bottom sheet on a phone', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    const sheet = await screen.findByRole('presentation');
    expect(within(sheet).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    act(() => setViewportWidth(1024));
  });
});

describe('GraphExplorerPage — the 300-node cap', () => {
  it('warns, names the cap, and disables Expand', async () => {
    useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) }));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });

    expect(await screen.findByText(CAP_WARNING_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('300 of 300 nodes')).toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    const panel = await screen.findByRole('complementary', { name: 'Joe Rivera' });
    expect(within(panel).getByRole('button', { name: 'Expand again' })).toBeDisabled();

    // Dismissible.
    const warning = screen.getByText(CAP_WARNING_TEXT).closest('[role="status"]') as HTMLElement;
    await user.click(within(warning).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(CAP_WARNING_TEXT)).not.toBeInTheDocument();
  });
});

describe('GraphExplorerPage — filters and time', () => {
  it('a type chip writes ?types=, prunes loaded nodes and narrows later requests', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    expect(within(canvas).getByRole('button', { name: 'Q3 planning' })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Meetings', pressed: true }));
    await waitFor(() =>
      expect(within(canvas).queryByRole('button', { name: 'Q3 planning' })).not.toBeInTheDocument(),
    );
    const shown = currentUrl().searchParams.get('types')?.split(',') ?? [];
    expect(shown).not.toContain('Meeting');
    expect(shown).toContain('Person');
    expect(screen.getByRole('button', { name: 'Meetings', pressed: false })).toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.click(await screen.findByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].types).not.toContain('Meeting');
    expect(bodies[1].types).toContain('Person');
  });

  it('sends ?types= with the very first request', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&types=Person,Organization`);
    const canvas = await canvasReady();
    expect(bodies[0].types).toEqual(['Person', 'Organization']);
    expect(within(canvas).queryByRole('button', { name: 'Q3 planning' })).not.toBeInTheDocument();
  });

  it('a domain chip hides its types and relation types together', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(await screen.findByRole('button', { name: 'Work domain', pressed: true }));
    expect(await screen.findByRole('button', { name: 'Work domain', pressed: false })).toBeInTheDocument();
    const shown = currentUrl().searchParams.get('types')?.split(',') ?? [];
    expect(shown).not.toContain('Project');
    expect(shown).not.toContain('commitment');
    expect(screen.getByRole('button', { name: /Relations \(\d+ hidden\)/ })).toBeInTheDocument();
  });

  it('the relation menu toggles one relation type', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(await screen.findByRole('button', { name: 'Relations' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Reports to' }));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(within(canvas).queryByRole('button', { name: `edge ${gid(411)}` })).not.toBeInTheDocument(),
    );
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(await screen.findByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].relationTypes).not.toContain('REPORTS_TO');
    expect(bodies[1].relationTypes).toContain('WORKS_FOR');
  });

  it('?asOf= refetches the graph as of that date — the manager was Ben, not Ana', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&asOf=2026-06-01`);
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Ben Okafor' });
    expect(within(canvas).queryByRole('button', { name: 'Ana Diaz' })).not.toBeInTheDocument();
    expect(bodies[0].as_of).toBe('2026-06-01');
  });

  it('the slider is debounced, writes ?asOf= and rebuilds through expand', async () => {
    renderExplorer();
    await canvasReady();
    const slider = await screen.findByRole('slider', { name: 'Show the graph as of' });
    // Wait for the seed's firstSeenAt to widen the range past one step.
    await waitFor(() => expect(Number(slider.getAttribute('aria-valuemax'))).toBeGreaterThan(0));

    act(() => {
      slider.focus();
    });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(bodies).toHaveLength(1);

    const now = new Date();
    const back = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const expected = back.toISOString().slice(0, 10);
    await waitFor(() => expect(currentUrl().searchParams.get('asOf')).toBe(expected));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ nodeIds: [JOE_ID], as_of: expected, cap: 300 });

    // "Now" clears it.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Now' }));
    await waitFor(() => expect(currentUrl().searchParams.get('asOf')).toBeNull());
  });

  it('Reset reloads from the seeds and Fit resets the camera', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.click(await screen.findByRole('button', { name: 'Hide' }));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await within(canvas).findByRole('button', { name: 'Ana Diaz' });
    expect(bodies).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(mocks.controls.fit).toHaveBeenCalled();
  });
});

describe('GraphExplorerPage — keyboard and the list view', () => {
  it('drives the canvas from the keyboard', async () => {
    renderExplorer();
    await canvasReady();
    const app = screen.getByRole('application');
    act(() => app.focus());

    fireEvent.keyDown(app, { key: '+' });
    fireEvent.keyDown(app, { key: '-' });
    fireEvent.keyDown(app, { key: '0' });
    expect(mocks.controls.zoomIn).toHaveBeenCalledTimes(1);
    expect(mocks.controls.zoomOut).toHaveBeenCalledTimes(1);
    expect(mocks.controls.fit).toHaveBeenCalledTimes(1);

    // Joe has the most connections, so ArrowRight lands on him first.
    fireEvent.keyDown(app, { key: 'ArrowRight' });
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toMatch(/^Joe Rivera, Person, \d+ connections$/);
    expect(screen.getByRole('complementary', { name: 'Joe Rivera' })).toBeInTheDocument();

    fireEvent.keyDown(app, { key: 'ArrowLeft' });
    expect(live.textContent).not.toMatch(/^Joe Rivera/);
    fireEvent.keyDown(app, { key: 'ArrowRight' });
    expect(live.textContent).toMatch(/^Joe Rivera/);

    fireEvent.keyDown(app, { key: 'Enter' });
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([JOE_ID]));
    expect(bodies).toHaveLength(2);

    fireEvent.keyDown(app, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Joe Rivera' })).not.toBeInTheDocument();

    fireEvent.keyDown(app, { key: 'ArrowRight' });
    fireEvent.keyDown(app, { key: 'o' });
    expect(await screen.findByRole('heading', { name: 'Entity page' })).toBeInTheDocument();
    expect(currentUrl().pathname).toBe(`/graph/entities/${JOE_ID}`);
  });

  it('L switches to the list view, which has every action and no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderExplorer();
    await canvasReady();
    const app = screen.getByRole('application');
    act(() => app.focus());
    fireEvent.keyDown(app, { key: 'L' });

    await waitFor(() => expect(currentUrl().searchParams.get('view')).toBe('list'));
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Graph as a list' });
    const people = within(list).getByRole('list', { name: /People|Person/ });
    expect(within(people).getAllByRole('listitem')[0]).toHaveTextContent('Joe Rivera');
    expect(within(people).getAllByRole('listitem')[0]).toHaveTextContent('Starting point');
    expect(screen.getByRole('button', { name: 'List view', pressed: true })).toBeInTheDocument();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(within(list).getByRole('button', { name: 'Expand Ana Diaz' }));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ANA_ID]));
    await user.click(within(list).getByRole('button', { name: 'Hide Q3 planning' }));
    expect(within(list).queryByText('Q3 planning')).not.toBeInTheDocument();
    expect(within(list).getByRole('link', { name: "Open Acme Corp's page" })).toHaveAttribute(
      'href',
      `/graph/entities/${ACME_ID}`,
    );

    await user.click(screen.getByRole('button', { name: 'List view' }));
    await waitFor(() => expect(currentUrl().searchParams.get('view')).toBeNull());
    expect(await screen.findByTestId('fake-canvas')).toBeInTheDocument();
  });

  it('opens straight into ?view=list', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&view=list`);
    const list = await screen.findByRole('region', { name: 'Graph as a list' });
    expect(await within(list).findByText('Acme Corp')).toBeInTheDocument();
  });

  it('uses the static layout for ?layout=static', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&layout=static`);
    expect(await screen.findByTestId('fake-canvas')).toHaveAttribute('data-layout', 'static');
  });
});

describe('GraphExplorerPage — no WebGL', () => {
  it('forces the list view with an explanation', async () => {
    mocks.webgl = false;
    const { container } = renderExplorer();
    expect(await screen.findByText(NO_WEBGL_TEXT)).toBeInTheDocument();
    const list = await screen.findByRole('region', { name: 'Graph as a list' });
    expect(await within(list).findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List view' })).toBeDisabled();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
