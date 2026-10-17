import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the ask slice, as data: the app renders each one inside its own
 * layout, at the position its literal route was.
 *
 * @remarks
 * Issue #380 (epic #348; spec `docs/specs/ontology.md` §21.5). ONE route with an
 * optional segment, not two: `/ask` becomes `/ask/:id` after the first question
 * and must keep the page mounted, so the rows it just posted stay on screen
 * instead of the page re-reading its configuration from scratch.
 *
 * GATED ON `graph:read`, the exact string every `/api/ask/*` route enforces
 * (there is no `ask:*` pair). Connected knowledge being off is checked inside the
 * page, which shows an info state. The `knowledge` destination of the graph slice
 * owns the `/ask` prefix, so this slice adds a route and no destination.
 *
 * The page is lazy: the answer renderer pulls in `react-markdown`, which nobody
 * who never opens Ask should pay for.
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxAskRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/ask/:conversationId?',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/AskPage.js').then((module) => ({ default: module.AskPage })),
    ),
  },
];
