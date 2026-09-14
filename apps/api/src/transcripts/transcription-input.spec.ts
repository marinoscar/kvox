import type { TranscriptionProviderCapabilities } from '../transcription/providers/transcription-provider.interface';
import { selectTranscriptionInput } from './transcription-input';

// =============================================================================
// `selectTranscriptionInput` — original, rendition, wait, impossible (#25 §2.4)
// =============================================================================
//
// The four answers and the conditions that produce each. The case worth
// reading twice is the `upload` delivery mode one: it waits for the rendition
// even for a format the provider accepts, because in that mode the API server
// relays the bytes itself and relaying a 5 GB original where a 60 MB rendition
// transcribes identically is the cost that mode exists under protest to pay.
// =============================================================================

const capabilities = (
  overrides: Partial<TranscriptionProviderCapabilities> = {},
): TranscriptionProviderCapabilities => ({
  diarization: true,
  wordTimestamps: true,
  languageDetection: true,
  speakersExpectedHint: true,
  acceptsUrl: true,
  acceptsUpload: true,
  maxInputBytes: 1_000_000,
  maxDurationMs: 10 * 60 * 60_000,
  acceptedMimeTypes: ['audio/mpeg', 'audio/mp4'],
  remoteDelete: true,
  cancel: true,
  ...overrides,
});

const original = { id: 'obj-original', mimeType: 'audio/mpeg', size: 500_000 };
const rendition = { id: 'obj-rendition', mimeType: 'audio/mp4', size: 90_000 };

describe('selectTranscriptionInput', () => {
  it('picks the original when the provider takes it and fetches bytes itself', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities(),
      audioDelivery: 'presigned_url',
      original,
    });

    expect(selection.kind).toBe('original');
    expect(selection.objectId).toBe('obj-original');
  });

  it('matches the accepted type case-insensitively', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ acceptedMimeTypes: ['AUDIO/MPEG'] }),
      audioDelivery: 'presigned_url',
      original: { ...original, mimeType: 'Audio/MPEG' },
    });

    expect(selection.kind).toBe('original');
  });

  it('waits for the rendition when the provider does not accept the original', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ acceptedMimeTypes: ['audio/mp4'] }),
      audioDelivery: 'presigned_url',
      original: { ...original, mimeType: 'audio/amr' },
    });

    expect(selection.kind).toBe('wait');
    expect(selection.objectId).toBeNull();
  });

  it('waits for the rendition when the original is over the byte ceiling', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ maxInputBytes: 100_000 }),
      audioDelivery: 'presigned_url',
      original,
    });

    expect(selection.kind).toBe('wait');
  });

  it('uses the rendition once it exists', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ maxInputBytes: 100_000 }),
      audioDelivery: 'presigned_url',
      original,
      rendition,
    });

    expect(selection.kind).toBe('rendition');
    expect(selection.objectId).toBe('obj-rendition');
  });

  it('waits for the rendition in `upload` mode even when the original is acceptable', () => {
    // THE ONE COUNTER-INTUITIVE CASE. In `upload` mode the API relays the
    // bytes, so the small file is the right one even though the provider would
    // have taken the large one.
    const selection = selectTranscriptionInput({
      capabilities: capabilities(),
      audioDelivery: 'upload',
      original,
    });

    expect(selection.kind).toBe('wait');
    expect(selection.reason).toContain('relays');
  });

  it('uses the rendition in `upload` mode once it exists', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities(),
      audioDelivery: 'upload',
      original,
      rendition,
    });

    expect(selection.kind).toBe('rendition');
  });

  it('is impossible — not a wait — when no rendition is coming', () => {
    // A transcode that failed, or a build with no transcode handler. Waiting
    // forever with no error is the failure mode this branch exists to prevent.
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ acceptedMimeTypes: ['audio/mp4'] }),
      audioDelivery: 'presigned_url',
      original: { ...original, mimeType: 'audio/amr' },
      renditionExpected: false,
    });

    expect(selection.kind).toBe('impossible');
    expect(selection.reason).toContain('no playback rendition');
  });

  it('names the size limit when an over-large file has no rendition coming', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ maxInputBytes: 100_000 }),
      audioDelivery: 'presigned_url',
      original,
      renditionExpected: false,
    });

    expect(selection.kind).toBe('impossible');
    expect(selection.reason).toContain('100000-byte limit');
  });

  it('is impossible when even the rendition is a type the provider refuses', () => {
    // A configuration fault, not a transient one: the same transcode produces
    // the same format forever.
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ acceptedMimeTypes: ['audio/mpeg'] }),
      audioDelivery: 'upload',
      original,
      rendition: { ...rendition, mimeType: 'audio/ogg' },
    });

    expect(selection.kind).toBe('impossible');
  });

  it('is impossible when the rendition is itself over the byte ceiling', () => {
    const selection = selectTranscriptionInput({
      capabilities: capabilities({ maxInputBytes: 50_000 }),
      audioDelivery: 'presigned_url',
      original,
      rendition,
    });

    expect(selection.kind).toBe('impossible');
  });

  it('carries a human reason on every branch', () => {
    // The reason reaches `transcripts.failure_reason` and the job log, so "why
    // is this transcript waiting?" is answerable from the row.
    const cases = [
      selectTranscriptionInput({ capabilities: capabilities(), audioDelivery: 'presigned_url', original }),
      selectTranscriptionInput({ capabilities: capabilities(), audioDelivery: 'upload', original }),
      selectTranscriptionInput({ capabilities: capabilities(), audioDelivery: 'upload', original, rendition }),
      selectTranscriptionInput({
        capabilities: capabilities({ maxInputBytes: 1 }),
        audioDelivery: 'presigned_url',
        original,
        renditionExpected: false,
      }),
    ];

    for (const selection of cases) {
      expect(selection.reason.length).toBeGreaterThan(20);
    }
  });
});
