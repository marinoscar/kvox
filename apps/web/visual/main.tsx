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
 * needs to wait on it. Other pages this harness can route to (the leaf
 * `/admin/settings/*` and `/settings/*` pages) make their own such calls;
 * specs that visit them scope their screenshot to the `AppBar`/rail element
 * rather than the full page, so that race can never appear in a baseline.
 *
 * `HomePage` is the exception, as of issue #32: it is a real page body driven
 * by `GET /api/transcripts/summary`, so `tests/visual/specs/home.spec.ts`
 * mocks the API with `page.route` and captures the whole page, exactly as the
 * transcript specs already do.
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
// Issue #30, epic #19. The New-transcript screen reads the app-wide upload
// manager, and `useUploadManager` THROWS without a provider — deliberately, so
// that an upload affordance rendered outside the authenticated shell is a loud
// routing mistake rather than a dead button. The harness therefore mounts the
// real provider, exactly as `App.tsx` does around `Layout`.
import { UploadManagerProvider } from '../src/contexts/UploadManagerContext';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { LoadingSpinner } from '../src/components/common/LoadingSpinner';
import type { Role, User } from '../src/types';

const HomePage = lazy(() => import('../src/pages/HomePage'));
const UserSettingsHubPage = lazy(() => import('../src/pages/UserSettingsHubPage'));
// Issue #298, follow-up to epic #271 / PR #286. Registered for the same reason
// every route in this file is: a route the harness cannot reach is a route
// this suite silently stops asserting pixels for — and #286 mounts the
// onboarding chrome (`OnboardingBanner`, `FirstRunWelcomeDialog`,
// `ReturnToSetupBar`) on every page, including these two checklist pages
// themselves.
const GettingStartedPage = lazy(() => import('../src/pages/GettingStartedPage'));
const UserProfilePage = lazy(() => import('../src/pages/UserProfilePage'));
const UserAppearancePage = lazy(() => import('../src/pages/UserAppearancePage'));
const UserTokensPage = lazy(() => import('../src/pages/UserTokensPage'));
// Issue #369, epic #346. Registered for the same reason every route in this
// file is: a route the harness cannot reach is one this suite cannot capture.
const UserKnowledgeGraphPage = lazy(() => import('../src/pages/UserKnowledgeGraphPage'));
// Two pages since #106, where one served both routes — the harness mirrors
// `App.tsx`'s lazy imports exactly, so a page split there is a page split here.
const TranscriptsPage = lazy(() => import('../src/pages/TranscriptsPage'));
const NotesPage = lazy(() => import('../src/pages/NotesPage'));
const NewTranscriptPage = lazy(() => import('../src/pages/NewTranscriptPage'));
const TranscriptPage = lazy(() => import('../src/pages/TranscriptPage'));
const TranscriptHistoryPage = lazy(() => import('../src/pages/TranscriptHistoryPage'));
// Notes (#57, epic #45). Registered for the same reason every route in this
// file is: a route the harness cannot reach is a route this suite silently
// stops asserting pixels for.
const NewNotePage = lazy(() => import('../src/pages/NewNotePage'));
const NotePage = lazy(() => import('../src/pages/NotePage'));
const NoteHistoryPage = lazy(() => import('../src/pages/NoteHistoryPage'));
// Knowledge graph (#373, epic #347). Mirrors `App.tsx`: owned by `home`,
// gated on `graph:read`. The default harness user does NOT hold it (so no
// existing Home/transcript baseline starts asking the graph for data); the
// graph spec passes `perms` explicitly.
const GraphIndexPage = lazy(() => import('../src/pages/GraphIndexPage'));
const GraphEntityPage = lazy(() => import('../src/pages/GraphEntityPage'));
const SettingsHubPage = lazy(() => import('../src/pages/Admin/SettingsHubPage'));
const AdminUsersPage = lazy(() => import('../src/pages/Admin/UsersPage'));
// Issue #298, follow-up to epic #271 / PR #286. See the `GettingStartedPage`
// import above for why this is registered at all.
const SetupPage = lazy(() => import('../src/pages/Admin/SetupPage'));

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
  // Transcripts (#30, epic #19). Present for the same reason as every string
  // above, with one addition specific to these: they are seeded to ALL THREE
  // roles, so a harness user without them is a user that cannot exist — and
  // the nav baselines would silently stop asserting the fourth destination.
  'transcripts:read',
  'transcripts:write',
  // Notes (#57, epic #45). Present for the same reason the transcript pair is,
  // and with one addition specific to them: the `library` destination is
  // reachable on EITHER `transcripts:read` or `notes:read`, and the library
  // page shows only the tabs the user can open — so a harness user without
  // these would screenshot a library with its Notes tab silently missing.
  'notes:read',
  'notes:write',
  'note_templates:read',
  'note_templates:write',
  // `GET /api/storage/objects/:id` is what resolves a note row's source name
  // and a document's extraction progress. Seeded to every role.
  'storage:read',
  // Connected knowledge (#354/#369, epic #346). Seeded to all three roles, and
  // `graph:write` gates the `Knowledge graph` card in `USER_SETTINGS_SECTIONS`
  // — a harness user without it would screenshot a user hub missing that card.
  'graph:read',
  'graph:write',
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
        <Route
          element={
            <UploadManagerProvider>
              <Layout />
            </UploadManagerProvider>
          }
        >
          <Route path="/" element={<HomePage />} />

          {/* Transcripts (#30, epic #19). Gates copied verbatim from
              `App.tsx`, like every other guarded route in this file. A spec
              that visits one of these MOCKS THE API with `page.route` — the
              pages genuinely render their own data, unlike the nav-only specs
              that scope their screenshot to the rail. */}
          <Route
            path="/transcripts"
            element={
              <RequirePermission
                permission="transcripts:read"
                fallback={<Navigate to="/" replace />}
              >
                <TranscriptsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/transcripts/new"
            element={
              <RequirePermission
                permission="transcripts:write"
                fallback={<Navigate to="/transcripts" replace />}
              >
                <NewTranscriptPage />
              </RequirePermission>
            }
          />
          <Route
            path="/transcripts/:id"
            element={
              <RequirePermission
                permission="transcripts:read"
                fallback={<Navigate to="/" replace />}
              >
                <TranscriptPage />
              </RequirePermission>
            }
          />
          {/* The version-history drill-down (#31). Registered here for the
              same reason as its three siblings: a route the harness cannot
              reach is a route this suite silently stops asserting pixels
              for. Gate copied verbatim from `App.tsx`. */}
          <Route
            path="/transcripts/:id/history"
            element={
              <RequirePermission
                permission="transcripts:read"
                fallback={<Navigate to="/" replace />}
              >
                <TranscriptHistoryPage />
              </RequirePermission>
            }
          />

          {/* Notes (#57, epic #45). Its OWN page since #106 — a sibling
              destination rather than the other tab of one `library` row, with
              `/transcripts`' fallback restored to `/` to match. Gates copied
              verbatim from `App.tsx`, like every other guarded route in this
              file. */}
          <Route
            path="/notes"
            element={
              <RequirePermission permission="notes:read" fallback={<Navigate to="/" replace />}>
                <NotesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/notes/new"
            element={
              <RequirePermission
                permission="notes:write"
                fallback={<Navigate to="/notes" replace />}
              >
                <NewNotePage />
              </RequirePermission>
            }
          />
          <Route
            path="/notes/:id"
            element={
              <RequirePermission permission="notes:read" fallback={<Navigate to="/" replace />}>
                <NotePage />
              </RequirePermission>
            }
          />
          {/* The note version-history drill-down (#58, epic #45). Registered
              here for the same reason `/transcripts/:id/history` is: the
              history specs navigate straight to it, and a route the harness
              does not know renders nothing at all — which fails as a timeout
              waiting for a label rather than as a missing route. */}
          <Route
            path="/notes/:id/history"
            element={
              <RequirePermission permission="notes:read" fallback={<Navigate to="/" replace />}>
                <NoteHistoryPage />
              </RequirePermission>
            }
          />

          <Route
            path="/graph"
            element={
              <RequirePermission permission="graph:read" fallback={<Navigate to="/" replace />}>
                <GraphIndexPage />
              </RequirePermission>
            }
          />
          <Route
            path="/graph/entities/:id"
            element={
              <RequirePermission permission="graph:read" fallback={<Navigate to="/" replace />}>
                <GraphEntityPage />
              </RequirePermission>
            }
          />

          <Route path="/settings" element={<UserSettingsHubPage />} />
          {/* Issue #279, epic #271 (harness wiring: issue #298). Ungated, exactly
              as `App.tsx` has it: `onboarding.controller.ts` gates
              `GET /api/onboarding` on `@Auth()` and no permission, because the
              resource is the caller's own activation state, scoped by `userId`
              in the query itself. A `RequirePermission` here would be a gate the
              API does not have. */}
          <Route path="/settings/getting-started" element={<GettingStartedPage />} />
          <Route path="/settings/profile" element={<UserProfilePage />} />
          <Route path="/settings/appearance" element={<UserAppearancePage />} />
          <Route path="/settings/tokens" element={<UserTokensPage />} />
          {/* Issue #369 — gate copied verbatim from `App.tsx`. */}
          <Route
            path="/settings/knowledge-graph"
            element={
              <RequirePermission
                permission="graph:write"
                fallback={<Navigate to="/settings" replace />}
              >
                <UserKnowledgeGraphPage />
              </RequirePermission>
            }
          />

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
          {/* Issue #278, epic #271 (harness wiring: issue #298). Gate copied
              verbatim from `App.tsx`: the same `system_settings:read` string
              `admin-onboarding.controller.ts` enforces on its one GET (#275). */}
          <Route
            path="/admin/settings/setup"
            element={
              <RequirePermission
                permission="system_settings:read"
                fallback={<Navigate to="/" replace />}
              >
                <SetupPage />
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
