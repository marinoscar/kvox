import { createFakeTranscriptionProvider, type FakeTranscriptionProvider } from '@marinoscar/kvox-api/transcription/testing';
import type { NormalizedTranscript } from '@marinoscar/kvox-api/transcription';

// =============================================================================
// The speech-to-text provider of the bare host
// =============================================================================
//
// There is no vendor here: `createFakeTranscriptionProvider` from
// `@marinoscar/kvox-api/transcription/testing` answers a fixed transcript for
// any audio. `TranscriptionModule.forRoot({ extraProviders })` takes CLASSES (the
// container builds them), so a small class wraps the factory. The provider id
// is `fake`; it is selectable because the provider vocabulary is open (the
// `transcription` settings accept any registered id).
// =============================================================================

/** The id the `transcription` settings name. */
export const FAKE_PROVIDER_ID = 'fake';

/** What the fake provider "hears": two segments of one speaker. */
export const FAKE_TRANSCRIPT: NormalizedTranscript = {
  language: 'en',
  durationMs: 7000,
  speakers: [{ label: 'A' }],
  segments: [
    { speakerLabel: 'A', startMs: 0, endMs: 3000, text: 'Welcome to the bare host smoke test.', confidence: 0.99, words: [] },
    { speakerLabel: 'A', startMs: 3500, endMs: 7000, text: 'Every port is a small local implementation.', confidence: 0.98, words: [] },
  ],
  provider: { id: FAKE_PROVIDER_ID, model: null, remoteId: 'fake-remote-1' },
};

/** The fake provider as a class the container can build. */
export class BareHostTranscriptionProvider {
  constructor() {
    Object.assign(this, createFakeTranscriptionProvider({ id: FAKE_PROVIDER_ID, script: { transcript: FAKE_TRANSCRIPT } }));
  }
}

// The members arrive through `Object.assign`; the interface tells the compiler.
export interface BareHostTranscriptionProvider extends FakeTranscriptionProvider {}
