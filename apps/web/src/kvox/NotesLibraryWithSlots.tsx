import { NotesPage } from '@marinoscar/kvox-web/notes/ui';

import { appNotesLibrarySlots } from './noteSlots';

/**
 * `/notes`: the packaged library with this app's search-hits slot (graph
 * entities). Issue #502, epic #498.
 */
export function NotesLibraryWithSlots() {
  return <NotesPage slots={appNotesLibrarySlots} />;
}
