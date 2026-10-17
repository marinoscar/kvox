/**
 * What the web edition adds to the transcripts pages (issue #500, epic #498).
 *
 * The slice imports only `core`, `transcription` and `search`. The notes under a
 * transcript are the notes slice's own `TranscriptNotesSection`; the person links
 * on a speaker, "Add to graph" on a selection and the entity hits above library
 * search are the graph slice's slot components (issue #503).
 */

import { TranscriptNotesSection } from '@marinoscar/kvox-web/notes/ui';
import {
  graphTranscriptPageSlots,
  graphTranscriptsLibrarySlots,
} from '@marinoscar/kvox-web/graph/ui';
import type {
  TranscriptPageSlots,
  TranscriptsLibrarySlots,
} from '@marinoscar/kvox-web/transcripts/ui';

/** The slots of the transcript page. */
export const appTranscriptPageSlots: TranscriptPageSlots = {
  NotesSection: TranscriptNotesSection,
  ...graphTranscriptPageSlots,
};

/** The slot of the transcripts library: knowledge-graph entity hits above the ranked results (#373). */
export const appTranscriptsLibrarySlots: TranscriptsLibrarySlots = graphTranscriptsLibrarySlots;
