import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';

/**
 * Issue #126, epic #109. This hook OBSERVES the browser's notification
 * permission and must NEVER request it - see the extensive header of
 * `hooks/useBrowserNotificationPermission.ts`. A denial is effectively
 * permanent, and browsers penalise (suppress or auto-deny) a prompt fired
 * with no user gesture, so a call to `Notification.requestPermission()` from
 * this hook would spend that one-shot resource on every visitor to
 * `/settings/notifications`, whether or not they ever asked for notifications.
 * #127 adds the deliberate click; nothing here may call it, ever.
 */

const originalNotification = (window as any).Notification;

function setNotification(
  permission: 'granted' | 'denied' | 'default' | 'absent',
  opts: { throwOnRead?: boolean } = {},
) {
  if (permission === 'absent') {
    delete (window as any).Notification;
    return null;
  }

  const requestPermission = vi.fn();

  if (opts.throwOnRead) {
    // Some embedded/privacy-hardened browsers define `Notification` but throw
    // on the `.permission` property access itself - see readPermission()'s own
    // `try` block.
    (window as any).Notification = {
      get permission(): string {
        throw new Error('blocked by privacy hardening');
      },
      requestPermission,
    };
  } else {
    (window as any).Notification = { permission, requestPermission };
  }

  return requestPermission;
}

describe('useBrowserNotificationPermission', () => {
  afterEach(() => {
    if (originalNotification === undefined) {
      delete (window as any).Notification;
    } else {
      (window as any).Notification = originalNotification;
    }
    vi.restoreAllMocks();
  });

  describe('the four distinct permission states', () => {
    it('reads "unsupported" when window.Notification does not exist at all', () => {
      setNotification('absent');

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('unsupported');
    });

    it('reads "granted"', () => {
      setNotification('granted');

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('granted');
    });

    it('reads "denied"', () => {
      setNotification('denied');

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('denied');
    });

    it('reads "default" for the browser\'s not-yet-asked value', () => {
      setNotification('default');

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('default');
    });

    it('falls back to "unsupported" - not a thrown error - when reading .permission throws', () => {
      setNotification('granted', { throwOnRead: true });

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('unsupported');
    });

    it('treats an unrecognised .permission value as "default" rather than passing it through', () => {
      (window as any).Notification = { permission: 'something-new', requestPermission: vi.fn() };

      const { result } = renderHook(() => useBrowserNotificationPermission());

      expect(result.current.permission).toBe('default');
    });
  });

  it('refresh() re-reads the live value without a remount', async () => {
    setNotification('default');
    const { result } = renderHook(() => useBrowserNotificationPermission());

    expect(result.current.permission).toBe('default');

    (window as any).Notification.permission = 'granted';
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.permission).toBe('granted'));
  });

  it('re-reads on visibilitychange - the user may have granted permission in another tab and come back', async () => {
    setNotification('default');
    const { result } = renderHook(() => useBrowserNotificationPermission());

    expect(result.current.permission).toBe('default');

    (window as any).Notification.permission = 'granted';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.permission).toBe('granted'));
  });

  // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE, per the hook's own
  // header. Checked across mount, an explicit refresh, and the
  // visibilitychange re-read - none of this hook's code paths may ever call
  // `Notification.requestPermission()`.
  it('never calls Notification.requestPermission - not on mount, refresh, or visibilitychange', async () => {
    const requestPermission = setNotification('default')!;

    const { result } = renderHook(() => useBrowserNotificationPermission());
    expect(requestPermission).not.toHaveBeenCalled();

    act(() => {
      result.current.refresh();
    });
    expect(requestPermission).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('never calls Notification.requestPermission when the browser has already denied - the app cannot recover from that by re-asking', () => {
    const requestPermission = setNotification('denied')!;

    renderHook(() => useBrowserNotificationPermission());

    expect(requestPermission).not.toHaveBeenCalled();
  });
});
