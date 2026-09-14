import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// `GET /api/ai/config` — what a NON-ADMIN client needs (issue #47, epic #45)
// =============================================================================
//
// A NARROW, PURPOSE-BUILT PROJECTION, for exactly the reason
// `transcription-config.dto.ts` and `notification-config.dto.ts` give:
// `GET /api/ai-settings` is gated on `system_settings:read`, which the seeded
// `viewer` and `contributor` roles do not hold — so the users the capability
// governs are precisely the users who cannot read it. Granting them
// `system_settings:read` instead would be one seed line and the wrong one: that
// permission returns the WHOLE settings blob.
//
// IT CARRIES NO POLICY DETAIL BEYOND WHAT A CLIENT MUST ACT ON. Not the base
// URL, not the request timeout, not `unknownModels`, and — needless to say —
// nothing derived from anyone's API key beyond the boolean fact that the
// CALLER has one.
//
// ⚠ `keyConfigured` IS THE SINGLE BOOLEAN THE ENTIRE WEB UI GATES ON (issue
// #47). Every AI surface in epic #45 reads it and nothing else to decide
// whether to render the key prompt instead of the feature. Two things follow:
// it is PER-CALLER, not per-deployment, and it is INDEPENDENT of `available` —
// see `ai-config.service.ts`'s header for why folding them together would make
// the UI unable to tell "your administrator has not turned this on" from "you
// have not pasted a key".
// =============================================================================

export const aiConfigModelSchema = z.object({
  id: z.string().describe("The provider's own model id, e.g. `gpt-4o`."),
  label: z.string().describe('Human name for a model picker.'),
  contextWindowTokens: z
    .number()
    .describe(
      "The EFFECTIVE context window: the model's own, already narrowed by this deployment's token policy. A client never has to compute the minimum itself.",
    ),
  maxOutputTokens: z
    .number()
    .describe(
      "The EFFECTIVE output ceiling: the model's own, already narrowed by this deployment's policy.",
    ),
});

export type AiConfigModel = z.infer<typeof aiConfigModelSchema>;

export const aiConfigSchema = z.object({
  available: z
    .boolean()
    .describe(
      'True only when AI is enabled, the configured provider is registered in this build, at least one permitted model is one this build can budget requests for, and the token ceilings leave room for input. A client should not offer AI generation when this is false. **Independent of `keyConfigured`** — see that field.',
    ),
  provider: z
    .string()
    .nullable()
    .describe('The active provider id, or null when none is usable.'),
  providerLabel: z
    .string()
    .nullable()
    .describe(
      'Human name of the active provider, for the "this will be sent to …" disclosure shown before every generation.',
    ),
  models: z
    .array(aiConfigModelSchema)
    .describe(
      'Models this deployment permits AND this build can budget for, in the order an administrator listed them. Empty when nothing is usable.',
    ),
  defaultModel: z
    .string()
    .nullable()
    .describe(
      'Which of `models` to offer first. Never a model absent from that list — a client can select it without re-checking.',
    ),
  maxInputTokens: z
    .number()
    .describe("This deployment's ceiling on the assembled prompt, in tokens."),
  maxOutputTokens: z
    .number()
    .describe("This deployment's ceiling on one generation, in tokens."),
  keyConfigured: z
    .boolean()
    .describe(
      'Whether **the calling user** has saved an API key for the active provider. This is the one field every AI surface gates on: false means render the "set up your AI key" prompt, true means render the feature. It never reveals anything about the key beyond its existence, and it is deliberately independent of `available`, so a user can save and verify a key before an administrator finishes enabling the feature.',
    ),
});

export class AiConfigDto extends createZodDto(aiConfigSchema) {}

export type AiConfigResponse = z.infer<typeof aiConfigSchema>;
