/**
 * `/notes` — the other of the app's two content destinations. Issue #106, over
 * #57 (epic #45).
 *
 * `TranscriptsPage`'s twin, and deliberately so: the same frame, the same
 * shape, one view swapped and one action relabelled. See that file's header for
 * why the Transcripts | Notes tab strip these two replace is gone, and why the
 * tabs INSIDE each view are a different judgement that stays.
 *
 * Notes was a tab between #57 and #106 for one reason — the bottom bar was
 * full, and `console` was holding the slot. #106 pins Console at the rail's
 * foot and in the avatar menu instead (`config/destinations.ts`), which makes
 * Notes a destination in its own right: it is one of the two things this
 * product produces, and the navigation now says so.
 */

import { LibraryPageFrame } from '../components/library/LibraryPageFrame';
import { NotesLibraryView } from '../components/library/NotesLibraryView';

export function NotesPage() {
  return (
    <LibraryPageFrame
      title="Notes"
      // `notes:write` — what `notes.controller.ts` enforces on create. The
      // route above already required `notes:read` to reach this page at all.
      action={{ label: 'New note', path: '/notes/new', permission: 'notes:write' }}
    >
      <NotesLibraryView />
    </LibraryPageFrame>
  );
}

export default NotesPage;
