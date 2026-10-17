import { UserNoteTemplatesPage } from '@marinoscar/kvox-web/notes/ui';

import { appNotesAiAccess } from './noteAiAccess';

/** `/settings/note-templates`: the packaged page with the viewer's AI availability. Issue #502, epic #498. */
export function UserNoteTemplatesPageWithAi() {
  return <UserNoteTemplatesPage ai={appNotesAiAccess} />;
}
