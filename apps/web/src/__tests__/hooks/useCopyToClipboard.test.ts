import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

/**
 * `useCopyToClipboard` — issue #308.
 *
 * ⚠ A FAILED COPY IS NEVER REPORTED AS A SUCCESS. That is the one invariant
 * this hook exists to hold, so the suite is organised around the two paths
 * that can produce `'done'` or `'failed'` — the modern `navigator.clipboard`
 * path, gated on `window.isSecureContext`, and the legacy `execCommand('copy')`
 * fallback for everywhere it is not — plus the lifecycle guarantees (the
 * `idle` reset, and never touching state after unmount) that make it safe to
 * drop into any component without a `catch` of its own.
 */

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('useCopyToClipboard — the modern path (secure context)', () => {
  beforeEach(() => {
    setSecureContext(true);
  });

  it('writes through navigator.clipboard and reports done', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('hello world');
    });

    expect(writeText).toHaveBeenCalledWith('hello world');
    expect(ok).toBe(true);
    expect(result.current.state).toBe('done');
  });

  it('reports failed, never done, when the browser refuses the write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('hello world');
    });

    expect(ok).toBe(false);
    expect(result.current.state).toBe('failed');
  });
});

describe('useCopyToClipboard — the legacy path (insecure context)', () => {
  beforeEach(() => {
    setSecureContext(false);
  });

  it('falls back to execCommand on an off-screen textarea, and cleans it up', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('legacy text');
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    // The textarea `execCommand` copied from was appended once…
    const textarea = appendSpy.mock.calls
      .map(([node]) => node)
      .find((node): node is HTMLTextAreaElement => node instanceof HTMLTextAreaElement);
    expect(textarea).toBeDefined();
    expect(textarea?.value).toBe('legacy text');
    // …and removed again — it must never linger in the document.
    expect(document.body.contains(textarea!)).toBe(false);

    expect(ok).toBe(true);
    expect(result.current.state).toBe('done');
  });

  it('reports failed when execCommand itself declines', async () => {
    document.execCommand = vi.fn().mockReturnValue(false);

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy('legacy text');
    });

    expect(ok).toBe(false);
    expect(result.current.state).toBe('failed');
  });
});

describe('useCopyToClipboard — lifecycle', () => {
  beforeEach(() => {
    setSecureContext(true);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets to idle after the timeout', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard(2000));

    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.state).toBe('done');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.state).toBe('idle');
  });

  it('never touches state, and never warns, after the component unmounts', async () => {
    // A deferred promise so the write is still in flight when we unmount.
    let resolveWrite: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useCopyToClipboard());

    let copyPromise!: Promise<boolean>;
    act(() => {
      copyPromise = result.current.copy('hello');
    });

    unmount();

    await act(async () => {
      resolveWrite();
      await copyPromise;
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
