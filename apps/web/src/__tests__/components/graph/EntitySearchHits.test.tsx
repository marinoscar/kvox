import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { graphReader, graphWriter, noGraphUser } from '../../utils/graphTestUsers';
import { EntitySearchHits } from '../../../components/graph/EntitySearchHits';
import NotesPage from '../../../pages/NotesPage';

/** Library search's "People & organizations" row (#373). */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let graphRequests: URL[];

beforeEach(() => {
  graphRequests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/graph/entities')) graphRequests.push(url);
  });
});

describe('EntitySearchHits', () => {
  it('shows matching people, organizations and projects as links to their pages', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Routes>
        <Route path="/" element={<EntitySearchHits query="acme" />} />
        <Route path="/graph/entities/:id" element={<p>Entity page</p>} />
      </Routes>,
      { wrapperOptions: { user: graphReader } },
    );

    const chip = await screen.findByRole('button', { name: /Acme Corp/ });
    expect(screen.getByRole('heading', { name: 'People & organizations' })).toBeInTheDocument();
    const asked = graphRequests[0].searchParams;
    expect(asked.get('q')).toBe('acme');
    expect(asked.get('type')).toBe('Person,Organization,Project');
    expect(asked.get('limit')).toBe('5');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(chip);
    expect(await screen.findByText('Entity page')).toBeInTheDocument();
  });

  it('renders nothing when there are no hits', async () => {
    const { container } = render(<EntitySearchHits query="zzz" />, { wrapperOptions: { user: graphReader } });
    await waitFor(() => expect(graphRequests).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing on a graph error', async () => {
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({ message: 'down' }, { status: 500 })));
    const { container } = render(<EntitySearchHits query="acme" />, { wrapperOptions: { user: graphReader } });
    await waitFor(() => expect(graphRequests).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('down')).not.toBeInTheDocument();
  });

  it('asks nothing without graph:read or with an empty box', async () => {
    render(<EntitySearchHits query="acme" />, { wrapperOptions: { user: noGraphUser } });
    render(<EntitySearchHits query="   " />, { wrapperOptions: { user: graphReader } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(graphRequests).toHaveLength(0);
  });
});

describe('EntitySearchHits inside library search', () => {
  function respondWithSearch() {
    server.use(
      http.get('*/api/search', () =>
        HttpResponse.json({
          data: {
            results: [],
            matchedDocuments: 0,
            truncated: false,
            nextCursor: null,
            degraded: null,
            searchedTypes: ['transcript', 'note'],
            semantic: true,
            semanticReason: null,
            unindexedCount: 0,
          },
        }),
      ),
    );
  }

  it('shows entity hits above the ranked results', async () => {
    const user = userEvent.setup();
    respondWithSearch();
    render(<NotesPage />, { wrapperOptions: { user: graphWriter, route: '/notes' } });

    await user.type(await screen.findByLabelText('Search notes'), 'acme');

    const hits = await screen.findByRole('heading', { name: 'People & organizations' });
    const noMatches = await screen.findByText('No matches for “acme”');
    // Above: the hits come first in document order.
    expect(hits.compareDocumentPosition(noMatches) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('never breaks search when the graph fails', async () => {
    const user = userEvent.setup();
    respondWithSearch();
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({ message: 'down' }, { status: 500 })));
    render(<NotesPage />, { wrapperOptions: { user: graphWriter, route: '/notes' } });

    await user.type(await screen.findByLabelText('Search notes'), 'acme');

    expect(await screen.findByText('No matches for “acme”')).toBeInTheDocument();
    await waitFor(() => expect(graphRequests.length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'People & organizations' })).not.toBeInTheDocument();
  });
});
