/**
 * `useMaintenance` / `useMaintenanceBlock` — issue #258, epic #254.
 *
 * The behaviours here are the ones the component suites cannot see from the
 * outside: what the hook does to the module-level block store when a window is
 * closed, and whether it honours `enabled: false` by making no request at all.
 * Everything visual about the banner and the admin page is asserted where it
 * belongs, against those components.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, renderHook, waitFor } from '@testing-library/react';
import { server } from '../mocks/server';
import {
  MAINTENANCE_POLL_INTERVAL_MS,
  useMaintenance,
  useMaintenanceBlock,
} from '../../hooks/useMaintenance';
import { api } from '../../services/api';
import {
  clearMaintenanceBlock,
  getMaintenanceBlock,
  reportMaintenanceBlock,
} from '../../services/maintenance';
import type { MaintenanceStatus } from '../../types';

function status(overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return {
    enabled: false,
    message: 'Back shortly.',
    allowAdmins: true,
    startedAt: null,
    startedById: null,
    source: 'persisted',
    layers: {
      env: { present: false, enabled: null },
      memory: { present: false, override: null },
      persisted: {
        readable: true,
        value: {
          enabled: false,
          message: 'Back shortly.',
          allowAdmins: true,
          startedAt: null,
          startedById: null,
        },
      },
    },
    ...overrides,
  };
}

const BLOCK = { message: 'Back shortly.', retryAfterSeconds: 30, allowAdmins: true };

describe('useMaintenanceBlock', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  it('re-renders when the store changes underneath it', () => {
    // The producer is a `fetch` handler with no React in scope, which is the
    // entire reason this is a `useSyncExternalStore` bridge rather than state.
    const { result } = renderHook(() => useMaintenanceBlock());

    expect(result.current.block).toBeNull();

    act(() => reportMaintenanceBlock(BLOCK));
    expect(result.current.block).toEqual(BLOCK);

    act(() => result.current.clear());
    expect(result.current.block).toBeNull();
  });
});

describe('useMaintenance', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
    vi.useRealTimers();
  });

  it('makes no request when disabled, and does not sit in a permanent loading state', async () => {
    // The banner mounts for every signed-in user and passes `enabled: false`
    // for the great majority who hold no `system_settings:read`. A hook that
    // reported `isLoading: true` forever would leave that component unable to
    // tell "not known yet" from "nothing to say".
    let calls = 0;
    server.use(
      http.get('*/api/admin/maintenance', () => {
        calls += 1;
        return HttpResponse.json({ data: status() });
      }),
    );

    const { result } = renderHook(() => useMaintenance({ enabled: false }));

    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(calls).toBe(0);
  });

  it('polls on the interval it is given, and stops on unmount', async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get('*/api/admin/maintenance', () => {
        calls += 1;
        return HttpResponse.json({ data: status() });
      }),
    );

    const { unmount } = renderHook(() =>
      useMaintenance({ pollIntervalMs: MAINTENANCE_POLL_INTERVAL_MS }),
    );

    await vi.waitFor(() => expect(calls).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_INTERVAL_MS);
    });
    await vi.waitFor(() => expect(calls).toBe(2));

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_INTERVAL_MS * 3);
    });
    expect(calls).toBe(2);
  });

  it('never polls when no interval is given', async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get('*/api/admin/maintenance', () => {
        calls += 1;
        return HttpResponse.json({ data: status() });
      }),
    );

    renderHook(() => useMaintenance());

    await vi.waitFor(() => expect(calls).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_INTERVAL_MS * 5);
    });
    expect(calls).toBe(1);
  });

  it('drops a recorded block when a save actually closes the window', async () => {
    // The one caller entitled to clear the gate, because it is the one that
    // knows something changed. An admin who closed a window from the page the
    // gate lets through must not be left looking at the maintenance screen.
    server.use(
      http.get('*/api/admin/maintenance', () => HttpResponse.json({ data: status({ enabled: true }) })),
      http.put('*/api/admin/maintenance', () => HttpResponse.json({ data: status({ enabled: false }) })),
    );

    reportMaintenanceBlock(BLOCK);
    const { result } = renderHook(() => useMaintenance());
    await waitFor(() => expect(result.current.status?.enabled).toBe(true));

    await act(async () => {
      await result.current.save({ enabled: false });
    });

    expect(getMaintenanceBlock()).toBeNull();
  });

  it('keeps the block when the save left the window OPEN because an env override outranks it', async () => {
    // `save({ enabled: false })` succeeded and the application is still out of
    // service. Clearing on the INPUT rather than on the server's effective
    // answer would show this operator an application that blocks them again on
    // the next request.
    server.use(
      http.get('*/api/admin/maintenance', () => HttpResponse.json({ data: status({ enabled: true }) })),
      http.put('*/api/admin/maintenance', () =>
        HttpResponse.json({
          data: status({
            enabled: true,
            source: 'env',
            layers: {
              env: { present: true, enabled: true },
              memory: { present: false, override: null },
              persisted: status().layers.persisted,
            },
          }),
        }),
      ),
    );

    reportMaintenanceBlock(BLOCK);
    const { result } = renderHook(() => useMaintenance());
    await waitFor(() => expect(result.current.status?.enabled).toBe(true));

    await act(async () => {
      await result.current.save({ enabled: false });
    });

    expect(result.current.status?.source).toBe('env');
    expect(getMaintenanceBlock()).toEqual(BLOCK);
  });

  it('resolves false and captures the message rather than throwing, when a save fails', async () => {
    // Every caller of `save` is a click handler that needs to branch, not a
    // place to handle an exception already captured for rendering — the same
    // contract `useEmailSettings` established.
    server.use(
      http.get('*/api/admin/maintenance', () => HttpResponse.json({ data: status() })),
      http.put('*/api/admin/maintenance', () =>
        HttpResponse.json({ message: 'Nope' }, { status: 400 }),
      ),
    );

    const { result } = renderHook(() => useMaintenance());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.save({ enabled: true });
    });

    expect(outcome).toBe(false);
    expect(result.current.saveError).toBe('Nope');
  });
});
