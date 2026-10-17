import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the notes slice, as data: the app renders each one inside its
 * own layout, at the position its literal routes were.
 *
 * @remarks
 * Issue #57 (epic #45).
 *
 * GATED ON THE SAME STRINGS `notes.controller.ts` ENFORCES: `notes:read` on
 * every read route and `notes:write` on the one that creates. Both are seeded
 * to all three roles, so in practice nobody is refused; the gate is here
 * because a deployment that revokes the permission must see the route close,
 * not merely the navigation row disappear.
 *
 * `/notes/new` carries `:write` and sends a reader who lacks it back to the
 * list (`redirectTo`), the same asymmetry `/transcripts/new` has: a user who may
 * read notes but not create one belongs on the list they can reach.
 *
 * `/settings/note-templates` carries NO permission, like every `/settings/*`
 * sibling: `note-templates.controller.ts` enforces `note_templates:read` and
 * `note_templates:write`, BOTH seeded to all three roles, so a gate would deny
 * nobody while inventing one the API does not have.
 *
 * The pages are lazy: the note surfaces pull in `react-markdown` and
 * `remark-gfm`, which nobody who never opens a note should pay for. The pages
 * here take no slots and no AI access; an app that fills them replaces
 * `Component` (the web edition does, in `apps/web/src/kvox/notesRoutes.ts`).
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxNotesRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/notes',
    permission: 'notes:read',
    Component: lazy(() =>
      import('./pages/NotesPage.js').then((module) => ({ default: module.NotesPage })),
    ),
  },
  {
    path: '/notes/new',
    permission: 'notes:write',
    redirectTo: '/notes',
    Component: lazy(() =>
      import('./pages/NewNotePage.js').then((module) => ({ default: module.NewNotePage })),
    ),
  },
  {
    path: '/notes/:id',
    permission: 'notes:read',
    Component: lazy(() =>
      import('./pages/NotePage.js').then((module) => ({ default: module.NotePage })),
    ),
  },
  {
    // Issue #58 builds this page out; the route, its gate and its AppBar
    // drill-down entry are #57's and are meant to survive that.
    path: '/notes/:id/history',
    permission: 'notes:read',
    Component: lazy(() =>
      import('./pages/NoteHistoryPage.js').then((module) => ({
        default: module.NoteHistoryPage,
      })),
    ),
  },
  {
    path: '/settings/note-templates',
    Component: lazy(() =>
      import('./pages/UserNoteTemplatesPage.js').then((module) => ({
        default: module.UserNoteTemplatesPage,
      })),
    ),
  },
];
