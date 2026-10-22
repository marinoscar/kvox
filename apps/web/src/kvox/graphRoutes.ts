import { lazy } from 'react';
import { kvoxGraphRoutes } from '@marinoscar/kvox-web/graph/ui';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';

const GraphEntityPageWithSlots = lazy(() =>
  import('./GraphEntityPageWithSlots').then((m) => ({ default: m.GraphEntityPageWithSlots })),
);

const GraphExplorerPageWithSlots = lazy(() =>
  import('./GraphExplorerPageWithSlots').then((m) => ({ default: m.GraphExplorerPageWithSlots })),
);

/**
 * The graph routes of `@marinoscar/kvox-web`, with the entity page and the
 * explorer swapped for this app's wrappers (the Ask action and panel on the
 * entity page; the Ask panel in the explorer inspector's Ask tab). Same paths,
 * same permissions, same order; the other pages take no slots. Issues #503 and
 * GIC-11 (#672), epics #498 and #661.
 */
export const appGraphRoutes: readonly KvoxRouteDef[] = kvoxGraphRoutes.map((route) => {
  if (route.path === '/graph/entities/:id') return { ...route, Component: GraphEntityPageWithSlots };
  if (route.path === '/graph/explore') return { ...route, Component: GraphExplorerPageWithSlots };
  return route;
});
