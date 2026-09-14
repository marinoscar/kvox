/**
 * `/settings/danger-zone` (issue #80).
 *
 * THE SERVICE MODULE IS MOCKED, NOT THE HOOK — the house pattern
 * `UserAiPage.test.tsx`'s header explains: `useUserData`'s own polling
 * contract (started by STATE rather than by the click, silent on a poll tick,
 * cleaned up on unmount) is exactly what this page's acceptance criteria are
 * about, so the real hook has to sit between the mocked transport and the
 * rendered page. `importOriginal` keeps `scopeIncludes`/`scopeIsCompound`/
 * `USER_DATA_CATEGORIES`/`USER_DATA_CONFIRMATION` REAL — `buildDeletionInventory`
 * and the dialog both call through them at render time, so mocking the whole
 * module wholesale would break the inventory line and the typed-confirmation
 * gate this suite also needs to exercise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('../../services/userData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/userData')>();
  return {
    ...actual,
    getUserDataSummary: vi.fn(),
    createUserDataDeletion: vi.fn(),
  };
});

import { render } from '../utils/test-utils';
import UserDangerZonePage from '../../pages/UserDangerZonePage';
import { ApiError } from '../../services/api';
import { USER_DATA_POLL_INTERVAL_MS } from '../../hooks/useUserData';
import { createUserDataDeletion, getUserDataSummary } from '../../services/userData';
import type { UserDataDeletion, UserDataSummary } from '../../services/userData';

const mockGetSummary = vi.mocked(getUserDataSummary);
const mockCreateDeletion = vi.mocked(createUserDataDeletion);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function emptySummary(overrides: Partial<UserDataSummary> = {}): UserDataSummary {
  return {
    transcripts: { count: 0, bytes: '0' },
    notes: { count: 0, bytes: '0' },
    files: { count: 0, bytes: '0' },
    noteTemplates: { count: 0 },
    credentials: { aiKeys: 0, accessTokens: 0 },
    activeDeletion: null,
    ...overrides,
  };
}

/**
 * 4 recordings, 0 notes (but 5 note templates — the regression guard for the
 * `notes` scope NOT covering `noteTemplates`), 2 files.
 */
const MIXED_SUMMARY: UserDataSummary = emptySummary({
  transcripts: { count: 4, bytes: '900000000' },
  notes: { count: 0, bytes: '0' },
  files: { count: 2, bytes: '100000000' },
  noteTemplates: { count: 5 },
});

function deletion(overrides: Partial<UserDataDeletion> = {}): UserDataDeletion {
  return {
    id: 'deletion-1',
    scope: 'notes',
    status: 'running',
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderPage() {
  const result = render(<UserDangerZonePage />);
  await screen.findByRole('heading', { level: 1, name: 'Delete My Data' });
  return result;
}

describe('UserDangerZonePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSummary.mockResolvedValue(MIXED_SUMMARY);
    mockCreateDeletion.mockResolvedValue(deletion());
  });

  // ==========================================================================
  // The three category rows — live counts, and the note-templates regression
  // guard
  // ==========================================================================

  describe('the three category rows', () => {
    it('renders live counts and sizes for each row', async () => {
      await renderPage();

      expect(screen.getByText('4 recordings · 900 MB')).toBeInTheDocument();
      expect(screen.getByText('No notes stored')).toBeInTheDocument();
      expect(screen.getByText('2 files · 100 MB')).toBeInTheDocument();
    });

    it('disables a row’s own button when its count is zero', async () => {
      await renderPage();

      expect(screen.getByRole('button', { name: 'Delete notes' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete recordings' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete files' })).not.toBeDisabled();
    });

    // ⚠ THE REGRESSION GUARD: `notes` does not cover `noteTemplates`. 0 notes
    // + 5 note templates must still leave the Notes row's button disabled (the
    // row is about NOTES, not templates) and must say nothing about templates
    // at all — a "5 note templates" appearing on this row would be exactly the
    // wrong-scope claim the reversal fixed.
    it('0 notes + 5 note templates leaves the Notes button disabled, and the Notes row names no template', async () => {
      await renderPage();

      const notesButton = screen.getByRole('button', { name: 'Delete notes' });
      expect(notesButton).toBeDisabled();

      const notesRow = notesButton.parentElement as HTMLElement;
      expect(within(notesRow).queryByText(/template/i)).not.toBeInTheDocument();
      expect(within(notesRow).getByText('No notes stored')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // A deletion in flight disables everything and names the scope
  // ==========================================================================

  describe('a deletion in progress', () => {
    it('disables every button and shows the in-progress alert naming the scope', async () => {
      mockGetSummary.mockResolvedValue({
        ...MIXED_SUMMARY,
        activeDeletion: deletion({ scope: 'content' }),
      });

      await renderPage();

      expect(await screen.findByText(/deleting all content/i)).toBeInTheDocument();

      for (const name of [
        'Delete recordings',
        'Delete notes',
        'Delete files',
        'Delete all content',
        'Delete everything',
      ]) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
    });
  });

  // ==========================================================================
  // Polling
  // ==========================================================================

  describe('polling while a deletion is active', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-reads the summary every USER_DATA_POLL_INTERVAL_MS while active, and stops once it clears', async () => {
      vi.useFakeTimers();
      let call = 0;
      mockGetSummary.mockImplementation(async () => {
        call += 1;
        return call < 3
          ? { ...MIXED_SUMMARY, activeDeletion: deletion({ scope: 'notes' }) }
          : { ...MIXED_SUMMARY, activeDeletion: null };
      });

      render(<UserDangerZonePage />);
      await vi.waitFor(() => expect(screen.getByText(/deleting notes/i)).toBeInTheDocument());
      expect(mockGetSummary).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS);
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/deleting notes/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS);
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(3);
      await vi.waitFor(() =>
        expect(screen.queryByText(/deleting notes/i)).not.toBeInTheDocument(),
      );

      // The flag has cleared — no further reads on the same clock.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS * 3);
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(3);
    });

    it('a reload straight into an already-active deletion still polls — the timer is keyed on state, not started by a click', async () => {
      // `shouldAdvanceTime` lets RTL's own `findBy*` (which polls on a real
      // timer under the hood) keep working normally, while
      // `vi.advanceTimersByTimeAsync` below still jumps the clock forward
      // precisely for the interval under test.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockGetSummary.mockResolvedValue({
        ...MIXED_SUMMARY,
        activeDeletion: deletion({ scope: 'files' }),
      });

      render(<UserDangerZonePage />);
      // `findByText` polls through `act`, so this waits for the STATE update
      // (not merely the mock call) to have actually landed before the clock
      // is advanced.
      await screen.findByText(/deleting uploaded files/i);
      expect(mockGetSummary).toHaveBeenCalledTimes(1);

      // No button was ever clicked in this test.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS);
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(2);
    });

    it('a poll tick never replaces the page with a spinner — the read is loading-silent', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockGetSummary.mockResolvedValue({
        ...MIXED_SUMMARY,
        activeDeletion: deletion({ scope: 'files' }),
      });

      render(<UserDangerZonePage />);
      await screen.findByRole('heading', { level: 1, name: 'Delete My Data' });
      expect(mockGetSummary).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS);
      });

      // The heading never left the document, and no spinner ever replaced it.
      expect(screen.getByRole('heading', { level: 1, name: 'Delete My Data' })).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('clears the interval on unmount — no further reads, and no state update on an unmounted component', async () => {
      vi.useFakeTimers();
      mockGetSummary.mockResolvedValue({
        ...MIXED_SUMMARY,
        activeDeletion: deletion({ scope: 'files' }),
      });

      const { unmount } = render(<UserDangerZonePage />);
      await vi.waitFor(() => expect(mockGetSummary).toHaveBeenCalledTimes(1));

      unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(USER_DATA_POLL_INTERVAL_MS * 5);
      });
      // If the timer had survived, this would be > 1 and/or React would warn
      // about a state update on an unmounted component.
      expect(mockGetSummary).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Errors surface as rendered strings, never as unhandled rejections
  // ==========================================================================

  describe('a failed deletion request', () => {
    it('renders the API error inside the dialog and leaves the page usable', async () => {
      const user = userEvent.setup();
      mockCreateDeletion.mockRejectedValue(
        new ApiError('A deletion is already running for your account.', 409),
      );

      await renderPage();
      await user.click(screen.getByRole('button', { name: 'Delete recordings' }));

      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByRole('textbox'), 'TRANSCRIPTS');
      await user.click(within(dialog).getByRole('button', { name: /^delete/i }));

      expect(
        await screen.findByText('A deletion is already running for your account.'),
      ).toBeInTheDocument();
      // The dialog stayed open — a failure is not treated as success, and the
      // explanation the user needs is not thrown away.
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // The page is still usable: Cancel closes it cleanly.
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { level: 1, name: 'Delete My Data' })).toBeInTheDocument();
    });

    it('a load failure is rendered rather than thrown, and the page still renders its chrome', async () => {
      mockGetSummary.mockRejectedValue(new ApiError('Could not reach the server.', 500));

      await renderPage();

      expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // A successful deletion request
  // ==========================================================================

  it('closes the dialog and adopts the returned deletion once a request succeeds', async () => {
    const user = userEvent.setup();
    mockCreateDeletion.mockResolvedValue(deletion({ scope: 'files', status: 'pending' }));
    // First load: nothing active yet, so the button is clickable. The hook
    // re-reads the summary right after a successful request (see its own
    // header on why: it has to, for the case where the optimistic patch has
    // no prior summary to land on) — every read AFTER the first reflects that,
    // the same way a real server's GET would once the job is enqueued.
    mockGetSummary.mockResolvedValueOnce(MIXED_SUMMARY).mockResolvedValue({
      ...MIXED_SUMMARY,
      activeDeletion: deletion({ scope: 'files', status: 'pending' }),
    });

    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete files' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'FILES');
    await user.click(within(dialog).getByRole('button', { name: /^delete/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockCreateDeletion).toHaveBeenCalledWith('files');
    expect(await screen.findByText(/deleting uploaded files/i)).toBeInTheDocument();
  });

  // ==========================================================================
  // Accessibility
  // ==========================================================================

  describe('accessibility', () => {
    it('passes axe on the page itself', async () => {
      const { container } = await renderPage();

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe with the confirmation dialog open', async () => {
      const user = userEvent.setup();
      const { container } = await renderPage();

      await user.click(screen.getByRole('button', { name: 'Delete recordings' }));
      await screen.findByRole('dialog');

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
