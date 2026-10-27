import { screen } from '@testing-library/react';
import { Suspense } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { LocalIdentityProvider } from '@marinoscar/platform-web/identity/headless';
import { describe, expect, it, vi } from 'vitest';

import { kvoxGraphRoutes } from '../../src/graph/ui/index.js';
import { renderKvoxRoutes } from '../../src/shell/routes.js';
import { graphReader, noGraphUser } from './graphTestUsers.js';
import type { MockUser } from './helpers.js';
import { render } from './helpers.js';

/**
 * #782: opening the knowledge graph lands on the whole-graph overview.
 * `/graph` is the overview, the entity index moved to `/graph/entities`, and
 * `/graph/overview` redirects to `/graph` with its query string kept. Rendered
 * through the real route table and `renderKvoxRoutes`, so the permission gate
 * and the lazy pages are the ones an app mounts.
 */

// jsdom has no WebGL; the list view needs no canvas.
vi.mock('../../src/graph/ui/components/explorer/webgl.js', () => ({
  isWebGLAvailable: () => false,
  resetWebGLDetection: () => undefined,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

function renderGraphRoutes(route: string, user: MockUser = graphReader) {
  return render(
    <LocalIdentityProvider userId={user.id} permissions={user.permissions}>
      <Suspense fallback={<p>Loading page</p>}>
        <Routes>
          {renderKvoxRoutes(kvoxGraphRoutes)}
          <Route path="/" element={<p>Home page</p>} />
        </Routes>
      </Suspense>
      <LocationProbe />
    </LocalIdentityProvider>,
    { wrapperOptions: { route, user } },
  );
}

describe('kvoxGraphRoutes (#782)', () => {
  it('lands /graph on the overview', async () => {
    renderGraphRoutes('/graph');
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Entities' })).toHaveAttribute('href', '/graph/entities');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/graph$/);
  });

  it('serves the entity index at /graph/entities, keeping q and type in the URL', async () => {
    renderGraphRoutes('/graph/entities?q=Person&type=Person');
    expect(await screen.findByRole('heading', { level: 1, name: 'Entities' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search people and organizations' })).toHaveValue('Person');
    expect(screen.getByTestId('location')).toHaveTextContent('/graph/entities?q=Person&type=Person');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/graph');
  });

  it('does not let /graph/entities swallow an entity page', async () => {
    renderGraphRoutes('/graph/entities/00000000-0000-4000-8000-000000009999');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Knowledge' })).toHaveAttribute('href', '/graph/entities');
  });

  it('redirects /graph/overview to /graph, keeping the query string and hash', async () => {
    renderGraphRoutes('/graph/overview?layer=nodes&cluster=2&view=list#map');
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/graph?layer=nodes&cluster=2&view=list#map');
  });

  it('redirects a bare /graph/overview to a bare /graph', async () => {
    renderGraphRoutes('/graph/overview');
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/graph$/);
  });

  it('sends a viewer without graph:read home from every landing path', async () => {
    for (const path of ['/graph', '/graph/entities', '/graph/overview?layer=nodes']) {
      const { unmount } = renderGraphRoutes(path, noGraphUser);
      expect(await screen.findByText('Home page')).toBeInTheDocument();
      unmount();
    }
  });
});
