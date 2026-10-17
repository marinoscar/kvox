import { lazy } from 'react';
import { kvoxGraphRoutes } from '@marinoscar/kvox-web/graph/ui';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';

const GraphEntityPageWithSlots = lazy(() =>
  import('./GraphEntityPageWithSlots').then((m) => ({ default: m.GraphEntityPageWithSlots })),
);

/**
 * The graph routes of `@marinoscar/kvox-web`, with the entity page swapped for
 * this app's wrapper (the Ask action and panel). Same paths, same permissions,
 * same order; the other pages take no slots. Issue #503, epic #498.
 */
export const appGraphRoutes: readonly KvoxRouteDef[] = kvoxGraphRoutes.map((route) =>
  route.path === '/graph/entities/:id' ? { ...route, Component: GraphEntityPageWithSlots } : route,
);
