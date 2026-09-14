/**
 * `components/common/ConfirmByTypingDialog.tsx` — extracted from
 * `PushConfigConfirmDialog` by issue #80 and now shared by two consumers
 * (`PushConfigConfirmDialog` and `UserDataDeleteDialog`). This suite covers
 * the SHARED CONTRACT directly — the clear-on-open-and-on-`resetKey` effect,
 * the exact `typed.trim() === literal` comparison, the disabled-until-match
 * button, `isWorking`, `error`, and the `aria-labelledby` wiring — so a future
 * change to this file cannot silently break one consumer while the other
 * consumer's own suite (which renders it unmocked, but only exercises its OWN
 * two literals) stays green. `PushConfigPage.test.tsx` and
 * `UserDataDeleteDialog.test.tsx` are the two call-site suites; this one is
 * the component's own.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfirmByTypingDialog } from '../../../components/common/ConfirmByTypingDialog';

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmByTypingDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof ConfirmByTypingDialog> = {
    open: true,
    literal: 'DELETE',
    title: 'Delete the thing?',
    consequence: 'The thing is gone forever.',
    confirmLabel: 'Delete it',
    isWorking: false,
    error: null,
    onConfirm,
    onClose,
    ...overrides,
  };
  const result = render(<ConfirmByTypingDialog {...props} />);
  return { ...result, onConfirm, onClose, props };
}

describe('ConfirmByTypingDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the title, the consequence and any extra children', () => {
    renderDialog({ children: <p>Extra detail line.</p> });

    expect(screen.getByText('Delete the thing?')).toBeInTheDocument();
    expect(screen.getByText('The thing is gone forever.')).toBeInTheDocument();
    expect(screen.getByText('Extra detail line.')).toBeInTheDocument();
  });

  // ==========================================================================
  // The comparison: exact, case-sensitive, trimmed
  // ==========================================================================

  describe('the typed-literal comparison', () => {
    it('is disabled until the typed text exactly matches the literal', async () => {
      const user = userEvent.setup();
      renderDialog({ literal: 'DELETE' });

      const field = screen.getByRole('textbox');
      const confirm = screen.getByRole('button', { name: 'Delete it' });
      expect(confirm).toBeDisabled();

      await user.type(field, 'DELET');
      expect(confirm).toBeDisabled();

      await user.type(field, 'E');
      expect(confirm).not.toBeDisabled();
    });

    it('never accepts a different case — lowercase does not satisfy an uppercase literal', async () => {
      const user = userEvent.setup();
      renderDialog({ literal: 'DELETE' });

      await user.type(screen.getByRole('textbox'), 'delete');

      expect(screen.getByRole('button', { name: 'Delete it' })).toBeDisabled();
    });

    it('trims surrounding whitespace before comparing', async () => {
      const user = userEvent.setup();
      renderDialog({ literal: 'DELETE' });

      await user.type(screen.getByRole('textbox'), '  DELETE  ');

      expect(screen.getByRole('button', { name: 'Delete it' })).not.toBeDisabled();
    });

    it('does not accept the literal merely as a substring — "includes" is not the rule', async () => {
      const user = userEvent.setup();
      renderDialog({ literal: 'DELETE' });

      await user.type(screen.getByRole('textbox'), 'PLEASE DELETE THIS');

      expect(screen.getByRole('button', { name: 'Delete it' })).toBeDisabled();
    });

    it('calls onConfirm only once the literal matches, never on a partial or mismatched value', async () => {
      const user = userEvent.setup();
      const { onConfirm } = renderDialog({ literal: 'DELETE' });

      const field = screen.getByRole('textbox');
      await user.type(field, 'WRONG');
      // Disabled, and (being disabled) not clickable at all — the actual
      // guarantee this dialog makes.
      expect(screen.getByRole('button', { name: 'Delete it' })).toBeDisabled();
      expect(onConfirm).not.toHaveBeenCalled();

      await user.clear(field);
      await user.type(field, 'DELETE');
      await user.click(screen.getByRole('button', { name: 'Delete it' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Clearing: on every open, and on every change of resetKey
  // ==========================================================================

  describe('the typed text is cleared', () => {
    it('when the dialog is closed and reopened', async () => {
      const user = userEvent.setup();
      const { rerender, props } = renderDialog({ literal: 'DELETE' });

      await user.type(screen.getByRole('textbox'), 'DELETE');
      expect(screen.getByRole('textbox')).toHaveValue('DELETE');

      rerender(<ConfirmByTypingDialog {...props} open={false} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      rerender(<ConfirmByTypingDialog {...props} open />);
      expect(screen.getByRole('textbox')).toHaveValue('');
    });

    it('when resetKey changes while the dialog stays open — a value typed for one action never carries into another', async () => {
      const user = userEvent.setup();
      const { rerender, props } = renderDialog({ literal: 'ROTATE', resetKey: 'rotate' });

      await user.type(screen.getByRole('textbox'), 'ROTATE');
      expect(screen.getByRole('textbox')).toHaveValue('ROTATE');

      // Same `open`, new `resetKey` and a new (unrelated) literal — modelling
      // switching from one destructive action to another without unmounting.
      rerender(<ConfirmByTypingDialog {...props} literal="REMOVE" resetKey="remove" />);

      expect(screen.getByRole('textbox')).toHaveValue('');
      // And the stale text would not have satisfied the new literal anyway.
      expect(screen.getByRole('button', { name: 'Delete it' })).toBeDisabled();
    });

    it('does NOT clear on a re-render that changes neither open nor resetKey', async () => {
      const user = userEvent.setup();
      const { rerender, props } = renderDialog({ literal: 'DELETE', resetKey: 'a' });

      await user.type(screen.getByRole('textbox'), 'partial');
      rerender(<ConfirmByTypingDialog {...props} error="A fresh error" />);

      expect(screen.getByRole('textbox')).toHaveValue('partial');
    });
  });

  // ==========================================================================
  // isWorking and error
  // ==========================================================================

  describe('isWorking', () => {
    it('disables Cancel and the confirm button, and relabels the confirm button', async () => {
      const user = userEvent.setup();
      renderDialog({ literal: 'DELETE', isWorking: true });

      await user.type(screen.getByRole('textbox'), 'DELETE');

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Delete it' })).not.toBeInTheDocument();
    });
  });

  describe('error', () => {
    it('renders the error text when present', () => {
      renderDialog({ error: 'Something went wrong.' });
      expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    });

    it('renders no error alert when null', () => {
      renderDialog({ error: null });
      // Only the "This cannot be undone" warning alert should exist.
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Cancel
  // ==========================================================================

  it('calls onClose, not onConfirm, when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Accessibility wiring
  // ==========================================================================

  it('wires aria-labelledby to the dialog title element, so the dialog is announced with a name', () => {
    renderDialog({ title: 'Delete the thing?' });

    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();

    const titleEl = document.getElementById(labelledBy as string);
    expect(titleEl).not.toBeNull();
    expect(within(dialog).getByText('Delete the thing?')).toBe(titleEl);
  });
});
