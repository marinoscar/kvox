/**
 * The status chip every transcript surface uses — issue #30, epic #19.
 *
 * ONE COMPONENT, not a chip per page. The library list, the viewer's header and
 * the home page's "in progress" section (#32) all answer the same question, and
 * three chips would be three chances for `processing` to mean something
 * slightly different in each.
 *
 * The words and colours come from `utils/transcriptDisplay.ts`; this file is
 * only the rendering.
 */

import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';

import { useLiveUploadTranscriptIds } from '../../hooks/useLiveUploadTranscriptIds';
import type { TranscriptListItem } from '../../services/transcripts';
import {
  UPLOAD_INTERRUPTED_LABEL,
  isUploadInterrupted,
  processingStageLabel,
  transcriptStatusDescriptor,
} from '../../utils/transcriptDisplay';

interface TranscriptStatusChipProps {
  /**
   * `id` is optional so every existing caller keeps compiling, but it is what
   * lets an `uploading` transcript with no live upload in this browser read as
   * "Upload interrupted" (issue #322). Without it the chip cannot tell, and
   * renders as it always did.
   */
  transcript: Pick<
    TranscriptListItem,
    'status' | 'transcriptionStatus' | 'playbackStatus'
  > & { id?: string };
  /**
   * Append the sub-pipeline stage ("Processing · Transcribing").
   *
   * Off by default because the stage is only meaningful while something is
   * moving, and a list of forty ready transcripts does not want forty chips
   * carrying a redundant second clause.
   */
  showStage?: boolean;
  size?: 'small' | 'medium';
}

export function TranscriptStatusChip({
  transcript,
  showStage = false,
  size = 'small',
}: TranscriptStatusChipProps) {
  const liveTranscriptIds = useLiveUploadTranscriptIds();

  // Issue #322: an `uploading` transcript nothing in this browser is uploading
  // is not "still moving" — it is stuck, and a spinner would say otherwise
  // forever. Warning colour, no spinner, no stage clause; the row's own ⋮ menu
  // still offers Delete, and the server purges it after
  // `transcription.abandonedUploadHours` regardless.
  if (isUploadInterrupted(transcript, liveTranscriptIds)) {
    return (
      <Chip
        size={size}
        color="warning"
        variant="outlined"
        label={UPLOAD_INTERRUPTED_LABEL}
      />
    );
  }

  const descriptor = transcriptStatusDescriptor(transcript.status);
  const stage = showStage ? processingStageLabel(transcript) : null;
  const label = stage ? `${descriptor.label} · ${stage}` : descriptor.label;

  const inFlight =
    transcript.status === 'processing' || transcript.status === 'uploading';

  return (
    <Chip
      size={size}
      color={descriptor.color}
      variant={descriptor.color === 'default' ? 'filled' : 'outlined'}
      label={label}
      // A spinner INSIDE the chip rather than beside it: the two are one
      // statement ("this is still moving"), and a separate spinner is a second
      // thing to align, wrap and explain to a screen reader.
      icon={
        inFlight ? (
          <CircularProgress
            size={size === 'small' ? 12 : 16}
            thickness={6}
            // `aria-hidden` because the chip's own text already says
            // "Processing"; an unlabelled progressbar next to it announces a
            // second, meaningless element.
            aria-hidden
            sx={{ ml: 0.75 }}
          />
        ) : undefined
      }
    />
  );
}

export default TranscriptStatusChip;
