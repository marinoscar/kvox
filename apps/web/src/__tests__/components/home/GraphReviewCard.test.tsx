import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { GraphReviewCard } from '../../../components/home/GraphReviewCard';
import { invalidateGraphOntology } from '../../../hooks/useGraphOntology';
import {
  mockGraphAiConfig,
  mockProposalDetail,
  proposalMock,
  proposalSummaryRow,
} from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { mockAdminUser, render } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const graphUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};

const RESOLUTION_ID = 'f0000000-0000-4000-8000-000000000001';

let listRequests: string[];
let drafts = [
  proposalSummaryRow('p-1', { noteId: 'n1', noteTitle: 'Weekly sync — minutes' }),
  proposalSummaryRow(RESOLUTION_ID, { kind: 'resolution', noteId: null, noteTitle: null }),
];

beforeEach(() => {
  mockNavigate.mockClear();
  invalidateGraphOntology();
  listRequests = [];
  drafts = [
    proposalSummaryRow('p-1', { noteId: 'n1', noteTitle: 'Weekly sync — minutes' }),
    proposalSummaryRow(RESOLUTION_ID, { kind: 'resolution', noteId: null, noteTitle: null }),
  ];
  const resolution = mockProposalDetail('draft');
  resolution.proposal = { ...resolution.proposal, id: RESOLUTION_ID, kind: 'resolution', noteId: null };
  proposalMock.reset(resolution);
  server.use(
    http.get(`${API}/ai/config`, () => HttpResponse.json({ data: mockGraphAiConfig() })),
    http.get(`${API}/graph/proposals`, ({ request }) => {
      listRequests.push(new URL(request.url).search);
      return HttpResponse.json({ data: { items: drafts, nextCursor: null } });
    }),
  );
});

function renderCard(route = '/') {
  return render(<GraphReviewCard />, { wrapperOptions: { user: graphUser, route } });
}

describe('GraphReviewCard', () => {
  it('lists drafts under "Waiting for review"', async () => {
    const { container } = renderCard();
    const section = await screen.findByRole('region', { name: 'Waiting for review' });
    expect(within(section).getByText('2 drafts')).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Weekly sync — minutes', level: 3 })).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Possible duplicates in your graph' })).toBeInTheDocument();
    const pending = drafts[0].counts.pending;
    expect(within(section).getAllByText(new RegExp(`^${pending} to review · `))).toHaveLength(2);
    expect(listRequests).toEqual(['?status=draft&limit=5']);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('an extraction draft opens its note with the sheet', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Review Weekly sync — minutes' }));
    expect(mockNavigate).toHaveBeenCalledWith('/notes/n1?review=1');
  });

  it('a resolution proposal opens the review sheet on Home', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Review Possible duplicates in your graph' }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
  });

  it('?review=<id> opens the sheet directly, and closing clears it', async () => {
    const user = userEvent.setup();
    renderCard(`/?review=${RESOLUTION_ID}`);
    const sheet = await screen.findByRole('region', { name: 'Graph proposal' });
    await user.click(within(sheet).getByRole('button', { name: /Close/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Graph proposal' })).not.toBeInTheDocument());
  });

  it('renders nothing without drafts', async () => {
    drafts = [];
    const { container } = renderCard();
    await waitFor(() => expect(listRequests).toHaveLength(1));
    await waitFor(() => expect(screen.queryByLabelText('Loading drafts waiting for review')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing and asks for nothing while the graph is off', async () => {
    server.use(http.get(`${API}/ai/config`, () => HttpResponse.json({ data: mockGraphAiConfig({ graphEnabled: false }) })));
    const { container } = renderCard();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
    expect(listRequests).toEqual([]);
  });

  it('renders nothing when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let asked = 0;
    server.use(
      http.get(`${API}/graph/proposals`, () => {
        asked += 1;
        return HttpResponse.json({ message: 'boom' }, { status: 500 });
      }),
    );
    const { container } = renderCard();
    await waitFor(() => expect(asked).toBe(1));
    await waitFor(() => expect(screen.queryByLabelText('Loading drafts waiting for review')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });

  it('phone: full-width rows with 44 px targets', async () => {
    setViewportWidth(390);
    const { container } = renderCard();
    const button = await screen.findByRole('button', { name: 'Review Weekly sync — minutes' });
    expect(button).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
