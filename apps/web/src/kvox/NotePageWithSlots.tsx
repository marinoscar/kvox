import { NotePage } from '@marinoscar/kvox-web/notes/ui';

import { appNotePageAiAccess, appNotePageSlots } from './noteSlots';

/**
 * `/notes/:id`: the packaged note page with this app's slots (the graph review
 * sheet, "Add to graph", the extract dialog) and the AI access its provider
 * read. Issue #502, epic #498.
 */
export function NotePageWithSlots() {
  return <NotePage slots={appNotePageSlots} ai={appNotePageAiAccess} />;
}
