import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { GuideGraphPanel } from '../../../components/graph/guide/GuideGraphPanel';
import { forgetEntityLabels, rememberEntityLabel } from '../../../components/graph/guide/guidance';
import type { UserGuidance } from '../../../services/graph';
import { EXISTING_SARAH_ID, EXISTING_TOM_ID, mockGraphOntology } from '../../mocks/graphData';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function Harness({
  initial = { pinnedEntityIds: [], instructions: '' },
  onChange = () => {},
  invalid,
}: {
  initial?: UserGuidance;
  onChange?: (value: UserGuidance) => void;
  invalid?: { unknownTypes?: string[]; invalidPinnedIds?: string[] };
}) {
  const [value, setValue] = useState(initial);
  return (
    <GuideGraphPanel
      value={value}
      ontology={mockGraphOntology()}
      invalid={invalid}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

beforeEach(() => {
  forgetEntityLabels();
});

describe('GuideGraphPanel', () => {
  it('groups extractable types by domain, all checked by default', async () => {
    const { container } = render(<Harness />);
    const group = screen.getByRole('group', { name: 'Extract these types' });
    expect(within(group).getByText('Core')).toBeInTheDocument();
    expect(within(group).getByText('Work')).toBeInTheDocument();
    for (const label of ['Person', 'Organization', 'Claim', 'Person fact', 'Project', 'Commitment', 'Decision']) {
      expect(within(group).getByRole('checkbox', { name: label })).toHaveAttribute('aria-checked', 'true');
    }
    // Not extractable → never offered.
    expect(within(group).queryByRole('checkbox', { name: 'Meeting' })).not.toBeInTheDocument();
    expect(screen.getByText('All types')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('unchecking narrows the list; re-checking all omits the field again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: 'Claim' }));
    const narrowed = onChange.mock.calls.at(-1)![0] as UserGuidance;
    expect(narrowed.entityTypes).toHaveLength(6);
    expect(narrowed.entityTypes).not.toContain('Claim');
    expect(screen.getByText('6 of 7 types')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Claim' }));
    expect((onChange.mock.calls.at(-1)![0] as UserGuidance).entityTypes).toBeUndefined();
  });

  it('cannot uncheck the last entity type', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ pinnedEntityIds: [], instructions: '', entityTypes: ['Person'] }} onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: 'Person' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Person' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Keep at least one type/)).toBeInTheDocument();
  });

  it('relationship types sit in a disclosure', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const toggle = screen.getByRole('button', { name: 'Relationships (all)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const group = await screen.findByRole('group', { name: 'Relationships to extract' });
    await user.click(within(group).getByRole('checkbox', { name: 'Reports to' }));
    const next = onChange.mock.calls.at(-1)![0] as UserGuidance;
    expect(next.relationTypes).not.toContain('REPORTS_TO');
    expect(next.entityTypes).toBeUndefined();
  });

  it('counts instruction characters up to 2 000', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Instructions' });
    expect(field).toHaveAttribute('placeholder', expect.stringContaining('Only the vendor migration'));
    expect(screen.getByText('0 / 2000')).toBeInTheDocument();
    await user.type(field, 'Only Q2');
    expect(screen.getByText('7 / 2000')).toBeInTheDocument();
    expect(field).toHaveAttribute('maxlength', '2000');
  });

  it('pins an entity from search as a chip, and unpins it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByRole('combobox', { name: 'Search your graph' }), 'Tom');
    await user.click(await screen.findByRole('option', { name: /Tom Baker/ }));
    expect((onChange.mock.calls.at(-1)![0] as UserGuidance).pinnedEntityIds).toEqual([EXISTING_TOM_ID]);
    const pinned = screen.getByRole('list', { name: 'Focused entities' });
    const chip = within(pinned).getByRole('button', { name: /Tom Baker/ });
    chip.focus();
    await user.keyboard('{Backspace}');
    expect((onChange.mock.calls.at(-1)![0] as UserGuidance).pinnedEntityIds).toEqual([]);
  });

  it('highlights what the server refused', () => {
    rememberEntityLabel(EXISTING_SARAH_ID, 'Sarah Chen');
    render(
      <Harness
        initial={{ pinnedEntityIds: [EXISTING_SARAH_ID], instructions: '', entityTypes: ['Person', 'Vendor'] }}
        invalid={{ unknownTypes: [], invalidPinnedIds: [EXISTING_SARAH_ID] }}
      />,
    );
    expect(screen.getByText('Sarah Chen (no longer in your graph)')).toBeInTheDocument();
  });
});
