import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { RevertDialog } from '../../../components/graph/review/RevertDialog';
import { revertProposal } from '../../../services/graph';
import { mockProposalDetail, PROPOSAL_ID, proposalMock } from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

beforeEach(() => {
  proposalMock.reset(mockProposalDetail('committed'));
});

function renderDialog() {
  const handlers = { onClose: vi.fn(), onStale: vi.fn(), onReverted: vi.fn() };
  const utils = render(
    <RevertDialog
      open
      onRevert={(confirmPartial) => revertProposal(PROPOSAL_ID, { confirmPartial })}
      {...handlers}
    />,
  );
  return { ...utils, ...handlers };
}

describe('RevertDialog', () => {
  it('explains, then reverts with confirmPartial: false', async () => {
    const user = userEvent.setup();
    const { onReverted, onClose, baseElement } = renderDialog();
    expect(
      screen.getByText("Removes what this proposal added. Anything you've edited or used since stays."),
    ).toBeInTheDocument();
    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(onReverted).toHaveBeenCalled());
    expect(proposalMock.requests.at(-1)?.body).toEqual({ confirmPartial: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('lists what must be kept on a conflict and offers a partial revert', async () => {
    proposalMock.revertConflicts = [
      { kind: 'entity', id: 'f0000000-0000-4000-8000-000000000001', label: 'Sarah Chen', why: 'edited_since' },
      { kind: 'relation', id: 'f0000000-0000-4000-8000-000000000002', label: 'Sarah → Northwind', why: 'referenced_since' },
    ];
    const user = userEvent.setup();
    const { onReverted, baseElement } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revert this proposal?' });
    expect(await within(dialog).findByText('Sarah Chen — edited since')).toBeInTheDocument();
    expect(within(dialog).getByText('Sarah → Northwind — used by something added since')).toBeInTheDocument();
    expect(onReverted).not.toHaveBeenCalled();
    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(within(dialog).getByRole('button', { name: 'Revert the rest' }));
    await waitFor(() => expect(onReverted).toHaveBeenCalledWith(expect.objectContaining({ kept: expect.any(Array) })));
    expect(proposalMock.requests.at(-1)?.body).toEqual({ confirmPartial: true });
  });

  it('a 409 proposal_not_committed re-reads and closes', async () => {
    proposalMock.reset(mockProposalDetail('reverted'));
    const user = userEvent.setup();
    const { onStale, onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(onStale).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows any other error', async () => {
    server.use(
      http.post('*/api/graph/proposals/:id/revert', () =>
        HttpResponse.json({ message: 'Database is sad' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('Database is sad')).toBeInTheDocument();
  });
});
