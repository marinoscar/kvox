import { lazy } from 'react';
import { kvoxNotesRoutes } from '@marinoscar/kvox-web/notes/ui';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';

const NotesLibraryWithSlots = lazy(() =>
  import('./NotesLibraryWithSlots').then((m) => ({ default: m.NotesLibraryWithSlots })),
);
const NewNotePageWithAi = lazy(() =>
  import('./NewNotePageWithAi').then((m) => ({ default: m.NewNotePageWithAi })),
);
const NotePageWithSlots = lazy(() =>
  import('./NotePageWithSlots').then((m) => ({ default: m.NotePageWithSlots })),
);
const UserNoteTemplatesPageWithAi = lazy(() =>
  import('./UserNoteTemplatesPageWithAi').then((m) => ({ default: m.UserNoteTemplatesPageWithAi })),
);

/**
 * The notes routes of `@marinoscar/kvox-web`, with the four pages that take
 * slots or AI access swapped for this app's wrappers. Same paths, same
 * permissions, same order; `/notes/:id/history` takes neither. Issue #502,
 * epic #498.
 */
export const appNotesRoutes: readonly KvoxRouteDef[] = kvoxNotesRoutes.map((route) => {
  if (route.path === '/notes') return { ...route, Component: NotesLibraryWithSlots };
  if (route.path === '/notes/new') return { ...route, Component: NewNotePageWithAi };
  if (route.path === '/notes/:id') return { ...route, Component: NotePageWithSlots };
  if (route.path === '/settings/note-templates') {
    return { ...route, Component: UserNoteTemplatesPageWithAi };
  }
  return route;
});
