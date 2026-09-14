import { Inject, Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import type { Readable } from 'node:stream';

import { parseRetryAfterMs, RateLimitError } from '../../jobs/rate-limit.error';
import { ProviderAuthError, ProviderInputError } from '../errors';
import {
  collectSpeakers,
  splitLongSegments,
  type NormalizedSegment,
  type NormalizedTranscript,
  type NormalizedWord,
} from '../normalized-transcript';
import { TranscriptionProviderRegistry } from '../transcription-provider.registry';
import {
  ASSEMBLYAI_REGIONS,
  transcriptionProvidersSchema,
  type AssemblyAiRegion,
  type TranscriptionProvidersValue,
} from '../transcription-settings.schema';
import type {
  ProviderFieldDescriptor,
  TranscriptionConnectionTest,
  TranscriptionProvider,
  TranscriptionProviderCapabilities,
  TranscriptionProviderContext,
  TranscriptionRequest,
  TranscriptionStatus,
  TranscriptionSubmitResult,
  TranscriptionResult,
} from './transcription-provider.interface';

// =============================================================================
// AssemblyAI transcription provider (issue #23, epic #19)
// =============================================================================
//
// ⚠ RE-VERIFY BEFORE THIS EPIC IS DECLARED FINAL.
//
// Every vendor-specific constant below — the parameter NAMES on `POST
// /v2/transcript`, the `speech_model` ids, the size and duration LIMITS, the
// status vocabulary, and the units (`audio_duration` in SECONDS while word
// `start`/`end` are MILLISECONDS) — was written against AssemblyAI's published
// API as understood when this issue was implemented. Vendors change all of
// these without changing a version number. Before epic #19 ships, walk this
// file against the current AssemblyAI documentation and correct anything that
// has moved; `assemblyai.provider.spec.ts`'s fixtures pin the SHAPE this file
// expects, so a change there will show up as a failing normalization test
// rather than as a silent mis-parse in production.
//
// -----------------------------------------------------------------------------
// NODE'S BUILT-IN `fetch`, INJECTED
// -----------------------------------------------------------------------------
//
// No SDK and no new dependency. The vendor's API is four REST calls; an SDK
// would add a supply-chain surface, its own retry policy fighting the queue's,
// and its own error shapes for `../errors.ts` to re-derive the answer from.
//
// `fetch` arrives through the constructor rather than being referenced
// globally, so a test replaces it with a function instead of monkey-patching a
// global — which is what lets every error-mapping case below be asserted
// deterministically and offline.
//
// -----------------------------------------------------------------------------
// THE API KEY GOES IN `authorization` WITH NO `Bearer` PREFIX
// -----------------------------------------------------------------------------
//
// That is the vendor's scheme and it is easy to "fix" into a bearer token,
// which produces a 401 that looks exactly like a wrong key. `authHeaders` is
// the one place it is written, and it never logs its argument.
// =============================================================================

/** Base URL per region. `us` is the default region for a new account. */
const REGION_BASE_URLS: Record<AssemblyAiRegion, string> = {
  us: 'https://api.assemblyai.com',
  eu: 'https://api.eu.assemblyai.com',
};

/** 5 GiB. The vendor's documented input ceiling. */
const MAX_INPUT_BYTES = 5 * 1024 ** 3;

/** 10 hours. The vendor's documented duration ceiling. */
const MAX_DURATION_MS = 10 * 60 * 60 * 1000;

/**
 * MIME types this provider is told to accept.
 *
 * A CONSERVATIVE LIST, not the vendor's full matrix: it is published to the
 * browser by `GET /api/transcription/config` and used to populate a file
 * picker's `accept`, so a type on this list that the vendor rejects wastes an
 * upload, while one missing from it merely means a user picks a different
 * format. Erring toward the common containers is the cheaper mistake.
 */
const ACCEPTED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/mp3',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

/**
 * DI token for the `fetch` implementation.
 *
 * A TOKEN RATHER THAN A BARE DEFAULT PARAMETER, because `emitDecoratorMetadata`
 * records `Function` as the parameter's type and Nest then tries to resolve a
 * provider called `Function` — which fails at boot with a message that names
 * neither `fetch` nor this file. `@Optional() @Inject(...)` tells the container
 * to skip it, at which point TypeScript's own default parameter applies.
 */
export const ASSEMBLYAI_FETCH = Symbol('ASSEMBLYAI_FETCH');

/** The `fetch` shape this provider needs. Injected so tests replace it. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Readable | Uint8Array;
    duplex?: 'half';
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

/** The subset of `Response` this provider reads. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** AssemblyAI's own status vocabulary, as documented. */
type AssemblyAiStatus = 'queued' | 'processing' | 'completed' | 'error';

/** One word in an AssemblyAI utterance. `start`/`end` are MILLISECONDS. */
interface AssemblyAiWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
}

/** One diarized utterance. `start`/`end` are MILLISECONDS. */
interface AssemblyAiUtterance {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
  confidence?: unknown;
  words?: unknown;
}

/** The `GET /v2/transcript/{id}` body, as far as this provider reads it. */
interface AssemblyAiTranscript {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  /** SECONDS. Converted on the way into `NormalizedTranscript.durationMs`. */
  audio_duration?: unknown;
  language_code?: unknown;
  speech_model?: unknown;
  text?: unknown;
  utterances?: unknown;
  words?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Map one AssemblyAI word. Timings are already milliseconds; a missing or
 * non-numeric one becomes 0 rather than `NaN`, because `NaN` propagates into a
 * segment's `startMs` and then into a seek that silently does nothing.
 */
function normalizeWord(raw: AssemblyAiWord): NormalizedWord {
  return {
    text: asString(raw.text) ?? '',
    startMs: asFiniteNumber(raw.start) ?? 0,
    endMs: asFiniteNumber(raw.end) ?? 0,
    confidence: asFiniteNumber(raw.confidence),
  };
}

/**
 * Turn an AssemblyAI transcript body into the provider-independent shape.
 *
 * EXPORTED AND PURE, so the normalization is tested against recorded vendor
 * JSON with no network, no Nest container and no clock — see
 * `__fixtures__/assemblyai/`. Everything vendor-specific about the mapping
 * lives here: the seconds→milliseconds conversion, the `speaker` → `speakerLabel`
 * rename, and the fall back to `words[]` when a response carries no
 * `utterances[]` (which is what a non-diarized job returns).
 */
export function normalizeAssemblyAiTranscript(
  body: AssemblyAiTranscript,
  remoteId: string,
): NormalizedTranscript {
  const utterances = Array.isArray(body.utterances)
    ? (body.utterances as AssemblyAiUtterance[])
    : [];

  let segments: NormalizedSegment[];

  if (utterances.length > 0) {
    segments = utterances.map((utterance) => {
      const words = Array.isArray(utterance.words)
        ? (utterance.words as AssemblyAiWord[]).map(normalizeWord)
        : [];

      return {
        // The vendor's label verbatim (`"A"`, `"B"`). Renaming it to
        // `Speaker 1` here would bake a presentation choice into stored data
        // and make a UI unable to show what the provider actually said.
        speakerLabel: asString(utterance.speaker) ?? 'unknown',
        startMs: asFiniteNumber(utterance.start) ?? 0,
        endMs: asFiniteNumber(utterance.end) ?? 0,
        text: asString(utterance.text) ?? '',
        confidence: asFiniteNumber(utterance.confidence),
        words,
      };
    });
  } else {
    // NO DIARIZATION IN THIS RESPONSE. A job run with `speaker_labels` off, or
    // audio the vendor could not diarize, returns `words[]` and no
    // `utterances[]`. One segment carrying every word is the honest projection:
    // inventing speaker turns from pauses would be this application asserting
    // something the provider declined to.
    const words = Array.isArray(body.words)
      ? (body.words as AssemblyAiWord[]).map(normalizeWord)
      : [];

    segments =
      words.length > 0
        ? [
            {
              speakerLabel: 'unknown',
              startMs: words[0].startMs,
              endMs: words[words.length - 1].endMs,
              text: asString(body.text) ?? words.map((w) => w.text).join(' '),
              confidence: null,
              words,
            },
          ]
        : [];
  }

  // The ~45-second split. Applied once, here, at the end of every provider's
  // normalizer — see `normalized-transcript.ts` for why a speaker turn is not
  // a usable editing unit.
  const split = splitLongSegments(segments);

  // SECONDS → MILLISECONDS. The single most likely place for a vendor change to
  // go unnoticed, which is why the fixture tests assert a real number here.
  const durationSeconds = asFiniteNumber(body.audio_duration);

  return {
    language: asString(body.language_code),
    durationMs: durationSeconds === null ? 0 : Math.round(durationSeconds * 1000),
    speakers: collectSpeakers(split),
    segments: split,
    provider: {
      id: ASSEMBLYAI_PROVIDER_ID,
      model: asString(body.speech_model),
      remoteId,
    },
  };
}

/** This provider's id. Matches `TRANSCRIPTION_PROVIDER_IDS`. PERMANENT. */
export const ASSEMBLYAI_PROVIDER_ID = 'assemblyai';

type AssemblyAiSettings = TranscriptionProvidersValue['assemblyai'];

/**
 * THE SAME SCHEMA OBJECT the settings namespace uses, never a restatement.
 *
 * Declared here at module scope rather than inline on the class so it is
 * evaluated before the class body's property initialiser reads it — a `const`
 * below the class would be in its temporal dead zone at class-definition time
 * and throw a `ReferenceError` at import.
 */
const assemblyAiSettingsSchema = transcriptionProvidersSchema.shape.assemblyai;

@Injectable()
export class AssemblyAiProvider
  implements TranscriptionProvider<AssemblyAiSettings>, OnModuleInit
{
  readonly id = ASSEMBLYAI_PROVIDER_ID;

  readonly label = 'AssemblyAI';

  readonly capabilities: TranscriptionProviderCapabilities = {
    diarization: true,
    wordTimestamps: true,
    languageDetection: true,
    speakersExpectedHint: true,
    acceptsUrl: true,
    acceptsUpload: true,
    maxInputBytes: MAX_INPUT_BYTES,
    maxDurationMs: MAX_DURATION_MS,
    acceptedMimeTypes: ACCEPTED_MIME_TYPES,
    remoteDelete: true,
    // No documented cancel endpoint. Declared false rather than implemented as
    // a no-op: a UI that offers "cancel" and silently does nothing is worse
    // than one that does not offer it, and the registry refuses a provider
    // whose capability and method disagree.
    cancel: false,
  };

  /**
   * ⚠ THIS SCHEMA MUST STAY IDENTICAL TO
   * `transcriptionProvidersSchema.shape.assemblyai`.
   *
   * It is the SAME schema object, imported rather than restated, precisely so
   * the two cannot drift: the settings row and the provider must agree about
   * what a valid AssemblyAI configuration is, and a second copy is how they
   * stop agreeing.
   */
  readonly settingsSchema = assemblyAiSettingsSchema;

  readonly fieldDescriptors: ProviderFieldDescriptor[] = [
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: ASSEMBLYAI_REGIONS.map((region) => ({
        value: region,
        label: region === 'us' ? 'United States' : 'European Union',
      })),
      helpText:
        'An API key is issued for one region. A key from the other region is refused with the same 401 a wrong key produces — test the connection after changing this.',
      required: true,
      defaultValue: 'us',
    },
    {
      key: 'speechModel',
      label: 'Speech model',
      type: 'text',
      helpText:
        "The provider's model identifier, e.g. `universal`. Free text rather than a fixed list, so a model added by the vendor can be adopted without a release of this application.",
      required: true,
      defaultValue: 'universal',
    },
  ];

  private readonly logger = new Logger(AssemblyAiProvider.name);

  constructor(
    private readonly registry: TranscriptionProviderRegistry,
    /**
     * Node's built-in `fetch`, injected so tests replace it.
     *
     * Bound to `globalThis` at construction: an unbound `fetch` reference
     * throws `Illegal invocation` in some runtimes, and the failure looks like
     * a network error rather than like the mistake it is.
     */
    @Optional()
    @Inject(ASSEMBLYAI_FETCH)
    private readonly fetchImpl: FetchLike = ((
      input: string,
      init?: unknown,
    ) =>
      globalThis.fetch(input, init as RequestInit)) as unknown as FetchLike,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // Probe
  // ---------------------------------------------------------------------------

  /**
   * `GET /v2/transcript?limit=1` — the cheapest authenticated read the API
   * offers.
   *
   * NEVER THROWS. Every outcome is a `{ ok, latencyMs, detail }`, and the
   * `detail` is written to name the FIX rather than the symptom: a 401 says the
   * key is wrong *for this region*, because "wrong key" and "right key, wrong
   * region" are indistinguishable to the vendor and distinguishing them is the
   * administrator's job — so the message has to mention both.
   */
  async testConnection(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
  ): Promise<TranscriptionConnectionTest> {
    const startedAt = Date.now();
    const region = ctx.settings.region;

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl(region)}/v2/transcript?limit=1`,
        { method: 'GET', headers: this.authHeaders(ctx.apiKey) },
      );

      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        return {
          ok: true,
          latencyMs,
          detail: `Authenticated against the ${region.toUpperCase()} endpoint in ${latencyMs} ms.`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          latencyMs,
          detail:
            `The ${region.toUpperCase()} endpoint rejected this API key (HTTP ${response.status}). ` +
            'Either the key is wrong, or it belongs to the other region — an AssemblyAI key is ' +
            'issued for one region and is refused by the other in exactly this way.',
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          latencyMs,
          detail:
            'The key is valid but the account is currently rate-limited (HTTP 429). ' +
            'Nothing is wrong with the configuration; try again shortly.',
        };
      }

      if (response.status === 404) {
        return {
          ok: false,
          latencyMs,
          detail:
            `The ${region.toUpperCase()} endpoint returned HTTP 404 for a documented route. ` +
            'This usually means the base URL for this region is no longer correct.',
        };
      }

      return {
        ok: false,
        latencyMs,
        detail: `The ${region.toUpperCase()} endpoint returned HTTP ${response.status}: ${await this.safeBodySnippet(response)}`,
      };
    } catch (err) {
      // A TRANSPORT failure, not an API one: DNS, TLS, a refused connection, a
      // proxy in the way. Named distinctly because the fix is a network fix,
      // and reporting it as "invalid key" sends an administrator to rotate a
      // credential that was never the problem.
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail:
          `Could not reach ${this.baseUrl(region)} — ${err instanceof Error ? err.message : 'network error'}. ` +
          'The request never got an HTTP response, so this is a network or DNS problem rather than a credential one.',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Job lifecycle
  // ---------------------------------------------------------------------------

  /**
   * `POST /v2/transcript`.
   *
   * A STREAM SOURCE IS UPLOADED FIRST. `POST /v2/upload` returns an
   * `upload_url` that only this account can read, which is then passed as
   * `audio_url` — so both delivery modes converge on one submission body and
   * the caller's choice of delivery does not fork the rest of this method.
   */
  async submit(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    request: TranscriptionRequest,
  ): Promise<TranscriptionSubmitResult> {
    const audioUrl =
      request.audio.kind === 'url'
        ? request.audio.url
        : await this.uploadAudio(ctx, request.audio.stream, request.audio.size);

    const { language, detectLanguage, speakersExpected } = request.options;

    const body: Record<string, unknown> = {
      audio_url: audioUrl,
      speaker_labels: true,
      speech_model: ctx.settings.speechModel,
    };

    // LANGUAGE OR DETECTION, NEVER BOTH. The vendor rejects a request carrying
    // `language_code` and `language_detection: true` together, and resolving
    // that here — an explicit language wins — means a caller can pass a
    // `defaultLanguage` and `detectLanguage: true` from two different settings
    // without having to know they conflict.
    if (language) {
      body.language_code = language;
    } else if (detectLanguage) {
      body.language_detection = true;
    }

    if (typeof speakersExpected === 'number' && speakersExpected > 0) {
      body.speakers_expected = speakersExpected;
    }

    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings.region)}/v2/transcript`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(ctx.apiKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    await this.assertOk(response, 'submit a transcription job');

    const parsed = (await response.json()) as AssemblyAiTranscript;
    const remoteId = asString(parsed.id);

    if (!remoteId) {
      // Retryable by omission — a plain Error. A 2xx with no id is either a
      // vendor incident or an API change; both deserve another attempt before
      // the job is written off.
      throw new Error(
        'AssemblyAI accepted the submission but returned no transcript id.',
      );
    }

    return { remoteId };
  }

  /** `GET /v2/transcript/{id}`, mapped onto the four provider-independent states. */
  async getStatus(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    remoteId: string,
  ): Promise<TranscriptionStatus> {
    const body = await this.getTranscript(ctx, remoteId);

    switch (body.status as AssemblyAiStatus) {
      case 'queued':
        return 'queued';
      case 'processing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'error':
        return 'failed';
      default:
        // An UNRECOGNISED status is not a failure. Reporting it as `failed`
        // would abandon a job over a vocabulary the vendor widened; reporting
        // it as `processing` costs one more poll and self-corrects.
        this.logger.warn(
          `AssemblyAI returned an unrecognised status "${String(body.status)}" for transcript ${remoteId}; treating it as processing.`,
        );
        return 'processing';
    }
  }

  /**
   * `GET /v2/transcript/{id}` for a finished job, normalized.
   *
   * A `status: 'error'` BODY IS A `ProviderInputError`, not a retry. The vendor
   * ran the job and reported that the input cannot be transcribed; another
   * attempt is a second upload and a second charge for the same answer. The
   * vendor's `error` string travels verbatim, because "audio file is silent"
   * and "unsupported codec" need different fixes.
   */
  async fetchResult(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    remoteId: string,
  ): Promise<TranscriptionResult> {
    const body = await this.getTranscript(ctx, remoteId);

    if (body.status === 'error') {
      const providerMessage = asString(body.error) ?? 'no reason given';
      throw new ProviderInputError(
        `AssemblyAI could not transcribe this audio: ${providerMessage}`,
        providerMessage,
        this.id,
      );
    }

    if (body.status !== 'completed') {
      // Called out of order. A plain Error (retryable): the poller asking too
      // early is a scheduling bug, and the next attempt will find it finished.
      throw new Error(
        `AssemblyAI transcript ${remoteId} is not finished (status "${String(body.status)}").`,
      );
    }

    return {
      raw: body,
      normalized: normalizeAssemblyAiTranscript(body, remoteId),
    };
  }

  /** `DELETE /v2/transcript/{id}` — removes the transcript and its audio. */
  async deleteRemote(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    remoteId: string,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings.region)}/v2/transcript/${encodeURIComponent(remoteId)}`,
      { method: 'DELETE', headers: this.authHeaders(ctx.apiKey) },
    );

    // ALREADY GONE IS SUCCESS. The caller's goal is "this is not on the
    // vendor's servers", and a 404 means that goal is met — turning it into an
    // error would make a retried ingest fail on its cleanup step.
    if (response.status === 404) return;

    await this.assertOk(response, `delete transcript ${remoteId}`);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private baseUrl(region: AssemblyAiRegion): string {
    return REGION_BASE_URLS[region] ?? REGION_BASE_URLS.us;
  }

  /**
   * The vendor's auth scheme: the raw key in `authorization`, NO `Bearer`.
   *
   * NEVER LOGS ITS ARGUMENT, and nothing else in this file may either.
   */
  private authHeaders(apiKey: string): Record<string, string> {
    return { authorization: apiKey };
  }

  /**
   * `POST /v2/upload` — push the bytes for storage the vendor cannot reach.
   *
   * `duplex: 'half'` is REQUIRED when a `Readable` is the body: undici refuses a
   * streaming request body without it, with an error that names neither
   * streaming nor duplex. `content-length` is sent because the endpoint rejects
   * a chunked body of unknown size, which is why
   * `TranscriptionAudioSource.stream` carries an exact `size`.
   */
  private async uploadAudio(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    stream: Readable,
    size: number,
  ): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings.region)}/v2/upload`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(ctx.apiKey),
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        body: stream,
        duplex: 'half',
      },
    );

    await this.assertOk(response, 'upload audio');

    const parsed = (await response.json()) as { upload_url?: unknown };
    const uploadUrl = asString(parsed.upload_url);

    if (!uploadUrl) {
      throw new Error(
        'AssemblyAI accepted the upload but returned no upload_url.',
      );
    }

    return uploadUrl;
  }

  private async getTranscript(
    ctx: TranscriptionProviderContext<AssemblyAiSettings>,
    remoteId: string,
  ): Promise<AssemblyAiTranscript> {
    const response = await this.fetchImpl(
      `${this.baseUrl(ctx.settings.region)}/v2/transcript/${encodeURIComponent(remoteId)}`,
      { method: 'GET', headers: this.authHeaders(ctx.apiKey) },
    );

    await this.assertOk(response, `read transcript ${remoteId}`);

    return (await response.json()) as AssemblyAiTranscript;
  }

  /**
   * Turn a non-2xx response into the right error from `../errors.ts`.
   *
   * THE MAPPING, AND WHY EACH ONE:
   *
   *   401/403 → `ProviderAuthError`. Retrying cannot help; an administrator
   *     must fix the key or the region. The message names BOTH possibilities
   *     because the vendor cannot tell them apart either.
   *   429 → `RateLimitError`, honouring `Retry-After` in both RFC 9110 forms
   *     (delta-seconds and HTTP-date) via the queue's own `parseRetryAfterMs`.
   *     NOT a new parser: the deferral path already has one, and a second
   *     would be a second thing that can disagree about what a date means.
   *   everything else → a plain `Error`, which the queue retries. That
   *     deliberately includes 4xx codes this method does not name: a 400 from
   *     a parameter the vendor renamed is a bug in this file, and burning the
   *     attempt budget is how it becomes visible in `lastError` rather than
   *     silently terminal.
   *
   * ⚠ THE BODY SNIPPET IS BOUNDED. A vendor error body can be large, and it
   * ends up in `Job.lastError` and in a log line; 500 characters is enough to
   * identify the problem and small enough not to fill a column with HTML.
   */
  private async assertOk(
    response: FetchLikeResponse,
    what: string,
  ): Promise<void> {
    if (response.ok) return;

    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(
        `AssemblyAI refused the API key (HTTP ${response.status}) when trying to ${what}. ` +
          'Check the key and that it belongs to the configured region.',
        this.id,
      );
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get('retry-after'),
      );

      throw new RateLimitError(
        `AssemblyAI rate-limited the request to ${what} (HTTP 429).`,
        // `?? undefined`, never `?? 0`: `parseRetryAfterMs` returns `null` for
        // "the provider said nothing", and zero would be read downstream as
        // "retry immediately", which is the one thing a throttled caller must
        // not do.
        retryAfterMs ?? undefined,
      );
    }

    throw new Error(
      `AssemblyAI returned HTTP ${response.status} when trying to ${what}: ${await this.safeBodySnippet(response)}`,
    );
  }

  /**
   * A bounded, never-throwing excerpt of an error body.
   *
   * `text()` can itself reject (a truncated response, an aborted stream), and a
   * throw from inside error-reporting replaces a useful message with a useless
   * one. Degrading to a fixed string keeps the original status code, which is
   * the part that matters.
   */
  private async safeBodySnippet(response: FetchLikeResponse): Promise<string> {
    try {
      const text = await response.text();
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      return '(response body unavailable)';
    }
  }
}
