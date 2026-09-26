import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphCanvasProps } from '../../components/graph/explorer/GraphCanvas';
import { takeExplorerHandoff } from '../../components/graph/explorer/explorerHandoff';
import { CLUSTER_LIST_LABEL } from '../../components/graph/overview/ClusterListView';
import {
  PENDING_TEXT,
  STALE_TEXT,
  TOO_LARGE_TEXT,
  truncatedText,
} from '../../components/graph/overview/OverviewBanners';
import { OVERVIEW_POLL_MS } from '../../hooks/useGraphOverview';
import GraphOverviewPage, {
  BUILDING_TEXT,
  EMPTY_TITLE,
  OVERVIEW_NO_WEBGL_TEXT,
  overviewCaption,
} from '../../pages/GraphOverviewPage';
import type { GraphOverview } from '../../services/graph';
import { ACME_ID, ANA_ID, GLOBEX_ID, JOE_ID, overviewFixture, overviewStates } from '../mocks/graphData';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { graphReader, graphWriter } from '../utils/graphTestUsers';
import type { MockUser } from '../utils/test-utils';
import { render } from '../utils/test-utils';

/**
 * `/graph/overview` (#375). jsdom has no WebGL, so the canvas is a FAKE that
 * renders one button per node, named by the node's UNDIMMED label and marked
 * with its current colour — every rule is tested outside the canvas, which is
 * the point of keeping them in `overviewModel`.
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
      <div data-testid="fake-canvas" data-layout={props.layout} data-selected={props.selectedId ?? ''}>
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-dimmed={props.graph.getNodeAttribute(id, 'label') === ''}
            onClick={() => props.onNodeClick(id)}
            onDoubleClick={() => props.onNodeDoubleClick(id)}
          >
            {String(props.graph.getNodeAttribute(id, 'baseLabel'))}
          </button>
        ))}
        <span data-testid="edge-count">{props.graph.size}</span>
        <button type="button" onClick={props.onStageClick}>
          stage
        </button>
      </div>
    );
  },
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let refreshCalls: number;

function serveOverview(next: GraphOverview | (() => GraphOverview)) {
  server.use(
    http.get('*/api/graph/overview', () =>
      HttpResponse.json({ data: typeof next === 'function' ? next() : next }),
    ),
  );
}

beforeEach(() => {
  mocks.webgl = true;
  mocks.controls.zoomIn.mockClear();
  mocks.controls.zoomOut.mockClear();
  mocks.controls.fit.mockClear();
  refreshCalls = 0;
  takeExplorerHandoff();
  server.use(
    http.post('*/api/graph/overview/refresh', () => {
      refreshCalls += 1;
      return HttpResponse.json({ data: { jobId: 'job-1', deduplicated: false } }, { status: 202 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');
}

function renderOverview(route = '/graph/overview', user: MockUser = graphWriter) {
  return render(
    <>
      <Routes>
        <Route path="/graph/overview" element={<GraphOverviewPage />} />
        <Route path="/graph/explore" element={<h1>Explorer</h1>} />
        <Route path="/graph/entities/:id" element={<h1>Entity page</h1>} />
        <Route path="/graph" element={<h1>Knowledge index</h1>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user } },
  );
}

async function canvasReady() {
  const canvas = await screen.findByTestId('fake-canvas');
  await within(canvas).findByRole('button', { name: /^Acme Corp/ });
  return canvas;
}

describe('overviewCaption', () => {
  it('says when it was built and how big the graph is', () => {
    const caption = overviewCaption(overviewFixture(), new Date('2026-09-23T15:00:00.000Z'));
    expect(caption).toBe('Built 3 days ago · 13 entities · 16 connections');
    expect(overviewCaption(overviewFixture({ computedAt: null, nodeCount: 1, edgeCount: 1 }))).toBe(
      '1 entity · 1 connection',
    );
  });
});

describe('GraphOverviewPage — layers', () => {
  it('draws the clusters layer by default, statically, with the header caption', async () => {
    renderOverview();
    const canvas = await canvasReady();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText(/13 entities · 16 connections/)).toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-layout', 'static');
    expect(within(canvas).getAllByRole('button', { name: /\(\d+\)$/ }).map((b) => b.textContent)).toEqual([
      'Unconnected (1)',
      'Acme Corp (6)',
      'Globex (4)',
      'Cluster 3 (2)',
    ]);
    expect(screen.getByTestId('edge-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Clusters', pressed: true })).toBeInTheDocument();
  });

  it('switches to every entity with the layer toggle, with no edges', async () => {
    const user = userEvent.setup();
    renderOverview();
    await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Everything' }));
    await waitFor(() => expect(currentUrl().searchParams.get('layer')).toBe('nodes'));
    const canvas = screen.getByTestId('fake-canvas');
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toBeInTheDocument();
    expect(within(canvas).getAllByRole('button')).toHaveLength(overviewFixture().nodes.length + 1);
    expect(screen.getByTestId('edge-count')).toHaveTextContent('0');

    await user.click(screen.getByRole('button', { name: 'Clusters' }));
    await waitFor(() => expect(currentUrl().searchParams.get('layer')).toBeNull());
  });

  it('selecting a node in the everything layer selects its cluster and dims the rest', async () => {
    const user = userEvent.setup();
    renderOverview('/graph/overview?layer=nodes');
    const canvas = await screen.findByTestId('fake-canvas');
    await user.click(await within(canvas).findByRole('button', { name: 'Ana Diaz' }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('1'));
    expect(within(canvas).getByRole('button', { name: 'Ana Diaz' })).toHaveAttribute('data-dimmed', 'false');
    expect(within(canvas).getByRole('button', { name: 'Globex' })).toHaveAttribute('data-dimmed', 'false');
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toHaveAttribute('data-dimmed', 'true');
    expect(await screen.findByRole('complementary', { name: 'Globex' })).toBeInTheDocument();
  });
});

describe('GraphOverviewPage — cluster selection and drill-down', () => {
  it('opens the side panel for a clicked cluster', async () => {
    const user = userEvent.setup();
    renderOverview();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp (6)' }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('0'));
    expect(canvas).toHaveAttribute('data-selected', 'c0');
    expect(within(canvas).getByRole('button', { name: 'Unconnected (1)' })).toHaveAttribute('data-dimmed', 'true');

    const panel = await screen.findByRole('complementary', { name: 'Acme Corp' });
    expect(within(panel).getByText('6 entities')).toBeInTheDocument();
    expect(within(panel).getByText('Person 3')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Joe Rivera' })).toHaveAttribute('href', `/graph/entities/${JOE_ID}`);
    expect(within(panel).getByRole('link', { name: 'Open Acme Corp' })).toHaveAttribute('href', `/graph/entities/${ACME_ID}`);

    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBeNull());
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('a cluster with no label entity offers no "Open" link; the stage click deselects', async () => {
    const user = userEvent.setup();
    renderOverview('/graph/overview?cluster=2');
    const panel = await screen.findByRole('complementary', { name: 'Cluster 3' });
    expect(within(panel).queryByRole('link', { name: /^Open/ })).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId('fake-canvas')).getByRole('button', { name: 'stage' }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBeNull());
  });

  it('ignores a ?cluster= this snapshot does not have', async () => {
    renderOverview('/graph/overview?cluster=77');
    await canvasReady();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('"Explore this cluster" hands the members over and opens the explorer', async () => {
    const user = userEvent.setup();
    renderOverview('/graph/overview?cluster=1');
    const panel = await screen.findByRole('complementary', { name: 'Globex' });
    await user.click(within(panel).getByRole('button', { name: 'Explore this cluster' }));

    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(currentUrl().pathname).toBe('/graph/explore');
    expect(currentUrl().searchParams.get('cluster')).toBe('1');
    const handoff = takeExplorerHandoff();
    expect(handoff?.title).toBe('Globex');
    // Ana Diaz and Globex share the top degree; label breaks the tie.
    expect(handoff?.seedIds.slice(0, 2)).toEqual([ANA_ID, GLOBEX_ID]);
    expect(handoff?.seedIds).toHaveLength(4);
    expect(handoff?.nodes).toContainEqual({ id: GLOBEX_ID, label: 'Globex', type: 'Organization', x: 380, y: -150, degree: 3 });
  });

  it('double-clicking a cluster explores it', async () => {
    renderOverview();
    const canvas = await canvasReady();
    fireEvent.doubleClick(within(canvas).getByRole('button', { name: 'Acme Corp (6)' }));
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(takeExplorerHandoff()?.seedIds[0]).toBe(ACME_ID);
  });

  it('renders the panel as a bottom sheet on a phone', async () => {
    act(() => setViewportWidth(390));
    renderOverview('/graph/overview?cluster=0');
    const sheet = await screen.findByRole('presentation');
    expect(within(sheet).getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Explore this cluster' })).toBeInTheDocument();
    act(() => setViewportWidth(1024));
  });
});

describe('GraphOverviewPage — keyboard', () => {
  it('arrows cycle clusters by size with an announcement; Enter explores; Escape deselects', async () => {
    renderOverview();
    await canvasReady();
    const app = screen.getByRole('application', { name: /^Graph overview, 4 clusters/ });
    app.focus();

    fireEvent.keyDown(app, { key: 'ArrowRight' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('0'));
    expect(screen.getByText('Cluster Acme Corp, 6 entities')).toBeInTheDocument();
    fireEvent.keyDown(app, { key: 'ArrowDown' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('1'));
    fireEvent.keyDown(app, { key: 'ArrowLeft' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('0'));
    fireEvent.keyDown(app, { key: 'ArrowUp' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('-1'));
    expect(screen.getByText('Cluster Unconnected, 1 entity')).toBeInTheDocument();

    fireEvent.keyDown(app, { key: 'Escape' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBeNull());

    fireEvent.keyDown(app, { key: '+' });
    fireEvent.keyDown(app, { key: '-' });
    fireEvent.keyDown(app, { key: '0' });
    expect(mocks.controls.zoomIn).toHaveBeenCalledTimes(1);
    expect(mocks.controls.zoomOut).toHaveBeenCalledTimes(1);
    expect(mocks.controls.fit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(app, { key: 'Enter' });
    expect(screen.queryByRole('heading', { name: 'Explorer' })).not.toBeInTheDocument();
    fireEvent.keyDown(app, { key: 'ArrowRight' });
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('0'));
    fireEvent.keyDown(app, { key: 'Enter' });
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
  });

  it('L switches to the list view', async () => {
    renderOverview();
    await canvasReady();
    const app = screen.getByRole('application');
    fireEvent.keyDown(app, { key: 'l' });
    expect(await screen.findByRole('region', { name: CLUSTER_LIST_LABEL })).toBeInTheDocument();
    expect(currentUrl().searchParams.get('view')).toBe('list');
  });
});

describe('GraphOverviewPage — list view', () => {
  it('lists clusters largest first, is keyboard operable and axe-clean', async () => {
    const user = userEvent.setup();
    const { container } = renderOverview('/graph/overview?view=list');
    const list = await screen.findByRole('region', { name: CLUSTER_LIST_LABEL });
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    const rows = within(list).getAllByRole('button', { expanded: false });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Acme Corp6 entities · Person, Meeting, Organization/),
      expect.stringMatching(/^Globex4 entities/),
      expect.stringMatching(/^Cluster 32 entities/),
      expect.stringMatching(/^Unconnected1 entity/),
    ]);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    rows[1].focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBe('1'));
    expect(within(list).getByRole('link', { name: 'Ana Diaz' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(within(list).getByRole('button', { name: 'Explore this cluster: Globex' }));
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    expect(takeExplorerHandoff()?.title).toBe('Globex');
  });

  it('collapsing the open row deselects; the toggle returns to the canvas', async () => {
    const user = userEvent.setup();
    renderOverview('/graph/overview?view=list&cluster=0');
    const list = await screen.findByRole('region', { name: CLUSTER_LIST_LABEL });
    await user.click(within(list).getByRole('button', { expanded: true }));
    await waitFor(() => expect(currentUrl().searchParams.get('cluster')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'List view', pressed: true }));
    await canvasReady();
    expect(currentUrl().searchParams.get('view')).toBeNull();
  });

  it('is forced without WebGL, with the toggle disabled and a note', async () => {
    mocks.webgl = false;
    renderOverview();
    expect(await screen.findByRole('region', { name: CLUSTER_LIST_LABEL })).toBeInTheDocument();
    expect(screen.getByText(OVERVIEW_NO_WEBGL_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List view', pressed: true })).toBeDisabled();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
  });
});

describe('GraphOverviewPage — snapshot states', () => {
  it('stale: a writer gets Refresh, which posts once and shows the pending state', async () => {
    serveOverview(overviewStates.stale());
    const user = userEvent.setup();
    renderOverview();
    await canvasReady();
    const banner = screen.getByText(STALE_TEXT).closest('[role="alert"]') as HTMLElement;
    await user.click(within(banner).getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(PENDING_TEXT)).toBeInTheDocument();
    expect(refreshCalls).toBe(1);
    expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
    // The header's Refresh is disabled while pending.
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('stale: a reader sees the sentence and no Refresh anywhere', async () => {
    serveOverview(overviewStates.stale());
    renderOverview('/graph/overview', graphReader);
    await canvasReady();
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('shows a refused refresh as an error', async () => {
    serveOverview(overviewStates.stale());
    server.use(
      http.post('*/api/graph/overview/refresh', () =>
        HttpResponse.json({ message: 'Forbidden resource', statusCode: 403 }, { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderOverview();
    await canvasReady();
    await user.click(screen.getAllByRole('button', { name: 'Refresh' })[0]);
    expect(await screen.findByText('You do not have permission to view your knowledge graph')).toBeInTheDocument();
  });

  it('pending over an existing snapshot: info banner with progress, canvas still drawn', async () => {
    serveOverview(overviewStates.pending());
    renderOverview();
    await canvasReady();
    expect(screen.getByText(PENDING_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: PENDING_TEXT })).toBeInTheDocument();
    expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
  });

  it('none + pending: a full-page building state that polls until the snapshot lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    serveOverview(() => {
      calls += 1;
      return calls === 1 ? overviewStates.building() : overviewStates.ready();
    });
    renderOverview();
    expect(await screen.findByRole('heading', { name: BUILDING_TEXT })).toBeInTheDocument();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS + 50);
    });
    await canvasReady();
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS * 2);
    });
    expect(calls).toBe(2);
  });

  it('none + empty graph: "Nothing to show yet" linking the index, no canvas', async () => {
    serveOverview(overviewStates.empty());
    const { container } = renderOverview();
    expect(await screen.findByRole('heading', { name: EMPTY_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Knowledge' })).toHaveAttribute('href', '/graph');
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('too large: the warning and an explorer link, no canvas and no list', async () => {
    serveOverview(overviewStates.tooLarge());
    renderOverview();
    expect(await screen.findByText(TOO_LARGE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the explorer' })).toHaveAttribute('href', '/graph/explore');
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: CLUSTER_LIST_LABEL })).not.toBeInTheDocument();
  });

  it('truncated: the caption shows in the everything layer only', async () => {
    serveOverview(overviewStates.truncated());
    const user = userEvent.setup();
    renderOverview();
    await canvasReady();
    expect(screen.queryByText(truncatedText(6200))).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Everything' }));
    expect(await screen.findByText('Showing the 5,000 most connected of 6,200 entities')).toBeInTheDocument();
  });

  it('a failed load shows the error with Retry, which recovers', async () => {
    let fail = true;
    server.use(
      http.get('*/api/graph/overview', () =>
        fail
          ? HttpResponse.json({ message: 'Database unavailable', statusCode: 500 }, { status: 500 })
          : HttpResponse.json({ data: overviewFixture() }),
      ),
    );
    const user = userEvent.setup();
    renderOverview();
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await canvasReady();
  });
});
