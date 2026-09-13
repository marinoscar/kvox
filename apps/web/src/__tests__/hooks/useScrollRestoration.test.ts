import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';

/**
 * Mirrors the hook's own private `RESTORE_DEADLINE_MS`. Kept as a named
 * constant here (rather than a magic `1000` sprinkled through the deadline
 * test) so a change to the hook's constant is one obvious diff away from a
 * failing test telling you to update this one too.
 */
const RESTORE_DEADLINE_MS = 1000;

const namespacedKey = (key: string) => `eab:scroll:${key}`;

/**
 * jsdom never lays out real content, so `document.documentElement.scrollHeight`
 * sits at 0 forever and real `requestAnimationFrame` timing is both
 * unreliable and needlessly slow to drive from a test. Both are stubbed:
 *
 *  - `requestAnimationFrame` / `cancelAnimationFrame` become a manually
 *    flushed queue (`flushRAF`), so the save-coalescing and restore-retry
 *    loops advance exactly one "frame" per call instead of racing real paint
 *    timing. A callback scheduled DURING a flush lands in the next frame,
 *    same as the real API.
 *  - `scrollHeight` / `innerHeight` become settable via `setDocumentHeight`,
 *    which is what lets a test simulate content growing between retries.
 */
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }>;
let rafIdCounter: number;

function installRAFMock(): void {
  rafQueue = [];
  rafIdCounter = 0;
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafIdCounter += 1;
    rafQueue.push({ id: rafIdCounter, cb });
    return rafIdCounter;
  });
  window.cancelAnimationFrame = vi.fn((id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
}

/** Runs every callback queued right now as one "frame". */
function flushRAF(): void {
  const queue = rafQueue;
  rafQueue = [];
  queue.forEach((entry) => entry.cb(0));
}

function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

function setDocumentHeight(scrollHeight: number, innerHeight = 800): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
}

beforeEach(() => {
  installRAFMock();
  window.sessionStorage.clear();
  window.scrollTo = vi.fn();
  setScrollY(0);
  setDocumentHeight(0, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScrollRestoration — saving', () => {
  it('writes the rounded scroll offset to sessionStorage under the namespaced key, coalesced through one rAF', () => {
    setScrollY(123.6);
    renderHook(() => useScrollRestoration('hub'));

    window.dispatchEvent(new Event('scroll'));
    // Coalesced: nothing is written synchronously from the event itself.
    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBeNull();

    flushRAF();

    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBe('124');
  });

  it('coalesces several scroll events inside the same frame into a single scheduled write', () => {
    renderHook(() => useScrollRestoration('hub'));
    const scheduledBefore = rafQueue.length;

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));

    // A dozen events per second is the normal shape of one scroll gesture —
    // only one frame callback should ever be pending regardless of count.
    expect(rafQueue.length).toBe(scheduledBefore + 1);
  });
});

describe('useScrollRestoration — restoring', () => {
  it('calls scrollTo once the document is already tall enough to reach the saved target', () => {
    window.sessionStorage.setItem(namespacedKey('hub'), '500');
    setDocumentHeight(2000, 800); // maxScroll = 1200 >= 500, satisfied on the first attempt

    renderHook(() => useScrollRestoration('hub'));

    // Only scheduled at mount — nothing has run until a frame is flushed.
    expect(window.scrollTo).not.toHaveBeenCalled();

    flushRAF();

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'auto' });
  });

  it('retries on later frames without restoring while the document stays too short, then gives up past the deadline', () => {
    window.sessionStorage.setItem(namespacedKey('hub'), '500');
    setDocumentHeight(100, 800); // maxScroll = -700, nowhere near the target

    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    renderHook(() => useScrollRestoration('hub'));

    flushRAF(); // 1st attempt: too short, reschedules itself
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(rafQueue.length).toBe(1);

    flushRAF(); // 2nd attempt: still too short, still before the deadline
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(rafQueue.length).toBe(1);

    // Cross the ~1000ms deadline before the next queued attempt runs.
    dateNowSpy.mockReturnValue(RESTORE_DEADLINE_MS + 1);
    flushRAF();

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(rafQueue.length).toBe(0); // gave up — no further frame gets scheduled
  });

  it('aborts a pending restore when a genuine user scroll happens, even if the document would have qualified on the next frame', () => {
    window.sessionStorage.setItem(namespacedKey('hub'), '500');
    setDocumentHeight(100, 800); // too short — the restore needs at least one retry

    renderHook(() => useScrollRestoration('hub'));
    flushRAF(); // schedules the retry attempt
    expect(rafQueue.length).toBe(1);

    // The document becomes tall enough to satisfy the target...
    setDocumentHeight(2000, 800);
    // ...but a real user scroll arrives first and must cancel the pending attempt.
    window.dispatchEvent(new Event('scroll'));

    flushRAF(); // runs only what abortRestore left behind (the coalesced save, if anything)

    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

describe('useScrollRestoration — enabled: false', () => {
  it('is a complete no-op: no listener, no restore attempt, and no final write on unmount', () => {
    window.sessionStorage.setItem(namespacedKey('hub'), '500');
    setDocumentHeight(2000, 800);
    setScrollY(999);

    const { unmount } = renderHook(() => useScrollRestoration('hub', { enabled: false }));

    expect(rafQueue.length).toBe(0); // nothing scheduled at mount
    flushRAF();
    expect(window.scrollTo).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('scroll'));
    expect(rafQueue.length).toBe(0); // no listener means no save gets scheduled

    const before = window.sessionStorage.getItem(namespacedKey('hub'));
    unmount();

    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBe(before); // untouched by unmount
  });
});

describe('useScrollRestoration — sessionStorage failures (Safari private mode)', () => {
  it('does not throw when getItem/setItem both throw, across mount, a scroll write, and unmount', () => {
    // `vi.spyOn(window.sessionStorage, 'getItem')` does not stick in jsdom —
    // `window.sessionStorage` is a live getter, not a stable object identity,
    // so a spy installed on one read is gone by the next. A full replacement
    // of the property (the same pattern `setup.ts` uses for `localStorage`)
    // is what actually reaches the hook's calls.
    const originalSessionStorage = window.sessionStorage;
    const getItem = vi.fn(() => {
      throw new DOMException('storage disabled');
    });
    const setItem = vi.fn(() => {
      throw new DOMException('storage disabled');
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: { getItem, setItem, removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 },
      configurable: true,
      writable: true,
    });

    try {
      expect(() => {
        // Mount triggers a read(); the dispatched scroll + flush trigger a
        // coalesced write(); unmount triggers the final synchronous write().
        const { unmount } = renderHook(() => useScrollRestoration('hub'));
        window.dispatchEvent(new Event('scroll'));
        flushRAF();
        unmount();
      }).not.toThrow();

      expect(getItem).toHaveBeenCalled();
      expect(setItem).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        value: originalSessionStorage,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('useScrollRestoration — unmount', () => {
  it('removes the scroll listener: a scroll event dispatched after unmount writes nothing', () => {
    setScrollY(50);
    const { unmount } = renderHook(() => useScrollRestoration('hub'));
    unmount();
    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBe('50');

    setScrollY(999);
    window.dispatchEvent(new Event('scroll'));
    flushRAF();

    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBe('50');
  });

  it('performs one final synchronous write of window.scrollY at unmount, even with no prior scroll event', () => {
    setScrollY(321);
    const { unmount } = renderHook(() => useScrollRestoration('hub'));
    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBeNull();

    unmount();

    expect(window.sessionStorage.getItem(namespacedKey('hub'))).toBe('321');
  });
});
