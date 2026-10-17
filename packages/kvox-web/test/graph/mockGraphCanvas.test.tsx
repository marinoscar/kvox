import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';

import { http, HttpResponse } from './msw-compat.js';
import { server } from './msw-compat.js';
import { render } from './helpers.js';
import { JOE_ID, neighborhoodFixture } from './graphData.js';
import { graphWriter } from './graphTestUsers.js';
import { NeighborhoodWidget } from '../../src/graph/ui/components/NeighborhoodWidget.js';
import { mockGraphCanvas } from '../../src/graph/testing/index.js';

/**
 * `mockGraphCanvas`: what a host's tests use to render a screen that draws the
 * graph in jsdom, which has no WebGL.
 */

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

function renderWidget() {
  server.use(
    http.get('*/api/graph/entities/:id/neighborhood', () =>
      HttpResponse.json({ data: neighborhoodFixture() }),
    ),
  );
  return render(
    <Routes>
      <Route
        path="/graph/entities/:id"
        element={<NeighborhoodWidget entityId={JOE_ID} entityLabel="Joe Rivera" />}
      />
    </Routes>,
    { wrapperOptions: { route: `/graph/entities/${JOE_ID}`, user: graphWriter } },
  );
}

describe('mockGraphCanvas', () => {
  it('puts a stand-in canvas where the real one would be, and reports WebGL as available', async () => {
    restore = mockGraphCanvas();
    renderWidget();

    expect(await screen.findByTestId('fake-canvas')).toBeInTheDocument();
  });

  it('with webgl: false, the widget hides itself as it does in a browser without WebGL', async () => {
    restore = mockGraphCanvas({ webgl: false });
    const { container } = renderWidget();

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
  });
});
