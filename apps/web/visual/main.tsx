/**
 * Visual regression harness — issue #107.
 *
 * NOT part of the shipped app. This mounts the REAL `Layout`, `NavigationRail`,
 * `AppBar` and `SettingsHub` (via both `SettingsHubPage` and
 * `UserSettingsHubPage`) behind a fake, synchronous auth context so Playwright
 * can screenshot the actual pixel layout — something jsdom cannot do at all
 * (no layout engine, no `offsetWidth`, no wrapping, no font metrics). Bug #105
 * (Console rendered inline instead of pinned at the rail's foot; collapsed-rail
 * captions truncated to "Setti…"/"Cons…") was structurally uncatchable by the
 * existing Vitest+RTL suite for exactly that reason.
 *
 * Nothing here reimplements app behaviour — every component below is imported
 * from `../src`, unmodified. This file only supplies the wiring a real
 * `main.tsx`/`App.tsx` normally gets from the network: a fake `AuthContext`
 * value instead of a real OAuth session, `MemoryRouter` instead of
 * `BrowserRouter`, and three query params that pick which corner of the app to
 * render.
 *
 * QUERY PARAMS (read from `location.search` once, before the first render):
 *   ?route=/admin/settings   Initial router entry. Default `/`.
 *   ?perms=a,b,c              Comma-separated permission strings that become
 *                              `user.permissions`. Default: a broad admin set
 *                              (see `DEFAULT_PERMISSIONS`), so every card and
 *                              rail row is visible unless a spec narrows it.
 *   ?theme=light|dark          Written to `localStorage.theme_mode` BEFORE
 *                              `createRoot(...).render(...)`, because
 *                              `ThemeContextProvider` reads that key
 *                              synchronously on mount to seed its initial
 *                              state (see `contexts/ThemeContext.tsx`). Default
 *                              `dark`.
 *   ?roles=admin,viewer        Comma-separated role names that become
 *                              `user.roles`. Default `admin`. Read for
 *                              completeness — `usePermissions().isAdmin` is
 *                              derived from it — but as of #105/#107 nothing
 *                              rendered by this harness (`config/destinations.ts`,
 *                              `config/adminSections.tsx`) gates on role rather
 *                              than permission, confirmed by reading both files
 *                              rather than assumed. No current spec relies on
 *                              this param.
 *
 * WHY THE `/api` FETCHES BELOW ARE SAFE TO IGNORE
 * -------------------------------------------------------------------------
 * `NavigationRail` → `useNavigationPrefs` → `useUserSettings({ syncTheme: false })`
 * fires `GET /api/user-settings` on mount (`services/api.ts`,
 * `API_BASE_URL` defaults to `/api`). This harness's Vite config
 * (`visual/vite.config.ts`) deliberately configures NO proxy for `/api` — so
 * the request resolves against Vite's own dev server, which has no route for
 * it and answers (or the fetch fails to parse) quickly rather than hanging or
 * slow-retrying against a `localhost:3000` nothing is listening on.
 * `fetchSettings` catches the failure, sets `isLoading` false and leaves
 * `settings` as `null`. `useNavigationPrefs` then reports
 * `stored.railCollapsed = settings?.navigation?.railCollapsed === true`, which
 * is `false` (rail expanded, subject to the width gates) whether `settings` is
 * `null` from the very first render or after the fetch has failed — so the
 * rail's rendered output never changes across that fetch settling. No spec
 * needs to wait on it. Other pages this harness can route to (`HomePage`'s
 * `UserProfileCard`, the leaf `/admin/settings/*` and `/settings/*` pages) make
 * their own such calls; specs that visit them scope their screenshot to the
 * `AppBar`/rail element rather than the full page, so that race can never
 * appear in a baseline.
 */

import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

import { AuthContext } from '../src/contexts/AuthContext';
import { ThemeContextProvider, useThemeContext } from '../src/contexts/ThemeContext';
import { ProtectedRoute } from '../src/components/common/ProtectedRoute';
import { RequirePermission } from '../src/components/common/RequirePermission';
import { Layout } from '../src/components/common/Layout';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { LoadingSpinner } from '../src/components/common/LoadingSpinner';
import type { Role, User } from '../src/types';

const HomePage = lazy(() => import('../src/pages/HomePage'));
const UserSettingsHubPage = lazy(() => import('../src/pages/UserSettingsHubPage'));
const UserProfilePage = lazy(() => import('../src/pages/UserProfilePage'));
const UserAppearancePage = lazy(() => import('../src/pages/UserAppearancePage'));
const UserTokensPage = lazy(() => import('../src/pages/UserTokensPage'));
const SettingsHubPage = lazy(() => import('../src/pages/Admin/SettingsHubPage'));
const AdminUsersPage = lazy(() => import('../src/pages/Admin/UsersPage'));

/** Byte-identical to `contexts/ThemeContext.tsx`'s private constant. */
const THEME_STORAGE_KEY = 'theme_mode';

/**
 * A broad admin permission set — enough to see every card in
 * `ADMIN_SECTIONS` and `USER_SETTINGS_SECTIONS`, and every rail/menu
 * destination in `DESTINATIONS`, without a spec having to spell out the list.
 * A spec that wants a narrower view (e.g. the `users:read`-only hub) passes
 * `?perms=` explicitly.
 */
const DEFAULT_PERMISSIONS = [
  'system_settings:read',
  'system_settings:write',
  'user_settings:read',
  'user_settings:write',
  'users:read',
  'users:write',
  'rbac:manage',
  'allowlist:read',
  'allowlist:write',
  'storage:read',
  'storage:write',
  'storage:delete',
  'storage:read_any',
  'storage:write_any',
  'storage:delete_any',
  // Operations (#256/#266, epic #254). Present for the same reason every
  // string above is: this list's contract is "enough to see EVERY card in
  // `ADMIN_SECTIONS`", so a card the harness cannot see is a card this suite
  // silently stops asserting pixels for. Omitting these would have let the
  // `Operations` group be added with all eleven baselines still passing —
  // green, and wrong.
  'jobs:read',
  'jobs:write',
  'nodes:read',
  'nodes:write',
  'db_backup:read',
  'db_backup:write',
  'db_backup:restore',
];

interface HarnessParams {
  route: string;
  permissions: string[];
  theme: 'light' | 'dark';
  roles: Role[];
}

function parseHarnessParams(): HarnessParams {
  const search = new URLSearchParams(window.location.search);

  const route = search.get('route') || '/';

  const permsParam = search.get('perms');
  const permissions = permsParam
    ? permsParam
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : DEFAULT_PERMISSIONS;

  const theme: 'light' | 'dark' = search.get('theme') === 'light' ? 'light' : 'dark';

  const rolesParam = search.get('roles');
  const roles: Role[] = (
    rolesParam
      ? rolesParam
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : ['admin']
  ).map((name) => ({ name }));

  return { route, permissions, theme, roles };
}

const { route, permissions, theme, roles } = parseHarnessParams();

// MUST happen before `createRoot(...).render(...)` — `ThemeContextProvider`
// reads this key synchronously in its `useState` initializer.
localStorage.setItem(THEME_STORAGE_KEY, theme);

// No profile image URL: a real one would be an external network fetch the
// harness has no business making, and a missing/broken image would render
// nondeterministically (broken-image icon vs. blank) across runs. `UserMenu`
// falls back to initials when `profileImageUrl` is null, which is fully
// deterministic and is what every spec here actually screenshots.
const harnessUser: User = {
  id: 'visual-harness-user',
  email: 'visual-harness@example.com',
  displayName: 'Visual Harness',
  profileImageUrl: null,
  roles,
  permissions,
  isActive: true,
  createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
};

const fakeAuth = {
  user: harnessUser,
  isLoading: false,
  isAuthenticated: true,
  providers: [],
  login: () => {},
  logout: async () => {},
  refreshUser: async () => {},
};

/**
 * The route tree, mirroring `App.tsx`'s protected/`Layout` branch. Kept as a
 * deliberate subset — no `/login`, `/auth/callback`, `/activate`,
 * `/testing/login` — since none of those mount `Layout` and none are ever a
 * screenshot target here. Every permission on every guarded route below is
 * copied verbatim from `App.tsx` so this harness cannot silently drift from
 * what the real app actually enforces.
 */
function HarnessRoutes() {
  return (
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />

          <Route path="/settings" element={<UserSettingsHubPage />} />
          <Route path="/settings/profile" element={<UserProfilePage />} />
          <Route path="/settings/appearance" element={<UserAppearancePage />} />
          <Route path="/settings/tokens" element={<UserTokensPage />} />

          <Route path="/admin" element={<Navigate to="/admin/settings" replace />} />
          <Route
            path="/admin/settings"
            element={
              <RequirePermission
                permissions={['system_settings:read', 'users:read']}
                fallback={<Navigate to="/" replace />}
              >
                <SettingsHubPage />
              </RequirePermission>
            }
          />
          <Route
            path="/admin/settings/users"
            element={
              <RequirePermission permission="users:read" fallback={<Navigate to="/" replace />}>
                <AdminUsersPage />
              </RequirePermission>
            }
          />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Reads the real `ThemeContext` and wraps in MUI's `ThemeProvider` +
 * `CssBaseline` — the exact composition `App.tsx`'s `AppRoutes` uses.
 */
function Inner() {
  const { theme: muiTheme } = useThemeContext();
  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner fullScreen />}>
          <HarnessRoutes />
        </Suspense>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={fakeAuth}>
        <ThemeContextProvider>
          <Inner />
        </ThemeContextProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  </React.StrictMode>,
);
