import { NewNotePage } from '@marinoscar/kvox-web/notes/ui';

import { appNotesAiAccess } from './noteAiAccess';

/** `/notes/new`: the packaged page with the viewer's AI availability. Issue #502, epic #498. */
export function NewNotePageWithAi() {
  return <NewNotePage ai={appNotesAiAccess} />;
}
