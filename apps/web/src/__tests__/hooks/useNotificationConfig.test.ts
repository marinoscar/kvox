import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import { getNotificationConfig, ApiError } from '../../services/api';
import type { NotificationConfigResponse } from '../../types';

/**
 * Issue #227, epic #215. `useNotificationConfig` is a plain fetch-on-mount
 * hook in the shape of `useNotificationEvents` / `useUserSettings` - see its
 * own file header. This suite mirrors `useUserSettings.test.ts`'s pattern for
 * mocking `services/api` (a hand-rolled `ApiError` class alongside the mocked
 * function) because the hook's error branch does `err instanceof ApiError`,
 * which requires the SAME class reference the hook imports - importActual
 * would also work, but re-declaring here keeps this file self-contained and
 * consistent with `useUserSettings.test.ts`.
 */

vi.mock('../../services/api', () => ({
  getNotificationConfig: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

const mockGetNotificationConfig = vi.mocked(getNotificationConfig);

const mockConfig: NotificationConfigResponse = {
  browserEnabled: true,
  pushEnabled: false,
  vapidPublicKey: null,
};

describe('useNotificationConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts loading, with config: null and no error', () => {
      mockGetNotificationConfig.mockReturnValue(new Promise(() => {})); // never resolves

      const { result } = renderHook(() => useNotificationConfig());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.config).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  describe('fetch on mount - success', () => {
    it('populates config and clears the loading state', async () => {
      mockGetNotificationConfig.mockResolvedValue(mockConfig);

      const { result } = renderHook(() => useNotificationConfig());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.config).toEqual(mockConfig);
      expect(result.current.error).toBeNull();
      expect(mockGetNotificationConfig).toHaveBeenCalledTimes(1);
    });

    it('reports browserEnabled: false faithfully - it is not the hook’s job to interpret it', async () => {
      mockGetNotificationConfig.mockResolvedValue({
        browserEnabled: false,
        pushEnabled: false,
        vapidPublicKey: null,
      });

      const { result } = renderHook(() => useNotificationConfig());

      await waitFor(() => expect(result.current.config?.browserEnabled).toBe(false));
    });
  });

  describe('fetch on mount - failure', () => {
    it('populates error with the ApiError message and leaves config null', async () => {
      mockGetNotificationConfig.mockRejectedValue(new ApiError('Forbidden', 403));

      const { result } = renderHook(() => useNotificationConfig());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.config).toBeNull();
      expect(result.current.error).toBe('Forbidden');
    });

    it('falls back to a generic message for a non-ApiError failure', async () => {
      mockGetNotificationConfig.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useNotificationConfig());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.config).toBeNull();
      expect(result.current.error).toBe('Failed to load notification config');
    });
  });

  describe('refresh', () => {
    it('re-fetches and replaces the config with the new result', async () => {
      mockGetNotificationConfig.mockResolvedValue(mockConfig);

      const { result } = renderHook(() => useNotificationConfig());
      await waitFor(() => expect(result.current.config).toEqual(mockConfig));

      const updatedConfig: NotificationConfigResponse = {
        browserEnabled: false,
        pushEnabled: false,
        vapidPublicKey: null,
      };
      mockGetNotificationConfig.mockResolvedValue(updatedConfig);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.config).toEqual(updatedConfig);
      expect(mockGetNotificationConfig).toHaveBeenCalledTimes(2);
    });

    it('clears a previous error on a successful refresh', async () => {
      mockGetNotificationConfig.mockRejectedValue(new ApiError('Server error', 500));

      const { result } = renderHook(() => useNotificationConfig());
      await waitFor(() => expect(result.current.error).toBe('Server error'));

      mockGetNotificationConfig.mockResolvedValue(mockConfig);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.config).toEqual(mockConfig);
    });

    it('sets isLoading true for the duration of a refresh', async () => {
      mockGetNotificationConfig.mockResolvedValue(mockConfig);
      const { result } = renderHook(() => useNotificationConfig());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let resolveRefetch!: (value: NotificationConfigResponse) => void;
      mockGetNotificationConfig.mockReturnValue(
        new Promise((resolve) => {
          resolveRefetch = resolve;
        }),
      );

      let refreshPromise: Promise<void>;
      act(() => {
        refreshPromise = result.current.refresh();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(true));

      resolveRefetch(mockConfig);
      await act(async () => {
        await refreshPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });
  });
});
