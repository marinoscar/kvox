import DescriptionIcon from '@mui/icons-material/Description';

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
