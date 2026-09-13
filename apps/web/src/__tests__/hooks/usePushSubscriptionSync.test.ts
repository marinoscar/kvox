import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePushSubscriptionSync } from '../../hooks/usePushSubscriptionSync';
import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import { useNotificationCapability } from '../../hooks/useNotificationCapability';
import {
  claimAutoPermissionPrompt,
  requestPermissionAndSyncPush,
  syncPushSubscription,
} from '../../services/pushSubscription';
import type { NotificationConfigResponse } from '../../types';
import type { NotificationCapability } from '../../hooks/useNotificationCapability';

/**
 * Issue #365, epic #215. `usePushSubscriptionSync` composes two existing,
 * independently-tested hooks (`useNotificationConfig`, `useNotificationCapability`
 * — see their own suites) with `services/pushSubscription.ts`, so all three are
 * mocked here: this suite is only about the WIRING between them — when the
 * auto-prompt fires, and when the boot sync fires — not about re-deriving
 * capability precedence or config-fetch behaviour those other suites already
 * own. Mirrors `UserNotificationsPage.test.tsx`'s pattern for mocking these
 * same two hooks.
 */

vi.mock('../../hooks/useNotificationConfig', () => ({
  useNotificationConfig: vi.fn(),
}));

vi.mock('../../hooks/useNotificationCapability', () => ({
  useNotificationCapability: vi.fn(),
}));

vi.mock('../../services/pushSubscription', () => ({
  claimAutoPermissionPrompt: vi.fn(),
  requestPermissionAndSyncPush: vi.fn(),
  syncPushSubscription: vi.fn(),
}));

const mockUseNotificationConfig = vi.mocked(useNotificationConfig);
const mockUseNotificationCapability = vi.mocked(useNotificationCapability);
const mockClaim = vi.mocked(claimAutoPermissionPrompt);
const mockRequestAndSync = vi.mocked(requestPermissionAndSyncPush);
const mockSync = vi.mocked(syncPushSubscription);

function mockConfig(config: NotificationConfigResponse | null): void {
  mockUseNotificationConfig.mockReturnValue({
    config,
    isLoading: config === null,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

function mockCapability(
  capability: NotificationCapability,
  permission: 'default' | 'granted' | 'denied' | 'unsupported' = 'default',
): void {
  mockUseNotificationCapability.mockReturnValue({
    capability,
    permission,
    refresh: vi.fn(),
  });
}

const ENABLED_CONFIG: NotificationConfigResponse = {
  browserEnabled: true,
  pushEnabled: true,
  vapidPublicKey: 'BKey123',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockReturnValue(true);
  mockRequestAndSync.mockResolvedValue('granted');
  mockSync.mockResolvedValue(undefined);
});

describe('usePushSubscriptionSync', () => {
  describe('the auto-prompt', () => {
    it('claims the one-shot prompt and requests permission when push is enabled and capability is default', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('default', 'default');

      renderHook(() => usePushSubscriptionSync());

      await waitFor(() => expect(mockClaim).toHaveBeenCalledTimes(1));
      expect(mockRequestAndSync).toHaveBeenCalledTimes(1);
      expect(mockRequestAndSync).toHaveBeenCalledWith(ENABLED_CONFIG);
    });

    it('does not prompt again on a rerender once the one-shot claim is spent', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('default', 'default');
      // Simulates the REAL module's one-shot semantics for this test: the
      // first claim succeeds, every subsequent one fails until reset.
      mockClaim.mockReturnValueOnce(true).mockReturnValue(false);

      const { rerender } = renderHook(() => usePushSubscriptionSync());
      await waitFor(() => expect(mockRequestAndSync).toHaveBeenCalledTimes(1));

      rerender();
      rerender();

      expect(mockRequestAndSync).toHaveBeenCalledTimes(1);
    });

    it('does not prompt again after an unmount/remount either — the claim is spent for the page load, not the component instance', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('default', 'default');
      mockClaim.mockReturnValueOnce(true).mockReturnValue(false);

      const { unmount } = renderHook(() => usePushSubscriptionSync());
      await waitFor(() => expect(mockRequestAndSync).toHaveBeenCalledTimes(1));
      unmount();

      renderHook(() => usePushSubscriptionSync());

      expect(mockClaim).toHaveBeenCalledTimes(2);
      expect(mockRequestAndSync).toHaveBeenCalledTimes(1);
    });

    it('never prompts when the deployment has turned browser notifications off (browserEnabled: false)', () => {
      mockConfig({ browserEnabled: false, pushEnabled: true, vapidPublicKey: 'BKey123' });
      mockCapability('default', 'default');

      renderHook(() => usePushSubscriptionSync());

      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockRequestAndSync).not.toHaveBeenCalled();
    });

    it('never prompts when push is not enabled (pushEnabled: false)', () => {
      mockConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });
      mockCapability('default', 'default');

      renderHook(() => usePushSubscriptionSync());

      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockRequestAndSync).not.toHaveBeenCalled();
    });

    it('never prompts while the config has not loaded yet (config: null)', () => {
      mockConfig(null);
      mockCapability('default', 'default');

      renderHook(() => usePushSubscriptionSync());

      expect(mockClaim).not.toHaveBeenCalled();
    });

    it('does not even attempt the claim outside the default capability', () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('granted', 'granted');

      renderHook(() => usePushSubscriptionSync());

      expect(mockClaim).not.toHaveBeenCalled();
    });
  });

  describe('the boot sync', () => {
    it('syncs with the fetched key when permission is granted and a key is present', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('granted', 'granted');

      renderHook(() => usePushSubscriptionSync());

      await waitFor(() => expect(mockSync).toHaveBeenCalledWith('BKey123'));
    });

    it('does not sync when permission is not granted', () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('default', 'default');

      renderHook(() => usePushSubscriptionSync());

      expect(mockSync).not.toHaveBeenCalled();
    });

    it('does not sync when pushEnabled is true but no key is present yet', () => {
      mockConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: null });
      mockCapability('granted', 'granted');

      renderHook(() => usePushSubscriptionSync());

      expect(mockSync).not.toHaveBeenCalled();
    });

    it('does not sync when push is not enabled at all, even if granted', () => {
      mockConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });
      mockCapability('granted', 'granted');

      renderHook(() => usePushSubscriptionSync());

      expect(mockSync).not.toHaveBeenCalled();
    });

    it('re-syncs when the key changes (VAPID rotation) without an explicit permission re-grant', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('granted', 'granted');

      const { rerender } = renderHook(() => usePushSubscriptionSync());
      await waitFor(() => expect(mockSync).toHaveBeenCalledWith('BKey123'));

      mockConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BKeyRotated' });
      rerender();

      await waitFor(() => expect(mockSync).toHaveBeenCalledWith('BKeyRotated'));
    });
  });

  describe('requestPermission (the banner/button action)', () => {
    it('delegates to requestPermissionAndSyncPush with the current config, and settles isRequestingPermission back to false', async () => {
      mockConfig(ENABLED_CONFIG);
      mockCapability('default', 'default');
      mockClaim.mockReturnValue(false); // no auto-prompt noise in this test

      let resolvePermission!: (value: NotificationPermission) => void;
      mockRequestAndSync.mockReturnValue(
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      );

      const { result } = renderHook(() => usePushSubscriptionSync());
      expect(result.current.isRequestingPermission).toBe(false);

      let requestPromise!: Promise<void>;
      act(() => {
        requestPromise = result.current.requestPermission();
      });

      // Still pending — the mock above deliberately has not resolved yet.
      await waitFor(() => expect(result.current.isRequestingPermission).toBe(true));

      act(() => {
        resolvePermission('granted');
      });
      await act(async () => {
        await requestPromise;
      });

      expect(mockRequestAndSync).toHaveBeenCalledWith(ENABLED_CONFIG);
      expect(result.current.isRequestingPermission).toBe(false);
    });
  });
});
