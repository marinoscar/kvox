/**
 * The #276 one-retry-on-409, restored over the packaged hook (#466).
 *
 * Over the REAL packaged `useUserSettings` and MSW, so the cases also pin the
 * message the wrapper keys on: if the package changes it (or starts retrying
 * itself), these fail instead of the retry silently vanishing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import { PlatformHost } from '../../platform/PlatformHost';
import { useUserSettings, PACKAGED_CONFLICT_MESSAGE } from '../../hooks/userSettingsRetry';
import { AuthContext } from '@marinoscar/platform-web/identity/headless';
import type { AuthContextValue } from '@marinoscar/platform-web/identity/headless';
import { vi } from 'vitest';
import type { UserSettings, UserSettingsUpdate } from '../../types';

const auth = {
  user: { id: 'u', email: 'u@example.com', roles: [], permissions: [] },
  isLoading: false,
  isAuthenticated: true,
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

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ThemeContextProvider>
        <AuthContext.Provider value={auth}>
          <PlatformHost>{children}</PlatformHost>
        </AuthContext.Provider>
      </ThemeContextProvider>
    </MemoryRouter>
  );
}

const doc = (version: number) => ({
  theme: 'system',
  profile: { imageSource: 'provider' },
  updatedAt: new Date().toISOString(),
  version,
});

interface Patch {
  body: unknown;
  ifMatch: string | null;
}
let patches: Patch[] = [];

/** GET serves version 1 first, then 2; each PATCH answers from `statuses` in order. */
function serve(statuses: number[]) {
  let gets = 0;
  let n = 0;
  server.use(
    http.get('*/api/user-settings', () => HttpResponse.json({ data: doc(++gets === 1 ? 1 : 2) })),
    http.patch('*/api/user-settings', async ({ request }) => {
      patches.push({ body: await request.json(), ifMatch: request.headers.get('If-Match') });
      const status = statuses[n++] ?? 200;
      if (status === 200) return HttpResponse.json({ data: doc(3) });
      return HttpResponse.json({ message: 'nope', statusCode: status }, { status });
    }),
  );
}

async function mount() {
  const hook = renderHook(
    () => useUserSettings<UserSettings, UserSettingsUpdate>({ syncTheme: false }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.settings?.version).toBe(1));
  return hook;
}

const NAV = { navigation: { railCollapsed: true } } as unknown as UserSettingsUpdate;

describe('useUserSettings (409 retry shim)', () => {
  beforeEach(() => {
    patches = [];
  });

  it('the packaged hook still throws the message the wrapper keys on', async () => {
    serve([409, 409]);
    const { result } = await mount();
    // Reach the packaged path alone: a 409 then a failing re-read is not needed;
    // two 409s make the wrapper rethrow the packaged message.
    await expect(act(() => result.current.updateSettings(NAV))).rejects.toThrow(
      PACKAGED_CONFLICT_MESSAGE,
    );
  });

  it('409 then success: re-applies the same patch once on the fresh version and resolves', async () => {
    serve([409, 200]);
    const { result } = await mount();

    await act(() => result.current.updateSettings(NAV));

    expect(patches).toHaveLength(2);
    expect(patches[0]).toEqual({ body: NAV, ifMatch: '1' });
    expect(patches[1]).toEqual({ body: NAV, ifMatch: '2' });
    await waitFor(() => expect(result.current.settings?.version).toBe(3));
  });

  it('409 then 409: throws after exactly one retry', async () => {
    serve([409, 409, 200]);
    const { result } = await mount();

    await expect(act(() => result.current.updateSettings(NAV))).rejects.toThrow(
      PACKAGED_CONFLICT_MESSAGE,
    );
    expect(patches).toHaveLength(2);
  });

  it('a non-409 error is not retried and is rethrown', async () => {
    serve([500, 200]);
    const { result } = await mount();

    await expect(act(() => result.current.updateSettings(NAV))).rejects.toBeTruthy();
    expect(patches).toHaveLength(1);
  });

  it('a first-try success sends one PATCH', async () => {
    serve([200]);
    const { result } = await mount();

    await act(() => result.current.updateSettings(NAV));

    expect(patches).toHaveLength(1);
  });
});
