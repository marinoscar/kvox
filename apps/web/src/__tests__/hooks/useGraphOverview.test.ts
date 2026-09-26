import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/graph')>();
  return { ...actual, getGraphOverview: vi.fn(), refreshGraphOverview: vi.fn() };
});

import {
  OVERVIEW_POLL_MAX_MS,
  OVERVIEW_POLL_MS,
  useGraphOverview,
} from '../../hooks/useGraphOverview';
import { ApiError } from '../../services/api';
import { getGraphOverview, refreshGraphOverview } from '../../services/graph';
import { overviewStates } from '../mocks/graphData';

/**
 * `useGraphOverview` (#375). The SERVICE is mocked, not MSW: what is under
 * test is the hook's polling policy, and "issued no request" is only
 * assertable by counting calls on a spy.
 */

const mockGet = vi.mocked(getGraphOverview);
const mockRefresh = vi.mocked(refreshGraphOverview);

beforeEach(() => {
  mockGet.mockReset();
  mockRefresh.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGraphOverview', () => {
  it('loads the snapshot once and does not poll a settled one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(overviewStates.stale());
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.overview?.stale).toBe(true);

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS * 3);
    // Stale is REPORTED, never refreshed on read.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('polls every 10 s while pending and stops once it is not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet
      .mockResolvedValueOnce(overviewStates.building())
      .mockResolvedValueOnce(overviewStates.building())
      .mockResolvedValue(overviewStates.ready());
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.overview?.pending).toBe(true));

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS + 50);
    expect(mockGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS);
    await waitFor(() => expect(result.current.overview?.status).toBe('ready'));
    expect(mockGet).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS * 3);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('gives up after 15 minutes of pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue(overviewStates.building());
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.overview?.pending).toBe(true));

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MAX_MS + OVERVIEW_POLL_MS);
    await waitFor(() => expect(result.current.pollingStopped).toBe(true));
    const calls = mockGet.mock.calls.length;
    // 1 initial load + one per 10 s tick before the budget ran out.
    expect(calls).toBe(1 + OVERVIEW_POLL_MAX_MS / OVERVIEW_POLL_MS - 1);

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS * 5);
    expect(mockGet).toHaveBeenCalledTimes(calls);
  });

  it('requestRecompute posts once, marks the snapshot pending and starts polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValueOnce(overviewStates.stale()).mockResolvedValue(overviewStates.pending());
    mockRefresh.mockResolvedValue({ jobId: 'job-1', deduplicated: false });
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let accepted = false;
    await act(async () => {
      accepted = await result.current.requestRecompute();
    });
    expect(accepted).toBe(true);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.overview?.pending).toBe(true);
    expect(result.current.isRequesting).toBe(false);

    await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS + 50);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('reports a refused recompute without touching the snapshot', async () => {
    mockGet.mockResolvedValue(overviewStates.stale());
    mockRefresh.mockRejectedValue(new ApiError('Forbidden resource', 403));
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let accepted = true;
    await act(async () => {
      accepted = await result.current.requestRecompute();
    });
    expect(accepted).toBe(false);
    expect(result.current.requestError).toBe('You do not have permission to view your knowledge graph');
    expect(result.current.overview?.pending).toBe(false);
  });

  it('resolves a failed load to an error string, and refresh() recovers', async () => {
    mockGet.mockRejectedValueOnce(new ApiError('Boom', 500)).mockResolvedValue(overviewStates.ready());
    const { result } = renderHook(() => useGraphOverview());
    await waitFor(() => expect(result.current.error).toBe('Boom'));
    expect(result.current.overview).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.overview?.status).toBe('ready');
  });
});
