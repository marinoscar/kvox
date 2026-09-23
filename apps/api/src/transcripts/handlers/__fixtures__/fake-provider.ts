// =============================================================================
// A fake transcription provider for the handler specs (issue #25)
// =============================================================================
//
// The acceptance criteria say "handler unit tests use a fake provider", and
// this is it: every method is a `jest.fn`, the capabilities are permissive by
// default, and nothing here reaches a network. Shared by the submit, poll and
// ingest specs so that a change to the provider interface breaks one file
// rather than three.
// =============================================================================

import { z } from 'zod';

import type { NormalizedTranscript } from '../../../transcription/normalized-transcript';
import type {
  TranscriptionProvider,
  TranscriptionProviderCapabilities,
} from '../../../transcription/providers/transcription-provider.interface';

export type FakeProvider = TranscriptionProvider<never> & {
  testConnection: jest.Mock;
  submit: jest.Mock;
  getStatus: jest.Mock;
  fetchResult: jest.Mock;
  cancel: jest.Mock;
  deleteRemote: jest.Mock;
};

export function fakeCapabilities(
  overrides: Partial<TranscriptionProviderCapabilities> = {},
): TranscriptionProviderCapabilities {
  return {
    diarization: true,
    wordTimestamps: true,
    languageDetection: true,
    speakersExpectedHint: true,
    acceptsUrl: true,
    acceptsUpload: true,
    maxInputBytes: 5_000_000_000,
    maxDurationMs: 10 * 60 * 60_000,
    acceptedMimeTypes: ['audio/mpeg', 'audio/mp4'],
    remoteDelete: true,
    cancel: true,
    keyterms: { maxTerms: 1000, maxWordsPerTerm: 6 },
    ...overrides,
  };
}

export function createFakeProvider(
  overrides: Partial<TranscriptionProviderCapabilities> = {},
): FakeProvider {
  return {
    id: 'fake',
    label: 'Fake Provider',
    capabilities: fakeCapabilities(overrides),
    settingsSchema: z.object({}),
    fieldDescriptors: [],
    testConnection: jest.fn(),
    submit: jest.fn().mockResolvedValue({ remoteId: 'remote-1' }),
    getStatus: jest.fn().mockResolvedValue('processing'),
    fetchResult: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    deleteRemote: jest.fn().mockResolvedValue(undefined),
  } as unknown as FakeProvider;
}

/** A small, complete `NormalizedTranscript` for the ingest spec. */
export function fakeNormalized(
  overrides: Partial<NormalizedTranscript> = {},
): NormalizedTranscript {
  return {
    language: 'en',
    durationMs: 120_000,
    speakers: [{ label: 'A' }, { label: 'B' }],
    segments: [
      {
        speakerLabel: 'A',
        startMs: 0,
        endMs: 2_000,
        text: 'Hello there.',
        confidence: 0.97,
        words: [
          { text: 'Hello', startMs: 0, endMs: 800, confidence: 0.99 },
          { text: 'there.', startMs: 820, endMs: 2_000, confidence: 0.95 },
        ],
      },
      {
        speakerLabel: 'B',
        startMs: 2_100,
        endMs: 4_000,
        text: 'General Kenobi.',
        confidence: 0.91,
        words: [
          { text: 'General', startMs: 2_100, endMs: 3_000, confidence: 0.9 },
          { text: 'Kenobi.', startMs: 3_050, endMs: 4_000, confidence: 0.92 },
        ],
      },
    ],
    provider: { id: 'fake', model: 'best', remoteId: 'remote-1' },
    ...overrides,
  };
}
