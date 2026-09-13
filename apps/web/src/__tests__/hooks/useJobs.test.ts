/**
 * The queue hooks — issue #266, epic #254.
 *
 * The centrepiece here is `useVisiblePolling`, because the polling contract is
 * the one part of the jobs page that CANNOT be seen by looking at it: a timer
 * that keeps firing in a hidden tab looks identical to one that does not, right
 * up until a dashboard left open overnight has issued a few thousand queries
 * against the database the workers are competing for. So the pause is asserted
 * through the real `document.visibilitychange`, and so is the half that makes
 * it invisible to the operator — the immediate catch-up fetch on return, without
 * which a restored tab would show stale numbers for up to a full interval, which
 * is worse than not pausing at all.
 *
 * The rest is the contract every hook in this app shares: a failure is a STRING
 * the page renders, never an exception a click handler has to catch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/jobs', async () => {
  const actual = await vi.importActual<typeof import('../../services/jobs')>(
    '../../services/jobs',
  );
  return {
    ...actual,
    getJobs: vi.fn(),
    getJobStats: vi.fn(),
    retryJob: vi.fn(),
    deleteJob: vi.fn(),
    retryFailedJobs: vi.fn(),
    resetStuckJobs: vi.fn(),
  };
});

import {
  deleteJob,
  getJobs,
  retryFailedJobs,
  retryJob,
} from '../../services/jobs';
import type { Job, JobListResponse } from '../../services/jobs';
import { ApiError } from '../../services/api';
import { useJobActions, useJobs, useVisiblePolling } from '../../hooks/useJobs';

const mockGetJobs = vi.mocked(getJobs);
const mockRetryJob = vi.mocked(retryJob);
const mockDeleteJob = vi.mocked(deleteJob);
const mockRetryFailedJobs = vi.mocked(retryFailedJobs);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'image.thumbnail',
    typeLabel: 'Thumbnail',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'pending',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    attempts: 0,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    ...overrides,
  };
}

function listOf(items: Job[]): JobListResponse {
  return { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 };
}

// ---------------------------------------------------------------------------
// `document.hidden` is a getter in jsdom, so it is redefined rather than
// assigned. The event is dispatched separately because the browser fires it
// AFTER the property flips, and a hook that read the property from the event
// object rather than the document would otherwise pass here and fail in a
// browser.
// ---------------------------------------------------------------------------
let documentHidden = false;

function setTabHidden(hidden: boolean) {
  documentHidden = hidden;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useVisiblePolling', () => {
  beforeEach(() => {
    documentHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    documentHidden = false;
  });

  it('calls the callback once per interval while the tab is in front', () => {
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 1000));

    act(() => vi.advanceTimersByTime(3000));

    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('STOPS calling once the tab is hidden', () => {
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 1000));

    act(() => vi.advanceTimersByTime(2000));
    expect(tick).toHaveBeenCalledTimes(2);

    setTabHidden(true);
    act(() => vi.advanceTimersByTime(60_000));

    // Not "fewer calls" — NONE. A throttled-but-alive timer is exactly the
    // state this hook exists to rule out.
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('fetches IMMEDIATELY when the tab comes back, then resumes the interval', () => {
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 1000));

    setTabHidden(true);
    act(() => vi.advanceTimersByTime(10_000));
    expect(tick).not.toHaveBeenCalled();

    setTabHidden(false);
    // The catch-up, before any timer has elapsed.
    expect(tick).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('never starts a timer for a tab that is already hidden at mount', () => {
    documentHidden = true;
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 1000));

    act(() => vi.advanceTimersByTime(10_000));

    expect(tick).not.toHaveBeenCalled();
  });

  it('does not start a second timer when visibilitychange fires twice for the same state', () => {
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 1000));

    // Two "visible" events in a row: the guard in `start()` is what keeps this
    // from doubling the request rate.
    setTabHidden(false);
    setTabHidden(false);
    tick.mockClear();

    act(() => vi.advanceTimersByTime(1000));

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('calls the LATEST callback without restarting the interval', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useVisiblePolling(cb, 1000), {
      initialProps: { cb: first },
    });

    act(() => vi.advanceTimersByTime(600));
    // A page re-renders with a fresh closure on every filter keystroke. If the
    // callback were an effect dependency the timer would restart here and never
    // reach its period.
    rerender({ cb: second });
    act(() => vi.advanceTimersByTime(400));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never polls at all for a non-positive interval', () => {
    const tick = vi.fn();
    renderHook(() => useVisiblePolling(tick, 0));

    act(() => vi.advanceTimersByTime(60_000));

    expect(tick).not.toHaveBeenCalled();
  });

  it('stops the timer and unsubscribes on unmount', () => {
    const tick = vi.fn();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useVisiblePolling(tick, 1000));

    unmount();
    act(() => vi.advanceTimersByTime(10_000));

    expect(tick).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('useJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads rows and the server’s total', async () => {
    mockGetJobs.mockResolvedValue(listOf([job(), job({ id: 'job-2' })]));

    const { result } = renderHook(() => useJobs());
    await act(async () => {
      await result.current.fetchJobs({ page: 1, pageSize: 20 });
    });

    expect(result.current.jobs).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it('reports a failure as a string and clears the stale rows behind it', async () => {
    mockGetJobs.mockResolvedValueOnce(listOf([job()]));
    const { result } = renderHook(() => useJobs());
    await act(async () => {
      await result.current.fetchJobs({});
    });
    expect(result.current.jobs).toHaveLength(1);

    mockGetJobs.mockRejectedValueOnce(new ApiError('Boom', 500));
    await act(async () => {
      await result.current.fetchJobs({});
    });

    expect(result.current.error).toBe('Boom');
    // Rows from the previous successful query, left under an error banner,
    // would read as the current state of the queue.
    expect(result.current.jobs).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('names a 403 as a permission problem rather than echoing the API', async () => {
    mockGetJobs.mockRejectedValueOnce(new ApiError('Forbidden resource', 403));

    const { result } = renderHook(() => useJobs());
    await act(async () => {
      await result.current.fetchJobs({});
    });

    expect(result.current.error).toBe('You do not have permission to manage jobs');
  });

  it('repeats the LAST query on refresh, so a poll re-reads the current view', async () => {
    mockGetJobs.mockResolvedValue(listOf([job()]));
    const { result } = renderHook(() => useJobs());

    await act(async () => {
      await result.current.fetchJobs({ page: 2, pageSize: 50, status: 'failed' });
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetJobs).toHaveBeenLastCalledWith({ page: 2, pageSize: 50, status: 'failed' });
  });

  it('does not raise the loading flag for a refresh', async () => {
    mockGetJobs.mockResolvedValue(listOf([job()]));
    const { result } = renderHook(() => useJobs());
    await act(async () => {
      await result.current.fetchJobs({});
    });

    const seen: boolean[] = [];
    mockGetJobs.mockImplementation(async () => {
      seen.push(result.current.isLoading);
      return listOf([job()]);
    });
    await act(async () => {
      await result.current.refresh();
    });

    // The rows must stay on screen with their scroll offset, expansion and
    // focus intact — a spinner every ten seconds over correct data is what
    // makes a live table unusable.
    expect(seen).toEqual([false]);
  });
});

describe('useJobActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports success as a boolean and re-reads the queue afterwards', async () => {
    mockRetryJob.mockResolvedValue(job({ status: 'pending' }));
    const onChanged = vi.fn();
    const { result } = renderHook(() => useJobActions(onChanged));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.retry('job-1');
    });

    expect(ok).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a delete that answered 204 as success, not as a failure', async () => {
    // `deleteJob` resolves `undefined`; a naive "did it return something"
    // check would call every successful delete a failure.
    mockDeleteJob.mockResolvedValue(undefined);
    const { result } = renderHook(() => useJobActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.remove('job-1');
    });

    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('captures a refusal as a string and never throws at the click handler', async () => {
    mockRetryJob.mockRejectedValue(
      new ApiError('Cannot retry a running job', 400),
    );
    const onChanged = vi.fn();
    const { result } = renderHook(() => useJobActions(onChanged));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.retry('job-1');
    });

    expect(ok).toBe(false);
    await waitFor(() => expect(result.current.error).toBe('Cannot retry a running job'));
    // Nothing changed, so nothing is re-read.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('hands back the sweep’s own counts rather than a bare boolean', async () => {
    mockRetryFailedJobs.mockResolvedValue({ retried: 12, skipped: 3, remaining: 5 });
    const { result } = renderHook(() => useJobActions());

    let sweep: Awaited<ReturnType<typeof result.current.retryAllFailed>>;
    await act(async () => {
      sweep = await result.current.retryAllFailed();
    });

    // `remaining` is the number that tells an operator to press it again, so
    // it must survive to the page.
    expect(sweep!).toEqual({ retried: 12, skipped: 3, remaining: 5 });
  });
});
