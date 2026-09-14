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
//
// ⚠ `provider` IS INDEPENDENT OF `available` FOR THE SAME REASON (issue #83).
// It answers "which vendor would a key belong to"; `available` answers "may AI
// be used right now". A key form needs the first and is not asking about the
// second, so `provider` is populated whenever a recognised vendor is
// configured — switched on or not — and is null only when there is genuinely no
// vendor to name. Blanking it while AI was off was what made a fresh
// deployment unsetuppable: nobody could save the key the administrator needed
// in order to finish enabling AI.
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
  source: z
    .enum(['explicit', 'catalogue', 'derived', 'default'])
    .describe(
      'How this deployment learnt the two numbers above (issue #97): `explicit` — an administrator typed them into the policy; `catalogue` — this build ships verified numbers for this exact model id; `derived` — the id was placed in a known family (a dated snapshot such as `gpt-5.4-mini-2026-03-17`) and took that family\'s numbers, with `derivedFrom` naming it; `default` — nothing better was available and the provider\'s conservative floor was used. **It is the WEAKEST source either number came from**, so a model whose window was derived but whose output ceiling fell back to the floor reports `default`. All four are usable; only the first two are knowledge, and a client showing an inference as a verified figure is the one thing this field exists to prevent. The effective ceilings are narrowed by deployment policy either way — that narrowing does not change this field.',
    ),
  derivedFrom: z
    .string()
    .nullable()
    .describe(
      'The catalogue model id the numbers were inferred from, non-null exactly when `source` is `derived` — so a client can say *which* model was assumed rather than only that one was.',
    ),
});

export type AiConfigModel = z.infer<typeof aiConfigModelSchema>;

export const aiConfigSchema = z.object({
  available: z
    .boolean()
    .describe(
      'True only when AI is enabled, the configured provider is registered in this build, at least one permitted model can be budgeted for (its numbers typed, catalogued, derived from its family, or taken from the provider floor — issue #97), and the token ceilings leave room for input. A client should not offer AI generation when this is false. **Independent of `keyConfigured` and of `provider`** — a non-null `provider` alongside `available: false` is the ordinary state of a deployment whose administrator has not finished setting AI up.',
    ),
  provider: z
    .string()
    .nullable()
    .describe(
      'The configured provider id — which vendor a key would belong to. **Independent of `available`** (issue #83): it is populated whenever this deployment names a provider this build recognises, including while AI is switched off or nothing is permitted yet, so a user can save and verify their key before an administrator finishes enabling the feature. Null means only that there is no vendor to name: either none is configured, or the configured one is unknown to this build.',
    ),
  providerLabel: z
    .string()
    .nullable()
    .describe(
      'Human name of the configured provider, for the "this will be sent to …" disclosure shown before every generation and for labelling the key form. Null exactly when `provider` is null — never merely because AI is unavailable.',
    ),
  models: z
    .array(aiConfigModelSchema)
    .describe(
      'Models this deployment permits AND can budget for, in the order an administrator listed them. Empty when nothing is usable. Since issue #97 a permitted model is almost always budgetable — an id this build carries no descriptor for takes its family\'s numbers, or the provider\'s conservative floor — so a model is omitted here only when nothing at all can supply a context window, which in practice means the policy names a provider this build does not implement. Read each entry\'s `source` to tell a verified number from an inferred one.',
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
