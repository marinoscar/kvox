import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the transcripts slice, as data: the app renders each one inside
 * its own layout, at the position its literal routes were.
 *
 * @remarks
 * Issue #30 (epic #19), the history page by #31.
 *
 * GATED ON THE SAME STRINGS `transcripts.controller.ts` ENFORCES:
 * `transcripts:read` for the three read surfaces and `transcripts:write` for the
 * one that creates. Both are seeded to all three roles, so in practice nobody is
 * refused; the gate is here because a deployment that revokes the permission
 * must see the route close, not merely the navigation row disappear.
 *
 * `/transcripts/new` carries `:write` while its siblings carry `:read`, and the
 * split is the reachability-versus-content distinction the settings pages make:
 * a user who may read transcripts but not create one reaches the list and the
 * viewer, and is sent back to the list (`redirectTo`) from the only route that
 * would 403 on submit. The other three send a viewer without the permission
 * home: a notes-only user is never shown a Transcripts row, so they can arrive
 * here only by an old bookmark, and `/` is the right answer.
 *
 * ORDER IS NOT SIGNIFICANT: the router ranks by specificity, so
 * `/transcripts/new` beats `/transcripts/:id` wherever each is written. The
 * pages are lazy: the viewer alone pulls in the virtualizer and the playback
 * engine, neither of which a user who never opens a transcript needs. The pages
 * here take no slots; an app that fills them replaces `Component` (the web
 * edition does, in `apps/web/src/kvox/transcriptsRoutes.ts`).
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxTranscriptsRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/transcripts',
    permission: 'transcripts:read',
    Component: lazy(() =>
      import('./pages/TranscriptsPage.js').then((module) => ({ default: module.TranscriptsPage })),
    ),
  },
  {
    path: '/transcripts/new',
    permission: 'transcripts:write',
    redirectTo: '/transcripts',
    Component: lazy(() =>
      import('./pages/NewTranscriptPage.js').then((module) => ({
        default: module.NewTranscriptPage,
      })),
    ),
  },
  {
    path: '/transcripts/:id',
    permission: 'transcripts:read',
    Component: lazy(() =>
      import('./pages/TranscriptPage.js').then((module) => ({ default: module.TranscriptPage })),
    ),
  },
  {
    // Issue #31 replaces the PAGE; this route, its gate and its AppBar
    // drill-down entry are #30's and are meant to survive that.
    path: '/transcripts/:id/history',
    permission: 'transcripts:read',
    Component: lazy(() =>
      import('./pages/TranscriptHistoryPage.js').then((module) => ({
        default: module.TranscriptHistoryPage,
      })),
    ),
  },
];
