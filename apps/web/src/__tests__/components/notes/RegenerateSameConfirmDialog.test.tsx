import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { RegenerateSameConfirmDialog } from '../../../components/notes/RegenerateSameConfirmDialog';
import { REGENERATE_COST_SENTENCE } from '../../../components/notes/regenerateInput';
import type { Note } from '../../../services/notes';

/**
 * `RegenerateSameConfirmDialog` — the one-click "same again" confirmation,
 * issue #312.
 *
 * It holds no controls, so the suite is about what it SAYS (the template
 * name, the shared cost sentence) and what its three buttons do — including
 * that "Change options…" is a distinct action from both Confirm and Cancel.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: 'The first attempt.',
    status: 'ready',
    currentVersion: 2,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: null,
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2024-03-12T10:00:00.000Z',
    updatedAt: '2024-03-12T10:00:00.000Z',
    ...overrides,
  };
}

type Props = React.ComponentProps<typeof RegenerateSameConfirmDialog>;

function setup(overrides: Partial<Props> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const onChangeOptions = vi.fn();

  const view = render(
    <RegenerateSameConfirmDialog
      open
      note={note()}
      busy={false}
      error={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onChangeOptions={onChangeOptions}
      {...overrides}
    />,
  );

  return { ...view, onCancel, onConfirm, onChangeOptions };
}

describe('RegenerateSameConfirmDialog — what it says', () => {
  it('titles itself, names the template in bold, and states the cost sentence', () => {
    setup();

    const dialog = screen.getByRole('dialog', { name: 'Regenerate this note?' });
    const bold = within(dialog).getByText('Meeting minutes');
    expect(bold.tagName).toBe('B');
    expect(within(dialog).getByText(REGENERATE_COST_SENTENCE)).toBeInTheDocument();
  });

  it('falls back to "Current template" when the note carries no name', () => {
    setup({ note: note({ templateName: null }) });

    expect(screen.getByText('Current template').tagName).toBe('B');
  });
});

describe('RegenerateSameConfirmDialog — its three actions', () => {
  it('Confirm calls onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('"Change options…" calls onChangeOptions, not onConfirm', async () => {
    const user = userEvent.setup();
    const { onChangeOptions, onConfirm } = setup();

    await user.click(screen.getByRole('button', { name: 'Change options…' }));

    expect(onChangeOptions).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Cancel calls onCancel', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('RegenerateSameConfirmDialog — busy and error', () => {
  it('disables all three actions while busy, and shows "Starting…"', () => {
    setup({ busy: true });

    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change options…' })).toBeDisabled();
  });

  it('shows a refusal without closing over it', () => {
    setup({ error: 'This note is already generating.' });

    expect(screen.getByRole('alert')).toHaveTextContent('This note is already generating.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RegenerateSameConfirmDialog — accessibility', () => {
  it('has no axe violations', async () => {
    setup();

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
