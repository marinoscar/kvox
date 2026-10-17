import { createFakeTranscriptionProvider, type FakeTranscriptionProvider } from '@marinoscar/kvox-api/transcription/testing';
import type { NormalizedTranscript, TranscriptionResult, TranscriptionSubmitResult } from '@marinoscar/kvox-api/transcription';

// =============================================================================
// The speech-to-text provider of the bare host
// =============================================================================
//
// There is no vendor here: `createFakeTranscriptionProvider` from
// `@marinoscar/kvox-api/transcription/testing` answers a scripted transcript for
// any audio. `TranscriptionModule.forRoot({ extraProviders })` takes CLASSES (the
// container builds them), so a small class wraps the factory. The provider id
// is `fake`; it is selectable because the provider vocabulary is open (the
// `transcription` settings accept any registered id).
//
// ONE SCRIPT PER UPLOAD. The happy path transcribes one recording with
// `FAKE_TRANSCRIPT`; the graph scenario (`graph-scenario.ts`) needs two more
// recordings that say different things. `queueFakeTranscript` puts a transcript
// in line: the next `submit` takes the head of the queue (or `FAKE_TRANSCRIPT`
// when it is empty) and pins it to the remote id it hands back, so `fetchResult`
// answers the transcript of THAT job however the jobs interleave. The queue is
// module state on purpose: the container builds the class, so a test cannot
// reach the instance before the first upload, and one process runs one host.
// =============================================================================

/** The id the `transcription` settings name. */
export const FAKE_PROVIDER_ID = 'fake';

/** What the fake provider "hears" by default: two segments of one speaker. */
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

/** Transcripts waiting for the next uploads, oldest first. */
const queued: NormalizedTranscript[] = [];

/**
 * Puts a transcript in line for the next upload the fake provider receives.
 * Without one, an upload is transcribed as {@link FAKE_TRANSCRIPT}.
 *
 * @param transcript - what the next submitted recording "says"; `provider` is overwritten.
 */
export function queueFakeTranscript(transcript: Omit<NormalizedTranscript, 'provider'>): void {
  queued.push({ ...transcript, provider: { id: FAKE_PROVIDER_ID, model: null, remoteId: '' } });
}

/** The fake provider as a class the container can build. */
export class BareHostTranscriptionProvider {
  constructor() {
    const base = createFakeTranscriptionProvider({ id: FAKE_PROVIDER_ID, script: { transcript: FAKE_TRANSCRIPT } });
    const byRemoteId = new Map<string, NormalizedTranscript>();
    let submitted = 0;

    Object.assign(this, base, {
      async submit(...args: Parameters<FakeTranscriptionProvider['submit']>): Promise<TranscriptionSubmitResult> {
        await base.submit(...args);
        submitted += 1;
        const remoteId = `fake-remote-${submitted}`;
        const next = queued.shift() ?? FAKE_TRANSCRIPT;
        byRemoteId.set(remoteId, { ...next, provider: { ...next.provider, remoteId } });
        return { remoteId };
      },
      async fetchResult(...args: Parameters<FakeTranscriptionProvider['fetchResult']>): Promise<TranscriptionResult> {
        const result = await base.fetchResult(...args);
        const normalized = byRemoteId.get(args[1]);
        return normalized ? { ...result, normalized } : result;
      },
    });
  }
}

// The members arrive through `Object.assign`; the interface tells the compiler.
export interface BareHostTranscriptionProvider extends FakeTranscriptionProvider {}
