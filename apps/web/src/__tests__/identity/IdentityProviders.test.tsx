/**
 * KVox's wiring of the packaged `AuthProvider` (issue #465).
 *
 * The provider's own behaviour (session probe, providers list, login redirect,
 * expiry) is proved by `@marinoscar/platform-web`'s suite. These are the cases
 * of the old `AuthContext.test.tsx` that are about KVOX's glue, ported:
 *
 *   - #365: logout drops this device's push subscription BEFORE
 *     `POST /auth/logout` (the access token must still be valid), and still
 *     signs the user out when that cleanup rejects.
 *   - the provider is driven by KVox's `PlatformHttpClient`, so the session it
 *     restores is the one `api` then uses for every other call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useAuth } from '@marinoscar/platform-web/identity/headless';
import { server } from '../mocks/server';
import { IdentityProviders } from '../../identity/IdentityProviders';
import { api } from '../../services/api';

vi.mock('@marinoscar/platform-web/notifications/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/notifications/headless')>()),
  removePushSubscription: vi.fn().mockResolvedValue(undefined),
}));

import { removePushSubscription } from '@marinoscar/platform-web/notifications/headless';

const mockRemovePushSubscription = vi.mocked(removePushSubscription);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <IdentityProviders>{children}</IdentityProviders>
    </MemoryRouter>
  );
}

function signedInServer(...extra: Parameters<typeof server.use>) {
  server.use(
    http.post('*/api/auth/refresh', () =>
      HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
    ),
    ...extra,
  );
}

describe('IdentityProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.setAccessToken(null);
    // `clearAllMocks` keeps implementations; reassert the safe default so a
    // previous test's `mockRejectedValue` cannot bleed in.
    mockRemovePushSubscription.mockResolvedValue(undefined);
  });

  it('restores the session through KVox\'s own HTTP client', async () => {
    signedInServer();

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.user?.email).toBe('test@example.com');
    // The token the provider obtained is the one `api` now sends.
    expect(api.getAccessToken()).toBe('test-token');
  });

  it('lists the sign-in providers the API offers', async () => {
    signedInServer();

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.providers).toHaveLength(1));
    expect(result.current.providers[0].name).toBe('google');
  });

  describe('push subscription cleanup on logout (#365)', () => {
    it('calls removePushSubscription before POST /auth/logout, in that order', async () => {
      const callOrder: string[] = [];
      mockRemovePushSubscription.mockImplementation(async () => {
        callOrder.push('removePushSubscription');
      });
      signedInServer(
        http.post('*/api/auth/logout', () => {
          callOrder.push('POST /auth/logout');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

      await act(async () => {
        await result.current.logout();
      });

      expect(callOrder).toEqual(['removePushSubscription', 'POST /auth/logout']);
      expect(result.current.isAuthenticated).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('still logs the user out even when removePushSubscription rejects', async () => {
      mockRemovePushSubscription.mockRejectedValue(new Error('serviceWorker.ready never settled'));
      signedInServer();

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

      await act(async () => {
        await result.current.logout();
      });

      expect(mockRemovePushSubscription).toHaveBeenCalledTimes(1);
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });
});
