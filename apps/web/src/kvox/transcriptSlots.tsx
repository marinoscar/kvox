/**
 * What the web edition adds to the transcripts pages (issue #500, epic #498).
 *
 * The slice imports only `core`, `transcription` and `search`. The notes under a
 * transcript, the person links on a speaker and "Add to graph" on a selection
 * belong to the notes and graph UI, which still lives in this app until issues
 * 7.4 and 7.5, so they are filled in here.
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import type {
  TranscriptPageSlots,
  TranscriptSelectionActionsProps,
  TranscriptSpeakerPeople,
  TranscriptsLibrarySlots,
} from '@marinoscar/kvox-web/transcripts/ui';

import { EntitySearchHits } from '../components/graph/EntitySearchHits';
import { TranscriptGraphSelection } from '../components/graph/selection/TranscriptGraphSelection';
import { TranscriptNotesSection } from '../components/notes/TranscriptNotesSection';
import { useGraphTranscriptPeople } from '../hooks/useGraphTranscriptPeople';

/**
 * Which speakers of a transcript are a Person in the viewer's graph (#373). Needs
 * `graph:read`; without it the speaker chips draw no person link.
 */
function useSpeakerPeople(
  transcriptId: string | undefined,
  enabled: boolean,
): TranscriptSpeakerPeople | null {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canReadGraph = hasPermission('graph:read');
  const entityIds = useGraphTranscriptPeople(transcriptId, canReadGraph && enabled);
  const open = useCallback(
    (entityId: string) => navigate(`/graph/entities/${encodeURIComponent(entityId)}`),
    [navigate],
  );
  return canReadGraph ? { entityIds, open } : null;
}

/**
 * "Add to graph" from a selection within one line (#368). `graph:write` gates the
 * mount; the component itself asks whether the graph is on.
 */
function SelectionActions({
  transcriptId,
  containerRef,
  segments,
  enabled,
}: TranscriptSelectionActionsProps) {
  const { hasPermission } = usePermissions();
  if (!hasPermission('graph:write')) return null;
  return (
    <TranscriptGraphSelection
      containerRef={containerRef}
      transcriptId={transcriptId}
      segments={segments}
      enabled={enabled}
    />
  );
}

/** The slots of the transcript page. */
export const appTranscriptPageSlots: TranscriptPageSlots = {
  NotesSection: TranscriptNotesSection,
  useSpeakerPeople,
  SelectionActions,
};

/** The slot of the transcripts library: knowledge-graph entity hits above the ranked results (#373). */
export const appTranscriptsLibrarySlots: TranscriptsLibrarySlots = {
  SearchPrefix: EntitySearchHits,
};
