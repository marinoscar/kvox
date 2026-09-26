import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { GraphCanvasProps } from '../../../components/graph/explorer/GraphCanvas';
import {
  NEIGHBORHOOD_WIDGET_LIMIT,
  NeighborhoodWidget,
  explorerPathFor,
} from '../../../components/graph/NeighborhoodWidget';
import { buildNeighborhoodGraph } from '../../../components/graph/explorer/NeighborhoodCanvas';
import GraphEntityPage from '../../../pages/GraphEntityPage';
import { ACME_ID, JOE_ID, neighborhoodFixture } from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { graphWriter } from '../../utils/graphTestUsers';
import { render } from '../../utils/test-utils';

/**
 * The entity page's `NeighborhoodWidget` (#374). The canvas is faked (jsdom
 * has no WebGL); the widget's own behaviour — the request, the header link,
 * the node card, the phone tap target, hiding without WebGL — is real.
 */

const mocks = vi.hoisted(() => ({ webgl: true, lastProps: null as GraphCanvasProps | null }));

vi.mock('../../../components/graph/explorer/webgl', () => ({
  isWebGLAvailable: () => mocks.webgl,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../../components/graph/explorer/GraphCanvas', () => ({
  default: function FakeGraphCanvas(props: GraphCanvasProps) {
    mocks.lastProps = props;
    return (
      <div data-testid="fake-canvas" data-interactive={String(props.interactive ?? true)} data-layout={props.layout}>
        {props.graph.nodes().map((id) => (
          <button key={id} type="button" onClick={() => props.onNodeClick(id)}>
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

let neighbourhoodUrls: URL[];

beforeEach(() => {
  mocks.webgl = true;
  mocks.lastProps = null;
  neighbourhoodUrls = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    if (request.url.includes('/neighborhood')) neighbourhoodUrls.push(new URL(request.url));
  });
});

function renderWidget(route = `/graph/entities/${JOE_ID}`) {
  return render(
    <Routes>
      <Route
        path="/graph/entities/:id"
        element={<NeighborhoodWidget entityId={JOE_ID} entityLabel="Joe Rivera" />}
      />
      <Route path="/graph/explore" element={<h1>Explorer</h1>} />
    </Routes>,
    { wrapperOptions: { route, user: graphWriter } },
  );
}

describe('NeighborhoodWidget', () => {
  it('draws the one-hop neighbourhood with an "Open in explorer" link', async () => {
    const { container } = renderWidget();
    expect(screen.getByRole('heading', { name: 'Neighbourhood' })).toBeInTheDocument();
    const canvas = await screen.findByTestId('fake-canvas');
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toBeInTheDocument();

    expect(neighbourhoodUrls[0].searchParams.get('hops')).toBe('1');
    expect(neighbourhoodUrls[0].searchParams.get('limit')).toBe(String(NEIGHBORHOOD_WIDGET_LIMIT));
    expect(screen.getByRole('link', { name: 'Open in explorer' })).toHaveAttribute(
      'href',
      explorerPathFor(JOE_ID),
    );
    expect(explorerPathFor(JOE_ID)).toBe(`/graph/explore?seed=${JOE_ID}`);
    expect(canvas).toHaveAttribute('data-interactive', 'true');
    expect(canvas).toHaveAttribute('data-layout', 'forceatlas');
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });

  it('selects a node and offers its page', async () => {
    const user = userEvent.setup();
    renderWidget();
    const canvas = await screen.findByTestId('fake-canvas');
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));

    const card = await screen.findByRole('status');
    expect(within(card).getByText('Acme Corp')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      `/graph/entities/${ACME_ID}`,
    );
    expect(mocks.lastProps?.selectedId).toBe(ACME_ID);

    // The entity itself and an item offer no link to "their" page.
    await user.click(within(canvas).getByRole('button', { name: 'Ship the Atlas beta' }));
    expect(within(await screen.findByRole('status')).queryByRole('link')).not.toBeInTheDocument();

    await user.click(within(canvas).getByRole('button', { name: 'stage' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses the static layout for ?layout=static', async () => {
    renderWidget(`/graph/entities/${JOE_ID}?layout=static`);
    expect(await screen.findByTestId('fake-canvas')).toHaveAttribute('data-layout', 'static');
  });

  it('is not interactive on a phone: the whole canvas is one tap into the explorer', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderWidget();
    const canvas = await screen.findByTestId('fake-canvas');
    expect(canvas).toHaveAttribute('data-interactive', 'false');
    const target = screen.getByTestId('neighborhood-tap-target');
    expect(target).toHaveAttribute('href', explorerPathFor(JOE_ID));
    expect(target).toHaveAttribute('aria-hidden', 'true');
    await user.click(target);
    expect(await screen.findByRole('heading', { name: 'Explorer' })).toBeInTheDocument();
    act(() => setViewportWidth(1024));
  });

  it('renders nothing without WebGL, and asks for nothing', async () => {
    mocks.webgl = false;
    const { container } = renderWidget();
    expect(container).toBeEmptyDOMElement();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(neighbourhoodUrls).toHaveLength(0);
  });

  it('renders nothing for an entity with no connections, or when the request fails', async () => {
    server.use(
      http.get('*/api/graph/entities/:id/neighborhood', () =>
        HttpResponse.json({ data: neighborhoodFixture({ nodes: neighborhoodFixture().nodes.slice(0, 1), edges: [] }) }),
      ),
    );
    const first = renderWidget();
    await waitFor(() => expect(first.container).toBeEmptyDOMElement());
    first.unmount();

    server.use(
      http.get('*/api/graph/entities/:id/neighborhood', () =>
        HttpResponse.json({ message: 'Timed out', statusCode: 503 }, { status: 503 }),
      ),
    );
    const second = renderWidget();
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });
});

describe('buildNeighborhoodGraph', () => {
  it('builds a deterministic graph with the entity at the centre', () => {
    const a = buildNeighborhoodGraph(neighborhoodFixture());
    const b = buildNeighborhoodGraph(neighborhoodFixture());
    expect(a.getNodeAttributes(JOE_ID)).toMatchObject({ x: 0, y: 0 });
    expect(a.nodes().map((id) => a.getNodeAttributes(id).x)).toEqual(
      b.nodes().map((id) => b.getNodeAttributes(id).x),
    );
  });
});

describe('GraphEntityPage — the widget above the Connections list', () => {
  it('mounts the widget above the Connections section', async () => {
    render(
      <Routes>
        <Route path="/graph/entities/:id" element={<GraphEntityPage />} />
      </Routes>,
      { wrapperOptions: { route: `/graph/entities/${JOE_ID}`, user: graphWriter } },
    );
    const widget = await screen.findByRole('heading', { name: 'Neighbourhood' });
    const connections = await screen.findByRole('heading', { name: 'Connections' });
    expect(widget.compareDocumentPosition(connections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
