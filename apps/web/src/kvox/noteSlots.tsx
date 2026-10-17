/**
 * What the web edition adds to the notes pages (issue #502, epic #498).
 *
 * The connected-knowledge features of the note page (the review sheet over a
 * note's proposal, "Add to graph" on a selection, the extract dialog, the
 * `?review=1` deep link) and the entity hits above library search are the graph
 * slice's own slot components (`@marinoscar/kvox-web/graph/ui`, issue #503); this
 * file only supplies what that slice does not know, the AI access.
 *
 * ONE PROVIDER. It reads `GET /api/ai-tasks/config` ONCE and hands it to the page
 * as its AI access, so the page makes the request it always made and no second
 * one, and it mounts the graph slice's provider inside, telling it when that
 * answer has landed (the `?review=1` link opens the sheet only after).
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import {
  GraphNotePageProvider,
  graphNotePageSlots,
  graphNotesLibrarySlots,
} from '@marinoscar/kvox-web/graph/ui';
import type {
  NotePageProviderProps,
  NotePageSlots,
  NotesAiAccess,
  NotesAiState,
  NotesLibrarySlots,
} from '@marinoscar/kvox-web/notes/ui';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';
import { useNotesAiState } from './noteAiAccess';

/** The AI availability, read once for the page. */
const NotePageAiContext = createContext<NotesAiState | null>(null);

/** Wraps the note page: reads the AI config once, then mounts the graph slice's provider. */
function NotePageProvider({ noteId, children }: NotePageProviderProps): ReactNode {
  const aiRead = useAiTasksConfig();
  const ai = useNotesAiState(aiRead);
  return (
    <NotePageAiContext.Provider value={ai}>
      <GraphNotePageProvider noteId={noteId} ready={!aiRead.isLoading}>
        {children}
      </GraphNotePageProvider>
    </NotePageAiContext.Provider>
  );
}

/** The slots of the note page: the graph slice's, with this app's provider in front. */
export const appNotePageSlots: NotePageSlots = {
  ...graphNotePageSlots,
  Provider: NotePageProvider,
};

function useNotePageAiState(): NotesAiState {
  const ai = useContext(NotePageAiContext);
  if (!ai) throw new Error('The note page AI access needs the note page provider above it');
  return ai;
}

/**
 * The note page's AI access: the one the page-wide provider already read, so
 * `GET /api/ai-tasks/config` is requested once per page. Only valid under
 * {@link appNotePageSlots}`.Provider`.
 */
export const appNotePageAiAccess: NotesAiAccess = {
  useAiState: useNotePageAiState,
  KeyRequired: AiKeyRequired,
};

/** The slot of the notes library: knowledge-graph entity hits above the ranked results (#373). */
export const appNotesLibrarySlots: NotesLibrarySlots = graphNotesLibrarySlots;
