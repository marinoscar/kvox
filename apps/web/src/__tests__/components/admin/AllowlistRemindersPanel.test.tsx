/**
 * Component tests, Admin -> Users & Allowlist -> Reminders (issue #301, re-homed
 * by #465).
 *
 * These are the reminder assertions of the old `AllowlistTable.test.tsx`
 * (`reminders` block), ported to the panel that now owns the feature. What
 * changed with the move:
 *
 *   - The entries come from the PLATFORM's `useAllowlist` (mocked here at the
 *     headless entry, partially, so `usePermissions` stays real).
 *   - The counts are no longer on the entry: they come from KVox's
 *     `GET /api/allowlist/reminders?ids=` (mocked at the service) and are joined
 *     by id, so there are new cases for the join and for its failure.
 *   - The panel lists PENDING entries only, so the old "no control on a claimed
 *     row" case becomes "the list is requested with status=pending".
 *
 * Table mechanics are asserted once by the DataTable conformance suite and are
 * not repeated.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import { AllowlistRemindersPanel } from '../../../components/admin/AllowlistRemindersPanel';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { ApiError, api } from '../../../services/api';
import type { AllowedEmailEntry } from '@marinoscar/platform-web/identity/headless';

vi.mock('@marinoscar/platform-web/identity/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/identity/headless')>()),
  useAllowlist: vi.fn(),
}));

vi.mock('../../../services/allowlistReminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/allowlistReminders')>()),
  getAllowlistReminders: vi.fn(),
  sendAllowlistReminder: vi.fn(),
}));

import { useAllowlist } from '@marinoscar/platform-web/identity/headless';
import {
  getAllowlistReminders,
  sendAllowlistReminder,
} from '../../../services/allowlistReminders';

const mockUseAllowlist = vi.mocked(useAllowlist);
const mockGetReminders = vi.mocked(getAllowlistReminders);
const mockSendReminder = vi.mocked(sendAllowlistReminder);
const mockFetchAllowlist = vi.fn();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const neverReminded: AllowedEmailEntry = {
  id: 'entry-1',
  email: 'pending@example.com',
  notes: null,
  addedAt: '2024-01-15T10:00:00Z',
  addedBy: { id: 'admin-id', email: 'admin@example.com' },
  claimedAt: null,
  claimedBy: null,
};

const chased: AllowedEmailEntry = {
  ...neverReminded,
  id: 'entry-4',
  email: 'chased@example.com',
};

const CHASED_AT = '2024-01-18T09:30:00Z';
const chasedText = new Date(CHASED_AT).toLocaleString();

function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

function setHookState({
  entries = [] as AllowedEmailEntry[],
  total = entries.length,
  isLoading = false,
  error = null as string | null,
} = {}) {
  mockUseAllowlist.mockReturnValue({
    entries,
    total,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    isLoading,
    error,
    fetchAllowlist: mockFetchAllowlist,
    addEmail: vi.fn(),
    removeEmail: vi.fn(),
  });
}

function renderPanel(permissions: string[] = mockAdminUser.permissions, width = 1400) {
  setInitialContainerWidth(width);
  return render(<AllowlistRemindersPanel />, { wrapperOptions: { user: userWith(permissions) } });
}

const sendButton = (email: string) =>
  screen.queryByRole('button', { name: `Send reminder to ${email}` });

// ---------------------------------------------------------------------------

describe('AllowlistRemindersPanel', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // The table's saved-layout read (`GET /user-settings`) and write.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockGetReminders.mockResolvedValue([]);
    mockSendReminder.mockResolvedValue({ reminderCount: 1, lastReminderAt: '2024-01-19T08:00:00Z' });
    setHookState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading the list', () => {
    it('asks for PENDING entries only', async () => {
      renderPanel();

      await waitFor(() => expect(mockFetchAllowlist).toHaveBeenCalled());
      expect(mockFetchAllowlist).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'pending', page: 1 }),
      );
    });

    it('reads the reminder history for exactly the ids on screen', async () => {
      setHookState({ entries: [neverReminded, chased], total: 2 });
      renderPanel();

      await screen.findByText('chased@example.com');
      await waitFor(() =>
        expect(mockGetReminders).toHaveBeenCalledWith(['entry-1', 'entry-4']),
      );
    });

    it('says so when nobody is waiting on an invitation', async () => {
      renderPanel();

      expect(await screen.findByText('No pending invitations')).toBeInTheDocument();
    });

    it('surfaces a failed list load', async () => {
      setHookState({ error: 'Failed to fetch allowlist' });
      renderPanel();

      expect(await screen.findByText('Failed to fetch allowlist')).toBeInTheDocument();
    });
  });

  describe('reminder history', () => {
    it('shows how many reminders have gone out and when the last one did', async () => {
      setHookState({ entries: [chased], total: 1 });
      mockGetReminders.mockResolvedValue([
        { allowedEmailId: 'entry-4', reminderCount: 2, lastReminderAt: CHASED_AT },
      ]);
      renderPanel();

      expect(await screen.findByText(`2 sent · ${chasedText}`)).toBeInTheDocument();
    });

    /** The restraint only works if a real number stands out from a column of zeroes. */
    it('shows no count on a row that has never been reminded', async () => {
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      await waitFor(() => expect(mockGetReminders).toHaveBeenCalled());
      expect(screen.queryByText(/\bsent\b/)).not.toBeInTheDocument();
    });

    it('keeps the list and warns when the history cannot be read', async () => {
      setHookState({ entries: [neverReminded], total: 1 });
      mockGetReminders.mockRejectedValue(new ApiError('History is down', 500));
      renderPanel();

      expect(await screen.findByText('pending@example.com')).toBeInTheDocument();
      expect(await screen.findByText(/reminder history is unavailable: history is down/i)).toBeInTheDocument();
      // Not a dead end: the row can still be reminded.
      expect(sendButton('pending@example.com')).toBeEnabled();
    });
  });

  describe('sending a reminder', () => {
    it('offers the action on a pending row', async () => {
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      expect(sendButton('pending@example.com')).toBeEnabled();
    });

    it('sends the reminder for the row whose button was pressed, and only that one', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [neverReminded, chased], total: 2 });
      renderPanel();

      await screen.findByText('chased@example.com');
      await user.click(sendButton('chased@example.com') as HTMLElement);

      await waitFor(() => expect(mockSendReminder).toHaveBeenCalledWith('entry-4'));
      expect(mockSendReminder).toHaveBeenCalledTimes(1);
    });

    it('renders the new count in place from the response, with no re-list, and confirms', async () => {
      const user = userEvent.setup();
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      expect(screen.queryByText(/\bsent\b/)).not.toBeInTheDocument();
      const listCalls = mockFetchAllowlist.mock.calls.length;

      await user.click(sendButton('pending@example.com') as HTMLElement);

      expect(
        await screen.findByText(`1 sent · ${new Date('2024-01-19T08:00:00Z').toLocaleString()}`),
      ).toBeInTheDocument();
      expect(screen.getByText('Reminder sent to pending@example.com.')).toBeInTheDocument();
      expect(mockFetchAllowlist.mock.calls.length).toBe(listCalls);
      // A second chase is a decision, not a door that closed.
      expect(sendButton('pending@example.com')).toBeEnabled();
    });

    it('explains a 409 as "they have already signed in"', async () => {
      const user = userEvent.setup();
      mockSendReminder.mockRejectedValue(
        new ApiError('Email pending@example.com has already been claimed', 409),
      );
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      await user.click(sendButton('pending@example.com') as HTMLElement);

      expect(
        await screen.findByText(/pending@example\.com has already signed in/i),
      ).toBeInTheDocument();
      // The spinner is released, not left turning.
      await waitFor(() => expect(sendButton('pending@example.com')).toBeEnabled());
    });

    it('explains a 404 as an entry removed somewhere else', async () => {
      const user = userEvent.setup();
      mockSendReminder.mockRejectedValue(new ApiError('Not found', 404));
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      await user.click(sendButton('pending@example.com') as HTMLElement);

      expect(
        await screen.findByText(/no longer exists .* removed somewhere else/i),
      ).toBeInTheDocument();
    });

    it('shows the server\'s own sentence for any other failure', async () => {
      const user = userEvent.setup();
      mockSendReminder.mockRejectedValue(new ApiError('Mail transport is not configured', 503));
      setHookState({ entries: [neverReminded], total: 1 });
      renderPanel();

      await screen.findByText('pending@example.com');
      await user.click(sendButton('pending@example.com') as HTMLElement);

      expect(await screen.findByText('Mail transport is not configured')).toBeInTheDocument();
    });
  });

  /**
   * `allowlist:write` is the exact string `POST /api/allowlist/:id/reminder`
   * enforces. The COUNT is not gated by it: reading the row is `allowlist:read`.
   */
  describe('permission gating', () => {
    it('withholds the button without allowlist:write while keeping the count', async () => {
      setHookState({ entries: [chased], total: 1 });
      mockGetReminders.mockResolvedValue([
        { allowedEmailId: 'entry-4', reminderCount: 2, lastReminderAt: CHASED_AT },
      ]);
      renderPanel(['allowlist:read']);

      expect(await screen.findByText(`2 sent · ${chasedText}`)).toBeInTheDocument();
      expect(sendButton('chased@example.com')).not.toBeInTheDocument();
    });
  });
});
