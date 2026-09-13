/**
 * Admin → Operations → Broadcasts (`/admin/settings/broadcasts`), issue #325,
 * epic #319.
 *
 * The table's MECHANICS are asserted once for every table in
 * `runDataTableConformanceSuite`, and the datetime helpers and wire shapes in
 * `__tests__/services/broadcasts.test.ts`. What is page-specific — and what
 * this file covers — is everything that could be wrong while both of those are
 * perfectly fine:
 *
 *   * rows render with the status chip an operator scans for;
 *   * a read-only admin sees the controls and cannot use ANY of them, rather
 *     than seeing a page with the controls missing;
 *   * Cancel is disabled for a `sent` broadcast and enabled for a `scheduled`
 *     one — the mirror of the API's 409, which is the difference between "this
 *     already went out" and "the system failed";
 *   * the confirmation names the audience count, because this is the one action
 *     in the application that reaches every user at once.
 *
 * The hooks are mocked, as `JobsPage.test.tsx` mocks `useJobs` and
 * `WorkersPage.test.tsx` mocks `useWorkerNodes`: the fetch layer has its own
 * suite, and driving it through msw here would test the transport twice while
 * making every assertion about the page wait on it.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import type { Broadcast } from '../../../services/broadcasts';

vi.mock('../../../hooks/useBroadcasts', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useBroadcasts')>(
    '../../../hooks/useBroadcasts',
  );
  return {
    ...actual,
    useBroadcasts: vi.fn(),
    useBroadcastActions: vi.fn(),
    useVisiblePolling: vi.fn(),
  };
});

// The audience count and the detail read go straight to the service, not
// through a hook, so they are stubbed at the module boundary.
vi.mock('../../../services/broadcasts', async () => {
  const actual = await vi.importActual<typeof import('../../../services/broadcasts')>(
    '../../../services/broadcasts',
  );
  return {
    ...actual,
    getBroadcastAudience: vi.fn(),
    getBroadcast: vi.fn(),
    getBroadcasts: vi.fn(),
  };
});

import {
  BROADCASTS_POLL_INTERVAL_MS,
  useBroadcastActions,
  useBroadcasts,
  useVisiblePolling,
} from '../../../hooks/useBroadcasts';
import { getBroadcast, getBroadcastAudience } from '../../../services/broadcasts';
import BroadcastsPage from '../../../pages/Admin/BroadcastsPage';

const mockUseBroadcasts = vi.mocked(useBroadcasts);
const mockUseBroadcastActions = vi.mocked(useBroadcastActions);
const mockUseVisiblePolling = vi.mocked(useVisiblePolling);
const mockGetAudience = vi.mocked(getBroadcastAudience);
const mockGetBroadcast = vi.mocked(getBroadcast);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Planned maintenance tonight',
    body: 'We will be offline from 01:00.\n\nThank you for your patience.',
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['browser', 'email'],
    status: 'scheduled',
    scheduledFor: '2026-06-15T22:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    audienceCutoff: null,
    recipientsTargeted: null,
    recipientsDispatched: 0,
    lastError: null,
    createdById: 'admin-user-id',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const scheduledBroadcast = broadcast();
const sentBroadcast = broadcast({
  id: '22222222-2222-4222-8222-222222222222',
  title: 'New export feature',
  status: 'sent',
  scheduledFor: null,
  startedAt: '2026-05-01T10:00:00.000Z',
  finishedAt: '2026-05-01T10:04:00.000Z',
  audienceCutoff: '2026-05-01T10:00:00.000Z',
  recipientsTargeted: 1284,
  recipientsDispatched: 1284,
});
const sendingBroadcast = broadcast({
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Security notice',
  eventKey: 'admin.broadcast_critical',
  status: 'sending',
  scheduledFor: null,
  startedAt: '2026-05-02T10:00:00.000Z',
  recipientsTargeted: 1284,
  recipientsDispatched: 400,
});
const failedBroadcast = broadcast({
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Release notes',
  status: 'failed',
  scheduledFor: null,
  lastError: 'The email provider refused the batch.',
});

const mockRefresh = vi.fn();
const mockFetch = vi.fn();
const mockCreate = vi.fn();
const mockCancel = vi.fn();
const mockRemove = vi.fn();
const mockSendTest = vi.fn();

function setListState(rows: Broadcast[] = [scheduledBroadcast], error: string | null = null) {
  mockUseBroadcasts.mockReturnValue({
    broadcasts: rows,
    total: rows.length,
    isLoading: false,
    error,
    fetchBroadcasts: mockFetch,
    refresh: mockRefresh,
  });
}

function setActionsState(overrides: { isWorking?: boolean; error?: string | null } = {}) {
  mockUseBroadcastActions.mockReturnValue({
    isWorking: overrides.isWorking ?? false,
    error: overrides.error ?? null,
    clearError: vi.fn(),
    create: mockCreate,
    cancel: mockCancel,
    remove: mockRemove,
    sendTest: mockSendTest,
  });
}

/** An admin holding exactly the permissions named. */
function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const READ_ONLY = ['broadcasts:read'];
const READ_WRITE = ['broadcasts:read', 'broadcasts:write'];

function renderPage(permissions: string[] = READ_WRITE, width = 1400) {
  setInitialContainerWidth(width);
  return render(<BroadcastsPage />, { wrapperOptions: { user: userWith(permissions) } });
}

/**
 * Open a row's action menu and return it.
 *
 * The desktop grid collapses several row actions into a menu, and the trigger
 * is named after the row's accessible name — which is the whole reason
 * `broadcastsTable.tsx`'s first column carries the short id alongside the
 * title.
 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, rowTitle: string) {
  const trigger = await screen.findByRole('button', {
    name: new RegExp(`actions.*${rowTitle}|${rowTitle}.*actions`, 'i'),
  });
  await user.click(trigger);
  return screen.getByRole('menu');
}

// ---------------------------------------------------------------------------

describe('BroadcastsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // The table persists its layout under `user_settings.dataTables`.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockGetAudience.mockResolvedValue({ activeUsers: 1284 });
    mockGetBroadcast.mockResolvedValue({
      ...sentBroadcast,
      approximateDeliveryAttempts: [{ channel: 'email', status: 'sent', count: 1200 }],
    });
    mockCancel.mockResolvedValue(true);
    mockRemove.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ broadcast: scheduledBroadcast, warnings: [] });
    mockSendTest.mockResolvedValue({
      eventKey: 'admin.broadcast',
      channels: ['browser'],
      sentToUserId: 'admin-user-id',
    });
    setListState();
    setActionsState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Reachability
  // =========================================================================

  it('redirects a user without broadcasts:read away, rather than rendering an empty page', () => {
    renderPage(['jobs:read']);

    expect(
      screen.queryByRole('heading', { level: 1, name: 'Broadcasts' }),
    ).not.toBeInTheDocument();
  });

  it('renders for a broadcasts:read holder, and says so when they cannot write', () => {
    renderPage(READ_ONLY);

    expect(screen.getByRole('heading', { level: 1, name: 'Broadcasts' })).toBeInTheDocument();
    // Stated up front rather than left to be discovered by finding every
    // control disabled.
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
  });

  // =========================================================================
  // The rows
  // =========================================================================

  describe('rows', () => {
    it('renders one row per broadcast, with its status as a chip', async () => {
      setListState([scheduledBroadcast, sentBroadcast, sendingBroadcast, failedBroadcast]);
      renderPage();

      expect(await screen.findByText('Planned maintenance tonight')).toBeInTheDocument();
      expect(screen.getByText('New export feature')).toBeInTheDocument();
      expect(screen.getByText('Security notice')).toBeInTheDocument();

      // The chip label is the status verbatim — an operator scans this column
      // for one word, so it must not be reworded per row.
      for (const status of ['scheduled', 'sent', 'sending', 'failed']) {
        expect(screen.getByText(status), status).toBeInTheDocument();
      }
    });

    it('distinguishes an unmuteable broadcast from a normal one', async () => {
      // Derived from `eventKey`, because there is no `critical` column on the
      // response — and "Cannot be muted" rather than a boolean, because the
      // fact an operator needs is what it does to the recipient.
      setListState([sendingBroadcast, sentBroadcast]);
      renderPage();

      expect(await screen.findByText('Cannot be muted')).toBeInTheDocument();
      expect(screen.getByText('Normal')).toBeInTheDocument();
    });

    it('shows progress as dispatched over targeted, and never invents a denominator', async () => {
      setListState([sendingBroadcast, scheduledBroadcast]);
      renderPage();

      expect(await screen.findByText('400 / 1284')).toBeInTheDocument();
      // The scheduled row's audience has not been frozen or counted yet, so
      // there is no target. `0 / 0` would read as "reaches nobody".
      expect(screen.getByText('0 / —')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // The permission split
  // =========================================================================

  describe('the write gate', () => {
    it('disables New broadcast for a read-only admin rather than removing it', async () => {
      renderPage(READ_ONLY);

      const button = await screen.findByRole('button', { name: /new broadcast/i });
      expect(button).toBeDisabled();
    });

    it('enables New broadcast for a writer', async () => {
      renderPage(READ_WRITE);

      expect(await screen.findByRole('button', { name: /new broadcast/i })).toBeEnabled();
    });

    it('leaves Cancel and Delete present but inert for a read-only admin', async () => {
      const user = userEvent.setup();
      setListState([scheduledBroadcast]);
      renderPage(READ_ONLY);

      const menu = await openRowMenu(user, 'Planned maintenance tonight');

      // PRESENT — the control set does not change shape — and both inert.
      expect(within(menu).getByRole('menuitem', { name: /cancel broadcast/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(within(menu).getByRole('menuitem', { name: /delete broadcast/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      // Viewing is what `broadcasts:read` buys, so it stays live.
      expect(
        within(menu).getByRole('menuitem', { name: /view broadcast/i }),
      ).not.toHaveAttribute('aria-disabled', 'true');
    });
  });

  // =========================================================================
  // Cancel — the mirror of the API's 409
  // =========================================================================

  describe('cancel', () => {
    it('is enabled for a scheduled broadcast', async () => {
      const user = userEvent.setup();
      setListState([scheduledBroadcast]);
      renderPage(READ_WRITE);

      const menu = await openRowMenu(user, 'Planned maintenance tonight');

      expect(
        within(menu).getByRole('menuitem', { name: /cancel broadcast/i }),
      ).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('is disabled for a sent broadcast, because there is nothing to recall', async () => {
      const user = userEvent.setup();
      setListState([sentBroadcast]);
      renderPage(READ_WRITE);

      const menu = await openRowMenu(user, 'New export feature');

      expect(within(menu).getByRole('menuitem', { name: /cancel broadcast/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('warns that one in-flight batch may still go out when cancelling a send', async () => {
      // THE SENTENCE THIS DIALOG EXISTS FOR. The fan-out re-checks the status
      // between batches, so the safe assumption ("nothing went out") is the
      // wrong one, and a vague warning reads as though the cancel failed.
      const user = userEvent.setup();
      setListState([sendingBroadcast]);
      renderPage(READ_WRITE);

      const menu = await openRowMenu(user, 'Security notice');
      await user.click(within(menu).getByRole('menuitem', { name: /cancel broadcast/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/in-flight batch of up to 200 recipients/i)).toBeInTheDocument();
    });

    it('calls the API when the confirmation is accepted', async () => {
      const user = userEvent.setup();
      setListState([scheduledBroadcast]);
      renderPage(READ_WRITE);

      const menu = await openRowMenu(user, 'Planned maintenance tonight');
      await user.click(within(menu).getByRole('menuitem', { name: /cancel broadcast/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^cancel broadcast$/i }));

      await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(scheduledBroadcast.id));
    });
  });

  // =========================================================================
  // Delete
  // =========================================================================

  it('disables Delete while a broadcast is sending — cancel first', async () => {
    const user = userEvent.setup();
    setListState([sendingBroadcast]);
    renderPage(READ_WRITE);

    const menu = await openRowMenu(user, 'Security notice');

    expect(within(menu).getByRole('menuitem', { name: /delete broadcast/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  // =========================================================================
  // The composer's confirmation names the audience
  // =========================================================================

  it('names the audience count in the confirmation before anything is sent', async () => {
    const user = userEvent.setup();
    renderPage(READ_WRITE);

    await user.click(await screen.findByRole('button', { name: /new broadcast/i }));

    // The count is read when the composer opens, not once at mount: a page
    // left open all afternoon must not confirm against an hours-old number.
    await waitFor(() => expect(mockGetAudience).toHaveBeenCalled());

    await user.type(screen.getByLabelText(/^title/i), 'Planned maintenance');
    await user.type(screen.getByLabelText(/^body/i), 'We will be offline from 01:00.');
    await user.click(screen.getByRole('button', { name: /^send…$/i }));

    const confirmation = await screen.findByRole('dialog', { name: /send this to everyone\?/i });
    expect(within(confirmation).getByText(/all 1,284 active users/i)).toBeInTheDocument();
    // Nothing has been sent yet — the dialog is the gate, not a receipt.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Polling
  // =========================================================================

  describe('polling', () => {
    it('is off when every row is in a terminal state', () => {
      // A list of `sent`, `canceled` and `failed` rows cannot change with
      // nobody touching it, so polling it is a request per ten seconds for an
      // answer that is already known. `useVisiblePolling` treats 0 as off.
      setListState([sentBroadcast, failedBroadcast]);
      renderPage();

      expect(mockUseVisiblePolling).toHaveBeenCalledWith(expect.any(Function), 0);
    });

    it('turns on while something is scheduled or sending', () => {
      setListState([sentBroadcast, sendingBroadcast]);
      renderPage();

      expect(mockUseVisiblePolling).toHaveBeenCalledWith(
        expect.any(Function),
        BROADCASTS_POLL_INTERVAL_MS,
      );
    });
  });

  // =========================================================================
  // Errors
  // =========================================================================

  it('renders a list error as an alert without clearing the page', async () => {
    setListState([], 'You do not have permission to manage broadcasts');
    renderPage();

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Broadcasts' })).toBeInTheDocument();
  });
});
