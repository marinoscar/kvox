import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ThemeContextProvider, useThemeContext } from './contexts/ThemeContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { RequirePermission } from './components/common/RequirePermission';
import { Layout } from './components/common/Layout';
import { ErrorBoundary } from './components/common/ErrorBoundary';
// Issue #258, epic #254. Eagerly imported, not lazy: it renders on the error
// path of a deployment that is deliberately out of service, and a code-split
// chunk fetched at that moment is one more thing that has to be working for the
// screen explaining why nothing is working to appear at all.
import { MaintenanceGate } from './components/common/MaintenanceGate';
// PWA prompts (#219, epic #215). Eagerly imported, not lazy: `UpdatePrompt` is
// what REGISTERS the service worker, and a registration deferred behind a
// dynamic import would not happen until React had already decided it was
// needed. Both render `null` in their default state, so the cost is a few
// hundred bytes in the entry chunk.
import { UpdatePrompt } from './components/pwa/UpdatePrompt';
import { InstallPrompt } from './components/pwa/InstallPrompt';

// Pages (lazy loaded)
import { Suspense, lazy } from 'react';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage'));
const ActivateDevicePage = lazy(() => import('./pages/ActivateDevicePage'));
const HomePage = lazy(() => import('./pages/HomePage'));
// User settings — the hub (#96) plus one route per card in
// `config/userSettingsSections.tsx` (#91, epic #90). These replace the single
// stacked `UserSettingsPage`, which is deleted rather than left unrouted.
const UserSettingsHubPage = lazy(() => import('./pages/UserSettingsHubPage'));
const UserProfilePage = lazy(() => import('./pages/UserProfilePage'));
// `User`-prefixed to make explicit that it edits the signed-in user's own
// theme, not anything under the Console.
const UserAppearancePage = lazy(() => import('./pages/UserAppearancePage'));
// Issue #126, epic #109 — the per-user event x channel notification matrix.
const UserNotificationsPage = lazy(() => import('./pages/UserNotificationsPage'));
const UserTokensPage = lazy(() => import('./pages/UserTokensPage'));

// Console — the hub (#93) plus one route per card in
// `config/adminSections.tsx` (#92, epic #90).
const SettingsHubPage = lazy(() => import('./pages/Admin/SettingsHubPage'));
// Issue #124, epic #109 — the admin email configuration and its test send.
const EmailSettingsPage = lazy(() => import('./pages/Admin/EmailSettingsPage'));
// Issue #225, epic #215 — the deployment-wide browser-notification policy.
const NotificationSettingsPage = lazy(
  () => import('./pages/Admin/NotificationSettingsPage'),
);
// Issue #355 — runtime-configurable Web Push (VAPID) key management.
const PushConfigPage = lazy(() => import('./pages/Admin/PushConfigPage'));
// Issue #258, epic #254 — the maintenance window's switch and its layers.
// `Admin`-prefixed locally to keep it distinct from `pages/MaintenancePage`,
// which is the screen a BLOCKED user sees rather than the page that opens and
// closes the window.
const AdminMaintenancePage = lazy(() => import('./pages/Admin/MaintenancePage'));
// Issue #266, epic #254 — the background queue's two Operations pages. Lazy
// like every other admin page: both pull in the shared DataTable, and neither
// is on the path of a user who never opens the Console.
const JobsPage = lazy(() => import('./pages/Admin/JobsPage'));
const JobInsightsPage = lazy(() => import('./pages/Admin/JobInsightsPage'));
// Issue #271, epic #254 — the fleet page, and with it the node credentials it
// hosts as a section. Lazy for the same reason: two DataTables and two dialogs
// that nobody who never opens the Console will ever mount.
const WorkersPage = lazy(() => import('./pages/Admin/WorkersPage'));
// Issue #287, epic #254 — the backup policy, the run history and the restore
// dialog. Lazy for the same reason: a DataTable, a policy form and the restore
// dialog that nobody who never opens the Console will ever mount.
const DbBackupPage = lazy(() => import('./pages/Admin/DbBackupPage'));
// Issue #325, epic #319 — the admin broadcast list and its composer. Lazy for
// the same reason: a DataTable, a composer dialog and a detail dialog that
// nobody who never opens the Console will ever mount.
const BroadcastsPage = lazy(() => import('./pages/Admin/BroadcastsPage'));
const AdminUsersPage = lazy(() => import('./pages/Admin/UsersPage'));

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import('./pages/TestLoginPage'));

function AppRoutes() {
  const { theme } = useThemeContext();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        {/* THE CLIENT GATE (#258, epic #254), around the whole route tree and
            inside `AuthProvider`.

            Around everything, because a maintenance window is a property of the
            deployment rather than of any one page — the user's next click is
            refused wherever they are — and because swapping the subtree is what
            makes the screen's retry work: the pages unmount, and clearing the
            block remounts them so their own effects re-issue the requests that
            failed.

            Inside `AuthProvider` because the screen asks who is looking:
            `system_settings:read` decides whether it offers a link to the page
            that closes the window. That answer comes from the session already
            in memory, never from the API, which is refusing.

            An ordinary 503 with no marker never reaches it — see
            `services/maintenance.ts` for why that distinction is the feature. */}
        <MaintenanceGate>
          <Suspense fallback={<LoadingSpinner fullScreen />}>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />

              {/* Test login (development only) */}
              {!import.meta.env.PROD && TestLoginPage && (
                <Route path="/testing/login" element={<TestLoginPage />} />
              )}

              {/* Protected routes */}
              <Route element={<ProtectedRoute />}>
                {/* Device activation page - without layout for full-screen experience */}
                <Route path="/activate" element={<ActivateDevicePage />} />

                {/* The notification centre (#127, epic #109) wraps the SHELL,
                    not the whole app, and that scoping is the point:

                      * It is INSIDE `ProtectedRoute`, so it only ever mounts for
                        an authenticated user. Every endpoint it calls is
                        `@Auth()`-guarded and every one resolves the recipient from
                        the JWT, so mounting it on `/login` would buy a burst of
                        401s and a stream that cannot connect.
                      * It is around `Layout` specifically, because `Layout`'s
                        `AppBar` is where the bell lives. `/activate` above sits
                        outside the shell on purpose (full-screen device flow) and
                        correspondingly gets no bell and opens no stream.

                    ONE MOUNT POINT, so there is exactly one SSE connection per
                    tab. A provider mounted per-page would open and close a stream
                    on every navigation, which the server sees as a connection
                    storm from a single user and the client experiences as a bell
                    that resets its state every time the route changes. */}
                <Route
                  element={
                    <NotificationProvider>
                      <Layout />
                    </NotificationProvider>
                  }
                >
                  <Route path="/" element={<HomePage />} />
                  {/* The per-user settings surface (#96, epic #90) — the same
                      hub component `/admin/settings` renders, over
                      `USER_SETTINGS_SECTIONS`, plus one route per card.

                      NONE OF THESE IS WRAPPED IN `RequirePermission`, and that is
                      the deliberate difference from the `/admin/settings/*` block
                      below rather than an oversight. `ProtectedRoute` above
                      establishes that someone is signed in, and that is the only
                      question these routes have: they edit the caller's OWN
                      settings, which the API grants to all three roles, and
                      `config/userSettingsSections.tsx` correspondingly declares no
                      `permission` on any card. A gate here would deny a Viewer
                      their own display name.

                      As above, declaration order does not matter — React Router
                      v6 ranks by specificity, so `/settings/profile` beats
                      `/settings` wherever each is written. */}
                  <Route path="/settings" element={<UserSettingsHubPage />} />
                  <Route path="/settings/profile" element={<UserProfilePage />} />
                  <Route path="/settings/appearance" element={<UserAppearancePage />} />
                  {/* Ungated like its siblings (#126): these are the caller's own
                      preferences, and the registry endpoint the page renders is
                      itself `@Auth()` with no permission for the same reason. */}
                  <Route path="/settings/notifications" element={<UserNotificationsPage />} />
                  <Route path="/settings/tokens" element={<UserTokensPage />} />
                  {/* Route-level AUTHORIZATION, not just authentication.
                      `ProtectedRoute` above only establishes that someone is
                      logged in — before this, a Viewer typing `/admin/settings`
                      reached the page and only then watched every API call 403.
                      `RequirePermission` was already in the codebase but had zero
                      usages; wrapping these routes is what turns it into the
                      enforcement point.

                      The permission on each route is the SAME string its card
                      declares in `config/adminSections.tsx`, which is the same
                      string the API's controller enforces — so the hub card, the
                      rail row, the menu entry and the route can no longer
                      disagree about who may go where.

                      ORDER IS NOT SIGNIFICANT HERE. React Router v6 ranks routes
                      by specificity rather than by declaration order, so
                      `/admin/settings/users` beats `/admin/settings` regardless
                      of where each sits in this list. They are grouped by surface
                      for reading, not for matching. */}

                  {/* Both redirects are REAL ROUTES, not catch-all fallout.
                      Without them a bookmarked `/admin/users` matches only `*`
                      and lands silently on `/` — the user asked for a page that
                      still exists and got the home screen with no explanation.
                      `replace` keeps the dead URL out of the history stack, so
                      Back returns to wherever the user came from rather than
                      bouncing through the redirect again.

                      They sit INSIDE `ProtectedRoute` so an unauthenticated
                      bookmark goes to login and arrives here afterwards, rather
                      than being redirected first and losing the destination. */}
                  <Route path="/admin" element={<Navigate to="/admin/settings" replace />} />
                  <Route
                    path="/admin/users"
                    element={<Navigate to="/admin/settings/users" replace />}
                  />

                  {/* The Console hub (#93, epic #90) — the searchable, grouped
                      card grid that reads `ADMIN_SECTIONS`. It replaces the
                      three-tab placeholder that answered this route through #92,
                      whose tabs duplicated the four routes below. That
                      duplication is now gone: the hub NAVIGATES to those routes
                      instead of re-hosting them. */}
                  {/* ANY-OF, and the one route here that is not a single
                      permission. This gate MUST STAY IN SYNC WITH `console`'s
                      `anyPermission` in `config/destinations.ts` — the two lists
                      answer the same question ("may this user reach the admin
                      surface?") on two different surfaces, and #92 left them
                      disagreeing: the Console row appeared in the rail, bottom
                      bar, user menu and quick actions for a `users:read`-only
                      user, whose click then bounced straight back to `/`. That
                      split brain is exactly what `config/destinations.ts`'s
                      header says the destination model exists to prevent, so the
                      route follows the destination rather than the reverse.

                      `requireAll` defaults to `false`, so `permissions` is an OR
                      here — matching `anyPermission`'s semantics, not
                      `hasAllPermissions`'.

                      A `users:read`-only user consequently reaches this route
                      and — since #93 — sees a hub containing exactly the one card
                      that permission unlocks, instead of the placeholder page's
                      blanket access-denied state. The hub's own gate
                      (`visibleSettingsSections`) does that per CARD, which is why
                      this route only answers the coarser question "may this user
                      reach the admin surface at all?". The five child routes
                      below keep their single-permission gates: each is one
                      specific page with one specific permission. */}
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
                  {/* Issue #124, epic #109. Same permission string the `Email`
                      card declares in `config/adminSections.tsx`, which is the
                      same string the API's email-settings controller enforces on
                      its GET — the invariant `destinations.test.ts` asserts for
                      every card. `system_settings:read` and not `:write`: saving
                      and test-sending need write, and the page disables both
                      without it, but the configuration is worth READING for
                      anyone diagnosing why mail is not arriving. */}
                  <Route
                    path="/admin/settings/email"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <EmailSettingsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #225, epic #215. `system_settings:read`, the same
                      string the `Notifications` card declares and the same one
                      `system-settings.controller.ts` enforces on its GET — the
                      invariant `destinations.test.ts` asserts for every card.
                      Saving needs `system_settings:write`, which the page gates
                      internally by disabling its controls. */}
                  <Route
                    path="/admin/settings/notifications"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <NotificationSettingsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #355. Same permission string the `Web Push` card
                      declares in `config/adminSections.tsx`, which is the
                      same string the API's push-config controller enforces on
                      its GET — the invariant `destinations.test.ts` asserts
                      for every card. `push:read` and not `:write`: generating,
                      rotating, enabling/disabling and removing all need
                      `push:write`, which the page disables without it, but
                      the configuration is worth READING for anyone diagnosing
                      why push notifications are not arriving. */}
                  <Route
                    path="/admin/settings/push"
                    element={
                      <RequirePermission
                        permission="push:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <PushConfigPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #258, epic #254. Same permission string the
                      `Maintenance` card declares and the same one
                      `common/maintenance/maintenance.controller.ts` enforces on
                      its GET — the invariant `destinations.test.ts` asserts for
                      every card. Opening and closing a window needs
                      `system_settings:write`, which the page gates internally by
                      disabling its controls.

                      THIS IS ALSO THE ONE ROUTE `MaintenanceGate` NEVER COVERS,
                      mirroring `@AllowDuringMaintenance()` on the controller
                      behind it: the switch that ends a window has to be reachable
                      while the window is open, on both sides. */}
                  <Route
                    path="/admin/settings/maintenance"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AdminMaintenancePage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #266, epic #254. `jobs:read` on both, the same
                      string the `Jobs` and `Job Insights` cards declare and the
                      same one `jobs/job-admin.controller.ts` enforces on its
                      list, stats and insights reads — the invariant
                      `destinations.test.ts` asserts for every card. Retrying,
                      deleting, sweeping and clearing the rollup all need
                      `jobs:write`, which each PAGE gates internally by omitting
                      the row actions and the sweep buttons.

                      TWO ROUTES, NOT A TAB. `/admin/settings/jobs/insights`
                      nests under the Jobs path deliberately, and React Router
                      v6 ranks by specificity, so the nested route wins wherever
                      it is declared. `settingsPageTitle`'s longest-prefix rule
                      is what keeps the compact AppBar titling it "Job Insights"
                      rather than "Jobs". */}
                  <Route
                    path="/admin/settings/jobs"
                    element={
                      <RequirePermission
                        permission="jobs:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <JobsPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin/settings/jobs/insights"
                    element={
                      <RequirePermission
                        permission="jobs:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <JobInsightsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #271, epic #254. Guarded EXACTLY as the two Jobs
                      routes above are, and on `nodes:read` — the literal string
                      `nodes/nodes-admin.controller.ts` enforces on its fleet
                      list, its node detail and its credential list, and the
                      same one the `Worker Nodes` card declares (the invariant
                      `settingsRegistry.test.ts` asserts against the API's own
                      constants file). Deleting a node and creating or revoking
                      a credential need `nodes:write`, which the PAGE gates
                      internally by omitting the row actions and the create
                      button — the route gate is about REACHABILITY.

                      ONE ROUTE, NOT TWO, and no tab: node credentials are
                      CONTENT of this page rather than a destination of their
                      own, because revoking a leaked worker token is an
                      incident-response action and a second card would put two
                      clicks in front of it. See `WorkersPage.tsx` and
                      `components/admin/NodeCredentials.tsx` for the full
                      argument and the alternatives rejected. */}
                  <Route
                    path="/admin/settings/workers"
                    element={
                      <RequirePermission
                        permission="nodes:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <WorkersPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #287, epic #254. Guarded EXACTLY as the Jobs and
                      Workers routes above are, and on `db_backup:read` — the
                      literal string `db-backup/db-backup.controller.ts`
                      enforces on its config read, its run list and its run
                      detail (`PERMISSIONS.DB_BACKUP_READ`), and the same one
                      the `Database Backup` card declares (the invariant
                      `destinations.test.ts` asserts for every card).

                      THREE PERMISSIONS BEHIND THIS ONE ROUTE, and only the
                      first is a reachability gate. Scheduling, cancelling and
                      deleting need `db_backup:write`; restoring and rolling
                      back need `db_backup:restore`, which the API keeps
                      SEPARATE from `write` precisely so it can be withheld from
                      someone who may schedule backups but must not be able to
                      replace the database. The PAGE gates both internally by
                      disabling its controls — widening this route gate to
                      either would make the page unreachable for the read-only
                      admin it is most useful to during an incident. */}
                  <Route
                    path="/admin/settings/db-backup"
                    element={
                      <RequirePermission
                        permission="db_backup:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <DbBackupPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #325, epic #319. Guarded EXACTLY as the Jobs and
                      Workers routes above are, and on `broadcasts:read` — the
                      literal string
                      `notifications/broadcasts/broadcasts.controller.ts`
                      enforces on its audience count, its list and its detail
                      read (`PERMISSIONS.BROADCASTS_READ`), and the same one the
                      `Broadcasts` card declares (the invariant
                      `destinations.test.ts` asserts for every card). Composing,
                      cancelling, deleting and test-sending need
                      `broadcasts:write`, which the PAGE gates internally by
                      disabling its controls with a tooltip — the route gate is
                      about REACHABILITY.

                      The `/admin/settings` hub gate is deliberately NOT widened
                      to include this permission. It mirrors `console`'s
                      `anyPermission` in `config/destinations.ts` byte for byte
                      (asserted in `destinations.test.ts`), and every holder of
                      `broadcasts:read` is an admin who also holds
                      `system_settings:read`, so nothing is unreachable.
                      Widening one side without the other is exactly the
                      disagreement that test exists to catch. */}
                  <Route
                    path="/admin/settings/broadcasts"
                    element={
                      <RequirePermission
                        permission="broadcasts:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <BroadcastsPage />
                      </RequirePermission>
                    }
                  />
                  {/* `users:read` alone, even though the page also hosts the
                      allowlist. The route gate is about REACHABILITY and the page
                      is worth reaching for its Users tab; the Allowlist tab gates
                      its own content on `allowlist:read` inside the page. */}
                  <Route
                    path="/admin/settings/users"
                    element={
                      <RequirePermission
                        permission="users:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AdminUsersPage />
                      </RequirePermission>
                    }
                  />
                </Route>
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </MaintenanceGate>
      </ErrorBoundary>
      {/* The PWA prompts (#219, epic #215) sit here — inside `ThemeProvider`
          so they are themed, OUTSIDE both `ErrorBoundary` and `Routes`, and
          outside `Layout`.

          Outside `Routes` because they belong to the DOCUMENT, not to any
          page: `UpdatePrompt` owns the service-worker registration, which must
          happen on `/login` and `/activate` too (those sessions run on the same
          precached shell, and the worker is also what makes notifications
          possible on Android at all). Mounting them inside `Layout` would tie
          both to the authenticated shell and re-run registration on every
          route change into and out of it.

          Outside `ErrorBoundary` because a page that has crashed is precisely
          when "a new version is available" is most likely to be the fix — a
          prompt inside the boundary would be replaced by the fallback along
          with the page.

          NEITHER RENDERS ANYTHING in its default state (no waiting worker, no
          captured install event), so a normal page load is pixel-identical to
          one before this change. */}
      <UpdatePrompt />
      <InstallPrompt />
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ThemeContextProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeContextProvider>
  );
}
