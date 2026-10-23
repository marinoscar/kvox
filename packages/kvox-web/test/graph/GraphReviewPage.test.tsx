import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from './msw-compat.js';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { GraphReviewPage } from '../../src/graph/ui/pages/GraphReviewPage.js';
import type { ProposalSummary } from '../../src/graph/headless/clients/graph.js';
import { server } from './msw-compat.js';
import { gid, proposalSummary } from './graphData.js';
import { render } from './helpers.js';
import { graphReader } from './graphTestUsers.js';

/** `/graph/review`: the draft proposals waiting for review. */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const NOTE_ID = gid(901);
const extraction = (n: number, over: Partial<ProposalSummary> = {}): ProposalSummary =>
  proposalSummary([], {
    id: gid(800 + n),
    noteId: NOTE_ID,
    noteTitle: `Weekly sync ${n}`,
    counts: { total: 5, pending: 3, accepted: 2, rejected: 0, known: 0, byGroup: {} },
    ...over,
  });

let requests: URL[];

beforeEach(() => {
  requests = [];
});

function serve(pages: Record<string, { items: ProposalSummary[]; nextCursor: string | null }>) {
  server.use(
    http.get('*/api/graph/proposals', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json({ data: pages[url.searchParams.get('cursor') ?? ''] });
    })
  );
}

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/" element={<GraphReviewPage />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    { wrapperOptions: { user: graphReader } }
  );
}

describe('GraphReviewPage', () => {
  it('lists draft note extractions and imports as links named after their source', async () => {
    serve({
      '': {
        items: [
          extraction(1),
          proposalSummary([], {
            id: gid(850),
            kind: 'import',
            noteId: null,
            noteTitle: null,
            stats: { filename: 'graph.ttl' },
            counts: { total: 1, pending: 1, accepted: 0, rejected: 0, known: 0, byGroup: {} },
          }),
          proposalSummary([], { id: gid(860), kind: 'resolution', noteId: null, noteTitle: null }),
        ],
        nextCursor: null,
      },
    });
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument();

    const note = await screen.findByRole('link', { name: /^Weekly sync 1/ });
    expect(note).toHaveAttribute('href', `/notes/${NOTE_ID}?review=1`);
    expect(note).toHaveTextContent('3 to decide · 5 items');
    expect(screen.getByRole('link', { name: /^graph\.ttl/ })).toHaveAttribute(
      'href',
      `/graph/imports/${gid(850)}`
    );
    expect(within(screen.getByRole('list', { name: 'Waiting for review' })).getAllByRole('link')).toHaveLength(2);
    // #721: the header reaches the grouped Review Queue.
    expect(screen.getByRole('link', { name: 'Review Queue' })).toHaveAttribute('href', '/graph/review-queue');
    expect(requests[0].searchParams.get('status')).toBe('draft');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('opens the note with its review sheet', async () => {
    serve({ '': { items: [extraction(1)], nextCursor: null } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('link', { name: /^Weekly sync 1/ }));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/notes/${NOTE_ID}?review=1`);
  });

  it('pages with Load more', async () => {
    serve({
      '': { items: [extraction(1)], nextCursor: 'c2' },
      c2: { items: [extraction(2)], nextCursor: null },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: /^Weekly sync 1/ });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /^Weekly sync 2/ })).toBeInTheDocument();
    expect(requests[1].searchParams.get('cursor')).toBe('c2');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    );
  });

  it('says Nothing to review when nothing waits', async () => {
    serve({ '': { items: [], nextCursor: null } });
    renderPage();
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    server.use(
      http.get('*/api/graph/proposals', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    renderPage();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
