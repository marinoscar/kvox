import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCopilotProvider } from '../../src/copilot/headless/index.js';
import type { CopilotProviderPort } from '../../src/copilot/headless/index.js';
import { consentedSettings, makeSettings, makeStatus } from './copilotData.js';

function makePort(overrides: Partial<CopilotProviderPort> = {}): CopilotProviderPort {
  return {
    getStatus: vi.fn().mockResolvedValue(makeStatus()),
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    update: vi.fn().mockImplementation(async (patch) => ({ ...makeSettings(), ...patch })),
    startSignIn: vi.fn().mockResolvedValue({ kind: 'browser', url: 'https://github.com/login' }),
    waitForSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    downloadRuntime: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useCopilotProvider', () => {
  it('loads the status and the setting on mount', async () => {
    const port = makePort({ getSettings: vi.fn().mockResolvedValue(consentedSettings()) });
    const { result } = renderHook(() => useCopilotProvider(port));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.runtime.state).toBe('ready');
    expect(result.current.settings?.enabled).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('reports a failed first read', async () => {
    const port = makePort({ getStatus: vi.fn().mockRejectedValue(new Error('offline')) });
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('offline');
  });

  it('update stores the returned setting and re-reads the status', async () => {
    const port = makePort();
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(port.getStatus).mockClear();

    await act(() => result.current.update({ enabled: true, model: 'gpt-5' }));

    expect(port.update).toHaveBeenCalledWith({ enabled: true, model: 'gpt-5' });
    expect(result.current.settings).toMatchObject({ enabled: true, model: 'gpt-5' });
    expect(port.getStatus).toHaveBeenCalledTimes(1);
  });

  it('waitForSignIn re-reads the status when the wait succeeds and when it fails', async () => {
    const port = makePort();
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(port.getStatus).mockClear();
    const signal = new AbortController().signal;

    await act(() => result.current.waitForSignIn(signal));
    expect(port.waitForSignIn).toHaveBeenCalledWith(signal);
    expect(port.getStatus).toHaveBeenCalledTimes(1);

    vi.mocked(port.waitForSignIn).mockRejectedValueOnce(new Error('sign_in_failed'));
    await act(async () => {
      await expect(result.current.waitForSignIn(signal)).rejects.toThrow('sign_in_failed');
    });
    expect(port.getStatus).toHaveBeenCalledTimes(2);
  });

  it('signOut and startSignIn go through the port', async () => {
    const port = makePort();
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.startSignIn()).resolves.toEqual({ kind: 'browser', url: 'https://github.com/login' });
    await act(() => result.current.signOut());
    expect(port.signOut).toHaveBeenCalledTimes(1);
  });

  it('polls the status while the runtime downloads and stops when it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(makeStatus({ runtime: { state: 'downloading', version: null, progress: 0.1 } }))
      .mockResolvedValueOnce(makeStatus({ runtime: { state: 'downloading', version: null, progress: 0.6 } }))
      .mockResolvedValue(makeStatus());
    const port = makePort({ getStatus });
    const { result } = renderHook(() => useCopilotProvider(port, { pollIntervalMs: 500 }));
    await waitFor(() => expect(result.current.status?.runtime.progress).toBe(0.1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.status?.runtime.progress).toBe(0.6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.status?.runtime.state).toBe('ready');

    const calls = getStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getStatus.mock.calls.length).toBe(calls);
  });

  it('cancelRuntimeDownload aborts the signal given to the port and is not an error', async () => {
    let signal: AbortSignal | undefined;
    const port = makePort({
      downloadRuntime: vi.fn(
        (s: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal = s;
            s.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    });
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.downloadRuntime();
    });
    act(() => result.current.cancelRuntimeDownload());

    await act(async () => {
      await expect(pending).resolves.toBeUndefined();
    });
    expect(signal?.aborted).toBe(true);
  });

  it('a failed download rejects', async () => {
    const port = makePort({ downloadRuntime: vi.fn().mockRejectedValue(new Error('checksum_mismatch')) });
    const { result } = renderHook(() => useCopilotProvider(port));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(result.current.downloadRuntime()).rejects.toThrow('checksum_mismatch');
    });
  });
});
