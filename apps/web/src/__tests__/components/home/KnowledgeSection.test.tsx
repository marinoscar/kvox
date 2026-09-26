import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { graphReader, noGraphUser } from '../../utils/graphTestUsers';
import { graphEntitySummaries } from '../../mocks/graphData';
import { KnowledgeSection } from '../../../components/home/KnowledgeSection';

/** Home's "Knowledge" entry point (#373). */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let graphRequests: URL[];

beforeEach(() => {
  graphRequests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.includes('/api/graph/')) graphRequests.push(url);
  });
});

describe('KnowledgeSection', () => {
  it('renders six recent people and organizations with links to the graph', async () => {
    const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: graphReader } });

    const section = await screen.findByRole('region', { name: 'Knowledge' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(6);
    expect(within(section).getByRole('link', { name: /Joe Rivera/ })).toHaveAttribute(
      'href',
      `/graph/entities/${graphEntitySummaries[0].id}`,
    );
    expect(within(section).getByRole('link', { name: /All people & organizations/ })).toHaveAttribute('href', '/graph');
    expect(within(section).getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/graph/explore');

    const asked = graphRequests[0].searchParams;
    expect(asked.get('type')).toBe('Person,Organization');
    expect(asked.get('limit')).toBe('6');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is hidden entirely when the graph is empty', async () => {
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({ data: { items: [], nextCursor: null } })));
    const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: graphReader } });
    await waitFor(() => expect(graphRequests).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('is hidden entirely on an error — no error box', async () => {
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({ message: 'down' }, { status: 500 })));
    const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: graphReader } });
    await waitFor(() => expect(graphRequests).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('is hidden, not crashed, on a 200 whose body is not an entity list', async () => {
    // PR #415's visual regression: a stub answering `{}` reached render as
    // `items: undefined` and threw on `.length`, taking the whole app into the
    // root ErrorBoundary. `listGraphEntities` now refuses the shape.
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({ data: {} })));
    const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: graphReader } });
    await waitFor(() => expect(graphRequests).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('contains a render-time throw to itself and renders nothing', async () => {
    // An array that passes the shape check but whose rows are not entities —
    // the section's own boundary must absorb the throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.use(
        http.get('*/api/graph/entities', () => HttpResponse.json({ data: { items: [null], nextCursor: null } })),
      );
      const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: graphReader } });
      await waitFor(() => expect(graphRequests).toHaveLength(1));
      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          'Knowledge section failed to render:',
          expect.anything(),
          expect.anything(),
        ),
      );
      expect(container).toBeEmptyDOMElement();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('asks nothing and renders nothing without graph:read', async () => {
    const { container } = render(<KnowledgeSection />, { wrapperOptions: { user: noGraphUser } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
    expect(graphRequests).toHaveLength(0);
  });
});
