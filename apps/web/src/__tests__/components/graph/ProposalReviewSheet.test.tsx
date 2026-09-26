import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ProposalReviewSheet } from '../../../components/graph/review/ProposalReviewSheet';
import { invalidateGraphOntology } from '../../../hooks/useGraphOntology';
import {
  EXISTING_TOM_ID,
  ITEM,
  mockProposalDetail,
  PROPOSAL_ID,
  proposalMock,
} from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { mockAdminUser, render } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

export const graphUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};

const graphReader: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read'],
};

export const AI_CONFIG = {
  available: true,
  provider: 'openai',
  providerLabel: 'OpenAI',
  models: [
    {
      id: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      source: 'catalogue',
      derivedFrom: null,
      structuredOutput: true,
      toolCalling: true,
    },
  ],
  defaultModel: 'gpt-4o-mini',
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  keyConfigured: true,
  graphEnabled: true,
};

beforeEach(() => {
  invalidateGraphOntology();
  proposalMock.reset(mockProposalDetail('draft'));
  server.use(http.get(`${API}/ai/config`, () => HttpResponse.json({ data: AI_CONFIG })));
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSheet(
  props: Partial<Parameters<typeof ProposalReviewSheet>[0]> = {},
  user: MockUser = graphUser,
) {
  const onClose = vi.fn();
  const utils = render(
    <ProposalReviewSheet open onClose={onClose} source={{ noteId: 'n1' }} {...props} />,
    { wrapperOptions: { user } },
  );
  return { ...utils, onClose };
}

async function draftLoaded() {
  await screen.findByRole('heading', { name: /People/ });
}

function lastRequest(path: RegExp) {
  const matches = proposalMock.requests.filter((request) => path.test(request.path));
  return matches[matches.length - 1];
}

describe('ProposalReviewSheet — states', () => {
  it('loading: skeleton rows, busy', async () => {
    server.use(
      http.get(`${API}/graph/notes/:noteId/proposal`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const { container } = renderSheet();
    expect(await screen.findByLabelText('Loading the graph proposal')).toHaveAttribute('aria-busy', 'true');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('error: the server message and Retry', async () => {
    let fail = true;
    server.use(
      http.get(`${API}/graph/notes/:noteId/proposal`, () =>
        fail
          ? HttpResponse.json({ message: 'The graph is unavailable' }, { status: 500 })
          : HttpResponse.json({ data: { proposal: null } }),
      ),
    );
    const user = userEvent.setup();
    const { container } = renderSheet();
    expect(await screen.findByText('The graph is unavailable')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing sent to your graph from this note yet.')).toBeInTheDocument();
  });

  it('empty: Extract requests an extraction with {} and shows progress', async () => {
    proposalMock.reset(null);
    const user = userEvent.setup();
    const { container } = renderSheet();
    expect(await screen.findByText('Nothing sent to your graph from this note yet.')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByText('Reading your note and transcript…')).toBeInTheDocument();
    expect(lastRequest(/\/extract$/)).toEqual({
      method: 'POST',
      path: '/graph/notes/n1/extract',
      body: {},
    });
  });

  it('empty without graph:write: text only', async () => {
    proposalMock.reset(null);
    renderSheet({}, graphReader);
    expect(await screen.findByText('Nothing sent to your graph from this note yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Extract' })).not.toBeInTheDocument();
  });

  it('empty: a custom onRequestExtract replaces the default', async () => {
    proposalMock.reset(null);
    const onRequestExtract = vi.fn();
    const user = userEvent.setup();
    renderSheet({ onRequestExtract });
    await user.click(await screen.findByRole('button', { name: 'Extract' }));
    expect(onRequestExtract).toHaveBeenCalledWith('extract');
    expect(proposalMock.requests).toHaveLength(0);
  });

  it('extracting: progress and the model label, then polling stops once it is a draft', async () => {
    proposalMock.reset(mockProposalDetail('extracting'));
    let reads = 0;
    server.use(
      http.get(`${API}/graph/notes/:noteId/proposal`, () => {
        reads += 1;
        return HttpResponse.json({ data: { proposal: proposalMock.detail } });
      }),
    );
    const { container } = renderSheet();
    expect(await screen.findByText('Reading your note and transcript…')).toBeInTheDocument();
    expect(screen.getAllByText(/GPT-4o mini/).length).toBeGreaterThan(0);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    proposalMock.detail = mockProposalDetail('draft');
    await screen.findByRole('heading', { name: /People/ }, { timeout: 5_000 });
    const settled = reads;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
    expect(reads).toBe(settled);
  });

  it('failed: the recorded reason and Try again', async () => {
    proposalMock.reset(mockProposalDetail('failed'));
    const onRequestExtract = vi.fn();
    const user = userEvent.setup();
    const { container } = renderSheet({ onRequestExtract });
    expect(await screen.findByText('The model returned something unreadable.')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRequestExtract).toHaveBeenCalledWith('re-extract');
  });

  it('draft: header, counts, groups and the commit bar', async () => {
    const { container } = renderSheet();
    await draftLoaded();
    expect(screen.getByText('Extracted with GPT-4o mini')).toBeInTheDocument();
    const counts = proposalMock.detail!.proposal.counts;
    expect(
      screen.getByText(`${counts.accepted} to send · ${counts.pending} undecided · ${counts.rejected} rejected`),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Send to graph (${counts.accepted})` })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Already in your graph (1)' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('stale: says which version it was made from, rows still reviewable', async () => {
    proposalMock.reset(mockProposalDetail('stale'));
    const { container } = renderSheet();
    expect(await screen.findByText(/Made from version 3; the note is now version 4\./)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' })).toBeEnabled();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('committed: read-only rows, Revert… and Re-extract', async () => {
    proposalMock.reset(mockProposalDetail('committed'));
    const { container } = renderSheet();
    expect(await screen.findByText(/^Sent to graph/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-extract' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Send to graph \(/ })).not.toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('reverted: an info notice and Re-extract', async () => {
    proposalMock.reset(mockProposalDetail('reverted'));
    const { container } = renderSheet();
    expect(await screen.findByText(/This proposal was reverted/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-extract' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('ProposalReviewSheet — layout', () => {
  it('is a right-hand region beside the note at desktop width', async () => {
    renderSheet();
    await draftLoaded();
    expect(screen.getByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Graph proposal' })).not.toBeInTheDocument();
  });

  it('is a modal bottom sheet on a phone', async () => {
    act(() => setViewportWidth(390));
    const { baseElement } = renderSheet();
    expect(await screen.findByRole('dialog', { name: 'Graph proposal' })).toBeInTheDocument();
    await draftLoaded();
    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('closes from its header', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Close graph proposal' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ProposalReviewSheet — decisions reach #366 verbatim', () => {
  async function rowMenu(title: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    return { user, menu: await screen.findByRole('menu') };
  }

  it('Reject sends { decision: "reject" } and the row unticks', async () => {
    renderSheet();
    await draftLoaded();
    const { user, menu } = await rowMenu('Sarah Chen');
    await user.click(within(menu).getByRole('menuitem', { name: 'Reject' }));
    await waitFor(() =>
      expect(lastRequest(/items\//)).toEqual({
        method: 'PATCH',
        path: `/graph/proposals/${PROPOSAL_ID}/items/${ITEM.sarah}`,
        body: { decision: 'reject' },
      }),
    );
    expect(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' })).not.toBeChecked();
  });

  it('Undo decision sends { decision: "pending" }', async () => {
    renderSheet();
    await draftLoaded();
    const { user, menu } = await rowMenu('Northwind Robotics');
    await user.click(within(menu).getByRole('menuitem', { name: 'Undo decision' }));
    await waitFor(() => expect(lastRequest(/items\//)?.body).toEqual({ decision: 'pending' }));
  });

  it('Not the same as sends distinctFrom', async () => {
    renderSheet();
    await draftLoaded();
    const { user, menu } = await rowMenu('Tom');
    await user.click(within(menu).getByRole('menuitem', { name: 'Not the same as Tom Baker' }));
    await waitFor(() =>
      expect(lastRequest(/items\//)?.body).toEqual({ decision: 'pending', distinctFrom: [EXISTING_TOM_ID] }),
    );
  });

  it('Link to existing on an entity sends merge_into + mergeIntoId', async () => {
    renderSheet();
    await draftLoaded();
    const { user, menu } = await rowMenu('Tom');
    await user.click(within(menu).getByRole('menuitem', { name: 'Link to existing…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link Tom to an existing entity' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Search your graph' }), 'Tom');
    await user.click(await screen.findByRole('option', { name: /Tom Baker/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(lastRequest(/items\//)).toEqual({
        method: 'PATCH',
        path: `/graph/proposals/${PROPOSAL_ID}/items/${ITEM.tom}`,
        body: { decision: 'merge_into', mergeIntoId: EXISTING_TOM_ID },
      }),
    );
  });

  it('Link to existing on a relation sends relinkTo for one endpoint', async () => {
    renderSheet();
    await draftLoaded();
    const { user, menu } = await rowMenu('Tom → works for → Northwind Robotics');
    await user.click(within(menu).getByRole('menuitem', { name: 'Link to existing…' }));
    const dialog = await screen.findByRole('dialog', { name: /Re-link Tom/ });
    await user.type(within(dialog).getByRole('combobox', { name: 'Search your graph' }), 'Tom');
    await user.click(await screen.findByRole('option', { name: /Tom Baker/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(lastRequest(/items\//)?.body).toEqual({
        decision: 'accept',
        relinkTo: { field: 'from', target: { entityId: EXISTING_TOM_ID } },
      }),
    );
  });

  it('a refused decision puts the row back and says why', async () => {
    server.use(
      http.patch(`${API}/graph/proposals/:id/items/:itemId`, () =>
        HttpResponse.json({ message: 'Nope', details: { reason: 'proposal_not_draft' } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    const box = screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' });
    await user.click(box);
    expect(await screen.findByText('This proposal changed in another tab')).toBeInTheDocument();
    await waitFor(() => expect(box).toBeChecked());
  });

  it('Accept all sends the group\'s non-known ids to the bulk endpoint', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: 'Accept all People' }));
    await waitFor(() =>
      expect(lastRequest(/bulk$/)?.body).toEqual({ itemIds: [ITEM.sarah, ITEM.tom], decision: 'accept' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Send Tom to graph' })).toBeChecked(),
    );
  });

  it('Accept all never ticks a sensitive fact and says so', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: 'Accept all Person facts' }));
    expect(await screen.findByText('1 sensitive fact needs to be accepted one by one')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send On medical leave to graph' })).not.toBeChecked();
  });

  it('Accept all never ticks a closing', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: 'Accept all Closes' }));
    expect(await screen.findByText('1 closing needs to be accepted one by one')).toBeInTheDocument();
  });
});

describe('ProposalReviewSheet — commit, discard, revert', () => {
  it('asks before sending with undecided rows, then announces the commit', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    const { accepted, pending } = proposalMock.detail!.proposal.counts;
    await user.click(screen.getByRole('button', { name: `Send to graph (${accepted})` }));
    const confirm = await screen.findByRole('dialog', { name: 'Send with undecided rows?' });
    expect(
      within(confirm).getByText(
        `${pending} rows are still undecided. They won't be sent, and they won't be remembered as rejected.`,
      ),
    ).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: `Send ${accepted}` }));

    await waitFor(() => expect(lastRequest(/commit$/)?.body).toEqual({}));
    const status = screen
      .getAllByRole('status')
      .find((node) => node.textContent === `Sent ${accepted} rows to your graph`);
    expect(status).toBeDefined();
    expect(await screen.findByText(/^Sent to graph/)).toBeInTheDocument();
    // The snackbar's Undo opens the revert flow.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('dialog', { name: 'Revert this proposal?' })).toBeInTheDocument();
  });

  it('commits straight away when nothing is undecided', async () => {
    const detail = mockProposalDetail('draft');
    detail.items = detail.items.filter((item) => item.decision !== 'pending');
    detail.proposal.counts = { ...detail.proposal.counts, pending: 0 };
    proposalMock.reset(detail);
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: /Send to graph \(/ }));
    await waitFor(() => expect(lastRequest(/commit$/)).toBeDefined());
    expect(screen.queryByRole('dialog', { name: 'Send with undecided rows?' })).not.toBeInTheDocument();
  });

  it('a 409 proposal_not_draft on commit re-reads and says so', async () => {
    server.use(
      http.post(`${API}/graph/proposals/:id/commit`, () =>
        HttpResponse.json({ message: 'x', details: { reason: 'proposal_not_draft' } }, { status: 409 }),
      ),
    );
    const detail = mockProposalDetail('draft');
    detail.proposal.counts = { ...detail.proposal.counts, pending: 0 };
    proposalMock.reset(detail);
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: /Send to graph \(/ }));
    expect(await screen.findByText('This proposal changed in another tab')).toBeInTheDocument();
  });

  it('discard asks, then discards', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this proposal?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(lastRequest(/discard$/)?.body).toEqual({}));
    expect(await screen.findByText(/This proposal was discarded/)).toBeInTheDocument();
  });

  it('shows what the AI saw', async () => {
    const user = userEvent.setup();
    renderSheet();
    await draftLoaded();
    await user.click(screen.getByRole('button', { name: 'Proposal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show what the AI saw' }));
    const dialog = await screen.findByRole('dialog', { name: 'What the AI saw' });
    expect(await within(dialog).findByText('You extract a knowledge graph.')).toBeInTheDocument();
  });

  it('Revert… reverts a committed proposal', async () => {
    proposalMock.reset(mockProposalDetail('committed'));
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole('button', { name: 'Revert…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revert this proposal?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(lastRequest(/revert$/)?.body).toEqual({ confirmPartial: false }));
    expect(await screen.findByText(/This proposal was reverted/)).toBeInTheDocument();
  });
});
