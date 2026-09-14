import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AI_PROVIDER_IDS,
  AI_REASONING_EFFORTS,
  systemAiPatchSchema,
} from '../ai-settings.schema';

// =============================================================================
// AI settings — request and response bodies (issue #47, epic #45)
// =============================================================================
//
// DERIVED FROM `systemAiPatchSchema`, NOT RESTATED, exactly as
// `dto/transcription-settings.dto.ts` derives from
// `systemTranscriptionPatchSchema`: a rule that changes there — a widened token
// bound, a new provider id — changes here in the same edit. A restated copy is
// how a settings page starts accepting a value the reader rejects, which
// surfaces as "I saved it and nothing happened" with nothing in the response to
// explain it.
//
// ⚠ THERE IS NO `apiKey` FIELD ANYWHERE IN THIS FILE, and unlike the
// transcription DTOs there is not even a write-only one. Epic #45 has NO
// deployment AI key: every key belongs to an individual user and is written
// through `PUT /api/ai-credentials` into `user_ai_credentials`. A key accepted
// by any body here would be both a secret in a settings blob and the
// deployment-wide fallback credential docs/specs/notes.md §9 rejected outright.
// `ai-settings.schema.ts` carries the compile-time proof.
// =============================================================================

/** `PUT /api/ai-settings` — a partial update of the policy. */
export const updateAiSettingsSchema = systemAiPatchSchema;

export class UpdateAiSettingsDto extends createZodDto(updateAiSettingsSchema) {}

export type UpdateAiSettingsBody = z.infer<typeof updateAiSettingsSchema>;

/**
 * `POST /api/ai-settings/test` — the reachability probe body.
 *
 * ONE OPTIONAL FIELD, AND NO CREDENTIAL. `baseUrl` lets an administrator prove
 * a URL BEFORE saving it, which is the same "test what you typed, not what you
 * committed" workflow `POST /api/transcription-settings/test` exists for. There
 * is nothing else to send, because there is no deployment key — see
 * `AiSettingsService.testReachability` for why a **401 is a passing result** on
 * this endpoint.
 */
export const testAiReachabilitySchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(512)
    .nullish()
    .describe(
      'A base URL to probe instead of the stored one, for proving a URL before saving it.',
    ),
});

export class TestAiReachabilityDto extends createZodDto(
  testAiReachabilitySchema,
) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------
//
// Declared as zod schemas and wrapped by `createZodDto`, matching every other
// settings surface in this repository. `.describe()` on each field is what
// `@nestjs/swagger` renders as the property description — the zod equivalent of
// `@ApiProperty({ description })`, which is what CI's document lint reads.

/** One model a provider offers, as the admin catalogue publishes it. */
export const aiModelDescriptorSchema = z.object({
  id: z.string().describe("The provider's own model id, e.g. `gpt-4o`."),
  label: z.string().describe('Human name for the admin form.'),
  contextWindowTokens: z
    .number()
    .describe("The model's total context window, in tokens."),
  maxOutputTokens: z
    .number()
    .describe('Most tokens this model will produce in one completion.'),
});

/** What a provider can do, published so a form need not discover it by trying. */
export const aiProviderCapabilitiesSchema = z.object({
  models: z
    .array(aiModelDescriptorSchema)
    .describe(
      'Every model this build ships **verified** numbers for. Since issue #97 this is no longer the set of models that can be permitted: an id absent from it takes its family\'s numbers (a dated snapshot of one of these) or, failing that, `defaultModelLimits` below. It remains the only source that reports `source: "catalogue"`.',
    ),
  defaultModelLimits: z
    .object({
      contextWindowTokens: z.number(),
      maxOutputTokens: z.number(),
    })
    .optional()
    .describe(
      'The conservative floor applied to a chat model this provider has never heard of (issue #97) — a **lower bound**, not a guess at the model\'s real size, so no model is ever un-permittable for want of two numbers. Absent means this provider declines to have one, and ids it cannot otherwise place stay unresolvable. An administrator who knows the real numbers still outranks it: an entry\'s own `contextWindowTokens`/`maxOutputTokens` win over every other source.',
    ),
  modelDiscovery: z
    .boolean()
    .describe(
      'Whether this provider can be asked for its live model list (`GET /api/ai-settings/models`). False means the admin form must let an administrator type model ids by hand — which it always allows anyway.',
    ),
  streaming: z
    .literal(true)
    .describe(
      'Always true. Every registered provider streams; there is no non-streaming path, because the durable generation buffer has nothing to append otherwise.',
    ),
});

/** One admin-form field a provider needs. See `AiProviderFieldDescriptor`. */
export const aiProviderFieldDescriptorSchema = z.object({
  key: z.string().describe("Key within this provider's settings block."),
  label: z.string().describe('Human label for the control.'),
  type: z
    .enum(['text', 'select', 'number', 'boolean', 'string-list'])
    .describe('Which control to render.'),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional()
    .describe('Choices for `type: "select"`; absent otherwise.'),
  helpText: z.string().optional().describe('One sentence under the control.'),
  required: z.boolean().describe('Whether the field must be filled in.'),
  defaultValue: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional()
    .describe('What a fresh installation shows before anything is saved.'),
});

export const aiProviderDescriptionSchema = z.object({
  id: z
    .string()
    .describe('Stable provider id, used in settings, credentials and notes.'),
  label: z.string().describe('Human name for the admin form.'),
  capabilities: aiProviderCapabilitiesSchema,
  fieldDescriptors: z
    .array(aiProviderFieldDescriptorSchema)
    .describe('Drives the provider-specific half of the admin form.'),
});

/**
 * One entry of `allowedModels` as it is READ BACK (#78).
 *
 * ALWAYS AN OBJECT IN A RESPONSE, even for a deployment whose stored JSONB
 * still holds the pre-#78 bare strings: the schema normalises on the way in, so
 * a client has exactly one shape to render. The request side still accepts
 * both — see `UpdateAiSettingsDto`.
 */
export const aiAllowedModelResponseSchema = z.object({
  id: z.string().describe("The provider's own model id, e.g. `gpt-4o`."),
  label: z
    .string()
    .optional()
    .describe(
      'What a picker shows. Absent means "use the build catalogue\'s label, or the id".',
    ),
  contextWindowTokens: z
    .number()
    .optional()
    .describe(
      "This entry's own context window. It **overrides every other source** — the build catalogue included — so a deployment can correct a stale number without waiting for a release. Absent means the resolution chain answers instead: the exact catalogue entry, then the model's family (issue #97), then the provider's conservative floor. Only when none of those can answer is the model reported in `unknownModels` and never offered, which in practice means the policy names a provider this build does not implement.",
    ),
  maxOutputTokens: z
    .number()
    .optional()
    .describe(
      "This entry's own output ceiling, overriding every other source. Absent means the same chain answers, per field — an entry may supply one number and inherit the other.",
    ),
});

/**
 * `GET`/`PUT /api/ai-settings` — the response.
 *
 * ⚠ NO FIELD HERE CAN HOLD AN API KEY, and there is no masked key-status array
 * either (unlike the transcription response), because this deployment stores no
 * AI key at all. A user's own key status is `GET /api/ai-credentials`.
 */
export const aiSettingsResponseSchema = z.object({
  settings: z
    .object({
      enabled: z.boolean().describe('Master switch for AI features.'),
      provider: z
        .enum(AI_PROVIDER_IDS)
        .nullable()
        .describe(
          'The active provider, or `null` when none has been chosen. A separate axis from `enabled`, so switching AI off does not discard the vendor choice.',
        ),
      providers: z.object({
        openai: z.object({
          baseUrl: z
            .string()
            .describe('The API root this deployment calls.'),
          allowedModels: z
            .array(aiAllowedModelResponseSchema)
            .describe(
              "Models users may generate with. This deployment's only lever over which vendor models its content reaches — the key and the bill are each user's own. An entry may carry its own context window and output ceiling, which override everything else; since issue #97 it does not need to, because an id this build has no descriptor for takes its family's numbers or the provider's conservative floor. Up to 200 entries — a bound on the size of the stored settings blob, not a ration on models.",
            ),
          defaultModel: z.string().describe('The model offered first.'),
        }),
      }),
      maxInputTokens: z
        .number()
        .describe('Ceiling on the assembled prompt, in tokens.'),
      maxOutputTokens: z
        .number()
        .describe('Ceiling on one generation, in tokens.'),
      requestTimeoutMs: z
        .number()
        .describe('How long one provider request may take, in milliseconds.'),
      reasoningEffort: z
        .enum(AI_REASONING_EFFORTS)
        .describe(
          'How hard a reasoning model may think before it answers. `none` is the default and the vendor\'s own: the parameter is not sent at all, so a deployment that never sets this puts exactly the bytes on the wire it always did — which matters because `baseUrl` may point at an OpenAI-compatible gateway that has never heard of the parameter. ⚠ **Reasoning tokens are billed and counted as output tokens**, drawn from the same ceiling the visible answer uses (`maxOutputTokens`, capped by the model\'s own). At `high`, against the default `maxOutputTokens` of 16,384, a generation can spend most of its budget thinking and return a truncated note or almost nothing — arriving as a `length` finish reason, **not** as an error. Raising this does not raise `maxOutputTokens`, deliberately: that ceiling bounds what one generation may cost on the user\'s own account, and widening it is a separate decision an administrator takes on purpose.',
        ),
      maxDocumentBytes: z
        .number()
        .describe(
          'Ceiling on one uploaded note source document, in bytes. An AI policy rather than a storage one: every byte becomes input tokens on the uploading user\'s own vendor account, and `note.source.extract` must hold a whole PDF in memory to read it.',
        ),
    })
    .describe('The stored AI policy. Carries no secret, by construction.'),
  providers: z
    .array(aiProviderDescriptionSchema)
    .describe('Every registered provider, with its models and form fields.'),
  unknownModels: z
    .array(z.string())
    .describe(
      'Model ids the policy permits that **nothing** can supply a context window for — not the entry itself, not the build catalogue, not the family derivation, not the provider floor (issue #97). Normally empty: for a registered provider that declares a floor it cannot be populated at all, so a non-empty list almost always means the policy names a provider this build does not implement. Reported rather than silently dropped, because such a model is saved, listed back, and then never offered to a single user with nothing anywhere to explain why.',
    ),
  version: z
    .number()
    .describe('Bumped on every write. Send as `If-Match` on the next PUT.'),
  updatedAt: z.iso.datetime().nullable().describe('When settings last changed.'),
  updatedBy: z
    .object({ id: z.string(), email: z.string() })
    .nullable()
    .describe('Who last changed them.'),
});

export class AiSettingsResponseDto extends createZodDto(
  aiSettingsResponseSchema,
) {}

/** `POST /api/ai-settings/test` — the outcome of the reachability probe. */
export const aiReachabilityTestSchema = z.object({
  ok: z
    .boolean()
    .describe(
      'Whether the endpoint behaved like a correctly configured API root. **A 401/403 counts as success** — an unauthenticated request to a working endpoint is supposed to be refused, and that refusal proves it exists and speaks the protocol.',
    ),
  latencyMs: z.number().describe('Wall-clock milliseconds the probe took.'),
  detail: z
    .string()
    .describe(
      'A specific, actionable sentence — which of "unreachable", "wrong path" and "answering normally" happened.',
    ),
});

export class AiReachabilityTestDto extends createZodDto(
  aiReachabilityTestSchema,
) {}
