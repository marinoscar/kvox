import { describe, it, expect } from 'vitest';

import { hasPlayableAudio } from '../../utils/transcriptDisplay';
import type { PlaybackStatus, TranscriptStatus } from '../../services/transcripts';

/**
 * `hasPlayableAudio` (issue #98) — see the function's own header for the
 * reasoning. This suite pins the two facts that header calls out as
 * deliberately absent from the decision (`durationMs`, `access`) and the two
 * that decide it (`status`, `playbackStatus`), as a full cross-product table
 * rather than a handful of cherry-picked cases: a status combination nobody
 * thought to write a dedicated test for is exactly the kind of gap a table
 * closes.
 */

const TRANSCRIPT_STATUSES: TranscriptStatus[] = [
  'uploading',
  'processing',
  'ready',
  'failed',
  'deleting',
];

const PLAYBACK_STATUSES: PlaybackStatus[] = [
  'pending',
  'processing',
  'ready',
  'failed',
  'not_needed',
];

describe('hasPlayableAudio — the full status matrix', () => {
  for (const status of TRANSCRIPT_STATUSES) {
    for (const playbackStatus of PLAYBACK_STATUSES) {
      const expected = status === 'ready' && playbackStatus !== 'pending' && playbackStatus !== 'processing';

      it(`status=${status} playbackStatus=${playbackStatus} → ${expected}`, () => {
        expect(hasPlayableAudio({ status, playbackStatus })).toBe(expected);
      });
    }
  }
});

describe('hasPlayableAudio — the cases the header calls out by name', () => {
  it('is playable when the transcode failed but the API falls back to the original upload', () => {
    expect(hasPlayableAudio({ status: 'ready', playbackStatus: 'failed' })).toBe(true);
  });

  it('is NOT playable while the transcode is still pending, even though transcription finished', () => {
    expect(hasPlayableAudio({ status: 'ready', playbackStatus: 'pending' })).toBe(false);
  });

  it('is NOT playable while the transcode is actively processing', () => {
    expect(hasPlayableAudio({ status: 'ready', playbackStatus: 'processing' })).toBe(false);
  });

  it('is never playable off a non-ready transcript, regardless of playbackStatus', () => {
    for (const playbackStatus of PLAYBACK_STATUSES) {
      expect(hasPlayableAudio({ status: 'uploading', playbackStatus })).toBe(false);
      expect(hasPlayableAudio({ status: 'processing', playbackStatus })).toBe(false);
      expect(hasPlayableAudio({ status: 'failed', playbackStatus })).toBe(false);
      expect(hasPlayableAudio({ status: 'deleting', playbackStatus })).toBe(false);
    }
  });
});
