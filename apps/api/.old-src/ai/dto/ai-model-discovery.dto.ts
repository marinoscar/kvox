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
 * ⚠ THE TWO TOKEN NUMBERS ARE NOW FILLED FOR EVERY MODEL A PROVIDER CAN PLACE
 * (issue #97), where before they were `null` for every id absent from this
 * build's catalogue. No vendor's model list carries either number, so they come
 * from the same resolution chain the save path and the token budget use: the
 * exact catalogue entry, then the model's family (a dated snapshot such as
 * `gpt-5.4-mini-2026-03-17` takes `gpt-5.4-mini`'s window), then the provider's
 * conservative floor. `source` says which rank answered.
 *
 * ⚠ THEY REMAIN NULLABLE, and `null` still means "nothing could answer" — NOT
 * "unlimited" and NOT "zero". It is now reachable only for a provider that
 * declares no floor, and a client offering such a model must still collect both
 * numbers from the administrator before saving it into `allowedModels`.
 *
 * ⚠ THE OLD SUPERSEDED RULE: "a model with `known: false` needs both numbers
 * typed before it can be permitted." That has not been true since #97 — a
 * client that still enforces it refuses models the server would accept. `known`
 * itself is unchanged and still means an exact catalogue hit; it is `source`
 * that says how much is knowledge.
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
      'True when this build carries a **verified** descriptor for this exact model id. Unchanged since issue #78 — and deliberately **not** widened to mean "permittable", which every model with non-null numbers below now is. Equivalent to `source === "catalogue"`; read `source` for the finer answer.',
    ),
  contextWindowTokens: z
    .number()
    .nullable()
    .describe(
      "The model's total context window, detected automatically: this build's verified number, else its family's, else the provider's conservative floor (issue #97). `null` only when the provider can answer none of those — it never means unlimited.",
    ),
  maxOutputTokens: z
    .number()
    .nullable()
    .describe(
      'Most tokens the model will produce in one completion, detected the same way and `null` under the same single condition.',
    ),
  source: z
    .enum(['catalogue', 'derived', 'default'])
    .describe(
      'Which rank of the resolution chain supplied the two numbers (issue #97), and the **weakest** of the two: `catalogue` — verified for this exact id; `derived` — taken from the family named in `derivedFrom`, the id being a dated snapshot of it; `default` — the provider\'s conservative floor, because nothing better was available. All three are permittable with one click, and all three can be overridden per model by typing real numbers into the policy entry, which outranks every rank here. Show the difference rather than hiding it: a floor is a lower bound, not a measurement.',
    ),
  derivedFrom: z
    .string()
    .nullable()
    .describe(
      'The catalogue model id the numbers were inferred from, non-null exactly when `source` is `derived` — so the dialog can say which model was assumed.',
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
      'Models the calling administrator\'s key can reach, ordered by how well this build knows each one — verified first, then models whose numbers were derived from a family, then models on the provider floor, alphabetically within each group. **Empty whenever `ok` is false**, never partial. The list is filtered to plausible chat models as a convenience; pass `includeAll=true` for the provider\'s whole list, and note that permitting a model id by hand never consults the filter either.',
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

  /**
   * `z.enum(['true','false']).transform(...)`, NEVER `z.coerce.boolean()`.
   *
   * Every query parameter arrives as a string and `Boolean('false')` is `true`,
   * so a coercing schema would turn the explicit opt-OUT `?includeAll=false`
   * into the opt-IN. The same shape as `jobs/dto/job-list-query.dto.ts` and
   * `users/dto/user-list-query.dto.ts`.
   */
  includeAll: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe(
      'Return every model the provider listed, skipping the plausible-chat-model filter (issue #97). The filter is a convenience over a flat vendor list with no capability field, so it is wrong occasionally; this is the escape hatch that keeps it from ever being the reason a working model cannot be found.',
    ),
});

export class AiModelDiscoveryQueryDto extends createZodDto(
  aiModelDiscoveryQuerySchema,
) {}
