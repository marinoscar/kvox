import { z } from 'zod';

/**
 * The version of the GitHub Copilot consent text a user accepts.
 *
 * @remarks
 * Stored beside the user's opt-in as `CopilotSettings.consentVersion`. A host
 * (or the packaged card) asks again whenever the stored version differs from
 * this one, so changing what the consent says means bumping this string. The
 * value is permanent per text: never reuse a version for different wording.
 *
 * Versions: `'1'`, the first text (Ask unavailable with Copilot); `'2'`, Ask
 * runs on Copilot and search by meaning does not (marinoscar/kvox#654).
 *
 * @stability experimental
 */
export const COPILOT_CONSENT_VERSION = '2' as const;

/**
 * The validators and descriptions of a Copilot setting, defined once so the full and the patch schema cannot drift.
 * The description is applied last, on the outermost schema, in both.
 */
const copilotSettingFields = {
  enabled: z.boolean(),
  consentedAt: z.string().datetime().nullable(),
  consentVersion: z.string().nullable(),
  model: z.string().nullable(),
};
const copilotSettingDescriptions = {
  enabled: 'Whether the user opted in to GitHub Copilot.',
  consentedAt: 'When the user accepted the consent text (ISO 8601), or null.',
  consentVersion: 'The consent text version the user accepted; bumped to ask again.',
  model: 'The chosen Copilot model id, or null for the default.',
} as const;

/**
 * The user's own GitHub Copilot setting: opt-in, off by default.
 *
 * @remarks
 * `enabled` turns the adapter on. `consentedAt` and `consentVersion` record
 * which consent text the user accepted and when; a host treats an enabled
 * setting whose `consentVersion` differs from {@link COPILOT_CONSENT_VERSION}
 * as not consented. `model` is the Copilot model id the user picked, or `null`
 * for the host's default.
 *
 * ⚠ Every field carries a default, and Zod 4 applies a default even under
 * `.partial()`. Validate a PATCH body with {@link CopilotSettingsPatchSchema},
 * never with `CopilotSettingsSchema.partial()`.
 *
 * @stability experimental
 */
export const CopilotSettingsSchema = z.object({
  enabled: copilotSettingFields.enabled.default(false).describe(copilotSettingDescriptions.enabled),
  consentedAt: copilotSettingFields.consentedAt.default(null).describe(copilotSettingDescriptions.consentedAt),
  consentVersion: copilotSettingFields.consentVersion.default(null).describe(copilotSettingDescriptions.consentVersion),
  model: copilotSettingFields.model.default(null).describe(copilotSettingDescriptions.model),
});

/**
 * A partial update of the Copilot setting: only the keys that were sent.
 *
 * @remarks
 * Exists because `CopilotSettingsSchema.partial()` does not make a patch: Zod 4
 * applies a field's default even when the field is optional, so
 * `CopilotSettingsSchema.partial().strict().parse({ model: 'gpt-4.1' })` returns
 * `{ enabled: false, consentedAt: null, consentVersion: null, model: 'gpt-4.1' }`,
 * which switches Copilot off and erases the consent. This schema has the same
 * four fields with the same validation and descriptions, each optional and with
 * NO default, so parsing returns exactly the keys sent. Unknown keys are refused.
 *
 * @example
 * ```ts
 * // A host route for PATCH /copilot/settings
 * const patch: CopilotSettingsPatch = CopilotSettingsPatchSchema.parse(request.body);
 * const stored = await settings.update(userId, patch); // only the sent keys change
 * ```
 *
 * @stability experimental
 */
export const CopilotSettingsPatchSchema = z
  .object({
    enabled: copilotSettingFields.enabled.optional().describe(copilotSettingDescriptions.enabled),
    consentedAt: copilotSettingFields.consentedAt.optional().describe(copilotSettingDescriptions.consentedAt),
    consentVersion: copilotSettingFields.consentVersion.optional().describe(copilotSettingDescriptions.consentVersion),
    model: copilotSettingFields.model.optional().describe(copilotSettingDescriptions.model),
  })
  .strict();

/**
 * A validated Copilot setting patch: any subset of the four fields.
 *
 * @stability experimental
 */
export type CopilotSettingsPatch = z.infer<typeof CopilotSettingsPatchSchema>;

/**
 * A stored or submitted Copilot setting.
 *
 * @stability experimental
 */
export type CopilotSettings = z.infer<typeof CopilotSettingsSchema>;

/**
 * The Copilot setting of a user who never touched it: off, no consent, no model.
 *
 * @stability experimental
 */
export const COPILOT_DEFAULT_SETTINGS: CopilotSettings = Object.freeze(CopilotSettingsSchema.parse({}));

/**
 * The states of the Copilot runtime a host downloads or bundles.
 *
 * @stability experimental
 */
export const COPILOT_RUNTIME_STATES = ['missing', 'downloading', 'ready', 'error'] as const;

/**
 * One of {@link COPILOT_RUNTIME_STATES}.
 *
 * @stability experimental
 */
export type CopilotRuntimeState = (typeof COPILOT_RUNTIME_STATES)[number];

/**
 * Why a KVox task cannot run on Copilot.
 *
 * @remarks
 * Mirrors the reasons `routeKvoxTasks` of `@marinoscar/kvox-ai` gives.
 * `needs_embeddings`: Copilot offers no embeddings, so search by meaning
 * cannot run on it. `needs_tool_calling`: the chosen model cannot call tools,
 * so Ask cannot run on it; Copilot itself supports tool calling, so this is
 * reported only for a model its live listing marks as tool-less.
 *
 * @stability experimental
 */
export const COPILOT_UNAVAILABLE_REASONS = ['needs_tool_calling', 'needs_embeddings'] as const;

/**
 * One of {@link COPILOT_UNAVAILABLE_REASONS}.
 *
 * @stability experimental
 */
export type CopilotUnavailableReason = (typeof COPILOT_UNAVAILABLE_REASONS)[number];

/**
 * What a host reports about GitHub Copilot right now: sign-in, runtime, models
 * and the tasks that cannot run on it.
 *
 * @remarks
 * `runtime.progress` is a fraction from 0 to 1 while `state` is `downloading`,
 * otherwise `null`. `task` in `unavailableTasks` is a KVox task or feature id
 * (for example `ask`); a client that does not know it shows it as written.
 *
 * @stability experimental
 */
export const CopilotStatusSchema = z.object({
  enabled: z.boolean().describe('Whether the adapter is on for this user.'),
  signedIn: z.boolean().describe('Whether a GitHub account is signed in to the runtime.'),
  login: z.string().nullable().describe('The signed-in GitHub login, or null. Never a token.'),
  runtime: z.object({
    state: z.enum(COPILOT_RUNTIME_STATES),
    version: z.string().nullable(),
    progress: z.number().min(0).max(1).nullable(),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      structuredOutput: z.enum(['native', 'prompted']),
    }),
  ),
  unavailableTasks: z.array(
    z.object({
      task: z.string(),
      reason: z.enum(COPILOT_UNAVAILABLE_REASONS),
    }),
  ),
});

/**
 * The Copilot status a host returns.
 *
 * @stability experimental
 */
export type CopilotStatus = z.infer<typeof CopilotStatusSchema>;

/**
 * What the user must do to finish signing in: type a code on a page (`device`)
 * or finish in the browser (`browser`).
 *
 * @remarks
 * The Copilot runtime today returns `browser`; `device` is part of the contract
 * so a host that handles both keeps working. A client switches on `kind`.
 *
 * @stability experimental
 */
export const CopilotSignInChallengeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device'),
    userCode: z.string(),
    verificationUri: z.string().url(),
    expiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('browser'),
    url: z.string().url(),
  }),
]);

/**
 * A sign-in challenge.
 *
 * @stability experimental
 */
export type CopilotSignInChallenge = z.infer<typeof CopilotSignInChallengeSchema>;
