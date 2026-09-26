/**
 * `UserDataDeleteDialog` — issue #80.
 *
 * The one thing this dialog exists to guarantee is that a literal typed for
 * one scope can never authorise another — five scopes sit three clicks apart
 * on the same page, and their consequences differ by orders of magnitude. So
 * the cross-scope rejection below is the suite's centrepiece; everything else
 * (the force semantics, the inventory line, isWorking/error passthrough) is
 * the rest of the acceptance criteria.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  FORCE_SEMANTICS,
  USER_DATA_DELETE_LITERALS,
  UserDataDeleteDialog,
} from '../../../components/settings/UserDataDeleteDialog';
import type { UserDataScope, UserDataSummary } from '../../../services/userData';

const ALL_SCOPES: UserDataScope[] = ['transcripts', 'notes', 'files', 'content', 'everything'];
const COMPOUND_SCOPES: UserDataScope[] = ['content', 'everything'];
const NARROW_SCOPES: UserDataScope[] = ['transcripts', 'notes', 'files'];

const RICH_SUMMARY: UserDataSummary = {
  transcripts: { count: 4, bytes: '900000000' },
  notes: { count: 8, bytes: '300000000' },
  files: { count: 2, bytes: '100000000' },
  noteTemplates: { count: 5 },
  credentials: { aiKeys: 1, accessTokens: 2 },
  graph: { entities: 3, items: 5 },
  activeDeletion: null,
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof UserDataDeleteDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof UserDataDeleteDialog> = {
    scope: 'notes',
    summary: RICH_SUMMARY,
    isWorking: false,
    error: null,
    onConfirm,
    onClose,
    ...overrides,
  };
  const result = render(<UserDataDeleteDialog {...props} />);
  return { ...result, onConfirm, onClose, props };
}

describe('UserDataDeleteDialog', () => {
  it('renders nothing when scope is null', () => {
    renderDialog({ scope: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ==========================================================================
  // The whole reason this dialog exists: cross-scope literal rejection
  // ==========================================================================

  describe('a literal typed for one scope never satisfies another scope’s dialog', () => {
    it.each(ALL_SCOPES)('the %s dialog accepts only its own literal', async (scope) => {
      const user = userEvent.setup();
      renderDialog({ scope });

      const field = screen.getByRole('textbox');
      const confirm = screen.getByRole('button', { name: /^delete/i });

      for (const other of ALL_SCOPES) {
        if (other === scope) continue;
        await user.clear(field);
        await user.type(field, USER_DATA_DELETE_LITERALS[other]);
        expect(confirm, `"${USER_DATA_DELETE_LITERALS[other]}" (scope ${other}) wrongly enabled the ${scope} dialog`).toBeDisabled();
      }

      await user.clear(field);
      await user.type(field, USER_DATA_DELETE_LITERALS[scope]);
      expect(confirm).not.toBeDisabled();
    });
  });

  // ==========================================================================
  // The typed text is cleared on open and on scope change
  // ==========================================================================

  it('clears typed text when the scope changes — a word typed for one action cannot carry over after the shared dialog instance is reused', async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderDialog({ scope: 'notes' });

    await user.type(screen.getByRole('textbox'), 'NOTES');
    expect(screen.getByRole('textbox')).toHaveValue('NOTES');

    rerender(<UserDataDeleteDialog {...props} scope="content" />);

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^delete/i })).toBeDisabled();
  });

  it('clears typed text when reopened after being closed (scope null then set again)', async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderDialog({ scope: 'files' });

    await user.type(screen.getByRole('textbox'), 'partial');

    rerender(<UserDataDeleteDialog {...props} scope={null} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<UserDataDeleteDialog {...props} scope="files" />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  // ==========================================================================
  // Confirm gating: disabled until it matches, disabled while working
  // ==========================================================================

  it('confirm stays disabled while isWorking, even with the exact literal typed', async () => {
    const user = userEvent.setup();
    renderDialog({ scope: 'transcripts', isWorking: true });

    await user.type(screen.getByRole('textbox'), USER_DATA_DELETE_LITERALS.transcripts);

    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  // ==========================================================================
  // FORCE_SEMANTICS — rendered for every scope, narrow and compound alike
  // ==========================================================================

  it.each(ALL_SCOPES)('renders all three force-delete statements for the %s scope', (scope) => {
    renderDialog({ scope });

    for (const line of FORCE_SEMANTICS) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
  });

  // ==========================================================================
  // The inventory line — compound scopes only
  // ==========================================================================

  it.each(COMPOUND_SCOPES)('renders the itemised inventory line for the compound %s scope', (scope) => {
    renderDialog({ scope, summary: RICH_SUMMARY });

    expect(screen.getByText(/right now that is/i)).toBeInTheDocument();
  });

  // #357: a destructive confirmation must not understate what it deletes.
  it.each(COMPOUND_SCOPES)('names the knowledge graph counts in the %s inventory line', (scope) => {
    renderDialog({ scope, summary: RICH_SUMMARY });

    expect(
      screen.getByText(/3 knowledge graph entities and 5 knowledge graph facts/i),
    ).toBeInTheDocument();
  });

  it.each(NARROW_SCOPES)('renders NO inventory line for the narrow %s scope', (scope) => {
    renderDialog({ scope, summary: RICH_SUMMARY });

    expect(screen.queryByText(/right now that is/i)).not.toBeInTheDocument();
  });

  it('renders no inventory line for a compound scope when the summary is not yet known', () => {
    renderDialog({ scope: 'everything', summary: null });

    expect(screen.queryByText(/right now that is/i)).not.toBeInTheDocument();
  });

  // ==========================================================================
  // error passthrough
  // ==========================================================================

  it('renders the error passed to it', () => {
    renderDialog({ scope: 'notes', error: 'A deletion is already running.' });

    expect(screen.getByText('A deletion is already running.')).toBeInTheDocument();
  });

  // ==========================================================================
  // onConfirm / onClose
  // ==========================================================================

  it('calls onConfirm only once the exact literal is typed, and onClose on Cancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = renderDialog({ scope: 'files' });

    await user.type(screen.getByRole('textbox'), 'wrong');
    // Disabled, and therefore not clickable at all.
    expect(screen.getByRole('button', { name: /^delete/i })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), USER_DATA_DELETE_LITERALS.files);
    await user.click(screen.getByRole('button', { name: /^delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // What survives is stated only for the two compound scopes
  // ==========================================================================

  it('states what survives only for the two compound scopes, not the three narrow ones', () => {
    for (const scope of NARROW_SCOPES) {
      const { unmount } = render(
        <UserDataDeleteDialog
          scope={scope}
          summary={RICH_SUMMARY}
          isWorking={false}
          error={null}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByText(/your account is not deleted/i)).not.toBeInTheDocument();
      unmount();
    }

    render(
      <UserDataDeleteDialog
        scope="content"
        summary={RICH_SUMMARY}
        isWorking={false}
        error={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/your account is not deleted/i)).toBeInTheDocument();
  });
});
