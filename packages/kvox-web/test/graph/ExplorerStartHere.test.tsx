import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import {
  ExplorerStartHere,
  startColumns,
  sinceDate,
  themeClusters,
  BUILDING_TEXT,
  NO_ACTIVE_TEXT,
  NO_THEMES_TEXT,
} from '../../src/graph/ui/components/explorer/start/ExplorerStartHere.js';
import { ANA_ID, graphEntitySummaries, overviewFixture, overviewStates } from './graphData.js';
import { graphReader } from './graphTestUsers.js';
import { render } from './helpers.js';
import { HttpResponse, http, server } from './msw-compat.js';

const typeLabel = (key: string) => key;

function renderStart(props: Partial<Parameters<typeof ExplorerStartHere>[0]> = {}) {
  const handlers = {
    onChooseEntity: vi.fn(),
    onChooseTheme: vi.fn(),
    onOpenSearch: vi.fn(),
  };
  const view = render(<ExplorerStartHere windowClass="expanded" typeLabel={typeLabel} {...handlers} {...props} />, {
    wrapperOptions: { user: graphReader },
  });
  return { ...view, ...handlers };
}

describe('start-here helpers', () => {
  it('lays the cards out in 1, 2 and 3 columns by window class', () => {
    expect(startColumns('compact')).toBe(1);
    expect(startColumns('medium')).toBe(2);
    expect(startColumns('expanded')).toBe(3);
  });

  it('counts 30 days back as a calendar date', () => {
    expect(sinceDate(30, new Date('2026-10-21T12:00:00Z'))).toBe('2026-09-21');
  });

  it('shows real clusters only, largest first, and nothing for an unready or too-large snapshot', () => {
    expect(themeClusters(overviewFixture()).map((c) => c.label)).toEqual(['Acme Corp', 'Globex', 'Cluster 3']);
    expect(themeClusters(overviewStates.empty())).toEqual([]);
    expect(themeClusters(overviewStates.tooLarge())).toEqual([]);
    expect(themeClusters(null)).toEqual([]);
  });
});

describe('ExplorerStartHere', () => {
  it('has Themes, Who and what is active, and Recent sections, and is axe-clean', async () => {
    const { container } = renderStart();
    expect(await screen.findByRole('heading', { name: 'Themes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Who and what is active' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Acme Corp.*6 things/ })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Last opened' });
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });

  it('chooses a theme with the overview and its cluster id', async () => {
    const user = userEvent.setup();
    const { onChooseTheme } = renderStart();
    await user.click(await screen.findByRole('button', { name: /Globex.*4 things/ }));
    expect(onChooseTheme).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }), 1);
  });

  it('chooses an entity from Active', async () => {
    const user = userEvent.setup();
    const { onChooseEntity } = renderStart();
    const people = await screen.findByRole('region', { name: 'Person' });
    await user.click(within(people).getByRole('button', { name: 'Ana Diaz' }));
    expect(onChooseEntity).toHaveBeenCalledWith(ANA_ID);
  });

  it('opens the palette from the search button', async () => {
    const user = userEvent.setup();
    const { onOpenSearch } = renderStart();
    await user.click(screen.getByRole('button', { name: /Search a person, project or topic/ }));
    expect(onOpenSearch).toHaveBeenCalled();
  });

  it('draws no "Connect two things" prompt until the capability exists', async () => {
    const first = renderStart();
    await screen.findByRole('heading', { name: 'Themes' });
    expect(screen.queryByRole('button', { name: 'Connect two things' })).not.toBeInTheDocument();
    first.unmount();
    const onConnect = vi.fn();
    renderStart({ onConnect });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Connect two things' }));
    expect(onConnect).toHaveBeenCalled();
  });

  it('says it is building the map, and explains an empty one', async () => {
    server.use(http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.building() })));
    const first = renderStart();
    expect(await screen.findByText(BUILDING_TEXT)).toBeInTheDocument();
    first.unmount();
    server.use(http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.empty() })));
    renderStart();
    expect(await screen.findByText(NO_THEMES_TEXT)).toBeInTheDocument();
  });

  it('handles each section being empty', async () => {
    server.use(
      http.get('*/api/graph/entities', () => HttpResponse.json({ data: { items: [], nextCursor: null } })),
      http.get('*/api/graph/overview', () => HttpResponse.json({ data: overviewStates.empty() })),
    );
    renderStart();
    expect(await screen.findByText(NO_ACTIVE_TEXT)).toBeInTheDocument();
    expect(await screen.findByText("You haven't opened anything yet.")).toBeInTheDocument();
    expect(screen.getByText(NO_THEMES_TEXT)).toBeInTheDocument();
  });

  it('survives a failing entity list (an ontology without Product or Topic)', async () => {
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        const type = new URL(request.url).searchParams.get('type');
        if (type === 'Product' || type === 'Topic') {
          return HttpResponse.json({ message: 'Unknown type', statusCode: 400 }, { status: 400 });
        }
        return HttpResponse.json({ data: { items: graphEntitySummaries.filter((s) => s.type === type), nextCursor: null } });
      }),
    );
    renderStart();
    expect(await screen.findByRole('region', { name: 'Person' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Product' })).not.toBeInTheDocument());
  });
});
