import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the graph slice, as data: the app renders each one inside its
 * own layout, at the position its literal routes were.
 *
 * @remarks
 * Owned by the `knowledge` destination since #438 (a bottom-bar tab of its own
 * while connected knowledge is on). Every read route is gated on `graph:read`,
 * the exact string `graph-read.controller.ts` (#370) enforces; seeded to all
 * three roles, so the gate is here for the deployment that revokes it.
 *
 * - `/graph/explore` (#374): `POST /api/graph/explore/expand` is `graph:read`.
 * - `/graph/overview` (#375): `GET /api/graph/overview` is `graph:read`; its
 *   Refresh (`graph:write`) is gated inside the page.
 * - `/graph/review`: the draft proposals waiting for review
 *   (`GET /api/graph/proposals?status=draft` is `graph:read`), each linking
 *   to the note page's review sheet (`?review=1`) or the import page.
 * - `/graph/review-queue` (#721): the same drafts grouped by library and import
 *   batch (`GET /api/graph/review-queue` is `graph:read`), with a safe-policy
 *   batch commit per group gated inside the page on `graph:write`.
 * - `/graph/imports/:proposalId` (#387): `graph:write`, the exact string
 *   `POST /api/graph/imports` and the review writes enforce, because importing
 *   is curating the graph. A viewer without it is sent to `/graph`.
 * - `/settings/knowledge-graph` (#369): the one gated `/settings/*` route,
 *   `graph:write` on the attribute-definition write routes. A viewer without it
 *   is sent to `/settings`.
 *
 * The pages are lazy; the explorer and the overview load their canvas
 * (`sigma`, `graphology` layout) a second time, so the list view never
 * downloads it. The entity page takes the Ask slots, so an app that offers Ask
 * replaces its `Component` (the web edition does, in
 * `apps/web/src/kvox/graphRoutes.ts`).
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxGraphRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/graph',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphIndexPage.js').then((module) => ({ default: module.GraphIndexPage })),
    ),
  },
  {
    path: '/graph/entities/:id',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphEntityPage.js').then((module) => ({ default: module.GraphEntityPage })),
    ),
  },
  {
    path: '/graph/explore',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphExplorerPage.js').then((module) => ({
        default: module.GraphExplorerPage,
      })),
    ),
  },
  {
    path: '/graph/overview',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphOverviewPage.js').then((module) => ({
        default: module.GraphOverviewPage,
      })),
    ),
  },
  {
    path: '/graph/review',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphReviewPage.js').then((module) => ({ default: module.GraphReviewPage })),
    ),
  },
  {
    path: '/graph/review-queue',
    permission: 'graph:read',
    Component: lazy(() =>
      import('./pages/GraphReviewQueuePage.js').then((module) => ({
        default: module.GraphReviewQueuePage,
      })),
    ),
  },
  {
    path: '/graph/imports/:proposalId',
    permission: 'graph:write',
    redirectTo: '/graph',
    Component: lazy(() =>
      import('./pages/GraphImportPage.js').then((module) => ({ default: module.GraphImportPage })),
    ),
  },
  {
    path: '/settings/knowledge-graph',
    permission: 'graph:write',
    redirectTo: '/settings',
    Component: lazy(() =>
      import('./pages/UserKnowledgeGraphPage.js').then((module) => ({
        default: module.UserKnowledgeGraphPage,
      })),
    ),
  },
];
