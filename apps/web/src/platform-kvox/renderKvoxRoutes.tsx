import { Navigate, Route } from 'react-router-dom';
import { RequirePermission } from '@marinoscar/platform-web/identity/headless';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';

/**
 * The `<Route>` elements of the routes a `@marinoscar/kvox-web` slice exports as
 * data (`kvoxTranscriptionRoutes`, ...).
 *
 * The slice declares the path, the lazy page and the permission the route is
 * gated on; this app supplies the guard. A route with a `permission` is wrapped
 * in the packaged `RequirePermission` and a user without it is sent home, exactly
 * what the literal routes in `App.tsx` did. Call it where the literal `<Route>`
 * used to be: the order of routes is the order of the spread.
 *
 * The page is rendered inside the `Suspense` boundary `AppRoutes` already
 * provides around every lazy page.
 */
export function renderKvoxRoutes(routes: readonly KvoxRouteDef[]) {
  return routes.map(({ path, permission, Component }) => (
    <Route
      key={path}
      path={path}
      element={
        permission ? (
          <RequirePermission permission={permission} fallback={<Navigate to="/" replace />}>
            <Component />
          </RequirePermission>
        ) : (
          <Component />
        )
      }
    />
  ));
}
