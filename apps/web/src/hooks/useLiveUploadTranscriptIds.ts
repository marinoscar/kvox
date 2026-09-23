/**
 * Which transcripts this browser is actually uploading — issue #322.
 *
 * The server only knows a transcript is `uploading`. Whether its bytes are
 * moving is known ONLY to the browser doing the upload, through the app-wide
 * upload manager (#22), whose `ManagedUpload.transcriptId` is the join. A
 * transcript in `uploading` that no live upload here names is one the UI
 * renders as "Upload interrupted" instead of a spinner that never stops.
 *
 * Its own file, not a second export of `useUploadManager.ts`, because several
 * suites `vi.mock` that module wholesale; a sibling export there would vanish
 * under every one of those mocks.
 */

import { useContext, useMemo } from 'react';

import {
  UploadManagerContext,
  type ManagedUpload,
} from '../contexts/UploadManagerContext';

/**
 * Phases in which an upload in this browser is still carrying (or has just
 * finished carrying) a transcript's bytes.
 *
 * `completed` is included on purpose: the bytes have landed and the server is
 * about to move the transcript to `processing`, but the list in front of the
 * user may still say `uploading` until its next refetch — calling that
 * "interrupted" for a few seconds would be wrong. `failed` and `cancelled` are
 * the two phases that genuinely mean nothing is moving.
 */
const LIVE_UPLOAD_PHASES: ReadonlySet<string> = new Set([
  'idle',
  'uploading',
  'paused',
  'completing',
  'completed',
]);

/** Pure form, for callers that already hold the upload list. */
export function liveUploadTranscriptIds(
  uploads: readonly ManagedUpload[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const upload of uploads) {
    if (upload.transcriptId && LIVE_UPLOAD_PHASES.has(upload.progress.phase)) {
      ids.add(upload.transcriptId);
    }
  }
  return ids;
}

/**
 * The transcript ids this browser's upload manager is live for, or `null` when
 * no manager is mounted.
 *
 * TOLERANT, unlike `useUploadManager`, and deliberately: `TranscriptStatusChip`
 * is a display component rendered in places (and tests) without the provider.
 * There "I cannot tell" must mean "render what you always rendered" — never a
 * thrown error, and never "interrupted".
 */
export function useLiveUploadTranscriptIds(): ReadonlySet<string> | null {
  const context = useContext(UploadManagerContext);
  const uploads = context?.uploads;
  return useMemo(() => (uploads ? liveUploadTranscriptIds(uploads) : null), [uploads]);
}
