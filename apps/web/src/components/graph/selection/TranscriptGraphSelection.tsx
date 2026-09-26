/**
 * "Add to graph" on the transcript page (#368; ontology.md §19).
 *
 * Mounted by `TranscriptPage` only for a caller holding `graph:write`; this
 * component then asks `GET /api/ai/config` whether connected knowledge is on
 * (`graphEnabled`), so the transcript page itself keeps its rule of not
 * reading the AI config (see its header). A selection within one line becomes
 * a segment span pinned to the line's `rev`; the row joins a draft of one of
 * the notes made from this transcript, and the review sheet then opens here,
 * on that draft, scrolled to the new row.
 */

import { useCallback, useState } from 'react';
import type { RefObject } from 'react';

import { useAiConfig } from '../../../hooks/useAiConfig';
import type { TranscriptSegment } from '../../../services/transcripts';
import { ProposalReviewSheet } from '../review/ProposalReviewSheet';
import { GraphSelectionAdd } from './GraphSelectionAdd';
import { resolveSegmentSelection } from './resolvers';

/** `TranscriptNotesSection`'s heading — where "Show notes" scrolls to. */
export const TRANSCRIPT_NOTES_HEADING_ID = 'transcript-notes-heading';

export interface TranscriptGraphSelectionProps {
  containerRef: RefObject<HTMLElement | null>;
  transcriptId: string;
  segments: readonly TranscriptSegment[];
  /** False while a line is being edited. */
  enabled: boolean;
}

export function TranscriptGraphSelection({ containerRef, transcriptId, segments, enabled }: TranscriptGraphSelectionProps) {
  const { config } = useAiConfig();
  const [sheet, setSheet] = useState<{ proposalId: string; itemId: string } | null>(null);

  const resolve = useCallback(
    (range: Range, container: HTMLElement) =>
      resolveSegmentSelection(range, container, {
        transcriptId,
        segmentText: (segmentId) => segments.find((segment) => segment.id === segmentId)?.text,
      }),
    [segments, transcriptId],
  );

  if (config?.graphEnabled !== true) return null;

  return (
    <>
      <GraphSelectionAdd
        containerRef={containerRef}
        enabled={enabled}
        resolve={resolve}
        target={{
          kind: 'transcript',
          transcriptId,
          onShowNotes: () =>
            document
              .getElementById(TRANSCRIPT_NOTES_HEADING_ID)
              ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }),
        }}
        onAdded={(result, proposalId) => setSheet({ proposalId, itemId: result.item.id })}
      />
      {sheet && (
        <ProposalReviewSheet
          open
          onClose={() => setSheet(null)}
          source={{ proposalId: sheet.proposalId }}
          originTranscriptId={transcriptId}
          focusItemId={sheet.itemId}
        />
      )}
    </>
  );
}

export default TranscriptGraphSelection;
