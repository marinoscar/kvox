import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { SpeakerNameForm } from '../../../components/transcripts/SpeakerNameForm';

/**
 * The shared rename form (#220) — one implementation behind both
 * `SegmentActions`' rename view and `SpeakerActions`' rename view. See the
 * component's own header for why it exists as a component at all: two copies
 * of this field would be two places for the suggestion filter, the trim rule
 * and the scope wording to drift apart.
 */

function renderForm(overrides: Partial<Parameters<typeof SpeakerNameForm>[0]> = {}) {
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const result = render(
    <SpeakerNameForm
      initialName="Ana"
      nameSuggestions={['Ana', 'Ben', 'Carolina']}
      onCancel={onCancel}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { ...result, onCancel, onSave };
}

const field = () => screen.getByRole('combobox', { name: 'Speaker name' });

describe('SpeakerNameForm', () => {
  it('opens seeded with the current name', () => {
    renderForm({ initialName: 'Ana' });

    expect(field()).toHaveValue('Ana');
  });

  it('disables Save while the draft is empty', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(field());

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('disables Save while the draft is all whitespace', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(field());
    await user.type(field(), '   ');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the TRIMMED draft, never the raw one', async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();

    await user.clear(field());
    await user.type(field(), '  Justin  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('Justin');
  });

  it('excludes the current name from its own suggestions', async () => {
    const user = userEvent.setup();
    renderForm({ initialName: 'Ana', nameSuggestions: ['Ana', 'Ben', 'Carolina'] });

    await user.click(field());

    expect(screen.getByRole('option', { name: 'Ben' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Carolina' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ana' })).not.toBeInTheDocument();
  });

  it('states the rename’s scope out loud, in the default wording', () => {
    renderForm();

    expect(
      screen.getByText('Renames this speaker on every line they speak.'),
    ).toBeInTheDocument();
  });

  it('lets a caller override the scope sentence — the guarantee itself is not deletable, only its wording', () => {
    renderForm({ helperText: 'Applies to this line only.' });

    expect(screen.getByText('Applies to this line only.')).toBeInTheDocument();
    expect(
      screen.queryByText('Renames this speaker on every line they speak.'),
    ).not.toBeInTheDocument();
  });

  it('calls onCancel, and never onSave, when Cancel is pressed', async () => {
    const user = userEvent.setup();
    const { onCancel, onSave } = renderForm();

    await user.clear(field());
    await user.type(field(), 'Justin');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
