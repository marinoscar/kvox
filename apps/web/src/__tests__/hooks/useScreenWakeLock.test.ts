/**
 * Screen Wake Lock — issue #22, epic #19.
 *
 * Three things are worth asserting and one of them is the whole reason the
 * hook is more than four lines: the browser RELEASES the sentinel itself
 * whenever the document is hidden, and never re-grants it. Without the
 * `visibilitychange` re-acquire, a user who glances at a notification loses
 * the lock for the rest of the upload — and every test that never hides the
 * document still passes.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWakeLockSupported, useScreenWakeLock } from '../../hooks/useScreenWakeLock';

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  fireRelease: () => void;
}

function makeSentinel(): FakeSentinel {
  const listeners: Array<() => void> = [];
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type, listener) => {
      if (type === 'release') listeners.push(listener);
    },
    fireRelease: () => listeners.forEach((listener) => listener()),
  };
  return sentinel;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('useScreenWakeLock', () => {
  let request: ReturnType<typeof vi.fn>;
  let sentinels: FakeSentinel[];

  beforeEach(() => {
    sentinels = [];
    request = vi.fn().mockImplementation(async () => {
      const sentinel = makeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    });
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      writable: true,
      value: { request },
    });
    setVisibility('visible');
  });

  afterEach(() => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    setVisibility('visible');
  });

  it('requests a screen lock while an upload is active and releases it afterwards', async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useScreenWakeLock({ enabled: true, active }),
      { initialProps: { active: true } },
    );

    await act(async () => {});

    expect(request).toHaveBeenCalledWith('screen');
    expect(result.current.supported).toBe(true);
    expect(result.current.held).toBe(true);

    rerender({ active: false });
    await act(async () => {});

    expect(sentinels[0].release).toHaveBeenCalled();
    expect(result.current.held).toBe(false);
  });

  it('does not request a lock while the preference is off', async () => {
    renderHook(() => useScreenWakeLock({ enabled: false, active: true }));
    await act(async () => {});

    expect(request).not.toHaveBeenCalled();
  });

  it('re-acquires when the page becomes visible again', async () => {
    const { result } = renderHook(() => useScreenWakeLock({ enabled: true, active: true }));
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);

    // What the browser really does on hide: it drops the sentinel itself.
    setVisibility('hidden');
    await act(async () => {
      sentinels[0].fireRelease();
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.held).toBe(false);
    // Hidden documents are refused by spec, so nothing is asked for here.
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBe(true);
  });

  it('releases the lock when the component unmounts', async () => {
    const { unmount } = renderHook(() => useScreenWakeLock({ enabled: true, active: true }));
    await act(async () => {});

    unmount();
    await act(async () => {});

    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it('is silent where the API is unsupported', async () => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;

    expect(isWakeLockSupported()).toBe(false);

    const { result } = renderHook(() => useScreenWakeLock({ enabled: true, active: true }));
    await act(async () => {});

    expect(result.current.supported).toBe(false);
    expect(result.current.held).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('is silent when the request is denied', async () => {
    request.mockRejectedValue(new Error('NotAllowedError'));

    const { result } = renderHook(() => useScreenWakeLock({ enabled: true, active: true }));
    await act(async () => {});

    expect(result.current.supported).toBe(true);
    expect(result.current.held).toBe(false);
  });
});
