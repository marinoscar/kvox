import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ProposalGroup } from '../../../components/graph/review/ProposalGroup';
import { groupProposalItems } from '../../../components/graph/review/proposalGrouping';
import { draftItems, ITEM } from '../../mocks/graphData';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function renderGroup(key: string, readOnly = false) {
  const items = draftItems();
  const group = groupProposalItems(items).find((entry) => entry.key === key)!;
  const onBulk = vi.fn();
  const utils = render(
    <ProposalGroup
      group={group}
      items={items}
      readOnly={readOnly}
      pendingItemIds={new Set()}
      onBulk={onBulk}
      onDecide={vi.fn()}
      onEdit={vi.fn()}
      onRelink={vi.fn()}
    />,
  );
  return { ...utils, onBulk, group };
}

describe('ProposalGroup', () => {
  it('heads the group with its count', async () => {
    const { container } = renderGroup('Person');
    expect(screen.getByRole('heading', { level: 3, name: 'People (3)' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('Accept all / Reject all send the non-known ids', async () => {
    const user = userEvent.setup();
    const { onBulk, group } = renderGroup('Person');
    await user.click(screen.getByRole('button', { name: 'Accept all People' }));
    expect(onBulk).toHaveBeenLastCalledWith(group, [ITEM.sarah, ITEM.tom], 'accept');
    await user.click(screen.getByRole('button', { name: 'Reject all People' }));
    expect(onBulk).toHaveBeenLastCalledWith(group, [ITEM.sarah, ITEM.tom], 'reject');
  });

  it('collapses known rows under "Already in your graph"', async () => {
    const user = userEvent.setup();
    renderGroup('Person');
    expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: 'Already in your graph (1)' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure);
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers no group actions when read-only', () => {
    renderGroup('Person', true);
    expect(screen.queryByRole('button', { name: /Accept all/ })).not.toBeInTheDocument();
  });
});
