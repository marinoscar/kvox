import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  useHasPermission,
  useKvoxHost,
} from '../../../core/headless/index.js';
import type {
  TranscriptPageSlots,
  TranscriptSelectionActionsProps,
  TranscriptSpeakerPeople,
  TranscriptSpeakerSuggestion,
  TranscriptSpeakerSuggestions,
  TranscriptsLibrarySlots,
} from '../../../transcripts/ui/index.js';
import { useGraphTranscriptPeople } from '../../headless/hooks/useGraphTranscriptPeople.js';
import { useSpeakerSuggestions } from '../../headless/hooks/useSpeakerSuggestions.js';
import { TranscriptGraphSelection } from '../components/selection/TranscriptGraphSelection.js';
import { GraphSearchPrefix } from './GraphSearchPrefix.js';

/**
 * Which speakers of a transcript are a person in the viewer's graph, and how to
 * open one. Fills the `useSpeakerPeople` slot of the transcript page.
 *
 * @remarks
 * Needs `graph:read` and connected knowledge on; without either it returns
 * `null` and the speaker chips draw no person link. It is a hook, called on
 * every render of the page.
 *
 * @param transcriptId - The transcript the page shows, or `undefined` while the route has no id.
 * @param enabled - `false` until the transcript is ready.
 * @returns The speaker-to-person map and the opener, or `null`.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function useGraphSpeakerPeople(
  transcriptId: string | undefined,
  enabled: boolean,
): TranscriptSpeakerPeople | null {
  const navigate = useNavigate();
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canReadGraph = useHasPermission('graph:read') && graphEnabled;
  const entityIds = useGraphTranscriptPeople(transcriptId, canReadGraph && enabled);
  const host = useKvoxHost();
  const open = useCallback(
    (entityId: string) => navigate(host.links.entity(entityId)),
    [host, navigate],
  );
  return canReadGraph ? { entityIds, open } : null;
}

/**
 * Voice-based name suggestions for the still-unnamed speakers of a transcript
 * (#827). Fills the `useSpeakerSuggestions` slot of the transcript page.
 *
 * @remarks
 * Needs `graph:read` and connected knowledge on; without either it returns
 * `null`, fetches nothing, and the page draws no suggestion. Accepting or
 * dismissing needs `graph:write` and `transcripts:write` (the routes' own
 * gates); without them the suggestion shows with its actions disabled.
 *
 * @param transcriptId - The transcript the page shows.
 * @param enabled - `false` until the transcript is ready and while no speaker is a placeholder.
 * @returns The suggestions by speaker and the actions, or `null`.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function useGraphSpeakerSuggestions(
  transcriptId: string | undefined,
  enabled: boolean,
): TranscriptSpeakerSuggestions | null {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canReadGraph = useHasPermission('graph:read');
  const canWriteGraph = useHasPermission('graph:write');
  const canWriteTranscripts = useHasPermission('transcripts:write');
  const canRead = canReadGraph && graphEnabled;
  const { suggestions, busyId, error, clearError, accept, dismiss } = useSpeakerSuggestions(
    transcriptId,
    canRead && enabled,
  );
  const bySpeaker = useMemo(() => {
    const map: Record<string, TranscriptSpeakerSuggestion> = {};
    // The list is best first: the first suggestion of a speaker is its best.
    for (const row of suggestions) {
      if (row.speakerId in map) continue;
      map[row.speakerId] = { id: row.id, speakerId: row.speakerId, personName: row.entityName, score: row.score };
    }
    return map;
  }, [suggestions]);
  if (!canRead) return null;
  return {
    bySpeaker,
    canDecide: canWriteGraph && canWriteTranscripts,
    busyId,
    error,
    clearError,
    accept,
    dismiss,
  };
}

/**
 * "Add to graph" from a selection within one transcript line. Fills the
 * `SelectionActions` slot of the transcript page.
 *
 * @remarks
 * Renders nothing unless the viewer holds `graph:write` (the component itself
 * asks the host whether connected knowledge is on).
 *
 * @param props - The transcript, its segments and the element the selection lives in.
 * @returns The selection action, or nothing.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphTranscriptSelectionActions({
  transcriptId,
  containerRef,
  segments,
  enabled,
}: TranscriptSelectionActionsProps) {
  const canWrite = useHasPermission('graph:write');
  if (!canWrite) return null;
  return (
    <TranscriptGraphSelection
      containerRef={containerRef}
      transcriptId={transcriptId}
      segments={segments}
      enabled={enabled}
    />
  );
}

/**
 * The graph members of the transcript page's slots, ready to spread into the
 * host's `TranscriptPageSlots` next to its own (`NotesSection`).
 *
 * @stability experimental
 * @extensionPoint slot
 */
export const graphTranscriptPageSlots: Pick<
  TranscriptPageSlots,
  'SelectionActions' | 'useSpeakerPeople' | 'useSpeakerSuggestions'
> = {
  useSpeakerPeople: useGraphSpeakerPeople,
  useSpeakerSuggestions: useGraphSpeakerSuggestions,
  SelectionActions: GraphTranscriptSelectionActions,
};

/**
 * The graph member of the transcripts library's slots: entity hits above the
 * ranked results.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export const graphTranscriptsLibrarySlots: TranscriptsLibrarySlots = {
  SearchPrefix: GraphSearchPrefix,
};
