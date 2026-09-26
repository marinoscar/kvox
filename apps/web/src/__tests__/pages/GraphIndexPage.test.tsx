import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import { graphReader, noGraphUser } from '../utils/graphTestUsers';
import { graphEntitySummaries } from '../mocks/graphData';
import GraphIndexPage, { typesFromQuery } from '../../pages/GraphIndexPage';
import { RequirePermission } from '../../components/common/RequirePermission';
import type { MockUser } from '../utils/test-utils';

/**
 * `/graph` — the knowledge graph's index (#373). MSW answers from
 * `mocks/graphData.ts`, the #370 contract's fixtures.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderIndex(route = '/graph', user: MockUser = graphReader) {
  return render(
    <>
      <Routes>
        <Route
          path="/graph"
          element={
            <RequirePermission permission="graph:read" fallback={<Navigate to="/" replace />}>
              <GraphIndexPage />
            </RequirePermission>
          }
        />
        <Route path="/" element={<p>Home page</p>} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user } },
  );
}

/** Every `GET /api/graph/entities` URL, for asserting on what was asked. */
let listRequests: URL[];

beforeEach(() => {
  listRequests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/graph/entities')) listRequests.push(url);
  });
});

describe('typesFromQuery', () => {
  it('defaults to people and organizations when absent, everything when empty', () => {
    expect(typesFromQuery(null)).toEqual(['Person', 'Organization']);
    expect(typesFromQuery('')).toEqual([]);
    expect(typesFromQuery('Project, Meeting')).toEqual(['Project', 'Meeting']);
  });
});

describe('GraphIndexPage', () => {
  it('lists people and organizations by default, each linking to its page', async () => {
    const { container } = renderIndex();

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    const joe = await screen.findByRole('link', { name: /Joe Rivera/ });
    expect(joe).toHaveAttribute('href', `/graph/entities/${graphEntitySummaries[0].id}`);
    expect(screen.getByRole('link', { name: /Acme Corp/ })).toBeInTheDocument();
    // Projects and Meetings are not selected by default.
    expect(screen.queryByRole('link', { name: /Project Atlas/ })).not.toBeInTheDocument();
    expect(listRequests[0].searchParams.get('type')).toBe('Person,Organization');

    // Explore / Overview render as links (the routes arrive in #374/#375).
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/graph/explore');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/graph/overview');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('builds the type chips from the ontology and syncs the selection to the URL', async () => {
    const user = userEvent.setup();
    renderIndex();

    const filter = await screen.findByRole('group', { name: 'Filter by type' });
    const projects = await within(filter).findByRole('button', { name: /Projects/ });
    expect(projects).toHaveAttribute('aria-pressed', 'false');

    await user.click(projects);

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('type=Person%2COrganization%2CProject'),
    );
    expect(await screen.findByRole('link', { name: /Project Atlas/ })).toBeInTheDocument();
  });

  it('reads the selection from the URL', async () => {
    renderIndex('/graph?type=Project');
    expect(await screen.findByRole('link', { name: /Project Atlas/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Joe Rivera/ })).not.toBeInTheDocument();
  });

  it('debounces the search box into one request and hides Load more for a search', async () => {
    const user = userEvent.setup();
    renderIndex();
    await screen.findByRole('link', { name: /Joe Rivera/ });

    await user.type(screen.getByRole('textbox', { name: 'Search people and organizations' }), 'acme');

    expect(await screen.findByRole('link', { name: /Acme Corp/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: /Joe Rivera/ })).not.toBeInTheDocument());
    const queries = listRequests.map((url) => url.searchParams.get('q')).filter(Boolean);
    expect(queries).toEqual(['acme']);
    expect(screen.getByTestId('location')).toHaveTextContent('q=acme');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so when a search matches nothing', async () => {
    renderIndex('/graph?q=zzz');
    expect(await screen.findByText('No matches for “zzz”')).toBeInTheDocument();
  });

  it('loads more with the cursor and appends', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json({
          data: cursor
            ? { items: graphEntitySummaries.slice(2, 4), nextCursor: null }
            : { items: graphEntitySummaries.slice(0, 2), nextCursor: 'page-2' },
        });
      }),
    );
    renderIndex();

    await screen.findByRole('link', { name: /Joe Rivera/ });
    expect(screen.queryByRole('link', { name: /Ana Diaz/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: /Ana Diaz/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Joe Rivera/ })).toBeInTheDocument();
    expect(listRequests.at(-1)?.searchParams.get('cursor')).toBe('page-2');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows the empty-graph state pointing at notes', async () => {
    server.use(
      http.get('*/api/graph/entities', () => HttpResponse.json({ data: { items: [], nextCursor: null } })),
    );
    renderIndex();
    expect(await screen.findByText('Nothing in your graph yet')).toBeInTheDocument();
    expect(screen.getByText(/Review a note's proposal to add people and organizations/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to notes' })).toHaveAttribute('href', '/notes');
  });

  it('shows an error with a working Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get('*/api/graph/entities', () =>
        fail
          ? HttpResponse.json({ message: 'Graph is down' }, { status: 500 })
          : HttpResponse.json({ data: { items: graphEntitySummaries.slice(0, 1), nextCursor: null } }),
      ),
    );
    renderIndex();

    expect(await screen.findByText('Graph is down')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: /Joe Rivera/ })).toBeInTheDocument();
  });

  it('redirects home without graph:read', async () => {
    renderIndex('/graph', noGraphUser);
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(listRequests).toHaveLength(0);
  });

  it('folds Explore and Overview into a menu on a phone', async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderIndex();
    await screen.findByRole('link', { name: /Joe Rivera/ });

    expect(screen.queryByRole('link', { name: 'Explore' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More knowledge views' }));
    expect(await screen.findByRole('menuitem', { name: 'Explore' })).toHaveAttribute('href', '/graph/explore');
    expect(screen.getByRole('menuitem', { name: 'Overview' })).toBeInTheDocument();
  });
});
