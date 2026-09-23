import { z } from 'zod';

// =============================================================================
// Transcription settings — shape and validation (issue #23, epic #19)
// =============================================================================
//
// The admin-configurable half of transcription: which vendor, which region and
// model, how the audio reaches the vendor, and what happens to it afterwards.
// Everything here is ORDINARY CONFIGURATION and is safe to return from an admin
// endpoint.
//
// THE PROVIDER API KEY IS NOT HERE, AND MUST NEVER BE ADDED. It lives in the
// encrypted credential store (#115, epic #108) at
// `(purpose 'transcription', name '<providerId>')` — see
// `transcription-credential.constants.ts`. The reason is mechanical, not
// stylistic: this object is persisted as a settings blob and returned wholesale
// by the settings endpoints, so a secret in it is one careless response away
// from exposure, and "blank preserves" on an admin form would have to be
// reimplemented here (badly) instead of being inherited from
// `CredentialsService`, which already enforces it. There is a compile-time proof
// of the absence at the bottom of this file.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A NAMESPACE OF THE `global` ROW AND NOT A ROW OF ITS OWN
// -----------------------------------------------------------------------------
//
// Email settings (#122) took a `system_settings` row of their own, because the
// `email` key would otherwise have been eaten by `SystemSettingsService`'s
// schema-driven rebuild. That argument applies to a key the schema does NOT
// model. This one IS modelled: it is registered in
// `common/schemas/settings.schema.ts` alongside `jobs`, `nodes`,
// `databaseBackup` and `maintenance`, which means the merge carries it, the
// parity guard checks it, and the degraded read fills it from
// `DEFAULT_SYSTEM_SETTINGS`. `databaseBackup` is the worked precedent all the
// way down to its own dedicated controller (`/api/admin/db-backup/config`)
// writing through `SystemSettingsService.patchSettings` — which is exactly what
// `TranscriptionSettingsService` does.
//
// ⚠ A NAMESPACE COSTS SIX EDITS, NOT ONE. See the header of
// `common/schemas/settings-parity.spec.ts`; missing #3 or #4 makes every PATCH
// a silent no-op that returns 200.
//
// NO `.default()` ANYWHERE IN THIS FILE, matching the rest of that row: the
// defaults live in `common/types/settings.types.ts` and nowhere else, so "what
// does a fresh deployment do?" is a question answered by reading one object
// rather than by finding which `parse` ran first.
// =============================================================================

/**
 * Providers this build can be configured to use.
 *
 * Derived type below rather than a hand-written union, exactly as
 * `EMAIL_PROVIDER_KINDS` does, so adding one widens every `switch` in the same
 * edit instead of silently falling through.
 *
 * ⚠ A VALUE HERE IS PERMANENT ONCE TRANSCRIPTS REFERENCE IT. It is stored in
 * `NormalizedTranscript.provider.id` and is the credential store's `name`, so
 * renaming one orphans both.
 */
export const TRANSCRIPTION_PROVIDER_IDS = ['assemblyai'] as const;

/** A configurable transcription provider. See {@link TRANSCRIPTION_PROVIDER_IDS}. */
export type TranscriptionProviderId =
  (typeof TRANSCRIPTION_PROVIDER_IDS)[number];

/** AssemblyAI's two API regions. See `providers/assemblyai.provider.ts`. */
export const ASSEMBLYAI_REGIONS = ['us', 'eu'] as const;

export type AssemblyAiRegion = (typeof ASSEMBLYAI_REGIONS)[number];

/**
 * How the audio reaches the provider.
 *
 *   `presigned_url` — the provider fetches it from object storage using a
 *     short-lived signed GET. THE DEFAULT, and the only one where the bytes
 *     never pass through this API: the same data-plane rule the worker-node
 *     design follows, for the same reason (an API server is not a proxy).
 *   `upload` — this deployment streams the bytes to the provider's upload
 *     endpoint. For object storage the provider cannot reach: a private
 *     endpoint, a VPC-only bucket, a MinIO instance with no public route.
 *
 * A DEPLOYMENT-WIDE SETTING rather than per-job, because which of the two works
 * is a property of the network between this deployment and the vendor, and that
 * does not vary from one recording to the next.
 */
export const AUDIO_DELIVERY_MODES = ['presigned_url', 'upload'] as const;

export type AudioDeliveryMode = (typeof AUDIO_DELIVERY_MODES)[number];

/**
 * Per-provider settings blocks.
 *
 * ONE KEY PER PROVIDER, ALL PRESENT, rather than a discriminated union keyed on
 * `provider`. Same argument `systemDatabaseBackupSchema` makes for keeping both
 * `dayOfWeek` and `dayOfMonth`: switching provider and switching back must not
 * lose the region and model an administrator already chose, and a PATCH that
 * changes only `provider` must not become invalid for failing to also carry the
 * new provider's whole block.
 */
export const transcriptionProvidersSchema = z.object({
  assemblyai: z.object({
    region: z.enum(ASSEMBLYAI_REGIONS),
    /**
     * The provider's model identifier, as a free string rather than an enum.
     *
     * DELIBERATELY NOT AN ENUM. Vendors add and retire model ids on their own
     * schedule; an enum here means a deployment cannot adopt a new model
     * without a release of this application, which is precisely the coupling a
     * runtime setting exists to avoid. The provider validates it by USING it —
     * an unknown id comes back as the vendor's own 4xx, which `testConnection`
     * and the job's `lastError` both surface verbatim.
     */
    speechModel: z.string().trim().min(1).max(64),
  }),
});

export type TranscriptionProvidersValue = z.infer<
  typeof transcriptionProvidersSchema
>;

/**
 * Playback preferences for the derived, streamable copy of the audio.
 *
 * Nested rather than flattened to `playbackBitrateKbps` because it is one
 * decision with more knobs coming (format, sample rate), and grouping now is
 * what lets a later UI render one control group without inventing a grouping
 * the API does not have — the same argument `jobs.history` makes.
 */
export const transcriptionPlaybackSchema = z.object({
  /**
   * Target bitrate for the playback rendition, in kbit/s.
   *
   * Bounded at 320 (the practical ceiling for lossy speech audio, above which
   * the file grows and nothing improves) and floored at 16 (below which speech
   * stops being intelligible, which makes the rendition useless for the
   * proof-reading it exists for).
   */
  bitrateKbps: z.number().int().min(16).max(320),
});

export type TranscriptionPlaybackValue = z.infer<
  typeof transcriptionPlaybackSchema
>;

/**
 * The `transcription` system-settings namespace.
 *
 * `enabled` and `provider` are SEPARATE AXES, exactly as they are for email: an
 * administrator can switch transcription off for a maintenance window, or
 * before a vendor migration, without losing the configuration they would
 * otherwise have to retype. `provider: null` is the state of every fresh
 * installation and is NULLABLE RATHER THAN OPTIONAL so that "nobody has chosen
 * one" is a persisted fact the settings page renders, not an absent key whose
 * meaning has to be guessed.
 */
export const systemTranscriptionSchema = z.object({
  /** Master switch. Nothing is submitted to any provider while this is false. */
  enabled: z.boolean(),

  /** The active provider, or `null` when none has been chosen. */
  provider: z.enum(TRANSCRIPTION_PROVIDER_IDS).nullable(),

  /** Per-provider configuration; every provider's block is always present. */
  providers: transcriptionProvidersSchema,

  /** How the audio reaches the provider. See {@link AUDIO_DELIVERY_MODES}. */
  audioDelivery: z.enum(AUDIO_DELIVERY_MODES),

  /**
   * Lifetime of the signed GET handed to the provider, in minutes.
   *
   * Six hours by default and bounded at 24. It has to outlive the provider's
   * whole queue-plus-processing time for a long recording — a URL that expires
   * while the vendor is still fetching produces a failure that looks like a
   * corrupt file — and there is no way to extend one after the fact. Bounded
   * anyway, because a signed URL is a bearer credential for the audio and
   * "forever" is not a TTL.
   */
  presignedUrlTtlMinutes: z.number().int().min(1).max(1440),

  /**
   * Delete the job and its audio from the provider once the result is stored.
   *
   * ON BY DEFAULT. Audio sent to a third party is this deployment's
   * responsibility; leaving it there indefinitely is a data-retention decision
   * nobody made. Turning it off is legitimate (a vendor whose dashboard an
   * operator wants to keep using for debugging), which is why it is a setting
   * and not a constant.
   */
  deleteRemoteAfterIngest: z.boolean(),

  /**
   * Language to request when a job does not name one, or `null` to ask the
   * provider to detect it.
   *
   * NULL MEANS DETECT, and that is why this is nullable rather than an empty
   * string: `''` would be a language code nobody has, and the provider would
   * have to guess what was meant.
   */
  defaultLanguage: z.string().trim().min(2).max(16).nullable(),

  /**
   * May a worker node perform the transcode to the playback rendition?
   *
   * A per-workload switch, exactly like `databaseBackup.nodeOffloadEnabled` and
   * for the same reason it is separate from `nodes.jobSecretBrokerEnabled`:
   * "are these machines inside the trust boundary at all" and "should THIS
   * workload leave the server" are different questions. Transcoding is CPU-hungry
   * and embarrassingly parallel, so this one defaults to TRUE where the backup's
   * defaults to false — a node doing this work needs a presigned URL and a CPU,
   * not a credential to the database.
   */
  transcodeNodeOffloadEnabled: z.boolean(),

  /**
   * Hours an upload may sit IDLE before its transcript is purged (issue #322).
   *
   * MEASURED FROM THE SOURCE UPLOAD'S LAST ACTIVITY, NOT FROM CREATION. The
   * clock is `storage_objects.updated_at` on the transcript's source object,
   * which every part-URL batch and every status poll refreshes — so an upload
   * that is actively being pushed is never killed, however many hours a
   * multi-gigabyte file takes on a slow link. Only an upload that has gone
   * quiet (a closed tab, a paused upload never resumed) for longer than this is
   * abandoned: `transcripts.housekeeping` soft-deletes the transcript and
   * queues `transcript.purge`, which aborts the multipart upload and frees the
   * object. A cancelled upload does not wait for this at all — the abort
   * endpoint purges it immediately.
   *
   * Three hours by default: long enough to survive a lunch break or a laptop
   * lid, short enough that the library does not fill with dead cards. Bounded
   * at 720 (thirty days), past which an idle upload is not "paused" in any
   * sense a person would recognise, and floored at 1 so a typo cannot purge an
   * upload between two part batches.
   */
  abandonedUploadHours: z.number().int().min(1).max(720),

  /** Playback rendition preferences. See {@link transcriptionPlaybackSchema}. */
  playback: transcriptionPlaybackSchema,
});

export type SystemTranscriptionValue = z.infer<typeof systemTranscriptionSchema>;

/**
 * PATCH counterpart — hand-written, one level deep.
 *
 * Exactly like `systemDatabaseBackupPatchSchema` and its siblings: zod v4
 * removed `deepPartial`, and the two nested blocks (`providers`, `playback`)
 * have to be optional both at the block level and field by field so that
 * `{ "transcription": { "playback": { "bitrateKbps": 96 } } }` is a legal body.
 */
export const systemTranscriptionPatchSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(TRANSCRIPTION_PROVIDER_IDS).nullable().optional(),
  providers: z
    .object({
      assemblyai: z
        .object({
          region: z.enum(ASSEMBLYAI_REGIONS).optional(),
          speechModel: z.string().trim().min(1).max(64).optional(),
        })
        .optional(),
    })
    .optional(),
  audioDelivery: z.enum(AUDIO_DELIVERY_MODES).optional(),
  presignedUrlTtlMinutes: z.number().int().min(1).max(1440).optional(),
  deleteRemoteAfterIngest: z.boolean().optional(),
  // `.nullable().optional()`, and the merge distinguishes the two with
  // `!== undefined` rather than `??` — `null` means "detect the language",
  // absent means "leave the setting alone". Collapsing them would make
  // switching back to detection impossible to express.
  defaultLanguage: z.string().trim().min(2).max(16).nullable().optional(),
  transcodeNodeOffloadEnabled: z.boolean().optional(),
  abandonedUploadHours: z.number().int().min(1).max(720).optional(),
  playback: z
    .object({
      bitrateKbps: z.number().int().min(16).max(320).optional(),
    })
    .optional(),
});

// -----------------------------------------------------------------------------
// Compile-time proof that no secret-bearing field crept in
// -----------------------------------------------------------------------------
//
// Mirrors the technique in `email/email-settings.schema.ts`, which in turn
// mirrors `credentials/interfaces/credential-info.interface.ts`. Adding
// `apiKey` (or any of the other names below) to the schema above — at the top
// level or inside `providers.assemblyai` — makes
// `TranscriptionSettingsCarriesNoSecret` resolve to `never` and this file stops
// compiling. A build break at the moment of the mistake, rather than a security
// review that has to notice a new optional string.
//
// BOTH LEVELS ARE CHECKED, and that is the difference from the email version:
// this namespace has a nested per-provider block, and `providers.assemblyai
// .apiKey` is by far the most natural place for somebody to put a key. A proof
// that only looked at the top level would miss the exact mistake it exists to
// prevent.
//
// If you are here because one of these lines went red: you are trying to put a
// secret into a settings blob. Use `CredentialsService` instead — see
// `transcription-credential.constants.ts` for the address.

type SecretFieldNames =
  | 'apiKey'
  | 'api_key'
  | 'key'
  | 'token'
  | 'secret'
  | 'password'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'authorization';

type CarriesNoSecret<T> =
  Extract<keyof T, SecretFieldNames> extends never ? true : never;

export type TranscriptionSettingsCarriesNoSecret =
  CarriesNoSecret<SystemTranscriptionValue>;

export type AssemblyAiSettingsCarryNoSecret = CarriesNoSecret<
  TranscriptionProvidersValue['assemblyai']
>;

export const TRANSCRIPTION_SETTINGS_CARRIES_NO_SECRET: TranscriptionSettingsCarriesNoSecret =
  true;

export const ASSEMBLYAI_SETTINGS_CARRY_NO_SECRET: AssemblyAiSettingsCarryNoSecret =
  true;
