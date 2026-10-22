import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse } from './msw-compat.js';
import { useImperativeHandle } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import { GraphExplorerPage } from '../../src/graph/ui/pages/GraphExplorerPage.js';
import { ACME_ID, ANA_ID, GLOBEX_ID, INITECH_ID, JOE_ID, expandFixture, type ExpandFixtureRequest } from './graphData.js';
import { server } from './msw-compat.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { graphReader } from './graphTestUsers.js';
import { render } from './helpers.js';

/**
 * GIC-16 (#677): the Insights panel inside the real explorer page, over the same fake canvas
 * the page suite uses. Every item must land on the canvas: seed it, ring what it marks and
 * focus its entity once drawn.
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
    focusNode: vi.fn(),
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
      <div data-testid="fake-canvas">
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-marked={props.markedIds?.has(id) ?? false}
            data-selected={props.selectedId === id}
            onClick={() => props.onNodeClick(id)}
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
          </button>
        ))}
      </div>
    );
  },
}));

let bodies: ExpandFixtureRequest[];

beforeEach(() => {
  bodies = [];
  mocks.controls.focusNode.mockClear();
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      bodies.push(body);
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => setViewportWidth(1024));
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderExplorer(route = `/graph/explore?seed=${JOE_ID}`) {
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

const seedsInUrl = () => (new URL(screen.getByTestId('location').textContent ?? '/', 'http://x').searchParams.get('seed') ?? '').split(',');

describe('GraphExplorerPage — Insights', () => {
  it('on an expanded window the panel sits with the filters, and a rising entity already drawn is just focused', async () => {
    act(() => setViewportWidth(1280));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Ana Diaz' });

    const rising = await screen.findByRole('region', { name: /^Rising/ });
    await user.click(within(rising).getByRole('button', { name: /Ana Diaz/ }));

    expect(mocks.controls.focusNode).toHaveBeenCalledWith(ANA_ID);
    expect(seedsInUrl()).toEqual([JOE_ID]);
  });

  it('a connector seeds the node and the groups it joins, rings those, and focuses the node once drawn', async () => {
    act(() => setViewportWidth(1280));
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${INITECH_ID}`);
    const canvas = await screen.findByTestId('fake-canvas');
    await within(canvas).findByRole('button', { name: 'Initech' });
    expect(within(canvas).queryByRole('button', { name: 'Joe Rivera' })).not.toBeInTheDocument();

    const connectors = await screen.findByRole('region', { name: /^Connectors/ });
    await user.click(within(connectors).getByRole('button', { name: /Joe Rivera/ }));

    await waitFor(() => expect(seedsInUrl()[0]).toBe(JOE_ID));
    expect(seedsInUrl()).toEqual(expect.arrayContaining([ACME_ID, GLOBEX_ID]));
    await waitFor(() => expect(mocks.controls.focusNode).toHaveBeenCalledWith(JOE_ID));
    await waitFor(() => expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'true'));
    expect(within(canvas).getByRole('button', { name: 'Joe Rivera' })).toHaveAttribute('data-marked', 'false');
  });

  it('a theme replaces the seeds with the theme members', async () => {
    act(() => setViewportWidth(1280));
    const user = userEvent.setup();
    renderExplorer();
    await within(await screen.findByTestId('fake-canvas')).findByRole('button', { name: 'Joe Rivera' });

    const themes = await screen.findByRole('region', { name: /^Themes/ });
    await user.click(within(themes).getByRole('button', { name: /^Globex/ }));

    await waitFor(() => expect(seedsInUrl()).toContain(GLOBEX_ID));
    expect(seedsInUrl()).not.toContain(JOE_ID);
  });

  it('a fading tie seeds both ends', async () => {
    act(() => setViewportWidth(1280));
    const user = userEvent.setup();
    renderExplorer(`/graph/explore?seed=${INITECH_ID}`);
    await within(await screen.findByTestId('fake-canvas')).findByRole('button', { name: 'Initech' });

    const ties = await screen.findByRole('region', { name: /^Fading ties/ });
    await user.click(within(ties).getByRole('button', { name: /Joe Rivera and Ana Diaz/ }));

    await waitFor(() => expect(seedsInUrl()).toEqual([JOE_ID, ANA_ID]));
  });

  it('on a medium window the panel is in the filter rail popover', async () => {
    act(() => setViewportWidth(900));
    const user = userEvent.setup();
    renderExplorer();
    await within(await screen.findByTestId('fake-canvas')).findByRole('button', { name: 'Joe Rivera' });

    expect(screen.queryByRole('region', { name: 'Insights' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Filters' }));
    expect(await screen.findByRole('region', { name: 'Insights' })).toBeInTheDocument();
  });

  it('on a compact window the panel is in the drawer', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    await within(await screen.findByTestId('fake-canvas')).findByRole('button', { name: 'Joe Rivera' });

    await user.click(await screen.findByRole('button', { name: /Filters/ }));
    expect(await screen.findByRole('region', { name: 'Insights' })).toBeInTheDocument();
  });
});
