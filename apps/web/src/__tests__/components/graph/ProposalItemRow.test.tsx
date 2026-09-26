import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ProposalItemRow } from '../../../components/graph/review/ProposalItemRow';
import type { ProposalItemRowProps } from '../../../components/graph/review/ProposalItemRow';
import { FLAG_COPY, HIDDEN_AS_CHIP } from '../../../components/graph/review/flagCopy';
import { PROPOSAL_ITEM_FLAGS } from '../../../services/graph';
import type { ProposalItem } from '../../../services/graph';
import { draftItems, EXISTING_TOM_ID, ITEM, proposalItem } from '../../mocks/graphData';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function renderRow(item: ProposalItem, overrides: Partial<ProposalItemRowProps> = {}) {
  const handlers = {
    onDecide: vi.fn(),
    onEdit: vi.fn(),
    onRelink: vi.fn(),
  };
  const utils = render(
    <ul>
      <ProposalItemRow item={item} items={draftItems()} readOnly={false} {...handlers} {...overrides} />
    </ul>,
  );
  return { ...utils, ...handlers };
}

function row(id: string): ProposalItem {
  const found = draftItems().find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
}

describe('ProposalItemRow — chips', () => {
  it('shows a confident link with its score', async () => {
    const { container } = renderRow(row(ITEM.sarah));
    expect(screen.getByText('Linked to Sarah Chen · 94%')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' })).toBeChecked();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('shows an uncertain row as "Might be …"', () => {
    renderRow(row(ITEM.tom));
    expect(screen.getByText('Might be Tom Baker')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send Tom to graph' })).not.toBeChecked();
  });

  it('shows a new entity, a user-added row and an edited row', () => {
    const { unmount } = renderRow(row(ITEM.northwind));
    expect(screen.getByText('New')).toBeInTheDocument();
    unmount();
    const second = renderRow(row(ITEM.contoso));
    expect(screen.getByText('Added by you')).toBeInTheDocument();
    second.unmount();
    renderRow({ ...row(ITEM.atlas), decision: 'edit' });
    expect(screen.getByText('Edited')).toBeInTheDocument();
  });

  it.each(PROPOSAL_ITEM_FLAGS.filter((flag) => !HIDDEN_AS_CHIP.has(flag)))(
    'renders one chip for the %s flag',
    (flag) => {
      renderRow(proposalItem({ id: `flag-${flag}`, flags: [flag] }));
      expect(screen.getByText(FLAG_COPY[flag])).toBeInTheDocument();
    },
  );

  it('does not chip known / previously rejected (they are disclosures)', () => {
    renderRow(proposalItem({ id: 'known', flags: ['known', 'previously_rejected'] }));
    expect(screen.queryByText(FLAG_COPY.known)).not.toBeInTheDocument();
    expect(screen.queryByText(FLAG_COPY.previously_rejected)).not.toBeInTheDocument();
  });

  it('renders an unknown flag as its raw key', () => {
    renderRow(proposalItem({ id: 'future', flags: ['some_future_flag'] }));
    expect(screen.getByText('some_future_flag')).toBeInTheDocument();
  });

  it('says when the cited text changed', () => {
    renderRow(row(ITEM.tom));
    expect(screen.getByText('Text changed since')).toBeInTheDocument();
  });
});

describe('ProposalItemRow — actions', () => {
  async function openMenu(title: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    return { user, menu: await screen.findByRole('menu') };
  }

  it('reject and undo send their decisions', async () => {
    const { onDecide } = renderRow(row(ITEM.sarah));
    const { user, menu } = await openMenu('Sarah Chen');
    await user.click(within(menu).getByRole('menuitem', { name: 'Reject' }));
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ id: ITEM.sarah }), {
      decision: 'reject',
    });

    const second = await openMenu('Sarah Chen');
    await second.user.click(within(second.menu).getByRole('menuitem', { name: 'Undo decision' }));
    expect(onDecide).toHaveBeenLastCalledWith(expect.anything(), { decision: 'pending' });
  });

  it('"Not the same as" records the candidate in distinctFrom', async () => {
    const { onDecide } = renderRow(row(ITEM.tom));
    const { user, menu } = await openMenu('Tom');
    await user.click(within(menu).getByRole('menuitem', { name: 'Not the same as Tom Baker' }));
    expect(onDecide).toHaveBeenCalledWith(expect.anything(), {
      decision: 'pending',
      distinctFrom: [EXISTING_TOM_ID],
    });
  });

  it('opens the editor, the type changer and the relink dialog', async () => {
    const { onEdit, onRelink } = renderRow(row(ITEM.sarah));
    let opened = await openMenu('Sarah Chen');
    await opened.user.click(within(opened.menu).getByRole('menuitem', { name: 'Edit…' }));
    expect(onEdit).toHaveBeenLastCalledWith(expect.anything(), 'edit');
    opened = await openMenu('Sarah Chen');
    await opened.user.click(within(opened.menu).getByRole('menuitem', { name: 'Change type…' }));
    expect(onEdit).toHaveBeenLastCalledWith(expect.anything(), 'type');
    opened = await openMenu('Sarah Chen');
    await opened.user.click(within(opened.menu).getByRole('menuitem', { name: 'Link to existing…' }));
    expect(onRelink).toHaveBeenCalledWith(expect.objectContaining({ id: ITEM.sarah }));
  });

  it('unticking rejects and ticking accepts', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderRow(row(ITEM.sarah));
    await user.click(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' }));
    expect(onDecide).toHaveBeenLastCalledWith(expect.anything(), { decision: 'reject' });
  });

  it('disables a row whose endpoint is still undecided and says why', async () => {
    const { container } = renderRow(row(ITEM.tomWorksFor));
    expect(
      screen.getByRole('checkbox', { name: 'Send Tom → works for → Northwind Robotics to graph' }),
    ).toBeDisabled();
    expect(screen.getByText('Accept or link Tom first')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives a sensitive fact an explicit Accept', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderRow(row(ITEM.personFact));
    expect(screen.getByText('Sensitive')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept On medical leave' }));
    expect(onDecide).toHaveBeenCalledWith(expect.anything(), { decision: 'accept' });
  });

  it('has no actions when read-only', () => {
    renderRow(row(ITEM.sarah), { readOnly: true });
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Send Sarah Chen to graph' })).toBeDisabled();
  });

  it('expands its evidence', async () => {
    const user = userEvent.setup();
    renderRow(row(ITEM.sarah));
    await user.click(screen.getByRole('button', { name: 'Evidence (1)' }));
    expect(await screen.findByText(/Sarah from Northwind will lead/)).toBeInTheDocument();
  });
});
