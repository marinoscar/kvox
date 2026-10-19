import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CopilotSettings,
  CopilotSignInChallenge,
  CopilotStatus,
} from '@marinoscar/kvox-contract/copilot';

/**
 * What a host maps to its routes (KVox Desktop: `/api/desktop/ai/copilot/*`).
 *
 * @remarks
 * Every method is a thin call: the hook owns the state, the polling and the
 * refresh after a change, the port owns the transport.
 *
 * @stability experimental
 */
export interface CopilotProviderPort {
  /** The status: sign-in, runtime, models and the tasks Copilot cannot serve. */
  getStatus(): Promise<CopilotStatus>;
  /** The stored setting. */
  getSettings(): Promise<CopilotSettings>;
  /** Merge a patch into the setting and resolve to the stored result. */
  update(patch: Partial<CopilotSettings>): Promise<CopilotSettings>;
  /** Begin a sign-in and resolve to what the user must do. */
  startSignIn(): Promise<CopilotSignInChallenge>;
  /** Resolve once the user has finished the sign-in; reject when `signal` aborts or the flow fails. */
  waitForSignIn(signal: AbortSignal): Promise<void>;
  /** Sign out of the runtime. */
  signOut(): Promise<void>;
  /**
   * Download the runtime. Resolves when the download has finished (progress
   * arrives meanwhile through `getStatus`, which the hook polls) and rejects
   * when `signal` aborts or the download fails.
   */
  downloadRuntime(signal: AbortSignal): Promise<void>;
}

/**
 * Options of {@link useCopilotProvider}.
 *
 * @stability experimental
 */
export interface UseCopilotProviderOptions {
  /** How often to re-read the status while the runtime downloads. Default 1000 ms. */
  pollIntervalMs?: number;
}

/**
 * The state and actions {@link useCopilotProvider} returns; each action is the
 * prop of the same name on `CopilotProviderCard`.
 *
 * @stability experimental
 */
export interface UseCopilotProviderResult {
  /** The last status, or `null` before the first read. */
  status: CopilotStatus | null;
  /** The last stored setting, or `null` before the first read. */
  settings: CopilotSettings | null;
  /** The first read is in flight. */
  loading: boolean;
  /** The first read failed, or `null`. */
  error: Error | null;
  /** Re-read the status (and, with `{ settings: true }`, the setting). */
  refresh(options?: { settings?: boolean }): Promise<void>;
  /** Save a patch, then re-read the status. */
  update(patch: Partial<CopilotSettings>): Promise<void>;
  /** Begin a sign-in. */
  startSignIn(): Promise<CopilotSignInChallenge>;
  /** Wait for the sign-in, then re-read the status (also when the wait fails). */
  waitForSignIn(signal: AbortSignal): Promise<void>;
  /** Sign out, then re-read the status. */
  signOut(): Promise<void>;
  /** Download the runtime (abortable with {@link UseCopilotProviderResult.cancelRuntimeDownload}), then re-read the status. */
  downloadRuntime(): Promise<void>;
  /** Abort a running runtime download. */
  cancelRuntimeDownload(): void;
}

/**
 * State and actions behind `CopilotProviderCard`, over a host's
 * {@link CopilotProviderPort}.
 *
 * @remarks
 * Reads the status and the setting on mount, re-reads the status after every
 * change and polls it while `runtime.state` is `downloading`. A host with
 * another design system builds its own UI on this hook. Pass a port that is
 * stable across renders (create it once or `useMemo` it).
 *
 * @param port - The host's routes.
 * @param options - Polling interval.
 * @stability experimental
 */
export function useCopilotProvider(
  port: CopilotProviderPort,
  options: UseCopilotProviderOptions = {},
): UseCopilotProviderResult {
  const { pollIntervalMs = 1000 } = options;
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [settings, setSettings] = useState<CopilotSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const download = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      download.current?.abort();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    const next = await port.getStatus();
    if (mounted.current) setStatus(next);
  }, [port]);

  const refresh = useCallback(
    async (opts?: { settings?: boolean }) => {
      await refreshStatus();
      if (opts?.settings) {
        const next = await port.getSettings();
        if (mounted.current) setSettings(next);
      }
    },
    [port, refreshStatus],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([port.getStatus(), port.getSettings()])
      .then(([s, c]) => {
        if (cancelled) return;
        setStatus(s);
        setSettings(c);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [port]);

  const downloading = status?.runtime.state === 'downloading';
  useEffect(() => {
    if (!downloading) return undefined;
    const timer = setInterval(() => {
      refreshStatus().catch(() => undefined);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [downloading, pollIntervalMs, refreshStatus]);

  const update = useCallback(
    async (patch: Partial<CopilotSettings>) => {
      const stored = await port.update(patch);
      if (mounted.current) setSettings(stored);
      await refreshStatus();
    },
    [port, refreshStatus],
  );

  const startSignIn = useCallback(() => port.startSignIn(), [port]);

  const waitForSignIn = useCallback(
    async (signal: AbortSignal) => {
      try {
        await port.waitForSignIn(signal);
      } finally {
        await refreshStatus().catch(() => undefined);
      }
    },
    [port, refreshStatus],
  );

  const signOut = useCallback(async () => {
    await port.signOut();
    await refreshStatus();
  }, [port, refreshStatus]);

  const downloadRuntime = useCallback(async () => {
    download.current?.abort();
    const controller = new AbortController();
    download.current = controller;
    try {
      await port.downloadRuntime(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    } finally {
      if (download.current === controller) download.current = null;
      await refreshStatus().catch(() => undefined);
    }
  }, [port, refreshStatus]);

  const cancelRuntimeDownload = useCallback(() => {
    download.current?.abort();
  }, []);

  return {
    status,
    settings,
    loading,
    error,
    refresh,
    update,
    startSignIn,
    waitForSignIn,
    signOut,
    downloadRuntime,
    cancelRuntimeDownload,
  };
}
