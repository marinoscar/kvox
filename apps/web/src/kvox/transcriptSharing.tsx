/**
 * The web edition's sharing for the transcripts slice (issue #500, epic #498).
 *
 * A share is a platform `grants` row, so the dialog is the packaged `ShareDialog`
 * (`@marinoscar/platform-web/sharing/ui`) and "leave" is `kvox/transcriptSharingClient.ts`.
 * The slice cannot import either, so this adapter hands it both through the
 * `sharing` prop of its pages.
 */

import { ShareDialog } from '@marinoscar/platform-web/sharing/ui';
import type {
  TranscriptShareDialogProps,
  TranscriptSharingAdapter,
} from '@marinoscar/kvox-web/transcripts/ui';

import {
  TRANSCRIPT_SHARE_ROLES,
  leaveTranscript,
  transcriptResource,
} from './transcriptSharingClient';

function TranscriptShareDialog({ open, onClose, transcriptId, title }: TranscriptShareDialogProps) {
  return (
    <ShareDialog
      open={open}
      onClose={onClose}
      resource={transcriptResource(transcriptId)}
      resourceTitle={title}
      roles={TRANSCRIPT_SHARE_ROLES}
      allowGroups={false}
      allowLinks={false}
    />
  );
}

/** How the web edition shares a transcript and leaves one shared with the viewer. */
export const appTranscriptSharing: TranscriptSharingAdapter = {
  ShareDialog: TranscriptShareDialog,
  leave: leaveTranscript,
};
