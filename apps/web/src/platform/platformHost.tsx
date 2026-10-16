/**
 * This app's binding of the platform host (issue #464, epic #462).
 *
 * `@marinoscar/platform-web` pages and headless hooks take their transport, the
 * viewer and the theme setter from ONE `PlatformHostProvider`. This file is the
 * host: it replaces the minimal one #466 added for the settings slice and now
 * serves every packaged slice this app mounts (settings, identity, host, doctor).
 *
 *   - `api`: `appPlatformApi`, the packaged `PlatformApiClient` over this app's
 *     one `PlatformHttpClient`, with the packaged `postSse` wired to the same
 *     bearer token, refresh and maintenance recogniser. Built ONCE at module
 *     scope: packaged hooks key on its identity.
 *   - `viewer`: the signed-in user from the identity slice. `hasPermission` is
 *     `usePermissions`'s, the same predicate every route guard uses.
 *     `isFeatureEnabled` answers from the settings-feature registry
 *     (`config/settingsFeatures.ts`), the one source the hubs and the rail read.
 *   - `applyTheme`: the shell's theme setter (`useShellTheme().setMode`, held by
 *     `ShellRoot` in `App.tsx` since #484). The Appearance page and
 *     `useUserSettings` call it when the stored preference loads or is saved, so
 *     a theme switch still applies live. This app's themes are `light | dark |
 *     system`; the setter itself ignores an id the app has no theme for, as the
 *     host contract asks.
 *   - `formatRelativeTime`: this app's formatter, so the packaged About page
 *     reads like the rest of the app.
 *
 * Mount `AppPlatformHostProvider` once, inside the auth provider and `ShellRoot`.
 */

import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  PlatformHostProvider,
  createPlatformApiClient,
  postSse,
} from '@marinoscar/platform-web/core';
import type {
  PlatformSseOptions,
  PlatformViewer,
  PlatformWebHost,
} from '@marinoscar/platform-web/core';
import { useAuth, usePermissions } from '@marinoscar/platform-web/identity/headless';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { useShellTheme } from '@marinoscar/platform-web/shell/headless';
import { API_BASE_URL, api } from '../services/api';
import { noticeMaintenance } from '../services/maintenance';
import { formatRelativeTime } from '../utils/relativeTime';

/**
 * The packaged `postSse` over this app's client: the same `Authorization`
 * header, the same one refresh-and-retry on a 401 and the same maintenance
 * recogniser as every JSON call. Paths are relative to the API base.
 */
function appPostSse(path: string, body: unknown, options: PlatformSseOptions): Promise<void> {
  return postSse<unknown>({
    url: `${API_BASE_URL}${path}`,
    body,
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    onFrame: options.onFrame,
    signal: options.signal,
    onErrorResponse: noticeMaintenance,
  });
}

/**
 * The packaged `PlatformApiClient` over this app's HTTP client. Built ONCE, at
 * module scope: packaged hooks key on its identity.
 */
export const appPlatformApi = createPlatformApiClient(api, { postSse: appPostSse });

function formatRelative(iso: string): string {
  return formatRelativeTime(iso);
}

/**
 * This app's {@link PlatformWebHost}, memoised. Must run inside the auth
 * provider and the theme context.
 */
export function useAppPlatformHost(): PlatformWebHost {
  const { user, refreshUser } = useAuth();
  const { hasPermission } = usePermissions();
  const { setMode } = useShellTheme();
  // The `graph` resolver reads `AppGraphFeatureProvider`, mounted above the host in
  // `App.tsx`, so the map here and the map the shell reads are the same answer.
  const features = useSettingsFeatures();

  const applyTheme = useCallback<NonNullable<PlatformWebHost['applyTheme']>>(
    (theme) => {
      setMode(theme);
    },
    [setMode],
  );

  const userId = user?.id ?? null;
  const email = user?.email ?? null;

  const viewer = useMemo<PlatformViewer>(
    () => ({
      userId,
      email,
      hasPermission,
      isFeatureEnabled: (feature) => features[feature as keyof typeof features] === true,
      refresh: refreshUser,
    }),
    [userId, email, hasPermission, features, refreshUser],
  );

  return useMemo<PlatformWebHost>(
    () => ({ api: appPlatformApi, viewer, applyTheme, formatRelativeTime: formatRelative }),
    [viewer, applyTheme],
  );
}

/** Mounts the packaged `PlatformHostProvider` with {@link useAppPlatformHost}. */
export function AppPlatformHostProvider({ children }: { children: ReactNode }) {
  const host = useAppPlatformHost();
  return <PlatformHostProvider host={host}>{children}</PlatformHostProvider>;
}
