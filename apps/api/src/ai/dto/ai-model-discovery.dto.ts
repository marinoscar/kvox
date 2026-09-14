import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// `GET /api/ai-settings/models` — the wire shapes (issue #78, epic #45)
// =============================================================================
//
// The live model list, as read from the configured provider's own API with the
// CALLING ADMINISTRATOR'S key. `AiModelDiscoveryService`'s header carries the
// design; this file is the contract the admin page builds against.
//
// ⚠ NO FIELD HERE CAN CARRY A CREDENTIAL, and — unlike every other `/test`-
// shaped surface in this codebase — there is not even one to redact: the
// request has no body at all, and the response carries model ids and this
// application's own sentences. The key that made the call belongs to the user
// who made it and never leaves `UserAiCredentialsService`.
//
// ⚠ A REFUSED PROBE IS A 200 WITH `ok: false`, not a 4xx or 5xx — the
// `POST /api/transcription-settings/test` convention. The one thing a client
// must not do is treat a non-2xx as the only failure mode; read `ok`, and show
// `detail` either way.
// =============================================================================

/**
 * One model the provider reported.
 *
 * ⚠ `contextWindowTokens` AND `maxOutputTokens` ARE NULLABLE, AND THAT IS THE
 * WHOLE POINT OF THIS TYPE. No vendor's model list carries either number, so
 * `null` here means "the vendor did not say and this build has no descriptor" —
 * NOT "unlimited" and NOT "zero". A client offering such a model must collect
 * both numbers from the administrator before saving it into `allowedModels`,
 * because a model with no context window cannot be budgeted and would be saved,
 * listed back, and silently never offered to anyone.
 */
export const aiDiscoveredModelSchema = z.object({
  id: z
    .string()
    .describe("The provider's own model id, exactly as its API spelled it."),
  label: z
    .string()
    .describe(
      'A display name. Falls back to the id when this build has no better one — never a prettified guess.',
    ),
  known: z
    .boolean()
    .describe(
      'True when this build carries a descriptor for the model and can budget against it, so permitting it needs no further input. False means the two token numbers below are `null` and the administrator must supply them.',
    ),
  contextWindowTokens: z
    .number()
    .nullable()
    .describe(
      "The model's total context window when this build knows it, otherwise `null` — the vendor's list does not carry it.",
    ),
  maxOutputTokens: z
    .number()
    .nullable()
    .describe(
      'Most tokens the model will produce in one completion when this build knows it, otherwise `null`.',
    ),
});

export const aiModelDiscoverySchema = z.object({
  ok: z
    .boolean()
    .describe(
      'Whether the provider answered with a list. **False still comes back as HTTP 200** — a vendor refusing a key is a successful diagnosis, and `detail` says which of "the key is wrong", "the account has no credit" and "the endpoint is unreachable" happened.',
    ),
  detail: z
    .string()
    .describe(
      'A specific, actionable sentence, in both the success and the refusal case. Show it either way.',
    ),
  models: z
    .array(aiDiscoveredModelSchema)
    .describe(
      'Chat-capable models the calling administrator\'s key can reach, models this build already knows first and then alphabetically. **Empty whenever `ok` is false**, never partial. The list is filtered to plausible chat models as a convenience — an administrator can still permit any model id by hand, and that path never consults the filter.',
    ),
});

export class AiModelDiscoveryDto extends createZodDto(aiModelDiscoverySchema) {}

/**
 * The one query parameter.
 *
 * A FREE STRING RATHER THAN A `z.enum`, deliberately: an unknown value gets the
 * service's own 400, which names the providers this build actually implements.
 * A zod enum rejection would name the same ids in a validation-error shape that
 * says nothing about why an administrator might have expected the one they
 * typed to work.
 */
export const aiModelDiscoveryQuerySchema = z.object({
  provider: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Which provider to ask. Defaults to the active one. Naming a different provider lets an administrator inspect its catalogue before switching to it.',
    ),
});

export class AiModelDiscoveryQueryDto extends createZodDto(
  aiModelDiscoveryQuerySchema,
) {}
