import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  systemTranscriptionPatchSchema,
  TRANSCRIPTION_PROVIDER_IDS,
} from '../transcription-settings.schema';

// =============================================================================
// Transcription settings — request and response bodies (issue #23, epic #19)
// =============================================================================
//
// DERIVED FROM `systemTranscriptionPatchSchema`, NOT RESTATED, exactly as
// `update-email-settings.dto.ts` derives from `emailSettingsSchema`: a rule
// that changes there — a tightened bitrate range, a new provider id — changes
// here in the same edit. A restated copy is how a settings page starts
// accepting a value the reader rejects, which surfaces as "I saved it and
// nothing happened" with nothing in the response to explain it.
//
// -----------------------------------------------------------------------------
// `apiKey` IS THE ONLY ADDITION, AND IT IS WRITE-ONLY
// -----------------------------------------------------------------------------
//
// It exists on the REQUEST and on nothing else. It is never in
// `systemTranscriptionSchema` (that file carries a compile-time proof of its
// absence), never in the persisted namespace — the service destructures it off
// before building the patch — and never in any response schema below, each of
// which carries its own proof by construction: there is no field able to hold
// it.
//
// So the value's entire lifetime is: request body → service →
// `CredentialsService.setSecret` → AES-GCM ciphertext in `credentials.secret`.
// There is no branch on which it can travel back out.
//
// -----------------------------------------------------------------------------
// BLANK PRESERVES — DO NOT "NORMALISE" THE KEY
// -----------------------------------------------------------------------------
//
// The form renders the key box EMPTY, because the stored value is unreadable by
// design. An empty submission therefore means "keep what is stored" and can
// never mean "erase it" — erasing is `DELETE .../credentials/:provider`.
//
// That contract is easy to defeat from here and every way of doing it looks
// like tidying up: `.trim()` turns a key whose surrounding whitespace matters
// into a different key; `.min(1)` turns an ordinary save into a 400 for an
// administrator who cannot see the value they would have to retype;
// `.default('')` turns "absent" into a value. So: `z.string()` with a ceiling
// and nothing else, `.nullish()` because a JSON body deserialises an omitted
// field to `undefined` and a cleared one to `null` and the administrator means
// the same thing by both.
// =============================================================================

/**
 * Length ceiling on a submitted key.
 *
 * Generous — provider keys are typically 32-64 characters, and some vendors
 * issue JWT-shaped credentials of several hundred. The bound exists to stop a
 * megabyte of junk reaching the cipher, not to validate a format this
 * application has no business knowing.
 */
const MAX_API_KEY_LENGTH = 4096;

export const updateTranscriptionSettingsSchema =
  systemTranscriptionPatchSchema.extend({
    /**
     * A new API key for the provider being saved.
     *
     * WRITE-ONLY. Blank, `null` or absent all mean "keep the stored key" — see
     * the header. There is no way to erase a key through this endpoint.
     */
    apiKey: z.string().max(MAX_API_KEY_LENGTH).nullish(),
  });

export class UpdateTranscriptionSettingsDto extends createZodDto(
  updateTranscriptionSettingsSchema,
) {}

export type UpdateTranscriptionSettingsBody = z.infer<
  typeof updateTranscriptionSettingsSchema
>;

/**
 * `POST /api/transcription-settings/test` — the probe body.
 *
 * ALL THREE FIELDS MATTER, and the two optional ones are the point: an
 * administrator must be able to prove a key BEFORE saving it, and to prove it
 * against a region they have not saved either. Without them this endpoint could
 * only ever answer "is the thing I already committed working", which is the
 * less useful half of the question.
 */
export const testTranscriptionConnectionSchema = z.object({
  provider: z.enum(TRANSCRIPTION_PROVIDER_IDS),
  /** Region to probe, overriding the stored one for this call only. */
  region: z.string().trim().min(1).max(16).nullish(),
  /**
   * The key to probe with. Absent falls back to the stored key — which is how
   * "is what I saved last month still valid?" is asked.
   */
  apiKey: z.string().max(MAX_API_KEY_LENGTH).nullish(),
});

export class TestTranscriptionConnectionDto extends createZodDto(
  testTranscriptionConnectionSchema,
) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------
//
// Declared as zod schemas and wrapped by `createZodDto`, matching every other
// settings surface in this repository. `.describe()` on each field is what
// `@nestjs/swagger` renders as the property description in the OpenAPI document
// — the zod equivalent of `@ApiProperty({ description })`, which is what CI's
// document lint reads.

/**
 * The masked view of a stored provider key.
 *
 * EVERY FIELD IS NON-SECRET BY CONSTRUCTION. `hint` is the credential store's
 * own mask (`••••` plus at most four trailing characters, and nothing at all
 * below eight), derived on write by code that already holds the plaintext.
 * Nothing here can widen it, and no other part of the secret is representable
 * in this shape.
 */
export const providerKeyStatusSchema = z.object({
  providerId: z.string().describe('Which provider this key status describes.'),
  configured: z
    .boolean()
    .describe('Whether an API key is stored for this provider.'),
  hint: z
    .string()
    .nullable()
    .describe(
      'A masked hint such as `••••a1b2`, or null when nothing is stored. NEVER the key itself.',
    ),
  updatedAt: z
    .iso
    .datetime()
    .nullable()
    .describe('When the stored key was last written.'),
  updatedByUserId: z
    .string()
    .nullable()
    .describe('Who last wrote it; null when nothing is stored or that user was deleted.'),
});

/** One admin-form field a provider needs. See `ProviderFieldDescriptor`. */
export const providerFieldDescriptorSchema = z.object({
  key: z.string().describe("Key within this provider's settings block."),
  label: z.string().describe('Human label for the control.'),
  type: z
    .enum(['text', 'select', 'number', 'boolean'])
    .describe('Which control to render.'),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional()
    .describe('Choices for `type: "select"`; absent otherwise.'),
  helpText: z.string().optional().describe('One sentence under the control.'),
  required: z.boolean().describe('Whether the field must be filled in.'),
  defaultValue: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .optional()
    .describe('What a fresh installation shows before anything is saved.'),
});

/** What a provider can do, published so a client need not discover it by trying. */
export const providerCapabilitiesSchema = z.object({
  diarization: z.boolean().describe('Can it label who is speaking?'),
  wordTimestamps: z.boolean().describe('Does it return per-word timings?'),
  languageDetection: z
    .boolean()
    .describe('Can it identify the language rather than being told it?'),
  speakersExpectedHint: z
    .boolean()
    .describe('Does telling it how many speakers to expect change the result?'),
  acceptsUrl: z
    .boolean()
    .describe('Can it fetch the audio itself from a signed URL?'),
  acceptsUpload: z
    .boolean()
    .describe('Can the bytes be pushed to it directly?'),
  maxInputBytes: z.number().describe('Hard input size ceiling, in bytes.'),
  maxDurationMs: z
    .number()
    .describe('Hard media duration ceiling, in milliseconds.'),
  acceptedMimeTypes: z
    .array(z.string())
    .describe('MIME types it accepts, lowercase.'),
  remoteDelete: z
    .boolean()
    .describe('Can a submitted job and its audio be deleted from the provider?'),
  cancel: z.boolean().describe('Can an in-flight job be cancelled?'),
});

export const transcriptionProviderDescriptionSchema = z.object({
  id: z.string().describe('Stable provider id, used in settings and credentials.'),
  label: z.string().describe('Human name for the admin form.'),
  capabilities: providerCapabilitiesSchema,
  fieldDescriptors: z
    .array(providerFieldDescriptorSchema)
    .describe('Drives the provider-specific half of the admin form.'),
});

/**
 * `GET`/`PUT /api/transcription-settings` — the response.
 *
 * ⚠ NO FIELD HERE CAN HOLD AN API KEY. `settings` is the namespace, which
 * carries a compile-time proof of the same thing; `keyStatuses` is the masked
 * view above. Adding a key-bearing field would require adding it to one of
 * those two, and both refuse.
 */
export const transcriptionSettingsResponseSchema = z.object({
  settings: z
    .object({
      enabled: z.boolean().describe('Master switch for transcription.'),
      provider: z
        .enum(TRANSCRIPTION_PROVIDER_IDS)
        .nullable()
        .describe('The active provider, or null when none has been chosen.'),
      providers: z
        .object({
          assemblyai: z.object({
            region: z.enum(['us', 'eu']).describe('Which AssemblyAI region to call.'),
            speechModel: z
              .string()
              .describe(
                'Comma-separated, ordered list of AssemblyAI speech model ids sent as `speech_models`, e.g. `universal-3-5-pro, universal-2`. The retired `universal`/`best`/`nano`/`slam-1` ids resolve to that default.',
              ),
          }),
        })
        .describe('Per-provider configuration; every provider block is always present.'),
      audioDelivery: z
        .enum(['presigned_url', 'upload'])
        .describe(
          'How the audio reaches the provider: a signed URL it fetches (default), or bytes pushed from this deployment.',
        ),
      presignedUrlTtlMinutes: z
        .number()
        .describe('Lifetime of the signed GET handed to the provider, in minutes.'),
      deleteRemoteAfterIngest: z
        .boolean()
        .describe('Delete the job and its audio from the provider once the result is stored.'),
      defaultLanguage: z
        .string()
        .nullable()
        .describe('Language to request when a job names none; null asks the provider to detect it.'),
      transcodeNodeOffloadEnabled: z
        .boolean()
        .describe('May a worker node produce the playback rendition?'),
      abandonedUploadHours: z
        .number()
        .describe(
          'Hours a source upload may sit idle (no part batch or status poll) before its transcript is purged. 1-720.',
        ),
      playback: z.object({
        bitrateKbps: z
          .number()
          .describe('Target bitrate for the playback rendition, in kbit/s.'),
      }),
    })
    .describe('The stored transcription policy. Carries no secret, by construction.'),
  keyStatuses: z
    .array(providerKeyStatusSchema)
    .describe('One masked key status per registered provider, configured or not.'),
  providers: z
    .array(transcriptionProviderDescriptionSchema)
    .describe('Every registered provider, with its capabilities and form fields.'),
  version: z
    .number()
    .describe('Bumped on every write. Send as `If-Match` on the next PUT.'),
  updatedAt: z.iso.datetime().nullable().describe('When settings last changed.'),
  updatedBy: z
    .object({ id: z.string(), email: z.string() })
    .nullable()
    .describe('Who last changed them.'),
});

export class TranscriptionSettingsResponseDto extends createZodDto(
  transcriptionSettingsResponseSchema,
) {}

/** `POST /api/transcription-settings/test` — the outcome of the probe. */
export const transcriptionConnectionTestSchema = z.object({
  ok: z.boolean().describe('Whether the provider accepted the credential.'),
  latencyMs: z.number().describe('Wall-clock milliseconds the probe took.'),
  detail: z
    .string()
    .describe(
      'A specific, actionable sentence — which of "the key is wrong", "the region is wrong" and "the network is down" happened.',
    ),
});

export class TranscriptionConnectionTestDto extends createZodDto(
  transcriptionConnectionTestSchema,
) {}

/**
 * `GET /api/transcription/config` — what a NON-ADMIN client needs.
 *
 * A NARROW, PURPOSE-BUILT PROJECTION, for exactly the reason
 * `notification-config.dto.ts` gives about `GET /api/notifications/config`:
 * `GET /api/transcription-settings` is gated on `system_settings:read`, which
 * the seeded `viewer` and `contributor` roles do not hold — so the users the
 * capability governs are precisely the users who cannot read it. Granting them
 * `system_settings:read` instead would be one seed line and the wrong one: that
 * permission returns the WHOLE settings blob.
 *
 * IT CARRIES NO POLICY DETAIL. Not the region, not the model, not the delivery
 * mode, and certainly not the key — a capability probe hands out the
 * CAPABILITY, not the configuration behind it. What a client genuinely needs is
 * "may I offer this at all", "how big a file may I pick", and "which types".
 */
export const transcriptionConfigSchema = z.object({
  available: z
    .boolean()
    .describe(
      'True only when transcription is enabled, a provider is chosen, that provider is registered, and an API key is stored for it. A client should not offer transcription when this is false.',
    ),
  providerLabel: z
    .string()
    .nullable()
    .describe('Human name of the active provider, or null when none is usable.'),
  maxUploadBytes: z
    .number()
    .describe("The active provider's input size ceiling, in bytes. 0 when none is usable."),
  maxDurationMs: z
    .number()
    .describe("The active provider's duration ceiling, in milliseconds. 0 when none is usable."),
  acceptedExtensions: z
    .array(z.string())
    .describe('Lowercase file extensions including the dot, for a file picker\'s `accept`.'),
  acceptedMimeTypes: z
    .array(z.string())
    .describe('Lowercase MIME types the active provider accepts.'),
});

export class TranscriptionConfigDto extends createZodDto(
  transcriptionConfigSchema,
) {}

export type TranscriptionConfigResponse = z.infer<
  typeof transcriptionConfigSchema
>;
