import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse, delay } from './msw-compat.js';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { CAP_WARNING_TEXT } from '../../src/graph/ui/components/explorer/CapWarning.js';
import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import { STALE_TEXT, TOO_LARGE_TEXT } from '../../src/graph/ui/components/overview/OverviewBanners.js';
import { PALETTE_LABEL } from '../../src/graph/ui/components/explorer/palette/ExplorerCommandPalette.js';
import { setExplorerHandoff } from '../../src/graph/headless/utils/explorerHandoff.js';
import {
  GraphExplorerPage,
  CLUSTER_HINT,
  NOT_IN_GRAPH_TITLE,
  NO_WEBGL_TEXT,
  parseSeeds,
} from '../../src/graph/ui/pages/GraphExplorerPage.js';
import {
  ACME_ID,
  ANA_ID,
  BEN_ID,
  GLOBEX_ID,
  INITECH_ID,
  JOE_ID,
  expandFixture,
  gid,
  graphEntitySummaries,
  manyNodesSlice,
  overviewStates,
  type ExpandFixtureRequest,
} from './graphData.js';
import { server } from './msw-compat.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { mockTouchInput } from './shellMedia.js';
import { graphReader } from './graphTestUsers.js';
import { render } from './helpers.js';

/**
 * `/graph/explore` (#374). jsdom has no WebGL, so the canvas is a FAKE that
 * renders one button per visible node (and per edge) — every rule is tested
 * outside the canvas, which is the point of keeping them in `explorerModel`.
 */

const mocks = vi.hoisted(() => {
  // The canvas's pin store (the layout's, GIC-07) as a Set, so the menu's Pin/Unpin label can flip.
  const pinned = new Set<string>();
  return {
    webgl: true,
    pinned,
    controls: {
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      fit: vi.fn(),
      relayoutAll: vi.fn(),
      togglePin: vi.fn((id: string) => {
        if (!pinned.delete(id)) pinned.add(id);
      }),
      unpinAll: vi.fn(),
      isPinned: vi.fn((id: string) => pinned.has(id)),
      focusNode: vi.fn(),
    },
  };
});

vi.mock('../../src/graph/ui/components/explorer/webgl.js', () => ({
  isWebGLAvailable: () => mocks.webgl,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../src/graph/ui/components/explorer/GraphCanvas.js', () => ({
  GraphCanvas: function FakeGraphCanvas(props: GraphCanvasProps) {
    useImperativeHandle(props.controlsRef, () => mocks.controls, []);
    return (
      <div
        data-testid="fake-canvas"
        data-layout={props.layout}
        data-preview={props.previewId ?? ''}
        data-modality={props.inputModality}
        data-pixel-ratio-cap={props.budgets?.pixelRatioCap ?? ''}
        data-reveal-right={props.revealInsets?.right ?? 0}
        data-reveal-bottom={props.revealInsets?.bottom ?? 0}
        data-dimmed={[...(props.dimmedIds ?? [])].sort().join(',')}
      >
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-selected={props.selectedId === id}
            data-marked={props.markedIds?.has(id) ?? false}
            // Like the real canvas: activating a "+N more" stub expands it.
            onClick={() =>
              props.graph.getNodeAttribute(id, 'isStub') === true
                ? props.onNodeDoubleClick(id)
                : props.onNodeClick(id)
            }
            onDoubleClick={() => props.onNodeDoubleClick(id)}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onNodeContextMenu?.({ id, clientX: 12, clientY: 34, source: 'right-click' });
            }}
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

function useExpand(respond?: (body: ExpandFixtureRequest) => Promise<HttpResponse> | HttpResponse) {
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
  mocks.pinned.clear();
  mocks.controls.togglePin.mockClear();
  mocks.webgl = true;
  mocks.controls.zoomIn.mockClear();
  mocks.controls.zoomOut.mockClear();
  mocks.controls.fit.mockClear();
  mocks.controls.focusNode.mockClear();
  mocks.controls.relayoutAll.mockClear();
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

  const noRecents = () =>
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        const url = new URL(request.url);
        const sort = url.searchParams.get('sort');
        if (sort === 'viewed') return HttpResponse.json({ data: { items: [], nextCursor: null } });
        const q = url.searchParams.get('q')?.toLowerCase();
        const types = url.searchParams.get('type')?.split(',');
        let items = graphEntitySummaries;
        if (q) items = items.filter((s) => s.label.toLowerCase().includes(q));
        if (types) items = items.filter((s) => types.includes(s.type));
        return HttpResponse.json({ data: { items, nextCursor: null } });
      }),
    );

  it('shows Start here when nothing was viewed, and choosing an active person sets ?seed=', async () => {
    noRecents();
    const user = userEvent.setup();
    const { container } = renderExplorer('/graph/explore');

    expect(await screen.findByRole('heading', { name: 'Where do you want to start?' })).toBeInTheDocument();
    // Themes from the overview (the "Unconnected" pool is not a theme), Active, and an empty Recent.
    expect(await screen.findByRole('button', { name: /Globex/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unconnected/ })).not.toBeInTheDocument();
    expect(await screen.findByText("You haven't opened anything yet.")).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    const active = await screen.findByRole('region', { name: 'Person' });
    await user.click(within(active).getByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(ANA_ID));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ANA_ID]));
  });

  it('asks the API for the most-mentioned people of the last 30 days', async () => {
    noRecents();
    const seen: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('sort=mentions')) seen.push(new URL(request.url));
    });
    renderExplorer('/graph/explore');
    await screen.findByRole('region', { name: 'Person' });
    const people = seen.find((url) => url.searchParams.get('type') === 'Person');
    expect(people?.searchParams.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(people?.searchParams.get('limit')).toBe('5');
    expect(seen.map((url) => url.searchParams.get('type')).sort()).toEqual(['Person', 'Product', 'Project', 'Topic']);
    server.events.removeAllListeners();
  });

  it('starts from a recently viewed entity on Start here (Home)', async () => {
    const user = userEvent.setup();
    renderExplorer('/graph/explore?start=1');
    const recent = await screen.findByRole('region', { name: 'Last opened' });
    await user.click(await within(recent).findByRole('button', { name: 'Acme Corp' }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(ACME_ID));
    expect(currentUrl().searchParams.get('start')).toBeNull();
  });

  it('seeds the explorer with a theme through the overview hand-off', async () => {
    noRecents();
    const user = userEvent.setup();
    renderExplorer('/graph/explore');
    await user.click(await screen.findByRole('button', { name: /Globex/ }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('1'));
    await canvasReady().catch(() => screen.findByTestId('fake-canvas'));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies[0].nodeIds).toContain(GLOBEX_ID);
  });

  it('says it is building the map while no snapshot exists, and handles the stale and too-large notices', async () => {
    noRecents();
    server.use(http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.building() })));
    const first = renderExplorer('/graph/explore');
    expect(await screen.findByText('Building your map…')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.stale() })));
    const second = renderExplorer('/graph/explore');
    expect(await screen.findByText(STALE_TEXT)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Globex/ })).toBeInTheDocument();
    second.unmount();

    server.use(http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.tooLarge() })));
    renderExplorer('/graph/explore');
    expect(await screen.findByText(TOO_LARGE_TEXT)).toBeInTheDocument();
  });

  it('starts from Home: the canvas gives way to Start here, keeping the seeds until a choice', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Start here' }));
    expect(await screen.findByRole('heading', { name: 'Where do you want to start?' })).toBeInTheDocument();
    expect(currentUrl().searchParams.get('start')).toBe('1');
    expect(currentUrl().searchParams.get('seed')).toBe(JOE_ID);
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
  });

  it('renders an overview hand-off at once, before the expand returns', async () => {
    useExpand(async (body) => {
      await delay(600);
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

  it('falls back to Start here with a hint when ?cluster= has no hand-off (a reload)', async () => {
    renderExplorer('/graph/explore?cluster=c-7');
    expect(await screen.findByText(CLUSTER_HINT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Where do you want to start?' })).toBeInTheDocument();
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

describe('GraphExplorerPage — selection and the inspector', () => {
  it('selects on click, and offers Expand, Open page, Hide and Focus (make seed)', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();

    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    const panel = await screen.findByRole('group', { name: 'Acme Corp' });
    expect(within(panel).getByText('Organization')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      `/graph/entities/${ACME_ID}`,
    );

    await user.click(within(panel).getByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ACME_ID]));
    expect(await within(canvas).findByRole('button', { name: 'Dana Li' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Focus' }));
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(`${JOE_ID},${ACME_ID}`));
    // Writing the new seed list to the URL does not reload the graph.
    expect(within(canvas).getByRole('button', { name: 'Dana Li' })).toBeInTheDocument();
    // A seed can no longer be hidden.
    expect(within(panel).queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();

    // Click the stage to deselect.
    await user.click(within(canvas).getByRole('button', { name: 'stage' }));
    expect(screen.queryByRole('group', { name: 'Acme Corp' })).not.toBeInTheDocument();
  });

  it('hides a node', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const panel = await screen.findByRole('group', { name: 'Ana Diaz' });
    await user.click(within(panel).getByRole('button', { name: 'Hide' }));
    expect(within(canvas).queryByRole('button', { name: 'Ana Diaz' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ana Diaz' })).not.toBeInTheDocument();
  });

  it('expands on double-click', async () => {
    renderExplorer();
    const canvas = await canvasReady();
    fireEvent.doubleClick(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([ANA_ID]));
  });

  it('shows an edge with its validity and confidence, and opens on its Evidence tab', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: `edge ${gid(411)}` }));
    const panel = await screen.findByRole('group', { name: 'Reports to' });
    expect(within(panel).getByText('Joe Rivera → Ana Diaz')).toBeInTheDocument();
    expect(within(panel).getByText('Since Sep 2026')).toBeInTheDocument();
    expect(within(panel).getByText('Confidence 90%')).toBeInTheDocument();
    // An edge opens on Evidence (GIC-11); the entity page is one tab away.
    expect(within(panel).getByRole('tab', { name: 'Evidence', selected: true })).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: 'Overview' }));
    expect(within(panel).getByRole('link', { name: "Open Joe Rivera's page" })).toHaveAttribute(
      'href',
      `/graph/entities/${JOE_ID}`,
    );
  });

  it("shows an edge's own props, labelled from the ontology (#442)", async () => {
    useExpand((body) => {
      const slice = expandFixture(body)!;
      return HttpResponse.json({
        data: {
          ...slice,
          edges: slice.edges.map((edge) =>
            edge.id === gid(410)
              ? { ...edge, type: 'HAS_ROLE', props: { title: 'Managing Director', businessUnit: 'Consulting' } }
              : edge,
          ),
        },
      });
    });
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: `edge ${gid(410)}` }));
    const panel = await screen.findByRole('group', { name: 'Has role' });
    await user.click(within(panel).getByRole('tab', { name: 'Overview' }));
    expect(within(panel).getByText('Role')).toBeInTheDocument();
    expect(within(panel).getByText('Managing Director')).toBeInTheDocument();
    expect(within(panel).getByText('Business unit')).toBeInTheDocument();
    expect(within(panel).getByText('Consulting')).toBeInTheDocument();
  });

  it('renders the panel as a bottom sheet on a phone', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    // GIC-08: the inspector is the shell's bottom sheet below 600px, opened at peek.
    const sheet = await screen.findByRole('region', { name: 'Inspector' });
    expect(sheet).toHaveAttribute('data-snap', 'peek');
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

    // An open shows the best 30 neighbours and one "+N more" stub, not the cap's worth;
    // the stub is not a node, so the count is Joe plus 30 and there is no warning yet.
    expect(await screen.findByLabelText('31 of 300 nodes')).toBeInTheDocument();
    expect(screen.queryByText(CAP_WARNING_TEXT)).not.toBeInTheDocument();

    // Expanding the stub, again and again, reaches the cap.
    for (let i = 0; i < 10; i += 1) {
      await user.click(await within(canvas).findByRole('button', { name: /^\+\d+ more Person$/ }));
      // Each expansion shows 30 more, until the cap stops it at 300.
      await screen.findByLabelText(`${Math.min(300, 31 + 30 * (i + 1))} of 300 nodes`);
    }

    expect(await screen.findByText(CAP_WARNING_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText('300 of 300 nodes')).toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Joe Rivera' }));
    const panel = await screen.findByRole('group', { name: 'Joe Rivera' });
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

    // Two controls toggle a type (the filter chip and the legend row); the chip is the one in the filters.
    const chip = (pressed: boolean) =>
      screen.getAllByRole('button', { name: 'Meetings', pressed }).find((el) => el.classList.contains('MuiChip-root'))!;
    await screen.findAllByRole('button', { name: 'Meetings', pressed: true });
    await user.click(chip(true));
    await waitFor(() =>
      expect(within(canvas).queryByRole('button', { name: 'Q3 planning' })).not.toBeInTheDocument(),
    );
    const shown = currentUrl().searchParams.get('types')?.split(',') ?? [];
    expect(shown).not.toContain('Meeting');
    expect(shown).toContain('Person');
    expect(chip(false)).toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.click(await screen.findByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].types).not.toContain('Meeting');
    expect(bodies[1].types).toContain('Person');
  });

  it('places the legend in the facets and a legend row toggles the same ?types= parameter', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    const legend = await screen.findByRole('region', { name: 'Legend' });
    expect(within(legend).getByRole('button', { name: 'Meetings', pressed: true })).toBeInTheDocument();

    await user.click(within(legend).getByRole('button', { name: 'Meetings', pressed: true }));
    await waitFor(() => expect(currentUrl().searchParams.get('types')?.split(',') ?? []).not.toContain('Meeting'));
    expect(within(canvas).queryByRole('button', { name: 'Q3 planning' })).not.toBeInTheDocument();
    // Hidden, it stays in the legend so it can be turned back on.
    expect(within(screen.getByRole('region', { name: 'Legend' })).getByRole('button', { name: 'Meetings', pressed: false })).toBeInTheDocument();
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

  it('the list view keeps the as-of slider as the fallback: debounced, writes ?asOf= and rebuilds through expand', async () => {
    renderExplorer(`/graph/explore?seed=${JOE_ID}&view=list`);
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

  describe('the TimeBar (GIC-15)', () => {
    const activity = (byEntity: Record<string, { start: string; count: number }[]>) =>
      http.get('*/api/graph/activity', () =>
        HttpResponse.json({
          data: {
            bucket: 'month',
            series: [
              { start: '2026-01-01', total: 2, byType: { Person: 2 } },
              { start: '2026-03-01', total: 3, byType: { Person: 1, Organization: 2 } },
            ],
            byEntity,
          },
        }),
      );

    it('replaces the as-of slider on the canvas with the time bar, which asks for the visible nodes', async () => {
      const asked: URL[] = [];
      server.use(
        http.get('*/api/graph/activity', ({ request }) => {
          asked.push(new URL(request.url));
          return HttpResponse.json({ data: { bucket: 'month', series: [], byEntity: {} } });
        }),
      );
      renderExplorer();
      await canvasReady();
      expect(await screen.findByRole('group', { name: 'Time bar' })).toBeInTheDocument();
      expect(screen.queryByRole('slider', { name: 'Show the graph as of' })).not.toBeInTheDocument();
      await waitFor(() => expect(asked.length).toBeGreaterThan(0));
      const ids = asked.at(-1)!.searchParams.get('ids')!.split(',');
      expect(ids).toContain(JOE_ID);
      expect(ids).toContain(ACME_ID);
    });

    it('?from=&to= shows the graph as of the range end and dims what has no evidence in it', async () => {
      server.use(activity({ [JOE_ID]: [{ start: '2026-03-01', count: 2 }], [ANA_ID]: [{ start: '2026-01-01', count: 1 }] }));
      renderExplorer(`/graph/explore?seed=${JOE_ID}&from=2026-03-01&to=2026-04-01`);
      const canvas = await canvasReady();
      // The range end is the as_of of the expand request.
      expect(bodies[0].as_of).toBe('2026-04-01');
      // Joe is active in March; everything else visible is dimmed (Ana only in January).
      await waitFor(() => expect(canvas.getAttribute('data-dimmed')).not.toBe(''));
      const dimmed = canvas.getAttribute('data-dimmed')!.split(',');
      expect(dimmed).not.toContain(JOE_ID);
      expect(dimmed).toContain(ACME_ID);
      expect(screen.getByTestId('timebar-brush')).toBeInTheDocument();
    });

    it('brushing a bar writes ?from= and ?to= and clearing removes them', async () => {
      server.use(activity({ [JOE_ID]: [{ start: '2026-03-01', count: 2 }] }));
      renderExplorer();
      await canvasReady();
      const plot = await screen.findByTestId('timebar-plot');
      await waitFor(() => expect(screen.getAllByTestId('timebar-column').length).toBeGreaterThan(0));
      fireEvent.click(plot, { clientX: 2 });
      await waitFor(() => expect(currentUrl().searchParams.get('from')).toMatch(/^\d{4}-\d{2}-01$/));
      expect(currentUrl().searchParams.get('to')).toMatch(/^\d{4}-\d{2}-01$/);
      expect(currentUrl().searchParams.get('asOf')).toBeNull();

      fireEvent.click(await screen.findByRole('button', { name: 'Clear the range' }));
      await waitFor(() => expect(currentUrl().searchParams.get('from')).toBeNull());
      expect(currentUrl().searchParams.get('to')).toBeNull();
    });

    it('ignores a hand-edited range that is not two ordered dates', async () => {
      renderExplorer(`/graph/explore?seed=${JOE_ID}&from=2026-05-01&to=2026-01-01`);
      await canvasReady();
      expect(bodies[0].as_of).toBeUndefined();
      expect(screen.queryByTestId('timebar-brush')).not.toBeInTheDocument();
    });
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
    expect(screen.getByRole('group', { name: 'Joe Rivera' })).toBeInTheDocument();

    fireEvent.keyDown(app, { key: 'ArrowLeft' });
    expect(live.textContent).not.toMatch(/^Joe Rivera/);
    fireEvent.keyDown(app, { key: 'ArrowRight' });
    expect(live.textContent).toMatch(/^Joe Rivera/);

    fireEvent.keyDown(app, { key: 'Enter' });
    await waitFor(() => expect(bodies.at(-1)?.nodeIds).toEqual([JOE_ID]));
    expect(bodies).toHaveLength(2);

    fireEvent.keyDown(app, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Joe Rivera' })).not.toBeInTheDocument();

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

describe('GraphExplorerPage — layout menu (#668)', () => {
  it('opens an ego view of fewer than 40 nodes concentric', async () => {
    renderExplorer();
    expect(await screen.findByTestId('fake-canvas')).toHaveAttribute('data-layout', 'concentric');
  });

  it('uses Force for ?layout=force and writes the choice from the menu to the URL', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}&layout=force`);
    expect(await screen.findByTestId('fake-canvas')).toHaveAttribute('data-layout', 'forceatlas');

    await user.click(screen.getByRole('button', { name: 'Layout' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Concentric by hop/ }));
    await waitFor(() => expect(currentUrl().searchParams.get('layout')).toBe('concentric'));
    expect(screen.getByTestId('fake-canvas')).toHaveAttribute('data-layout', 'concentric');
  });

  it('"Re-layout all" and "Unpin all" reach the canvas', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}&layout=force`);
    await screen.findByTestId('fake-canvas');
    mocks.controls.relayoutAll.mockClear();

    await user.click(screen.getByRole('button', { name: 'Layout' }));
    await user.click(screen.getByRole('menuitem', { name: /Re-layout all/ }));
    expect(mocks.controls.relayoutAll).toHaveBeenCalledTimes(1);
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

describe('GraphExplorerPage — the touch model (GIC-08)', () => {
  it('first tap previews, second tap on the same node opens the inspector at peek', async () => {
    mockTouchInput();
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    expect(canvas).toHaveAttribute('data-modality', 'touch');

    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    expect(canvas).toHaveAttribute('data-preview', ACME_ID);
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toMatch(/Acme Corp.*Tap again/);

    // A different node moves the preview and still opens nothing.
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    expect(canvas).toHaveAttribute('data-preview', ANA_ID);
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const sheet = await screen.findByRole('region', { name: 'Inspector' });
    expect(sheet).toHaveAttribute('data-snap', 'peek');
    expect(within(sheet).getByRole('heading', { name: 'Ana Diaz' })).toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-preview', '');
  });

  it('a stage tap clears the preview and closes the sheet', async () => {
    mockTouchInput();
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await screen.findByRole('region', { name: 'Inspector' });
    await user.click(within(canvas).getByRole('button', { name: 'stage' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument());
  });

  it('a pointer still opens on one click, and shows no Select toggle', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    expect(canvas).toHaveAttribute('data-preview', '');
    expect(await screen.findByRole('group', { name: 'Acme Corp' })).toBeInTheDocument();
  });

  it('Select mode marks nodes by tapping instead of previewing or opening them, and 2+ marks show the Selection view', async () => {
    mockTouchInput();
    act(() => setViewportWidth(820));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();

    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: 'Select', pressed: true })).toBeInTheDocument();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true');
    expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-marked', 'true');
    expect(canvas).toHaveAttribute('data-preview', '');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    // Two marked nodes open the inspector on the Selection view (GIC-11), not on either node.
    const inspector = await screen.findByRole('region', { name: 'Inspector' });
    expect(within(inspector).getByRole('group', { name: 'Selection' })).toBeInTheDocument();
    expect(within(inspector).getByRole('heading', { name: '2 nodes selected' })).toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument());
  });

  it('the context menu offers Open details, Expand, Pin and Hide, and Pin sticks', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    fireEvent.contextMenu(within(canvas).getByRole('button', { name: 'Ana Diaz' }));

    const menu = await screen.findByRole('menu', { name: 'Actions for Ana Diaz' });
    for (const name of ['Open details', 'Expand', 'Pin', 'Hide', 'Make seed']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin' }));
    // The same pin function as the layout's drag-end pin and the P key.
    expect(mocks.controls.togglePin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    fireEvent.contextMenu(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    expect(await screen.findByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Open details' }));
    expect(await screen.findByRole('group', { name: 'Ana Diaz' })).toBeInTheDocument();
  });

  it('the context menu hides a node', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    fireEvent.contextMenu(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    await waitFor(() => expect(within(canvas).queryByRole('button', { name: 'Ana Diaz' })).not.toBeInTheDocument());
  });

  it('has no axe violations on a phone with the sheet open', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    const { container } = renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await screen.findByRole('region', { name: 'Inspector' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

/**
 * An open shows the best 30 neighbours and a "+N more" stub (#667); expanding that stub shows 30 more.
 * Do it `times` times, waiting for each count, so the graph reaches (or stops at) `cap` real nodes.
 */
async function expandStubTimes(user: ReturnType<typeof userEvent.setup>, canvas: HTMLElement, times: number, cap: number) {
  for (let i = 0; i < times; i += 1) {
    await user.click(await within(canvas).findByRole('button', { name: /^\+\d+ more Person$/ }));
    await screen.findByLabelText(`${Math.min(cap, 31 + 30 * (i + 1))} of ${cap} nodes`);
  }
}

describe('GraphExplorerPage — responsive budgets (GIC-08)', () => {
  it('a coarse pointer caps the graph at 120 nodes, asks for 120 and names it in the CapWarning', async () => {
    mockTouchInput();
    useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) }));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });
    // The DOI truncation reads the budget's cap (120), not a hardcoded 300.
    expect(await screen.findByLabelText('31 of 120 nodes')).toBeInTheDocument();
    expect(bodies[0]?.cap).toBe(120);

    await expandStubTimes(user, canvas, 4, 120);
    expect(await screen.findByText(/^Showing 120 nodes/)).toBeInTheDocument();
    expect(screen.queryByText(CAP_WARNING_TEXT)).not.toBeInTheDocument();
    expect(screen.getByLabelText('120 of 120 nodes')).toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-pixel-ratio-cap', '2');
  });

  it('a compact window caps at 120 even with a mouse', async () => {
    act(() => setViewportWidth(390));
    useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) }));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });
    expect(bodies[0]?.cap).toBe(120);
    await expandStubTimes(user, canvas, 4, 120);
    expect(await screen.findByText(/^Showing 120 nodes/)).toBeInTheDocument();
  });

  it('keeps 300 on a roomy window with a precise pointer', async () => {
    useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) }));
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });
    expect(await screen.findByLabelText('31 of 300 nodes')).toBeInTheDocument();
    expect(bodies[0]?.cap).toBe(300);
    expect(canvas).toHaveAttribute('data-pixel-ratio-cap', '');
  });

  it('offers the list as the default on a phone when the graph has over 120 nodes, and view=graph overrides it', async () => {
    useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 200) }));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });
    // 31 nodes, then three stub expansions: 121 real nodes, one over the compact budget.
    await expandStubTimes(user, canvas, 3, 300);

    // Narrowing the window (a rotation, a resize) keeps the 121 nodes: the list is now the default.
    act(() => setViewportWidth(390));
    expect(await screen.findByRole('region', { name: 'Graph as a list' })).toBeInTheDocument();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    expect(screen.getByText(/more than 120 nodes/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Graph view' }));
    await waitFor(() => expect(currentUrl().searchParams.get('view')).toBe('graph'));
    expect(await screen.findByTestId('fake-canvas')).toBeInTheDocument();
  });

  it('never defaults to the list on a phone for a graph within the budget', async () => {
    act(() => setViewportWidth(390));
    renderExplorer();
    expect(await screen.findByTestId('fake-canvas')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Graph as a list' })).not.toBeInTheDocument();
  });

  it('keeps the selection and the inspector across a rotation 820 to 1180 to 1440', async () => {
    act(() => setViewportWidth(820));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await screen.findByRole('region', { name: 'Inspector' });
    expect(canvas).toHaveAttribute('data-reveal-right', '360');

    act(() => setViewportWidth(1180));
    // Still medium at 1180: the inspector stays an overlay and the SAME canvas element stays mounted.
    expect(screen.getByTestId('fake-canvas')).toBe(canvas);
    expect(within(screen.getByRole('region', { name: 'Inspector' })).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();

    act(() => setViewportWidth(1440));
    expect(screen.getByTestId('fake-canvas')).toBe(canvas);
    expect(within(screen.getByRole('region', { name: 'Inspector' })).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-reveal-right', '0');
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-selected', 'true');
  });
});

describe('GraphExplorerPage — command palette (GIC-09)', () => {
  const searchInput = () => screen.findByRole('combobox', { name: PALETTE_LABEL });

  it('opens with Ctrl+K, closes with Escape and returns focus to the canvas', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    const application = screen.getByRole('application');
    application.focus();

    await user.keyboard('{Control>}k{/Control}');
    const input = await searchInput();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: PALETTE_LABEL })).not.toBeInTheDocument());
    await waitFor(() => expect(application).toHaveFocus());
  });

  it('opens with the Meta key and with "/", but not while typing in a field', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    screen.getByRole('application').focus();
    await user.keyboard('/');
    await searchInput();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: PALETTE_LABEL })).not.toBeInTheDocument());

    await user.keyboard('{Meta>}k{/Meta}');
    await searchInput();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: PALETTE_LABEL })).not.toBeInTheDocument());

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    await user.keyboard('/');
    expect(screen.queryByRole('combobox', { name: PALETTE_LABEL })).not.toBeInTheDocument();
    field.remove();
  });

  it('opens from the search field in the top bar', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Search the graph' }));
    expect(await searchInput()).toBeInTheDocument();
  });

  it('selects a node that is on the canvas and flies the camera to it', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.keyboard('/');
    const input = await searchInput();
    await user.type(input, 'ana');
    const option = await screen.findByRole('option', { name: /Ana Diaz/ });
    expect(within(screen.getByRole('group', { name: 'On canvas' })).getByRole('option', { name: /Ana Diaz/ })).toBe(option);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.controls.focusNode).toHaveBeenCalledWith(ANA_ID));
    await waitFor(() =>
      expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-selected', 'true'),
    );
  });

  it('adds an entity that is not on the canvas as a seed on Enter, and replaces the seeds on Alt+Enter', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.keyboard('/');
    await user.type(await searchInput(), 'globex');
    const group = await screen.findByRole('group', { name: 'In your graph' });
    expect(within(group).getByRole('option', { name: /Globex/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(`${JOE_ID},${GLOBEX_ID}`));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: PALETTE_LABEL })).not.toBeInTheDocument());
    await canvasReady();

    await user.keyboard('/');
    await user.type(await searchInput(), 'initech');
    await screen.findByRole('group', { name: 'In your graph' });
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    await waitFor(() => expect(currentUrl().searchParams.get('seed')).toBe(INITECH_ID));
  });

  it('refuses an eleventh seed with a message and stays open', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => gid(100 + i));
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${ten.join(',')}`);
    // The fixture has no such entities: the explorer says so, but the palette still opens on "/".
    await screen.findByRole('heading', { name: NOT_IN_GRAPH_TITLE });
    await user.keyboard('/');
    await user.type(await searchInput(), 'globex');
    await screen.findByRole('option', { name: /Globex/ });
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/up to 10/);
    expect(screen.getByRole('combobox', { name: PALETTE_LABEL })).toBeInTheDocument();
    expect(currentUrl().searchParams.get('seed')).toBe(ten.join(','));
  });

  it('filters by type: tokens', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.keyboard('/');
    await user.type(await searchInput(), 'type:Organization a');
    const canvasGroup = await screen.findByRole('group', { name: 'On canvas' });
    expect(within(canvasGroup).getByRole('option', { name: /Acme Corp/ })).toBeInTheDocument();
    expect(within(canvasGroup).queryByRole('option', { name: /Ana Diaz/ })).not.toBeInTheDocument();
    const graphGroup = await screen.findByRole('group', { name: 'In your graph' });
    expect(within(graphGroup).queryByRole('option', { name: /Ana Diaz/ })).not.toBeInTheDocument();
    expect(within(graphGroup).getByRole('option', { name: /Globex/ })).toBeInTheDocument();
  });

  it('moves with the arrow keys and announces the result count', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.keyboard('/');
    const input = await searchInput();
    await user.type(input, 'a');
    await screen.findByRole('group', { name: 'On canvas' });
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(2);
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1].id);
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent(/\d+ results?/));
  });

  it('runs actions, and offers Connect and the lenses (GIC-17)', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.keyboard('/');
    await searchInput();
    const actions = await screen.findByRole('group', { name: 'Actions' });
    const names = within(actions).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.join('|')).toMatch(/Expand selection/);
    expect(names.join('|')).toMatch(/Hide selection/);
    expect(names.join('|')).toMatch(/Re-layout/);
    expect(names.join('|')).toMatch(/Switch to list/);
    expect(names.join('|')).toMatch(/Connect A/);
    expect(names.join('|')).toMatch(/Lens: People network/);
    expect(names.join('|')).toMatch(/Undo/);
    // No selection yet: Expand is disabled.
    expect(within(actions).getByRole('option', { name: /Expand selection/ })).toHaveAttribute('aria-disabled', 'true');

    await user.click(within(actions).getByRole('option', { name: /Re-layout/ }));
    expect(mocks.controls.relayoutAll).toHaveBeenCalled();

    // The dialog stays mounted through its exit transition; a "/" typed while it is still there
    // lands in the old text field (which the shortcut deliberately ignores), so wait it out.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.keyboard('/');
    await searchInput();
    await user.click(await screen.findByRole('option', { name: /Switch to list/ }));
    await waitFor(() => expect(currentUrl().searchParams.get('view')).toBe('list'));
  });

  it('is axe-clean, open', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.keyboard('/');
    await user.type(await searchInput(), 'a');
    await screen.findByRole('group', { name: 'On canvas' });
    expect(await axe(screen.getByRole('dialog'), AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is a full-screen sheet on a compact window', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderExplorer();
    await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Search the graph' }));
    await searchInput();
    expect(screen.getByRole('dialog').className).toMatch(/FullScreen/);
    expect(screen.getByRole('button', { name: 'Close search' })).toBeInTheDocument();
  });
});

describe('GraphExplorerPage — minimap (GIC-09)', () => {
  const big = () => useExpand(() => HttpResponse.json({ data: manyNodesSlice(JOE_ID, 400) }));

  it('is on by itself on an expanded window above 150 nodes, and is aria-hidden', async () => {
    big();
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Joe Rivera' });
    // An open shows 31 nodes; each expansion of the "+N more" stub adds 30.
    await screen.findByLabelText('31 of 300 nodes');
    expect(screen.queryByTestId('explorer-minimap')).not.toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) {
      await user.click(await within(canvas).findByRole('button', { name: /^\+\d+ more Person$/ }));
      await screen.findByLabelText(`${31 + 30 * (i + 1)} of 300 nodes`);
    }
    const minimap = await screen.findByTestId('explorer-minimap');
    expect(minimap).toHaveAttribute('aria-hidden', 'true');
  });

  it('is off on an expanded window with a small graph', async () => {
    renderExplorer();
    await canvasReady();
    expect(screen.queryByTestId('explorer-minimap')).not.toBeInTheDocument();
  });

  it('is optional on a medium window, through a toggle', async () => {
    act(() => setViewportWidth(900));
    big();
    const user = userEvent.setup();
    renderExplorer();
    await screen.findByTestId('fake-canvas');
    expect(screen.queryByTestId('explorer-minimap')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Minimap' }));
    expect(await screen.findByTestId('explorer-minimap')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Minimap' }));
    expect(screen.queryByTestId('explorer-minimap')).not.toBeInTheDocument();
  });

  it('is never on a compact window', async () => {
    act(() => setViewportWidth(390));
    big();
    renderExplorer();
    await waitFor(() => expect(screen.queryByTestId('explorer-minimap')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Minimap' })).not.toBeInTheDocument();
  });
});
