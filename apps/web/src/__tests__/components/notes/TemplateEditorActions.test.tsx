import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { TemplateEditorActions } from '../../../components/notes/TemplateEditorActions';

/**
 * `TemplateEditorActions` — the note template editor's Save/Create row,
 * issue #331. See the component's own header for why it exists as the
 * editor's sticky footer rather than a second copy of the top-bar button.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function renderActions(overrides: Partial<Parameters<typeof TemplateEditorActions>[0]> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <TemplateEditorActions
      primaryLabel="Create template"
      onSave={onSave}
      onCancel={onCancel}
      disabled={false}
      isSaving={false}
      {...overrides}
    />,
  );
  return { onSave, onCancel, ...utils };
}

describe('TemplateEditorActions', () => {
  it('shows the given primary label when idle', () => {
    renderActions({ primaryLabel: 'Save changes' });

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('shows "Saving…" and disables both buttons while saving', () => {
    renderActions({ isSaving: true, primaryLabel: 'Save changes' });

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // The label given never leaks through while saving.
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('shows the shortcut hint when enabled, with no disabled reason', () => {
    renderActions();

    expect(screen.getByText('Ctrl/⌘ + S to save')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Create template' });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-describedby');
  });

  it('disables the primary button and shows the reason, linked via aria-describedby', () => {
    renderActions({ disabled: true, disabledReason: 'Add a name to save' });

    const hint = screen.getByText('Add a name to save');
    expect(hint).toBeInTheDocument();
    expect(screen.queryByText('Ctrl/⌘ + S to save')).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Create template' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', hint.id);
  });

  it('falls back to the shortcut hint when disabled with no reason given', () => {
    renderActions({ disabled: true, disabledReason: null });

    expect(screen.getByText('Ctrl/⌘ + S to save')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Create template' });
    expect(button).toBeDisabled();
    // No reason to point at, so nothing is described.
    expect(button).not.toHaveAttribute('aria-describedby');
  });

  it('calls onSave when the primary button is pressed', async () => {
    const user = userEvent.setup();
    const { onSave } = renderActions();

    await user.click(screen.getByRole('button', { name: 'Create template' }));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is pressed', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderActions();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onSave when the primary button is disabled', () => {
    const { onSave } = renderActions({ disabled: true, disabledReason: 'Add a name to save' });

    // A disabled MUI button has `pointer-events: none`, so `userEvent.click`
    // refuses the interaction it is asserting against; `fireEvent` bypasses
    // that and still exercises the browser's own disabled-button behaviour
    // (no click event is dispatched for a disabled `<button>`).
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));

    expect(onSave).not.toHaveBeenCalled();
  });

  it('passes axe', async () => {
    const { container } = renderActions({ disabled: true, disabledReason: 'Add a name to save' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
