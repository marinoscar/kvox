/**
 * Admin → Operations → Job Insights (`/admin/settings/jobs/insights`), issue
 * #266, epic #254.
 *
 * The page's reason for existing is that an ETA must say how much of it is
 * real, so that is what most of this file is about. The API publishes `basis`
 * precisely so a client can tell measurement (`live`) from analogy (`partial`)
 * from a shipped constant (`none`), and the failure this suite exists to
 * prevent is the easy one: rendering all three identically, so that "about 4
 * minutes" computed from a constant gets quoted to somebody as a fact.
 *
 * The `none` case is asserted NEGATIVELY as well as positively — the duration
 * must be absent from the document, not merely accompanied by a caveat.
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
import type { JobInsights } from '../../../services/jobs';

vi.mock('../../../hooks/useJobInsights', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useJobInsights')>(
    '../../../hooks/useJobInsights',
  );
  return { ...actual, useJobInsights: vi.fn() };
});

import { useJobInsights } from '../../../hooks/useJobInsights';
import JobInsightsPage, {
  buildTypeInsightRows,
} from '../../../pages/Admin/JobInsightsPage';

const mockUseJobInsights = vi.mocked(useJobInsights);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function insights(overrides: Partial<JobInsights> = {}): JobInsights {
  return {
    windowDays: 7,
    generatedAt: '2026-01-08T00:00:00.000Z',
    concurrency: 4,
    live: {
      total: 50,
      byStatus: { pending: 6, running: 2, succeeded: 40, failed: 2 },
      byType: [],
      scheduled: 3,
      rateLimited: 1,
      retried: 5,
    },
    history: {
      windowStart: '2026-01-01T00:00:00.000Z',
      throughputSince: '2026-01-07T23:00:00.000Z',
      overall: {
        samples: 40,
        avgMs: 2000,
        p50Ms: 1500,
        p95Ms: 9000,
        throughputPerMin: 0.67,
      },
      byType: [
        {
          type: 'image.thumbnail',
          label: 'Thumbnail',
          samples: 38,
          avgMs: 1800,
          p50Ms: 1500,
          p95Ms: 8000,
          throughputPerMin: 0.63,
        },
      ],
    },
    eta: [],
    lifetime: [
      {
        type: 'image.thumbnail',
        label: 'Thumbnail',
        succeeded: 900,
        failed: 12,
        total: 912,
        avgMs: 1900,
        durationSamples: 880,
      },
    ],
    ...overrides,
  };
}

const mockRefresh = vi.fn();
const mockResetHistory = vi.fn();

function setHookState(value: JobInsights | null, extra: { error?: string | null; isLoading?: boolean } = {}) {
  mockUseJobInsights.mockReturnValue({
    insights: value,
    isLoading: extra.isLoading ?? false,
    error: extra.error ?? null,
    refresh: mockRefresh,
    isResetting: false,
    resetHistory: mockResetHistory,
  });
}

function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const READ_ONLY = ['jobs:read'];
const READ_WRITE = ['jobs:read', 'jobs:write'];

function renderPage(permissions: string[] = READ_WRITE) {
  setInitialContainerWidth(1400);
  return render(<JobInsightsPage />, { wrapperOptions: { user: userWith(permissions) } });
}

// ---------------------------------------------------------------------------

describe('JobInsightsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockResetHistory.mockResolvedValue(3);
    setHookState(insights());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects a user without jobs:read away', () => {
    renderPage(['system_settings:read']);

    expect(
      screen.queryByRole('heading', { level: 1, name: 'Job Insights' }),
    ).not.toBeInTheDocument();
  });

  it('renders the KPI strip from the live block', () => {
    renderPage();

    const strip = screen.getByLabelText('Queue insights summary');
    // Outstanding is pending + running — the number the ETAs are about.
    expect(within(strip).getByText('Outstanding').nextSibling).toHaveTextContent('8');
    expect(within(strip).getByText('Scheduled').nextSibling).toHaveTextContent('3');
    expect(within(strip).getByText('Rate limited').nextSibling).toHaveTextContent('1');
    expect(within(strip).getByText('Retried').nextSibling).toHaveTextContent('5');
    expect(within(strip).getByText('Worker concurrency').nextSibling).toHaveTextContent('4');
  });

  it('labels the history with the window the API USED, not the one requested', async () => {
    // The endpoint clamps `windowDays`; a label reading back the request would
    // describe a window that was never applied.
    setHookState(insights({ windowDays: 90 }));
    renderPage();

    expect(await screen.findByText(/Covering 90 day\(s\)/)).toBeInTheDocument();
  });

  it('shows when the numbers were taken, because the page does not poll', () => {
    renderPage();

    expect(screen.getByText(/taken /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
  });

  // =========================================================================
  // The ETA, and its basis
  // =========================================================================

  describe('the ETA', () => {
    it('presents a `live` basis as a measurement', () => {
      setHookState(
        insights({
          eta: [
            {
              type: 'image.thumbnail',
              label: 'Thumbnail',
              pending: 10,
              running: 2,
              remaining: 12,
              avgMs: 2000,
              basis: 'live',
              estimatedMs: 6000,
            },
          ],
        }),
      );
      renderPage();

      expect(screen.getByText('Measured')).toBeInTheDocument();
      expect(screen.getByText('6.0 s')).toBeInTheDocument();
      expect(screen.getByText(/12 outstanding \(10 pending, 2 running\)/)).toBeInTheDocument();
    });

    it('hedges a `partial` basis in words while still showing the duration', () => {
      setHookState(
        insights({
          eta: [
            {
              type: 'email.send',
              label: 'Send email',
              pending: 4,
              running: 0,
              remaining: 4,
              avgMs: 30_000,
              basis: 'partial',
              estimatedMs: 120_000,
            },
          ],
        }),
      );
      renderPage();

      // An analogy is still evidence — it is right about the order of
      // magnitude in a way a constant is not — so the number stays, hedged.
      expect(screen.getByText('Estimated')).toBeInTheDocument();
      expect(screen.getByText('2m 00s')).toBeInTheDocument();
      expect(
        screen.getByText(/average across other job types was used/i),
      ).toBeInTheDocument();
    });

    it('shows NO duration at all for a `none` basis', () => {
      setHookState(
        insights({
          eta: [
            {
              type: 'report.build',
              label: 'Build report',
              pending: 7,
              running: 0,
              remaining: 7,
              avgMs: 60_000,
              basis: 'none',
              estimatedMs: 420_000,
            },
          ],
        }),
      );
      renderPage();

      expect(screen.getByText('No history')).toBeInTheDocument();
      expect(screen.getByText('No estimate yet')).toBeInTheDocument();

      // THE NEGATIVE HALF, and the point of the whole case: neither the
      // estimate (7m 00s) nor the per-job constant (1m 00s) may appear
      // anywhere. A duration on screen is read as a measurement by everybody
      // who has ever seen a progress bar.
      expect(screen.queryByText('7m 00s')).not.toBeInTheDocument();
      expect(screen.queryByText(/1m 00s per job/)).not.toBeInTheDocument();

      // What that case DOES know is still shown.
      expect(screen.getByText(/7 outstanding/)).toBeInTheDocument();
    });

    it('says so plainly when there is nothing outstanding', () => {
      setHookState(insights({ eta: [] }));
      renderPage();

      expect(screen.getByText(/Nothing is outstanding/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Per type
  // =========================================================================

  describe('the per-type table', () => {
    it('renders the window’s distribution for each type', async () => {
      renderPage();

      expect(await screen.findByText('Thumbnail')).toBeInTheDocument();
      // Scoped to the table: the same p50 also appears in the KPI strip above,
      // which is the point of the strip — the overall distribution is not
      // derivable from the per-type rows.
      const table = screen.getByTestId('admin-job-insights-types-table');
      expect(within(table).getByText('1.5 s')).toBeInTheDocument(); // p50
      expect(within(table).getByText('8.0 s')).toBeInTheDocument(); // p95
      expect(within(table).getByText('1.8 s')).toBeInTheDocument(); // average
    });

    it('merges history and lifetime into one row per type', () => {
      const rows = buildTypeInsightRows(insights());

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'image.thumbnail',
        samples: 38,
        lifetimeTotal: 912,
        lifetimeSucceeded: 900,
      });
    });

    it('keeps a type that has lifetime totals but no runs inside the window', () => {
      // Its percentiles are null (the window has nothing to sort), but dropping
      // the row would hide a job type from a page whose whole purpose is
      // per-type comparison.
      const rows = buildTypeInsightRows(
        insights({
          history: {
            ...insights().history,
            byType: [],
          },
        }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].samples).toBe(0);
      expect(rows[0].p95Ms).toBeNull();
      expect(rows[0].lifetimeTotal).toBe(912);
    });

    it('keeps a type new in this window that has no lifetime rollup yet', () => {
      const rows = buildTypeInsightRows(insights({ lifetime: [] }));

      expect(rows).toHaveLength(1);
      expect(rows[0].samples).toBe(38);
      expect(rows[0].lifetimeTotal).toBe(0);
    });

    it('states that all-time figures carry no percentiles, and why', () => {
      renderPage();

      expect(
        screen.getByText(/cannot be reconstructed from history that has been purged/i),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Clearing the lifetime rollup
  // =========================================================================

  describe('clearing the lifetime statistics', () => {
    it('is not offered without jobs:write', () => {
      renderPage(READ_ONLY);

      expect(
        screen.queryByRole('button', { name: /Clear lifetime statistics/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
    });

    it('confirms first, and does nothing when cancelled', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: /Clear lifetime statistics/i }));
      const dialog = await screen.findByRole('dialog');
      // The dialog has to say what survives, because "clear statistics" reads
      // like "delete jobs" to anyone who has not read the API docs.
      expect(within(dialog).getByText(/No job is deleted/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /Cancel/i }));

      expect(mockResetHistory).not.toHaveBeenCalled();
    });

    it('reports how many rollup rows went, and that no job changed', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: /Clear lifetime statistics/i }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: /^Clear$/i }),
      );

      await waitFor(() => expect(mockResetHistory).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/Cleared 3 lifetime rollup row\(s\)/)).toBeInTheDocument();
    });
  });

  it('surfaces a load failure instead of an empty page', () => {
    setHookState(null, { error: 'You do not have permission to view queue insights' });
    renderPage();

    expect(
      screen.getByText('You do not have permission to view queue insights'),
    ).toBeInTheDocument();
  });
});
