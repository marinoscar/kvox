import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { AuthContext } from '@marinoscar/platform-web/identity/headless';
import type { AuthContextValue } from '@marinoscar/platform-web/identity/headless';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { server } from '../mocks/server';
import { mockGraphAiConfig } from '../mocks/graphData';
import { AppGraphFeatureProvider, useGraphFeature } from '../../platform/GraphFeatureBinding';
import '../../config/settingsFeatures';

/**
 * The one read of the connected-knowledge switch (issue #484, epic #478). The
 * settings-feature resolver must never fetch, so this provider does, once, and
 * only for a signed-in session; everything else reads "off".
 */

function authValue(authenticated: boolean): AuthContextValue {
  return {
    user: authenticated ? { id: 'u', email: 'u@example.com', roles: [], permissions: [] } : null,
    isLoading: false,
    isAuthenticated: authenticated,
    providers: [],
    sessionExpired: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    setAccessToken: vi.fn(),
    activeOrg: null,
    memberships: [],
    switchOrg: vi.fn(),
  } as unknown as AuthContextValue;
}

function wrapperFor(authenticated: boolean) {
  const value = authValue(authenticated);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={value}>
        <AppGraphFeatureProvider>{children}</AppGraphFeatureProvider>
      </AuthContext.Provider>
    );
  };
}

function serve(graphEnabled: () => boolean, onRequest?: () => void) {
  server.use(
    http.get('*/api/ai-tasks/config', () => {
      onRequest?.();
      return HttpResponse.json({ data: mockGraphAiConfig({ graphEnabled: graphEnabled() }) });
    }),
  );
}

describe('AppGraphFeatureProvider', () => {
  it('is off until the config lands, then follows graphEnabled', async () => {
    serve(() => true);
    const { result } = renderHook(() => useGraphFeature(), { wrapper: wrapperFor(true) });

    expect(result.current.graph).toBe(false);
    await waitFor(() => expect(result.current.graph).toBe(true));
  });

  it('feeds the `graph` settings feature the shell\'s destinations gate on', async () => {
    serve(() => true);
    const { result } = renderHook(() => useSettingsFeatures(), { wrapper: wrapperFor(true) });

    expect(result.current.graph).toBe(false);
    await waitFor(() => expect(result.current.graph).toBe(true));
  });

  it('stays off when connected knowledge is switched off', async () => {
    const seen = vi.fn();
    serve(() => false, seen);
    const { result } = renderHook(() => useGraphFeature(), { wrapper: wrapperFor(true) });

    await waitFor(() => expect(seen).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.graph).toBe(false);
  });

  it('never reads for a signed-out session: the endpoint is authenticated', async () => {
    const seen = vi.fn();
    serve(() => true, seen);
    const { result } = renderHook(() => useGraphFeature(), { wrapper: wrapperFor(false) });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen).not.toHaveBeenCalled();
    expect(result.current.graph).toBe(false);
  });

  it('refresh re-reads, so the admin AI page can flip the tab without a reload', async () => {
    let enabled = false;
    serve(() => enabled);
    const { result } = renderHook(() => useGraphFeature(), { wrapper: wrapperFor(true) });

    await waitFor(() => expect(result.current.graph).toBe(false));
    enabled = true;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.graph).toBe(true));
  });

  it('is off outside any provider', () => {
    const { result } = renderHook(() => useGraphFeature());
    expect(result.current.graph).toBe(false);
  });
});
