/**
 * `AttributeDefDialog` (issue #369, docs/specs/ontology.md §17.3).
 *
 * Rendered directly with `onCreate`/`onUpdate` spies, so each assertion is
 * about the exact #355 body the dialog hands its caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { mockAttributeDef } from '../../mocks/graphData';
import { AttributeDefDialog } from '../../../components/graph/settings/AttributeDefDialog';
import { ApiError } from '../../../services/api';
import type { AttributeDef } from '../../../services/graph';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const ENTITY_TYPES = [
  { key: 'Person', label: 'Person', sensitivityDefault: 'personal' as const },
  { key: 'Organization', label: 'Organization', sensitivityDefault: 'business' as const },
];

function renderDialog(def?: AttributeDef) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const result = render(
    <AttributeDefDialog
      open
      def={def ?? null}
      entityTypes={ENTITY_TYPES}
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
    />,
  );
  return { ...result, onCreate, onUpdate, onClose };
}

async function chooseKind(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Kind' }));
  await user.click(screen.getByRole('option', { name }));
}

describe('AttributeDefDialog', () => {
  it('creates a text attribute with the #355 body', async () => {
    const user = userEvent.setup();
    const { onCreate, onClose } = renderDialog();

    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Nickname');
    await user.click(screen.getByRole('switch', { name: /let extraction fill this in/i }));
    await user.type(
      screen.getByRole('textbox', { name: /hint for extraction/i }),
      'How teammates address them',
    );
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        entityType: 'Person',
        label: 'Nickname',
        kind: 'text',
        extractable: true,
        extractionHint: 'How teammates address them',
        sortOrder: 0,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('requires a hint when extraction may fill the attribute in', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Nickname');
    await user.click(screen.getByRole('switch', { name: /let extraction fill this in/i }));
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    expect(await screen.findByText('Describe what extraction should look for.')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows the choices editor for select kinds, and needs at least one labelled choice', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    expect(screen.queryByText('Choices')).not.toBeInTheDocument();
    await chooseKind(user, 'One of a list');
    expect(screen.getByText('Choices')).toBeInTheDocument();
    // The only choice cannot be removed: at least one is required.
    expect(screen.getByRole('button', { name: 'Remove choice 1' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Industry');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(await screen.findByText('Every choice needs a label.')).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'Choice 1' }), 'Software & SaaS');
    await user.click(screen.getByRole('button', { name: 'Add choice' }));
    await user.type(screen.getByRole('textbox', { name: 'Choice 2' }), 'Retail');
    // Reorder: Retail first.
    await user.click(screen.getByRole('button', { name: 'Move choice 2 up' }));
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'select',
          options: {
            choices: [
              { value: 'retail', label: 'Retail' },
              { value: 'software_saas', label: 'Software & SaaS' },
            ],
          },
        }),
      ),
    );
  });

  it('asks for target types on an entity_ref', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await chooseKind(user, 'Link to another entity');
    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Reports to');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(await screen.findByText('Choose at least one type it can link to.')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Links to' }));
    await user.click(screen.getByRole('option', { name: 'Person' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'entity_ref', options: { targetTypes: ['Person'] } }),
      ),
    );
  });

  it('on edit, kind and entity type are fixed and only changed fields are sent', async () => {
    const user = userEvent.setup();
    const def = mockAttributeDef();
    const { onUpdate, onCreate } = renderDialog(def);

    expect(screen.getByRole('dialog', { name: 'Edit attribute' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: 'Entity type' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const label = screen.getByRole('textbox', { name: /label/i });
    await user.clear(label);
    await user.type(label, 'Nick');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(def.id, { label: 'Nick' }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('on edit, saved choices can be renamed but not removed; new ones can be added', async () => {
    const user = userEvent.setup();
    const def = mockAttributeDef({
      kind: 'select',
      options: { choices: [{ value: 'saas', label: 'SaaS' }] },
      extractable: false,
      extractionHint: null,
    });
    const { onUpdate } = renderDialog(def);

    expect(
      screen.getByRole('button', { name: 'Choice 1 is saved and cannot be removed' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add choice' }));
    await user.type(screen.getByRole('textbox', { name: 'Choice 2' }), 'Retail');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(def.id, {
        options: {
          choices: [
            { value: 'saas', label: 'SaaS' },
            { value: 'retail', label: 'Retail' },
          ],
        },
      }),
    );
  });

  it('maps a 400 from #355 to the field it names', async () => {
    const user = userEvent.setup();
    const { onCreate, onClose } = renderDialog();
    onCreate.mockRejectedValue(
      new ApiError('You already have 50 attributes on Person. Deprecate one first.', 400),
    );

    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Nickname');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    const entityType = screen.getByRole('combobox', { name: 'Entity type' }).closest('.MuiFormControl-root')!;
    expect(
      await within(entityType as HTMLElement).findByText(/already have 50 attributes on Person/),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an unrecognised refusal above the form rather than swallowing it', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();
    onCreate.mockRejectedValue(new ApiError('Something unexpected', 409));

    await user.type(screen.getByRole('textbox', { name: /label/i }), 'Nickname');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something unexpected');
  });

  it('has no axe violations', async () => {
    const { baseElement } = renderDialog();

    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();
  });
});
