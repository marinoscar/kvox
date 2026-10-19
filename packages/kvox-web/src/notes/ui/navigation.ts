import DescriptionIcon from '@mui/icons-material/Description';
import NoteAddIcon from '@mui/icons-material/NoteAdd';

import type { KvoxDestination, KvoxDestinationRoutes } from '../../core/ui/index.js';

/**
 * The navigation destination of the notes slice, as data: the app spreads it
 * into its destination table at the position its literal `notes` entry was
 * (between Transcripts and Knowledge), so the rail, the bottom bar and the
 * avatar menu see exactly what they saw before.
 *
 * @remarks
 * Issue #57 (epic #45), promoted from a tab to a destination by #106.
 *
 * ONE PERMISSION, for the same reason as the Transcripts row: `notes.controller.ts`
 * carries `PERMISSIONS.NOTES_READ` on its reads and nothing else gates this
 * subtree. Seeded to all three roles, same as the transcript pair.
 *
 * The icon is a page of prose, never a waveform: a note is generated text, and
 * half of what the app holds is not something the user recorded.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxNotesDestinations: readonly KvoxDestination<'notes'>[] = [
  {
    key: 'notes',
    label: 'Notes',
    compactLabel: 'Notes',
    Icon: DescriptionIcon,
    path: '/notes',
    permission: 'notes:read',
  },
];

/**
 * The route prefixes the notes destination owns, keyed by destination key.
 *
 * @remarks
 * ONE PREFIX. It owns its whole subtree: `/notes` covers the library,
 * `/notes/new`, `/notes/:id` and `/notes/:id/history` (#57, epic #45), because
 * a reader watching one note being written has not left the surface they
 * started on. The app spreads it into its `DESTINATION_ROUTES` at the same key
 * position.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxNotesDestinationRoutes: KvoxDestinationRoutes<'notes'> = {
  notes: ['/notes'],
};

/**
 * The Templates destination of the notes slice, as data, for a host that lists
 * the note-template manager as a row of its own (KVox Desktop's rail).
 *
 * @remarks
 * KVox web does NOT spread this: there the manager is the Note Templates card of
 * the settings hub, and `/settings/note-templates` is owned by the pinned
 * `settings` row. A host that lists both rows gets the longest-prefix answer.
 * `createKvoxNavigation` from `@marinoscar/kvox-web/shell` composes it when asked
 * for `'templates'`.
 *
 * No permission, like the route and the hub card: `note_templates:*` is seeded to
 * every role and the page's real gate is the viewer's AI key.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxNoteTemplatesDestinations: readonly KvoxDestination<'templates'>[] = [
  {
    key: 'templates',
    label: 'Templates',
    compactLabel: 'Templates',
    Icon: NoteAddIcon,
    path: '/settings/note-templates',
  },
];

/**
 * The route prefix the Templates destination owns, keyed by destination key.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxNoteTemplatesDestinationRoutes: KvoxDestinationRoutes<'templates'> = {
  templates: ['/settings/note-templates'],
};
