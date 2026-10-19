import type { ReactElement } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { RequirePermission } from '@marinoscar/platform-web/identity/headless';

import type { KvoxRouteDef } from '../core/ui/index.js';

/**
 * Options of {@link renderKvoxRoutes}.
 *
 * @stability experimental
 */
export interface RenderKvoxRoutesOptions {
  /**
   * Where a viewer without a route's `permission` is sent when the route names no
   * `redirectTo` of its own. Default `'/'`.
   */
  fallback?: string;
}

/**
 * The `<Route>` elements of the routes a `@marinoscar/kvox-web` slice exports as
 * data (`kvoxNotesRoutes`, `kvoxGraphRoutes`, ...).
 *
 * @remarks
 * The slice declares the path, the lazy page and the permission the route is gated
 * on; this supplies the guard. A route with a `permission` is wrapped in the
 * platform's `RequirePermission`, and a viewer without it is sent to the route's
 * `redirectTo` (or `fallback`, default `/`) with `replace`. A route without one
 * renders its page directly. Call it where the literal `<Route>`s would go: the
 * order of routes is the order of the array, and the page renders inside the
 * `Suspense` boundary the host already provides around lazy pages.
 *
 * @param routes - the slice's route data, possibly several arrays concatenated.
 * @param options - see {@link RenderKvoxRoutesOptions}.
 * @returns the `<Route>` elements, keyed by path.
 *
 * @example
 * ```tsx
 * <Route element={<KvoxAppShell navigation={NAVIGATION} />}>
 *   {renderKvoxRoutes([...kvoxNotesRoutes, ...kvoxGraphRoutes])}
 * </Route>
 * ```
 *
 * @stability experimental
 */
export function renderKvoxRoutes(
  routes: readonly KvoxRouteDef[],
  options: RenderKvoxRoutesOptions = {},
): ReactElement[] {
  const fallback = options.fallback ?? '/';
  return routes.map(({ path, permission, redirectTo, Component }) => (
    <Route
      key={path}
      path={path}
      element={
        permission ? (
          <RequirePermission
            permission={permission}
            fallback={<Navigate to={redirectTo ?? fallback} replace />}
          >
            <Component />
          </RequirePermission>
        ) : (
          <Component />
        )
      }
    />
  ));
}
