/**
 * Admin → Operations → Jobs (`/admin/settings/jobs`), issue #266, epic #254.
 *
 * The table's MECHANICS — pagination round-trips, the column picker, CSV
 * escaping, the renderer switch, the axe pass — are asserted once for every
 * table in `runDataTableConformanceSuite`, and are deliberately not repeated
 * here. What is page-specific, and what this file covers, is everything about
 * this page that could be wrong while the table is perfectly fine:
 *
 *   * the QUERY it sends — filters flattened to the scalars the endpoint takes,
 *     one-based pages, and `scheduled` never travelling with `status`;
 *   * the two actions the API REFUSES for a running job, which must not be
 *     offered rather than merely failing;
 *   * the queue-wide sweeps, which are page-level buttons and not a selection
 *     toolbar, and which report the server's own counts back;
 *   * the permission split: `jobs:read` reaches the page, `jobs:write` is what
 *     puts any control on it;
 *   * the polling wiring (its BEHAVIOUR is asserted against a real
 *     `visibilitychange` in `__tests__/hooks/useJobs.test.ts`).
 *
 * The hooks are mocked, as `UserList.test.tsx` mocks `useUsers`: the fetch
 * layer has its own suite, and driving it through msw here would test the
 * transport twice while making every assertion about the page wait on it.
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
import type { Job, JobStats } from '../../../services/jobs';

vi.mock('../../../hooks/useJobs', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useJobs')>(
    '../../../hooks/useJobs',
  );
  return {
    ...actual,
    useJobs: vi.fn(),
    useJobStats: vi.fn(),
    useJobActions: vi.fn(),
    useVisiblePolling: vi.fn(),
  };
});

import {
  JOBS_POLL_INTERVAL_MS,
  useJobActions,
  useJobStats,
  useJobs,
  useVisiblePolling,
} from '../../../hooks/useJobs';
import JobsPage from '../../../pages/Admin/JobsPage';

const mockUseJobs = vi.mocked(useJobs);
const mockUseJobStats = vi.mocked(useJobStats);
const mockUseJobActions = vi.mocked(useJobActions);
const mockUseVisiblePolling = vi.mocked(useVisiblePolling);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'image.thumbnail',
    typeLabel: 'Thumbnail',
    subjectType: 'storage_object',
    subjectId: 'obj-1',
    dedupKey: null,
    status: 'failed',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    attempts: 3,
    lastError: 'upstream exploded',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:05.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z',
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    ...overrides,
  };
}

const failedJob = job();
const runningJob = job({
  id: '22222222-2222-4222-8222-222222222222',
  type: 'email.send',
  typeLabel: 'Send email',
  status: 'running',
  finishedAt: null,
  executor: 'worker-a',
});

function stats(overrides: Partial<JobStats> = {}): JobStats {
  return {
    total: 42,
    byStatus: { pending: 4, running: 1, succeeded: 30, failed: 7 },
    byType: [
      { type: 'image.thumbnail', label: 'Thumbnail', total: 30, byStatus: { pending: 2, running: 0, succeeded: 26, failed: 2 } },
      { type: 'email.send', label: 'Send email', total: 12, byStatus: { pending: 2, running: 1, succeeded: 4, failed: 5 } },
    ],
    scheduled: 2,
    stuckRunning: 1,
    stuckThresholdMinutes: 30,
    generatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

const mockFetchJobs = vi.fn();
const mockRefresh = vi.fn();
const mockRefreshStats = vi.fn();
const mockRetry = vi.fn();
const mockRemove = vi.fn();
const mockRetryAllFailed = vi.fn();
const mockResetStuck = vi.fn();

function setJobsState(rows: Job[] = [failedJob], error: string | null = null) {
  mockUseJobs.mockReturnValue({
    jobs: rows,
    total: rows.length,
    isLoading: false,
    error,
    fetchJobs: mockFetchJobs,
    refresh: mockRefresh,
  });
}

function setStatsState(value: JobStats | null = stats(), error: string | null = null) {
  mockUseJobStats.mockReturnValue({
    stats: value,
    isLoading: false,
    error,
    refresh: mockRefreshStats,
  });
}

function setActionsState(overrides: { isWorking?: boolean; error?: string | null } = {}) {
  mockUseJobActions.mockReturnValue({
    isWorking: overrides.isWorking ?? false,
    error: overrides.error ?? null,
    clearError: vi.fn(),
    retry: mockRetry,
    remove: mockRemove,
    retryAllFailed: mockRetryAllFailed,
    resetStuck: mockResetStuck,
  });
}

/** An admin holding exactly the permissions named. */
function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const READ_ONLY = ['jobs:read'];
const READ_WRITE = ['jobs:read', 'jobs:write'];

function renderPage(permissions: string[] = READ_WRITE, width = 1400) {
  setInitialContainerWidth(width);
  return render(<JobsPage />, { wrapperOptions: { user: userWith(permissions) } });
}

/** Choose an option from one of the filter editor's MUI selects. */
async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

async function applyFilter(
  user: ReturnType<typeof userEvent.setup>,
  column: string,
  value: string,
) {
  await pickOption(user, 'Column', column);
  await pickOption(user, 'Value', value);
  await user.click(screen.getByTestId('datatable-filter-apply'));
}

// ---------------------------------------------------------------------------

describe('JobsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // The table persists its layout under `user_settings.dataTables`.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockRetry.mockResolvedValue(true);
    mockRemove.mockResolvedValue(true);
    mockRetryAllFailed.mockResolvedValue({ retried: 12, skipped: 3, remaining: 5 });
    mockResetStuck.mockResolvedValue({ reset: 2, failed: 1, thresholdMinutes: 30 });
    setJobsState();
    setStatsState();
    setActionsState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Reachability
  // =========================================================================

  it('redirects a user without jobs:read away, rather than rendering an empty page', () => {
    renderPage(['system_settings:read']);

    expect(screen.queryByRole('heading', { level: 1, name: 'Jobs' })).not.toBeInTheDocument();
  });

  it('renders for a jobs:read holder, and says so when they cannot write', () => {
    renderPage(READ_ONLY);

    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    // Stated up front rather than left to be discovered by finding every
    // control missing.
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
  });

  // =========================================================================
  // The summary strip
  // =========================================================================

  describe('the summary strip', () => {
    it('renders the whole queue’s counts, not the page of rows below it', () => {
      renderPage();

      const strip = screen.getByLabelText('Queue summary');
      expect(within(strip).getByText('Total').nextSibling).toHaveTextContent('42');
      expect(within(strip).getByText('Failed').nextSibling).toHaveTextContent('7');
      expect(within(strip).getByText('Scheduled').nextSibling).toHaveTextContent('2');
    });

    it('labels the stuck count with the API’s own threshold, never a constant of its own', () => {
      // `stuckThresholdMinutes` is a system setting. A number invented in the
      // UI would disagree with the sweep the button beside it actually runs.
      renderPage();

      expect(screen.getByText('Running over 30 min')).toBeInTheDocument();
    });

    it('surfaces a stats failure without emptying the strip', () => {
      setStatsState(stats(), 'Failed to load queue statistics');
      renderPage();

      expect(screen.getByText('Failed to load queue statistics')).toBeInTheDocument();
      expect(within(screen.getByLabelText('Queue summary')).getByText('Total')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // The query
  // =========================================================================

  describe('the query it sends', () => {
    it('asks for the first page one-based, at the API-legal default size', async () => {
      renderPage();

      await waitFor(() =>
        expect(mockFetchJobs).toHaveBeenCalledWith(
          expect.objectContaining({ page: 1, pageSize: 20 }),
        ),
      );
    });

    it('maps the Status filter onto ?status=', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Thumbnail');

      await applyFilter(user, 'Status', 'Failed');

      await waitFor(() =>
        expect(mockFetchJobs).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'failed', page: 1 }),
        ),
      );
    });

    it('maps the Job filter onto ?type= using the MACHINE key, not the label', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Thumbnail');

      await applyFilter(user, 'Job', 'Send email');

      await waitFor(() =>
        expect(mockFetchJobs).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'email.send' }),
        ),
      );
    });

    it('maps the Last activity filter onto ?processedWithin=', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Thumbnail');

      await applyFilter(user, 'Last activity', 'Last 24 hours');

      await waitFor(() =>
        expect(mockFetchJobs).toHaveBeenLastCalledWith(
          expect.objectContaining({ processedWithin: '24h' }),
        ),
      );
    });

    it('sends `scheduled=true` and NO status when the backoff filter is applied', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Thumbnail');

      await applyFilter(user, 'Backoff', 'Waiting out a backoff');

      await waitFor(() => {
        const last = mockFetchJobs.mock.lastCall?.[0];
        expect(last).toMatchObject({ scheduled: true });
        expect(last).not.toHaveProperty('status');
      });
    });
  });

  // =========================================================================
  // Mutual exclusivity, through the real filter UI
  // =========================================================================

  it('drops the Status filter when Backoff is applied — the server overrides one with the other', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Thumbnail');

    await applyFilter(user, 'Status', 'Failed');
    await screen.findByLabelText(/Remove filter: Status is Failed/i);

    await applyFilter(user, 'Backoff', 'Waiting out a backoff');

    // The chip bar must never advertise a constraint the server did not
    // apply: `scheduled=true` overrides `status` outright, so a "Status is
    // Failed" chip above a table of pending rows would read as a broken table.
    await waitFor(() =>
      expect(screen.queryByLabelText(/Remove filter: Status is Failed/i)).not.toBeInTheDocument(),
    );
    const last = mockFetchJobs.mock.lastCall?.[0];
    expect(last).toMatchObject({ scheduled: true });
    expect(last).not.toHaveProperty('status');
  });

  it('drops the Backoff filter when Status is applied second', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Thumbnail');

    await applyFilter(user, 'Backoff', 'Waiting out a backoff');
    await screen.findByLabelText(/Remove filter: Backoff is/i);

    await applyFilter(user, 'Status', 'Running');

    await waitFor(() => {
      const last = mockFetchJobs.mock.lastCall?.[0];
      expect(last).toMatchObject({ status: 'running' });
      expect(last).not.toHaveProperty('scheduled');
    });
  });

  // =========================================================================
  // Row actions
  // =========================================================================

  describe('row actions', () => {
    async function openRowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
      await user.click(await screen.findByRole('button', { name: `Row actions for ${label}` }));
      return screen.findByRole('menu');
    }

    it('offers retry and delete on a job that is not running', async () => {
      const user = userEvent.setup();
      setJobsState([failedJob]);
      renderPage();

      const menu = await openRowMenu(user, `Thumbnail (${failedJob.id.slice(0, 8)})`);

      expect(within(menu).getByRole('menuitem', { name: /Retry job/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(within(menu).getByRole('menuitem', { name: /Delete job/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('DISABLES both on a running job, because the API 400s on either', async () => {
      const user = userEvent.setup();
      setJobsState([runningJob]);
      renderPage();

      const menu = await openRowMenu(user, `Send email (${runningJob.id.slice(0, 8)})`);

      // Disabled and still present, not absent: the set of actions must not
      // change shape row to row, or the operator has to hunt for a control
      // that moved.
      expect(within(menu).getByRole('menuitem', { name: /Retry job/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(within(menu).getByRole('menuitem', { name: /Delete job/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('retries the row that was clicked', async () => {
      const user = userEvent.setup();
      setJobsState([failedJob]);
      renderPage();

      const menu = await openRowMenu(user, `Thumbnail (${failedJob.id.slice(0, 8)})`);
      await user.click(within(menu).getByRole('menuitem', { name: /Retry job/ }));

      await waitFor(() => expect(mockRetry).toHaveBeenCalledWith(failedJob.id));
    });

    it('confirms before deleting, and does not delete if the dialog is cancelled', async () => {
      const user = userEvent.setup();
      setJobsState([failedJob]);
      renderPage();

      const menu = await openRowMenu(user, `Thumbnail (${failedJob.id.slice(0, 8)})`);
      await user.click(within(menu).getByRole('menuitem', { name: /Delete job/ }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Delete this job\?/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /Cancel/i }));

      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('offers NO row action at all without jobs:write', async () => {
      setJobsState([failedJob]);
      renderPage(READ_ONLY);

      await screen.findByText('Thumbnail');
      // The ARRAY is gated, not a rendered control — so nothing appears in the
      // grid, the tablet expander or the phone card.
      expect(screen.queryByRole('button', { name: /Row actions for/ })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Queue-wide sweeps
  // =========================================================================

  describe('queue-wide actions', () => {
    it('renders them as page-level buttons, never as a selection toolbar', () => {
      renderPage();

      expect(screen.getByRole('button', { name: /Retry all failed/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Reset stuck/i })).toBeInTheDocument();
      // No selection is offered, because nothing is scoped by one — a checkbox
      // column that gates no action is a tab stop per row for nothing.
      expect(screen.queryByRole('checkbox', { name: /Select all/i })).not.toBeInTheDocument();
    });

    it('disables each one when its count is zero', () => {
      setStatsState(stats({ byStatus: { pending: 4, running: 0, succeeded: 30, failed: 0 }, stuckRunning: 0 }));
      renderPage();

      expect(screen.getByRole('button', { name: /Retry all failed/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Reset stuck/i })).toBeDisabled();
    });

    it('confirms, then reports the sweep’s OWN counts back', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: /Retry all failed/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/whole queue/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /Continue/i }));

      await waitFor(() => expect(mockRetryAllFailed).toHaveBeenCalledTimes(1));
      // `remaining` is what tells an operator to press it again — the sweep
      // caps at 500 rows per call — so it has to reach the screen.
      expect(await screen.findByText(/Retried 12 job\(s\)/)).toBeInTheDocument();
      expect(screen.getByText(/5 still failed/)).toBeInTheDocument();
    });

    it('sweeps stuck jobs with NO threshold of its own, so the setting decides', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: /Reset stuck/i }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: /Continue/i }),
      );

      // An `olderThanMinutes` invented here would be a second place the
      // threshold is decided, and it would win over the system setting the
      // count above was measured against.
      await waitFor(() => expect(mockResetStuck).toHaveBeenCalledWith());
      expect(await screen.findByText(/30-minute threshold/)).toBeInTheDocument();
    });

    it('offers neither sweep without jobs:write', () => {
      renderPage(READ_ONLY);

      expect(screen.queryByRole('button', { name: /Retry all failed/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Reset stuck/i })).not.toBeInTheDocument();
    });

    it('surfaces a refused write as an alert', () => {
      setActionsState({ error: 'Cannot retry a running job' });
      renderPage();

      expect(screen.getByText('Cannot retry a running job')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Polling wiring — the behaviour is asserted in the hook's own suite
  // =========================================================================

  it('polls on the shipped interval, refreshing the rows AND the summary together', () => {
    renderPage();

    expect(mockUseVisiblePolling).toHaveBeenCalledWith(
      expect.any(Function),
      JOBS_POLL_INTERVAL_MS,
    );

    // One callback drives both, so the strip and the table are never a poll
    // apart — "Failed: 3" above a table with no failed rows is unreadable.
    const [poll] = mockUseVisiblePolling.mock.lastCall!;
    poll();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefreshStats).toHaveBeenCalledTimes(1);
  });

  it('tells the user the table is live, and how often', () => {
    renderPage();

    expect(
      screen.getByText(/re-read every 10 seconds while this tab is in front/i),
    ).toBeInTheDocument();
  });
});
