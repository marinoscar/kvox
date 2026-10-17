import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the search slice, as data: the app renders each one inside its
 * own layout, at the position its literal route used to be.
 *
 * @remarks
 * Issue #191, epic #165. NO `permission`, and that is the API's own shape:
 * `search-index.controller.ts` gates both of its routes on `@Auth()` and no
 * permission string, because the resource is the caller's own content and the
 * caller's own vendor account, scoped by `ownerId` in the query itself. The
 * page's real gate is a CAPABILITY (does this deployment embed, and has this
 * user saved a key), which the page checks itself and which is not an
 * authorization.
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxSearchRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/settings/search-index',
    Component: lazy(() =>
      import('./UserSearchIndexPage.js').then((module) => ({
        default: module.UserSearchIndexPage,
      })),
    ),
  },
];
