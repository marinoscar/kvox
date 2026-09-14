import type { Readable } from 'node:stream';
import type { ZodType } from 'zod';

import type { NormalizedTranscript } from '../normalized-transcript';

// =============================================================================
// TranscriptionProvider (issue #23, epic #19)
// =============================================================================
//
// One interface, N vendors. Shaped after `email/providers/email-provider.interface.ts`
// — which is the precedent this repository already reads for "a pluggable
// third-party transport picked by a system setting" — with the differences that
// come from transcription being ASYNCHRONOUS AND EXPENSIVE rather than
// synchronous and cheap:
//
//   • `send` on an email provider MUST NOT THROW, because a notification fires
//     from the middle of a business action and must never fail it. Transcription
//     is the opposite: every method here runs inside a QUEUE JOB, where throwing
//     is the documented way to fail (`CLAUDE.md`, "Adding a Job Type"). So these
//     methods DO throw, and the taxonomy in `../errors.ts` is what decides what
//     a throw costs.
//
//   • Submission and result are separate round trips (`submit` → `getStatus` →
//     `fetchResult`), because a provider takes minutes and holds the work on its
//     side. That is also why `remoteId` exists at all, and why `deleteRemote` is
//     mandatory rather than optional: audio uploaded to a third party is data
//     this deployment is responsible for, and "the provider still has last
//     year's recordings" must not be the default outcome of an ingest.
//
// -----------------------------------------------------------------------------
// CAPABILITIES ARE DECLARED, NOT PROBED
// -----------------------------------------------------------------------------
//
// `capabilities` is a static description a caller can read BEFORE spending a
// request: the config endpoint publishes `maxInputBytes` so the browser can
// refuse a 12 GB file without uploading it first, and the admin form renders
// `diarization`/`languageDetection` as facts rather than as options that may or
// may not do anything. A capability that has to be discovered by trying is a
// capability the UI cannot describe.
//
// -----------------------------------------------------------------------------
// `ctx` CARRIES A SECRET AND MUST NEVER BE LOGGED
// -----------------------------------------------------------------------------
//
// Every method takes a `TranscriptionProviderContext` holding the resolved API
// key. It is built at the moment of use from `CredentialsService.getSecret`,
// passed down, and dropped. Do not store it on an instance field, do not put it
// in an error message, do not `JSON.stringify` it, and do not include it in a
// span attribute. The type below carries a compile-time note and a `toJSON`
// that makes an accidental serialisation harmless rather than catastrophic.
// =============================================================================

/**
 * What a provider can do, as a static, publishable description.
 *
 * EVERY FIELD IS REQUIRED. An optional capability flag reads as "unknown" at
 * every call site, and every call site then has to decide what unknown means —
 * which is how one of them decides wrongly. A provider that does not diarize
 * says `diarization: false`.
 */
export interface TranscriptionProviderCapabilities {
  /** Can it label who is speaking? */
  diarization: boolean;
  /** Does it return per-word start/end times? */
  wordTimestamps: boolean;
  /** Can it detect the language rather than being told it? */
  languageDetection: boolean;
  /** Does telling it how many speakers to expect actually change the result? */
  speakersExpectedHint: boolean;
  /** Can it fetch the audio itself from a URL we sign? */
  acceptsUrl: boolean;
  /** Can we push the bytes to it directly, for storage it cannot reach? */
  acceptsUpload: boolean;
  /** Hard input size ceiling, in bytes. */
  maxInputBytes: number;
  /** Hard media duration ceiling, in milliseconds. */
  maxDurationMs: number;
  /** MIME types it accepts, lowercase. */
  acceptedMimeTypes: string[];
  /** Can a submitted job's data be deleted from the provider afterwards? */
  remoteDelete: boolean;
  /** Can an in-flight job be cancelled? Pairs with the optional `cancel`. */
  cancel: boolean;
}

/**
 * One admin-form field a provider needs configured, described well enough for
 * the settings page to render it without knowing which provider it is.
 *
 * THE FORM IS DATA, NOT A COMPONENT PER PROVIDER. A second provider then costs
 * one descriptor array here and zero React files — which is the same promise
 * `ADMIN_SECTIONS` makes on the navigation axis and `NOTIFICATION_EVENTS` makes
 * on the notification axis.
 *
 * THE API KEY IS NOT ONE OF THESE. It is never a provider setting; it lives in
 * the encrypted credential store and the page renders it from a dedicated
 * masked control. A descriptor with `key: 'apiKey'` would put a secret into the
 * settings blob by the back door — see the compile-time proof in
 * `transcription-settings.schema.ts`.
 */
export interface ProviderFieldDescriptor {
  /** Key within this provider's settings object, e.g. `'region'`. */
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean';
  /** Required for `type: 'select'`, meaningless otherwise. */
  options?: Array<{ value: string; label: string }>;
  /** One sentence under the control. */
  helpText?: string;
  required: boolean;
  /** What a fresh installation shows before anything is saved. */
  defaultValue?: string | number | boolean | null;
}

/**
 * The per-call context: the resolved credential and this provider's settings.
 *
 * ⚠ CONTAINS A SECRET. See the file header. `toJSON` is declared so that the
 * most common accidental leak — a context reaching `JSON.stringify` through a
 * log serialiser or an error's `cause` — produces a marker string rather than
 * the key. It is a backstop, not permission: the rule is still "never log this".
 */
export interface TranscriptionProviderContext<TSettings = unknown> {
  /** Plaintext API key, valid for this call only. NEVER log or persist. */
  readonly apiKey: string;
  /** This provider's validated settings — the output of `settingsSchema.parse`. */
  readonly settings: TSettings;
}

/**
 * Build a context whose accidental serialisation is inert.
 *
 * The `toJSON` is non-enumerable so it does not show up in `Object.keys` or a
 * spread, and the object is frozen so a caller cannot remove it.
 */
export function createProviderContext<TSettings>(
  apiKey: string,
  settings: TSettings,
): TranscriptionProviderContext<TSettings> {
  const ctx = { apiKey, settings };

  Object.defineProperty(ctx, 'toJSON', {
    value: () => ({ apiKey: '[redacted]', settings }),
    enumerable: false,
  });

  return Object.freeze(ctx);
}

/** Where the audio comes from, for one submission. */
export type TranscriptionAudioSource =
  | {
      kind: 'url';
      /**
       * A URL the PROVIDER fetches. In this deployment that is a short-lived
       * presigned GET — the bytes never pass through the API, which is the same
       * data-plane rule the worker-node design follows.
       */
      url: string;
    }
  | {
      kind: 'stream';
      /** The bytes themselves, for storage the provider cannot reach. */
      stream: Readable;
      /** Exact byte length. Required: providers reject a chunked upload of unknown size. */
      size: number;
      mimeType: string;
    };

/** The language/diarization knobs for one submission. */
export interface TranscriptionOptions {
  /**
   * Language code to force, or `null`/absent to leave it to the provider.
   * MUTUALLY EXCLUSIVE WITH `detectLanguage` in practice — a provider told both
   * has to pick one, so the provider resolves the conflict explicitly rather
   * than sending both and hoping.
   */
  language?: string | null;
  /** Ask the provider to identify the language itself. */
  detectLanguage: boolean;
  /**
   * How many speakers to expect. A HINT, never a constraint: providers that
   * accept it use it to bias diarization, and `null` means "no opinion".
   * Ignored by providers whose `speakersExpectedHint` is false.
   */
  speakersExpected?: number | null;
}

/** One submission. */
export interface TranscriptionRequest {
  audio: TranscriptionAudioSource;
  options: TranscriptionOptions;
}

/** What `submit` returns: the provider's handle for this job. */
export interface TranscriptionSubmitResult {
  /** The provider's own id. Stored, and used by every later call. */
  remoteId: string;
}

/**
 * The provider-independent job lifecycle.
 *
 * FOUR STATES, NOT THE PROVIDER'S OWN. AssemblyAI says `queued|processing|
 * completed|error`; another vendor says `pending|running|done|failed`. Mapping
 * at the provider boundary means the poller has one `switch` that a new
 * provider cannot widen.
 */
export type TranscriptionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

/** What `fetchResult` returns: the raw body AND the projection. */
export interface TranscriptionResult {
  /**
   * The provider's response exactly as received.
   *
   * STORED ALONGSIDE THE NORMALIZED FORM, because a normalization bug that
   * drops a field must be repairable from data already paid for rather than by
   * re-running the job.
   */
  raw: unknown;
  normalized: NormalizedTranscript;
}

/** The outcome of `testConnection` — always resolved, never thrown. */
export interface TranscriptionConnectionTest {
  ok: boolean;
  /** Wall-clock milliseconds the probe took, measured by the provider. */
  latencyMs: number;
  /**
   * A SPECIFIC, ACTIONABLE sentence. "Connection failed" is not one: the whole
   * value of this endpoint is telling an administrator whether the key is
   * wrong, the region is wrong, or the network is down — three different fixes.
   */
  detail: string;
}

/**
 * A concrete transcription vendor.
 *
 * ## Every method except `testConnection` THROWS to fail.
 *
 * That is the opposite of `EmailProvider.send`, and deliberately so: these run
 * inside a queue job, where a thrown error is the documented failure channel
 * and a swallowed one is a job that reports success having done nothing. Throw
 * the narrowest type in `../errors.ts` that is true — `ProviderInputError` when
 * the provider blamed the input, `ProviderAuthError` when it refused the key,
 * `RateLimitError` when it throttled — and a plain `Error` for everything else,
 * which the queue treats as retryable.
 *
 * `testConnection` is the ONE exception and is a probe, not work: it reports a
 * failure as `{ ok: false, detail }` for exactly the reason
 * `POST /api/email-settings/test` returns 200 on a refused send — a refused
 * probe is a successful diagnosis, and it is the entire point of the call.
 */
export interface TranscriptionProvider<TSettings = unknown> {
  /** Stable id, used in settings, credentials and stored transcripts. PERMANENT. */
  readonly id: string;
  /** Human name for the admin form. */
  readonly label: string;
  readonly capabilities: TranscriptionProviderCapabilities;
  /** Validates this provider's own settings block. Never carries a secret. */
  readonly settingsSchema: ZodType<TSettings>;
  /** Drives the admin form. See {@link ProviderFieldDescriptor}. */
  readonly fieldDescriptors: ProviderFieldDescriptor[];

  /**
   * Probe the credential and the endpoint.
   *
   * NEVER THROWS — see the class note above. The `apiKey` on `ctx` may be one
   * the administrator has typed but NOT SAVED, which is the case this method
   * exists for: proving a key before committing it.
   */
  testConnection(
    ctx: TranscriptionProviderContext<TSettings>,
  ): Promise<TranscriptionConnectionTest>;

  /** Start a job. Returns the provider's handle for it. */
  submit(
    ctx: TranscriptionProviderContext<TSettings>,
    request: TranscriptionRequest,
  ): Promise<TranscriptionSubmitResult>;

  /** Where is it? Mapped to the four provider-independent states. */
  getStatus(
    ctx: TranscriptionProviderContext<TSettings>,
    remoteId: string,
  ): Promise<TranscriptionStatus>;

  /**
   * Fetch a COMPLETED job's result.
   *
   * Throws `ProviderInputError` when the provider reports the job failed for an
   * input reason — that is not an exceptional path, it is the documented way a
   * provider says "this audio cannot be transcribed".
   */
  fetchResult(
    ctx: TranscriptionProviderContext<TSettings>,
    remoteId: string,
  ): Promise<TranscriptionResult>;

  /**
   * Cancel an in-flight job.
   *
   * OPTIONAL, and its presence must agree with `capabilities.cancel` — the
   * registry asserts that, because a capability advertising a method that does
   * not exist is a `TypeError` at exactly the worst moment.
   */
  cancel?(
    ctx: TranscriptionProviderContext<TSettings>,
    remoteId: string,
  ): Promise<void>;

  /**
   * Delete this job and its audio from the provider.
   *
   * MANDATORY, not optional. Audio sent to a third party is this deployment's
   * responsibility, and a provider that genuinely cannot delete must say so in
   * `capabilities.remoteDelete` and implement this as an explicit throw — so
   * the inability is visible rather than absent.
   */
  deleteRemote(
    ctx: TranscriptionProviderContext<TSettings>,
    remoteId: string,
  ): Promise<void>;
}

/** The publishable description of one provider. See `registry.describeAll()`. */
export interface TranscriptionProviderDescription {
  id: string;
  label: string;
  capabilities: TranscriptionProviderCapabilities;
  fieldDescriptors: ProviderFieldDescriptor[];
}
