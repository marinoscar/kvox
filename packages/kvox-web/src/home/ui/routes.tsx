import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The Home route as data, for `renderKvoxRoutes`: `/`, open to every signed-in person.
 *
 * @remarks
 * It draws `<KvoxHomePage />` with its defaults. A host that fills a slot
 * (`heroActions`, `extraSteps`, `sections`) mounts `KvoxHomePage` itself in a
 * `<Route path="/">` and does not spread this.
 *
 * @stability experimental
 */
export const kvoxHomeRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/',
    Component: lazy(() =>
      import('./KvoxHomePage.js').then((module) => ({ default: module.KvoxHomePage })),
    ),
  },
];
