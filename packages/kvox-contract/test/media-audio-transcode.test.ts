import { describe, expect, it } from 'vitest';

import { mediaAudioTranscodeResultSchema } from '../src/transcripts/index.js';

// =============================================================================
// The `media.audio.transcode` node result (issue #493, epic #491)
// =============================================================================
//
// Moved here from the API's `transcripts/contracts/` so a worker-node package can import
// it. It is the trust boundary for a rendition a node produced: every field arrives from a
// machine the deployment may not own and lands in the database.
// =============================================================================

const RESULT = {
  bytes: 512_000,
  durationMs: 75_264,
  codec: 'aac',
  bitrateKbps: 96,
  channels: 1,
  remuxed: false,
};

describe('mediaAudioTranscodeResultSchema', () => {
  it('accepts a well-formed result unchanged', () => {
    expect(mediaAudioTranscodeResultSchema.parse(RESULT)).toEqual(RESULT);
  });

  it.each([
    ['a zero-byte rendition', { ...RESULT, bytes: 0 }],
    ['a fractional byte count', { ...RESULT, bytes: 1.5 }],
    ['a negative duration', { ...RESULT, durationMs: -1 }],
    ['an implausible duration', { ...RESULT, durationMs: 50 * 60 * 60 * 1000 }],
    ['a bitrate above the ceiling', { ...RESULT, bitrateKbps: 999 }],
    ['zero channels', { ...RESULT, channels: 0 }],
    ['an empty codec', { ...RESULT, codec: '' }],
    ['a non-boolean remuxed', { ...RESULT, remuxed: 'yes' }],
    ['a missing field', { bytes: 1 }],
    ['not an object at all', 'nope'],
  ])('refuses %s', (_label, body) => {
    expect(mediaAudioTranscodeResultSchema.safeParse(body).success).toBe(false);
  });

  it('carries no storage key: the server derives it from the transcript and the job', () => {
    expect(mediaAudioTranscodeResultSchema.parse({ ...RESULT, storageKey: 'anywhere' })).not.toHaveProperty(
      'storageKey',
    );
  });
});
