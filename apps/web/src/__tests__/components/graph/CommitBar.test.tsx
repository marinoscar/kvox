import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { CommitBar } from '../../../components/graph/review/CommitBar';
import type { ProposalCounts } from '../../../services/graph';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function counts(overrides: Partial<ProposalCounts> = {}): ProposalCounts {
  return { total: 10, pending: 0, accepted: 7, rejected: 3, known: 1, byGroup: {}, ...overrides };
}

function renderBar(value: ProposalCounts, busy = false) {
  const onCommit = vi.fn();
  const onDiscard = vi.fn();
  const utils = render(<CommitBar counts={value} busy={busy} onCommit={onCommit} onDiscard={onDiscard} />);
  return { ...utils, onCommit, onDiscard };
}

describe('CommitBar', () => {
  it('commits at once when nothing is undecided', async () => {
    const user = userEvent.setup();
    const { onCommit, container } = renderBar(counts());
    await user.click(screen.getByRole('button', { name: 'Send to graph (7)' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('asks first when rows are undecided', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderBar(counts({ pending: 2 }));
    await user.click(screen.getByRole('button', { name: 'Send to graph (7)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send with undecided rows?' });
    expect(
      within(dialog).getByText(
        "2 rows are still undecided. They won't be sent, and they won't be remembered as rejected.",
      ),
    ).toBeInTheDocument();
    expect(await axe(dialog, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Keep reviewing' }));
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Send to graph (7)' }));
    await user.click(await screen.findByRole('button', { name: 'Send 7' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('is disabled with nothing to send or while busy', () => {
    const { unmount } = renderBar(counts({ accepted: 0 }));
    expect(screen.getByRole('button', { name: 'Send to graph (0)' })).toBeDisabled();
    unmount();
    renderBar(counts(), true);
    expect(screen.getByRole('button', { name: 'Send to graph (7)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('hands Discard to the sheet', async () => {
    const user = userEvent.setup();
    const { onDiscard } = renderBar(counts());
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
