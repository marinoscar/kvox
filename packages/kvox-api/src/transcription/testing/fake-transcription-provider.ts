import { z } from 'zod';

import { ProviderAuthError, ProviderInputError, RateLimitError } from '../errors.js';
import type { NormalizedTranscript } from '../normalized-transcript.js';
import type {
  TranscriptionConnectionTest,
  TranscriptionProvider,
  TranscriptionProviderCapabilities,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionStatus,
  TranscriptionSubmitResult,
} from '../providers/transcription-provider.interface.js';
import { TRANSCRIPTION_THROTTLE_KEY } from '../../core/index.js';

// =============================================================================
// createFakeTranscriptionProvider (issue #492, epic #491)
// =============================================================================
//
// A scriptable `TranscriptionProvider` for the slices above this one: the
// transcripts pipeline's handlers (submit, poll, ingest) are tested against it
// with no network and no vendor fixture. It keeps a log of every call so a test
// can assert what the handler sent, and it never holds a key: the context it
// receives is recorded WITHOUT `apiKey`.
// =============================================================================

/**
 * The provider operations a script can make fail.
 *
 * @stability experimental
 */
export type FakeTranscriptionOperation = 'testConnection' | 'submit' | 'getStatus' | 'fetchResult' | 'deleteRemote' | 'cancel';

/**
 * How the fake provider fails.
 *
 * - `auth`: {@link ProviderAuthError}, the key was refused.
 * - `input`: {@link ProviderInputError}, the audio cannot be transcribed.
 * - `rate_limit`: {@link RateLimitError} against the transcription bucket.
 * - `transient`: a plain `Error`, which the queue retries.
 *
 * @stability experimental
 */
export type FakeTranscriptionFailure = 'auth' | 'input' | 'rate_limit' | 'transient';

/**
 * What the fake provider does.
 *
 * @stability experimental
 */
export interface FakeTranscriptionScript {
  /** The id `submit` returns. Default `fake-remote-1`. */
  remoteId?: string;
  /**
   * The states `getStatus` reports, one per call; the last repeats. Default
   * `['completed']`.
   */
  statuses?: TranscriptionStatus[];
  /** What `fetchResult` returns. Default: a one-segment, one-speaker transcript. */
  transcript?: NormalizedTranscript;
  /** Operations that fail, and how. An operation listed here fails on every call. */
  fail?: Partial<Record<FakeTranscriptionOperation, FakeTranscriptionFailure>>;
  /** The `Retry-After` a `rate_limit` failure carries, in milliseconds. */
  retryAfterMs?: number;
}

/**
 * Options of {@link createFakeTranscriptionProvider}.
 *
 * @stability experimental
 */
export interface FakeTranscriptionProviderOptions {
  /** The provider id. Default `fake`. Permanent once transcripts reference it. */
  id?: string;
  /** The scripted behaviour. */
  script?: FakeTranscriptionScript;
  /** Capability overrides. */
  capabilities?: Partial<TranscriptionProviderCapabilities>;
}

/**
 * One call the fake saw.
 *
 * @stability experimental
 */
export interface FakeTranscriptionCall {
  /** Which operation. */
  operation: FakeTranscriptionOperation;
  /** The settings of the context it received. The key is never recorded. */
  settings: unknown;
  /** The remote id argument, for the operations that take one. */
  remoteId?: string;
  /** The request, for `submit`. */
  request?: TranscriptionRequest;
}

/**
 * The fake provider, with its call log.
 *
 * @stability experimental
 */
export interface FakeTranscriptionProvider extends TranscriptionProvider<Record<string, never>> {
  /** Every call, in order. */
  readonly calls: FakeTranscriptionCall[];
}

/** A transcript with one speaker and one segment. */
function defaultTranscript(id: string): NormalizedTranscript {
  return {
    language: 'en',
    durationMs: 2000,
    speakers: [{ label: 'A' }],
    segments: [
      {
        speakerLabel: 'A',
        startMs: 0,
        endMs: 2000,
        text: 'Hello from the fake provider.',
        confidence: 0.99,
        words: [],
      },
    ],
    provider: { id, model: null, remoteId: 'fake-remote-1' },
  };
}

/**
 * Builds a fake provider for tests of the slices that call providers.
 *
 * @example
 * ```ts
 * const provider = createFakeTranscriptionProvider({
 *   script: { statuses: ['processing', 'completed'], fail: { deleteRemote: 'transient' } },
 * });
 * ```
 *
 * @param options - id, script and capability overrides.
 * @returns the provider; register it with the provider registry.
 * @stability experimental
 */
export function createFakeTranscriptionProvider(
  options: FakeTranscriptionProviderOptions = {},
): FakeTranscriptionProvider {
  const id = options.id ?? 'fake';
  const script = options.script ?? {};
  const calls: FakeTranscriptionCall[] = [];
  let statusIndex = 0;

  const maybeFail = (operation: FakeTranscriptionOperation): void => {
    const mode = script.fail?.[operation];
    if (mode === undefined) return;
    if (mode === 'auth') throw new ProviderAuthError(`The fake provider refused the key (${operation}).`, id);
    if (mode === 'input') throw new ProviderInputError(`The fake provider rejected the input (${operation}).`, 'scripted', id);
    if (mode === 'rate_limit') {
      throw new RateLimitError(TRANSCRIPTION_THROTTLE_KEY, script.retryAfterMs, `The fake provider is rate-limited (${operation}).`);
    }
    throw new Error(`The fake provider failed transiently (${operation}).`);
  };

  const record = (
    operation: FakeTranscriptionOperation,
    ctx: { settings: unknown },
    extra: Partial<FakeTranscriptionCall> = {},
  ): void => {
    calls.push({ operation, settings: ctx.settings, ...extra });
  };

  return {
    id,
    label: `Fake (${id})`,
    capabilities: {
      diarization: true,
      wordTimestamps: false,
      languageDetection: true,
      speakersExpectedHint: false,
      acceptsUrl: true,
      acceptsUpload: true,
      maxInputBytes: 1024 ** 3,
      maxDurationMs: 60 * 60 * 1000,
      acceptedMimeTypes: ['audio/mpeg', 'audio/wav'],
      remoteDelete: true,
      cancel: false,
      keyterms: null,
      ...options.capabilities,
    },
    settingsSchema: z.object({}),
    fieldDescriptors: [],
    calls,

    async testConnection(ctx): Promise<TranscriptionConnectionTest> {
      record('testConnection', ctx);
      try {
        maybeFail('testConnection');
      } catch (error) {
        return { ok: false, latencyMs: 0, detail: error instanceof Error ? error.message : 'The fake probe failed.' };
      }
      return { ok: true, latencyMs: 1, detail: 'The fake provider answered.' };
    },

    async submit(ctx, request): Promise<TranscriptionSubmitResult> {
      record('submit', ctx, { request });
      maybeFail('submit');
      return { remoteId: script.remoteId ?? 'fake-remote-1' };
    },

    async getStatus(ctx, remoteId): Promise<TranscriptionStatus> {
      record('getStatus', ctx, { remoteId });
      maybeFail('getStatus');
      const statuses = script.statuses ?? ['completed'];
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return status;
    },

    async fetchResult(ctx, remoteId): Promise<TranscriptionResult> {
      record('fetchResult', ctx, { remoteId });
      maybeFail('fetchResult');
      const normalized = script.transcript ?? defaultTranscript(id);
      return { raw: { fake: true, remoteId }, normalized };
    },

    async deleteRemote(ctx, remoteId): Promise<void> {
      record('deleteRemote', ctx, { remoteId });
      maybeFail('deleteRemote');
    },
  };
}
