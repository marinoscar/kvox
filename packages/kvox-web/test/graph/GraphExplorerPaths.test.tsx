import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import { GraphExplorerPage } from '../../src/graph/ui/pages/GraphExplorerPage.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { ACME_ID, JOE_ID, entityDetail, expandFixture, graphEntitySummaries, type ExpandFixtureRequest } from './graphData.js';
import { COPILOT_ID, COPILOT_SUMMARY, EDGE_INVOLVED, EDGE_USES, pathEvidence, pathsResponse } from './pathsData.js';
import { graphReader } from './graphTestUsers.js';
import { render } from './helpers.js';
import { http, HttpResponse, server } from './msw-compat.js';
import { mockTouchInput } from './shellMedia.js';

/**
 * Path mode of `/graph/explore` (GIC-13, #674). The canvas is the same FAKE the
 * explorer suite uses (jsdom has no WebGL); it also reports the path it was
 * told to highlight, and the camera is a spy so "fit to the path" is asserted.
 */

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  fitTo: vi.fn(),
}));

vi.mock('../../src/graph/ui/components/explorer/webgl.js', () => ({
  isWebGLAvailable: () => true,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../src/graph/ui/components/explorer/GraphCanvas.js', () => ({
  GraphCanvas: function FakeGraphCanvas(props: GraphCanvasProps) {
    useImperativeHandle(
      props.controlsRef,
      () => ({
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        fit: mocks.fit,
        fitTo: mocks.fitTo,
        relayoutAll: vi.fn(),
        togglePin: vi.fn(),
        unpinAll: vi.fn(),
        isPinned: () => false,
      }),
      [],
    );
    return (
      <div
        data-testid="fake-canvas"
        data-path-nodes={[...(props.pathNodeIds ?? [])].sort().join(',')}
        data-path-edges={[...(props.pathEdgeIds ?? [])].sort().join(',')}
      >
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => props.onNodeClick(id)}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onNodeContextMenu?.({ id, clientX: 12, clientY: 34, source: 'right-click' });
            }}
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
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

let pathRequests: URL[];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');
}

beforeEach(() => {
  pathRequests = [];
  mocks.fit.mockClear();
  mocks.fitTo.mockClear();
  setViewportWidth(1000);
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const slice = expandFixture((await request.json()) as ExpandFixtureRequest);
      return slice ? HttpResponse.json({ data: slice }) : HttpResponse.json({ message: 'no', statusCode: 404 }, { status: 404 });
    }),
    http.get('*/api/graph/paths', ({ request }) => {
      pathRequests.push(new URL(request.url));
      return HttpResponse.json({ data: pathsResponse() });
    }),
    http.get('*/api/graph/evidence/by-subject', ({ request }) => {
      const url = new URL(request.url);
      const items = pathEvidence.filter((ev) => ev.subjectId === url.searchParams.get('id'));
      return HttpResponse.json({ data: { items } });
    }),
    http.get('*/api/graph/entities/:id', ({ params }) =>
      params.id === COPILOT_ID
        ? HttpResponse.json({ data: { ...entityDetail(ACME_ID), id: COPILOT_ID, label: 'Copilot rollout', type: 'Project' } })
        : HttpResponse.json({ data: entityDetail(String(params.id)) }),
    ),
    http.get('*/api/graph/entities', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q')?.toLowerCase();
      const all = [...graphEntitySummaries, COPILOT_SUMMARY];
      const items = q ? all.filter((s) => s.label.toLowerCase().includes(q)) : all;
      return HttpResponse.json({ data: { items, nextCursor: null } });
    }),
  );
});

function renderExplorer(route: string) {
  return render(
    <>
      <Routes>
        <Route path="/graph/explore" element={<GraphExplorerPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user: graphReader } },
  );
}

const PAIR = `seed=${JOE_ID}&pathFrom=${JOE_ID}&pathTo=${COPILOT_ID}`;

async function pathReady() {
  const list = await screen.findByRole('list', { name: /^Path 1, strong evidence/ });
  return list;
}

describe('path mode — results', () => {
  it('Joe to the Copilot rollout: two ranked paths, each hop with a quote and a working deep link', async () => {
    renderExplorer(`/graph/explore?${PAIR}`);
    const list = await pathReady();

    expect(list).toHaveAccessibleName(
      'Path 1, strong evidence, 1 hop: Joe Rivera, involved in as stakeholder, skeptical, Copilot rollout',
    );
    expect(screen.getByRole('button', { name: /^Path 1, strong evidence$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Path 2, moderate evidence$/ })).toBeInTheDocument();

    const quote = await within(list).findByText(/Joe is a stakeholder on the Copilot rollout/);
    expect(quote).toBeInTheDocument();
    const link = within(list).getByRole('link', { name: /Open at source: Copilot sync/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('/notes/'));
    // 5 sources, one shown: "4 more".
    expect(within(list).getByRole('button', { name: '4 more sources for this connection' })).toBeInTheDocument();

    // The request: the pair, three paths, four hops, and the canvas's date.
    expect(pathRequests[0].searchParams.get('from')).toBe(JOE_ID);
    expect(pathRequests[0].searchParams.get('to')).toBe(COPILOT_ID);
    expect(pathRequests[0].searchParams.get('k')).toBe('3');
    expect(pathRequests[0].searchParams.get('maxHops')).toBe('4');

    await userEvent.setup().click(screen.getByRole('button', { name: /^Path 2, moderate evidence$/ }));
    const second = await screen.findByRole('list', { name: /^Path 2, moderate evidence, 2 hops/ });
    expect(await within(second).findByText(/Acme is piloting Copilot/)).toBeInTheDocument();
    expect(within(second).getByText('Pilot')).toBeInTheDocument();
  });

  it('lays the strip out horizontally on a tablet and vertically in the phone sheet', async () => {
    const { unmount } = renderExplorer(`/graph/explore?${PAIR}`);
    expect(await pathReady()).toHaveAttribute('data-orientation', 'horizontal');
    expect(screen.getByTestId('path-overlay')).toBeInTheDocument();
    unmount();

    setViewportWidth(390);
    mockTouchInput();
    renderExplorer(`/graph/explore?${PAIR}`);
    expect(await pathReady()).toHaveAttribute('data-orientation', 'vertical');
    expect(screen.queryByTestId('path-overlay')).not.toBeInTheDocument();
  });

  it('is accessible', async () => {
    const { container } = renderExplorer(`/graph/explore?${PAIR}`);
    const list = await pathReady();
    await within(list).findByText(/Joe is a stakeholder/);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('path mode — on the canvas', () => {
  it('"Show on canvas" merges the path, highlights it and fits the camera to it', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?${PAIR}`);
    await pathReady();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Acme Corp' });
    expect(within(canvas).queryByRole('button', { name: 'Copilot rollout' })).not.toBeInTheDocument();
    expect(canvas).toHaveAttribute('data-path-nodes', '');

    await user.click(screen.getByRole('button', { name: 'Show on canvas' }));

    await within(canvas).findByRole('button', { name: 'Copilot rollout' });
    // Merge, not replace: Acme was already there.
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toBeInTheDocument();
    await waitFor(() => expect(canvas).toHaveAttribute('data-path-nodes', [JOE_ID, COPILOT_ID].sort().join(',')));
    expect(canvas).toHaveAttribute('data-path-edges', EDGE_INVOLVED);
    await waitFor(() => expect(mocks.fitTo).toHaveBeenCalledWith([JOE_ID, COPILOT_ID]));
  });

  it('switching to another path while it is shown re-highlights and re-fits', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?${PAIR}`);
    await pathReady();
    await user.click(screen.getByRole('button', { name: 'Show on canvas' }));
    await waitFor(() => expect(mocks.fitTo).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /^Path 2, moderate evidence$/ }));
    await waitFor(() => expect(mocks.fitTo).toHaveBeenCalledWith([JOE_ID, ACME_ID, COPILOT_ID]));
    expect(screen.getByTestId('fake-canvas')).toHaveAttribute('data-path-edges', expect.stringContaining(EDGE_USES));
  });

  it('Enter on a hop opens that edge in the inspector, on its Evidence tab', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?${PAIR}`);
    const list = await pathReady();
    const hop = within(list).getByRole('button', {
      name: 'Joe Rivera, involved in as stakeholder, skeptical, Copilot rollout. Open this connection in the inspector.',
    });
    hop.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(currentUrl().searchParams.get('sel')).toBe(`e:${EDGE_INVOLVED}`));
    expect(await screen.findByRole('tab', { name: 'Evidence', selected: true })).toBeInTheDocument();
  });
});

describe('path mode — URL and entry points', () => {
  it('a link with only pathFrom opens the picker with A filled in; Find paths writes the URL', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}&pathFrom=${JOE_ID}`);

    const a = await screen.findByRole('combobox', { name: 'From (A)' });
    await waitFor(() => expect(a).toHaveValue('Joe Rivera'));
    const find = screen.getByRole('button', { name: 'Find paths' });
    expect(find).toBeDisabled();

    await user.type(screen.getByRole('combobox', { name: 'To (B)' }), 'Copilot');
    await user.click(await screen.findByRole('option', { name: /Copilot rollout/ }));
    await user.click(screen.getByRole('button', { name: /^2 hops$/ }));
    expect(find).toBeEnabled();
    await user.click(find);

    await waitFor(() => expect(currentUrl().searchParams.get('pathTo')).toBe(COPILOT_ID));
    expect(currentUrl().searchParams.get('pathFrom')).toBe(JOE_ID);
    expect(currentUrl().searchParams.get('pathHops')).toBe('2');
    await pathReady();
    expect(pathRequests.at(-1)!.searchParams.get('maxHops')).toBe('2');
  });

  it('swaps A and B', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?${PAIR}`);
    await pathReady();
    await user.click(await screen.findByRole('button', { name: 'Change the connection' }));
    const a = await screen.findByRole('combobox', { name: 'From (A)' });
    await waitFor(() => expect(a).toHaveValue('Joe Rivera'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'To (B)' })).toHaveValue('Copilot rollout'));
    await user.click(screen.getByRole('button', { name: 'Swap A and B' }));
    expect(screen.getByRole('combobox', { name: 'From (A)' })).toHaveValue('Copilot rollout');
    expect(screen.getByRole('combobox', { name: 'To (B)' })).toHaveValue('Joe Rivera');
  });

  it('the inspector offers "Path to…" with A pre-filled', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}`);
    const canvas = await screen.findByTestId('fake-canvas');
    await user.click(await within(canvas).findByRole('button', { name: 'Joe Rivera' }));

    await user.click(await screen.findByRole('button', { name: 'Path to…' }));

    expect(currentUrl().searchParams.get('pathFrom')).toBe(JOE_ID);
    expect(currentUrl().searchParams.get('pathTo')).toBeNull();
    const a = await screen.findByRole('combobox', { name: 'From (A)' });
    await waitFor(() => expect(a).toHaveValue('Joe Rivera'));
  });

  it('the node context menu offers "Path to…"', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${JOE_ID}`);
    const canvas = await screen.findByTestId('fake-canvas');
    fireEvent.contextMenu(await within(canvas).findByRole('button', { name: 'Joe Rivera' }));

    await user.click(await screen.findByRole('menuitem', { name: 'Path to…' }));

    expect(currentUrl().searchParams.get('pathFrom')).toBe(JOE_ID);
    expect(await screen.findByRole('combobox', { name: 'From (A)' })).toBeInTheDocument();
  });

  it('closing path mode removes it from the URL', async () => {
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?${PAIR}`);
    await pathReady();
    await user.click(screen.getByRole('button', { name: 'Close the connection' }));
    await waitFor(() => expect(currentUrl().searchParams.get('pathFrom')).toBeNull());
    expect(currentUrl().searchParams.get('pathTo')).toBeNull();
    expect(currentUrl().searchParams.get('seed')).toBe(JOE_ID);
  });
});

describe('path mode — empty and failing searches', () => {
  it('no path: says so and offers one more hop and removing relation filters', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/graph/paths', ({ request }) => {
        pathRequests.push(new URL(request.url));
        return HttpResponse.json({ data: pathsResponse({ paths: [] }) });
      }),
    );
    renderExplorer(`/graph/explore?${PAIR}&pathRel=USES`);

    // The live region says it too, so look inside the panel.
    const panel = async () => within(await screen.findByRole('region', { name: /^Connection:/ }));
    expect(await (await panel()).findByText('No connection within 4 hops')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove relation filters' }));
    await waitFor(() => expect(currentUrl().searchParams.get('pathRel')).toBeNull());
    await (await panel()).findByText('No connection within 4 hops');

    await user.click(screen.getByRole('button', { name: 'Look 5 hops out' }));
    await waitFor(() => expect(currentUrl().searchParams.get('pathHops')).toBe('5'));
    expect(await (await panel()).findByText('No connection within 5 hops')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hops out/ })).not.toBeInTheDocument();
  });

  it('a 503 reads "That search took too long, try fewer hops" and can be retried', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get('*/api/graph/paths', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'graph_query_timeout', statusCode: 503 }, { status: 503 })
          : HttpResponse.json({ data: pathsResponse() });
      }),
    );
    renderExplorer(`/graph/explore?${PAIR}`);

    expect(await screen.findByText(/That search took too long, try fewer hops/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await pathReady();
  });

  it('never asks for evidence behind a person fact', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/graph/paths', () => {
        const response = pathsResponse();
        response.slice.nodes[2] = { ...response.slice.nodes[2], nodeKind: 'item', type: 'person_fact' };
        return HttpResponse.json({ data: response });
      }),
      http.get('*/api/graph/evidence/by-subject', ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('id') ?? '');
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    renderExplorer(`/graph/explore?${PAIR}`);
    const list = await pathReady();
    expect(await within(list).findAllByText('No quote on record for this connection.')).not.toHaveLength(0);
    expect(asked).not.toContain(EDGE_INVOLVED);
    expect(asked).not.toContain(EDGE_USES);
  });
});
