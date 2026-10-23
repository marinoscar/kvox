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

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { LibraryPageFrame } from '../../../core/ui/index.js';
import { ImportNotesButton } from '../components/ImportNotesButton.js';
import { NotesDropZone } from '../components/NotesDropZone.js';
import { NotesLibraryView } from '../components/NotesLibraryView.js';
import type { NotesLibrarySlots } from '../slots.js';

/**
 * Props of {@link NotesPage}.
 *
 * @stability experimental
 */
export interface NotesPageProps {
  /** What the host adds to the library (the search-hits slot). */
  slots?: NotesLibrarySlots;
  /**
   * A control beside "New note" in the header (#585: KVox Desktop's "Import…"). Rendered
   * as given at every width; it gates itself. Default {@link NotesImportActions}
   * ("Import notes" and "Libraries", #720); `null` shows none.
   */
  secondaryAction?: ReactNode;
}

/**
 * The default secondary actions of `/notes` (#720): "Import notes" (files, gated on
 * `notes:write` by the button itself) and "Libraries" (the folders kept in sync).
 *
 * @returns The two controls.
 *
 * @stability experimental
 */
export function NotesImportActions() {
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <ImportNotesButton />
      <Button
        variant="outlined"
        component={RouterLink}
        to="/notes/libraries"
        startIcon={<FolderCopyIcon />}
        sx={{ whiteSpace: 'nowrap' }}
      >
        Libraries
      </Button>
    </Box>
  );
}

/**
 * `/notes`: the notes library inside the shared library frame.
 *
 * @param props - See {@link NotesPageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function NotesPage({ slots, secondaryAction }: NotesPageProps = {}) {
  return (
    <NotesDropZone>
    <LibraryPageFrame
      title="Notes"
      // `notes:write` — what `notes.controller.ts` enforces on create. The
      // route above already required `notes:read` to reach this page at all.
      action={{ label: 'New note', path: '/notes/new', permission: 'notes:write' }}
      secondaryAction={secondaryAction === undefined ? <NotesImportActions /> : secondaryAction}
    >
      <NotesLibraryView slots={slots} />
    </LibraryPageFrame>
    </NotesDropZone>
  );
}

