import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ProposalItemEditor } from '../../../components/graph/review/ProposalItemEditor';
import { ApiError } from '../../../services/api';
import type { GraphOntology, ProposalItem } from '../../../services/graph';
import { draftItems, ITEM, mockGraphOntology, proposalItem } from '../../mocks/graphData';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function item(id: string): ProposalItem {
  return draftItems().find((row) => row.id === id)!;
}

function renderEditor(target: ProposalItem, mode: 'edit' | 'type' = 'edit', ontology: GraphOntology = mockGraphOntology()) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onRelink = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ProposalItemEditor
      open
      item={target}
      mode={mode}
      ontology={ontology}
      items={draftItems()}
      onSave={onSave}
      onRelink={onRelink}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onSave, onRelink, onCancel };
}

describe('ProposalItemEditor', () => {
  it('edits an entity from its ontology attributes and saves the whole payload', async () => {
    const user = userEvent.setup();
    const { onSave, baseElement } = renderEditor(item(ITEM.sarah));
    const dialog = screen.getByRole('dialog', { name: 'Edit Sarah Chen' });
    // `Job title` is the `work` domain's mixin on Person — never hand-coded.
    const jobTitle = within(dialog).getByRole('textbox', { name: 'Job title' });
    expect(jobTitle).toHaveValue('Head of Platform');
    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();

    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Sarah C. Chen');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({
      ref: 'e1',
      type: 'Person',
      label: 'Sarah C. Chen',
      aliases: [],
      props: { title: 'Head of Platform' },
      occurredAt: null,
    });
  });

  it('renders a type added to the ontology with no component change', () => {
    const ontology = mockGraphOntology();
    const person = ontology.entityTypes.find((type) => type.key === 'Person')!;
    ontology.entityTypes.push({
      ...person,
      key: 'Vessel',
      label: 'Vessel',
      pluralLabel: 'Vessels',
      attributes: [
        { ...person.attributes[0], key: 'hullNumber', label: 'Hull number', kind: 'text' },
        {
          ...person.attributes[0],
          key: 'flag',
          label: 'Flag state',
          kind: 'select',
          options: { choices: [{ value: 'pt', label: 'Portugal' }] },
        },
      ],
    });
    const vessel = proposalItem({
      id: 'vessel',
      groupKey: 'Other',
      payload: { ref: 'e9', type: 'Vessel', label: 'Santa Maria', aliases: [], props: {}, occurredAt: null },
    });
    renderEditor(vessel, 'edit', ontology);
    expect(screen.getByRole('textbox', { name: 'Hull number' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Flag state' })).toBeInTheDocument();
  });

  it('change type names the fields that will be dropped, and drops them', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor(item(ITEM.sarah), 'type');
    const dialog = screen.getByRole('dialog', { name: 'Change type of Sarah Chen' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Organization' }));
    expect(within(dialog).getByText('These fields will be dropped: Job title')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Website' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'Organization', props: {} }));
  });

  it('maps a 400 details.issues onto the fields', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor(item(ITEM.sarah));
    onSave.mockRejectedValueOnce(
      new ApiError('Invalid payload', 400, 'BAD_REQUEST', {
        issues: [
          { path: ['label'], message: 'Too long' },
          { path: ['props', 'title'], message: 'Not a job title' },
          { path: [], message: 'Something else' },
        ],
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Too long')).toBeInTheDocument();
    expect(screen.getByText('Not a job title')).toBeInTheDocument();
    expect(screen.getByText('Something else')).toBeInTheDocument();
  });

  it('edits a relation: type, validity, and endpoints through relink', async () => {
    const user = userEvent.setup();
    const { onRelink, onSave } = renderEditor(item(ITEM.worksFor));
    const dialog = screen.getByRole('dialog', { name: /Edit Sarah Chen → works for/ });
    expect(within(dialog).getByRole('combobox', { name: 'Relationship' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Valid from')).toHaveValue('2026-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Change To' }));
    expect(onRelink).toHaveBeenCalledWith('to');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'WORKS_FOR' })));
  });

  it('edits a commitment: title, statement, status and due date', async () => {
    renderEditor(item(ITEM.commitment));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Write the rollback plan');
    expect(screen.getByRole('textbox', { name: 'Statement' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByLabelText('Due')).toHaveValue('2026-10-01');
    expect(screen.getByRole('button', { name: 'Change Owner' })).toBeInTheDocument();
  });

  it('edits a person fact with its sensitivity', () => {
    renderEditor(item(ITEM.personFact));
    expect(screen.getByRole('combobox', { name: 'Sensitivity' })).toBeInTheDocument();
  });
});
