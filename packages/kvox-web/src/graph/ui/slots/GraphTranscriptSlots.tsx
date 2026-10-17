import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  useHasPermission,
  useKvoxHost,
} from '../../../core/headless/index.js';
import type {
  TranscriptPageSlots,
  TranscriptSelectionActionsProps,
  TranscriptSpeakerPeople,
  TranscriptsLibrarySlots,
} from '../../../transcripts/ui/index.js';
import { useGraphTranscriptPeople } from '../../headless/hooks/useGraphTranscriptPeople.js';
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
  'SelectionActions' | 'useSpeakerPeople'
> = {
  useSpeakerPeople: useGraphSpeakerPeople,
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
