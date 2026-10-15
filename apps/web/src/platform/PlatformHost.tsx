/**
 * This app's minimal binding of the platform host (issue #466, epic #462).
 *
 * `@marinoscar/platform-web` pages and headless hooks take their transport, the
 * viewer and the theme setter from ONE `PlatformHostProvider`. The settings
 * slice is the first one this app mounts that needs it (the packaged Profile and
 * Appearance pages, and `useSystemSettings` / `useUserSettings`), so this is
 * the host, kept to exactly what that slice reads:
 *
 *   - `api`: this app's one `PlatformApiClient` (`identity/identityAdapters.ts`,
 *     built once at module scope because packaged hooks key on its identity).
 *   - `viewer`: the signed-in user from the identity slice. `hasPermission` is
 *     `usePermissions`'s, the same predicate every route guard uses.
 *   - `applyTheme`: this app's `ThemeContext` setter. The Appearance page and
 *     `useUserSettings` call it when the stored preference loads or is saved, so
 *     a theme switch still applies live. this app themes are `light | dark |
 *     system`; an id the app has no theme for is ignored, as the host contract
 *     asks.
 *
 * PLATFORM-ADOPTION-SHIM(466): #464 (the host slice) completes this host
 * (formatRelativeTime, extensions, real feature switches) and replaces this
 * file. Mount it once, inside the auth provider and the theme context.
 */

import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformViewer, PlatformWebHost } from '@marinoscar/platform-web/core';
import { useAuth, usePermissions } from '@marinoscar/platform-web/identity/headless';
import { useThemeContext } from '../contexts/ThemeContext';
import type { ThemeMode } from '../theme';
import { platformApi } from '../identity/identityAdapters';

function isThemeMode(theme: string): theme is ThemeMode {
  return theme === 'light' || theme === 'dark' || theme === 'system';
}

export function PlatformHost({ children }: { children: ReactNode }) {
  const { user, refreshUser } = useAuth();
  const { hasPermission } = usePermissions();
  const { setMode } = useThemeContext();

  const applyTheme = useCallback<NonNullable<PlatformWebHost['applyTheme']>>(
    (theme) => {
      if (isThemeMode(theme)) setMode(theme);
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
      // PLATFORM-ADOPTION-SHIM(466): no packaged page that reads a host feature
      // switch is mounted yet. The settings hub's own feature map comes from
      // `registerSettingsFeature` (config/settingsFeatures.ts), not from here.
      isFeatureEnabled: () => false,
      refresh: refreshUser,
    }),
    [userId, email, hasPermission, refreshUser],
  );

  const host = useMemo<PlatformWebHost>(
    () => ({ api: platformApi, viewer, applyTheme }),
    [viewer, applyTheme],
  );

  return <PlatformHostProvider host={host}>{children}</PlatformHostProvider>;
}
