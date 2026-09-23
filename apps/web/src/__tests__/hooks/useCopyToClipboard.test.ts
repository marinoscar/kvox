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

/**
 * `copyRich` — issue #334.
 *
 * Puts BOTH `text/html` and `text/plain` on the clipboard through
 * `ClipboardItem` when it can, and falls back to the plain-text `copy` path
 * — never throwing — whenever `ClipboardItem`, `navigator.clipboard.write`,
 * or the write itself is unavailable or refused.
 */
describe('useCopyToClipboard — copyRich', () => {
  const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

  beforeEach(() => {
    setSecureContext(true);
  });

  afterEach(() => {
    if (originalClipboardItem === undefined) {
      delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    } else {
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
    }
  });

  it('writes a ClipboardItem carrying both text/html and text/plain, and reports done', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const capturedItems: ClipboardItem[] = [];
    write.mockImplementation((items: ClipboardItem[]) => {
      capturedItems.push(...items);
      return Promise.resolve();
    });
    class FakeClipboardItem {
      types: Record<string, Blob>;
      constructor(types: Record<string, Blob>) {
        this.types = types;
      }
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copyRich({ text: 'plain', html: '<p>rich</p>' });
    });

    expect(ok).toBe(true);
    expect(result.current.state).toBe('done');
    expect(write).toHaveBeenCalledTimes(1);
    expect(capturedItems).toHaveLength(1);
    const built = capturedItems[0] as unknown as FakeClipboardItem;
    expect(Object.keys(built.types)).toEqual(['text/html', 'text/plain']);
  });

  it('falls back to plain-text copy when ClipboardItem is unavailable', async () => {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copyRich({ text: 'plain text', html: '<p>rich</p>' });
    });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain text');
    expect(result.current.state).toBe('done');
  });

  it('falls back to plain-text copy when navigator.clipboard.write is missing', async () => {
    class FakeClipboardItem {
      constructor(public types: Record<string, Blob>) {}
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copyRich({ text: 'plain text', html: '<p>rich</p>' });
    });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain text');
  });

  it('falls back to plain-text copy, and never throws, when the rich write is refused', async () => {
    class FakeClipboardItem {
      constructor(public types: Record<string, Blob>) {}
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn().mockRejectedValue(new Error('refused'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await expect(
      act(async () => {
        ok = await result.current.copyRich({ text: 'plain text', html: '<p>rich</p>' });
      }),
    ).resolves.not.toThrow();

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain text');
    expect(result.current.state).toBe('done');
  });

  it('reports failed, never throws, when both the rich write and the fallback are refused', async () => {
    class FakeClipboardItem {
      constructor(public types: Record<string, Blob>) {}
    }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn().mockRejectedValue(new Error('refused'));
    const writeText = vi.fn().mockRejectedValue(new Error('also refused'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });

    const { result } = renderHook(() => useCopyToClipboard());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copyRich({ text: 'plain text', html: '<p>rich</p>' });
    });

    expect(ok).toBe(false);
    expect(result.current.state).toBe('failed');
  });
});
