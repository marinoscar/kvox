import { z } from 'zod';

// =============================================================================
// AI settings — shape and validation (issue #47, epic #45)
// =============================================================================
//
// The DEPLOYMENT-POLICY half of epic #45's AI features: is AI on at all, which
// provider endpoint may be called, which models are permitted, and what token
// and time ceilings bound one request. Everything here is ordinary
// configuration and is safe to return from an admin endpoint.
//
// ⚠ NO API KEY IS HERE, AND NONE CAN BE ADDED — and unlike
// `transcription-settings.schema.ts`, the key this namespace must never grow is
// not even the deployment's. Epic #45 is strict BYO: every key belongs to an
// individual user, lives in `user_ai_credentials` behind a cascading foreign
// key, and is reachable only through `UserAiCredentialsService`. A key in this
// blob would be BOTH of the two failures at once — a secret in a wholesale-
// returned settings object, and a deployment-wide fallback credential the epic
// rejected outright (docs/specs/notes.md §9: shared spend and a user's private
// conversation reaching the organisation's AI account without them choosing
// it). There is a compile-time proof of the absence at the bottom of this file.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A NAMESPACE OF THE `global` ROW
// -----------------------------------------------------------------------------
//
// Same argument `systemTranscriptionSchema` makes, and the same worked
// precedent (`databaseBackup`): it is registered in
// `common/schemas/settings.schema.ts`, so the merge carries it, the parity
// guard checks it, and the degraded read fills it from
// `DEFAULT_SYSTEM_SETTINGS`. `AiSettingsService` writes it through
// `SystemSettingsService.patchSettings` and never touches `system_settings`
// itself.
//
// ⚠ A NAMESPACE COSTS SIX EDITS, NOT ONE. See the header of
// `common/schemas/settings-parity.spec.ts`; missing the two WIRE DTOs makes
// every PATCH a silent no-op that returns 200.
//
// NO `.default()` ANYWHERE IN THIS FILE, matching the rest of that row: the
// defaults live in `common/types/settings.types.ts` and nowhere else.
// =============================================================================

/**
 * Providers this build can be configured to use.
 *
 * ⚠ A VALUE HERE IS PERMANENT ONCE A USER HAS SAVED A KEY FOR IT. It is
 * `user_ai_credentials.provider` and `notes.provider`, so renaming one orphans
 * every stored key and mislabels every note already generated.
 */
export const AI_PROVIDER_IDS = ['openai'] as const;

/** A configurable AI provider. See {@link AI_PROVIDER_IDS}. */
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/**
 * One entry of a provider's `allowedModels` list (#78).
 *
 * WHY AN OBJECT AND NOT A BARE ID ANY MORE. `allowedModels` used to be
 * `string[]`, and every consumer resolved each id against this build's
 * hardcoded `MODELS` catalogue to find the context window the §3.3 token budget
 * needs. That made the deployment's model policy a SUBSET of a four-entry array
 * compiled into the application: a model the vendor shipped last week could be
 * saved but never offered to anyone, and adopting it required a release. It
 * also made model DISCOVERY pointless — there is no use in listing the sixty
 * models a key can reach if fifty-six of them cannot be permitted.
 *
 * So an entry may now carry the two numbers itself. The build catalogue remains
 * the default and the convenience; the entry is the override; neither is
 * mandatory as long as ONE of them can answer. See `resolveAllowedModel` in
 * `ai-model-resolution.ts` — the single implementation of that precedence,
 * which both the admin service and the capability probe call.
 *
 * ⚠ NO SECRET-BEARING FIELD MAY BE ADDED HERE EITHER, and the compile-time
 * proof at the bottom of this file now checks this type too. A per-model
 * `apiKey` is a plausible-looking idea ("this one model is on a different
 * account") and would be the deployment-wide fallback credential
 * docs/specs/notes.md §9 rejected, smuggled in one level deeper.
 */
export const aiAllowedModelSchema = z.object({
  /** The provider's own model id. The only required field. */
  id: z.string().trim().min(1).max(128),

  /**
   * What a model picker shows. Falls back to the build catalogue's label, then
   * to the id — never to a prettified guess, which would look exactly like a
   * model this application actually knows something about.
   */
  label: z.string().trim().min(1).max(128).optional(),

  /**
   * Total context window, in tokens. The §3.3 budget's starting number.
   *
   * Bounded at 1,024 below — a window smaller than that cannot hold a system
   * prompt and a paragraph, so a value there is a typo rather than a policy —
   * and at ten million above, which is far past any shipped model and is a
   * bound on a MISTAKE (a byte count pasted into a token field), not on a
   * vendor's ambition.
   */
  contextWindowTokens: z.number().int().min(1_024).max(10_000_000).optional(),

  /** Most tokens this model will produce in one completion. */
  maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
});

export type AiAllowedModel = z.infer<typeof aiAllowedModelSchema>;

/**
 * One `allowedModels` entry as it may be WRITTEN: an object, or a bare id.
 *
 * ⚠ THE LEGACY STRING FORM IS LOAD-BEARING AND MUST NEVER BE REMOVED. Every
 * deployment that has already saved an AI policy has `["gpt-4o", …]` sitting in
 * the `global` row's JSONB right now. `SystemSettingsService.readKnownSettings`
 * DEGRADES A NAMESPACE THAT FAILS TO PARSE TO `DEFAULT_SYSTEM_SETTINGS` — it
 * does not error, it does not log an administrator can find later, it quietly
 * substitutes the defaults. So a schema that rejected the string form would not
 * produce a migration failure or a 500; it would silently reset every existing
 * deployment's `allowedModels` to `[]` and its `enabled` to `false`, and the
 * first anyone would know is users reporting that AI had stopped working. That
 * is why this is a union with a normalising transform rather than a widened
 * object type, and why there is no migration: the old shape stays readable
 * forever.
 *
 * NORMALISED ON THE WAY IN, so every reader downstream sees objects only. The
 * alternative — a union type every consumer narrows — would put the same
 * `typeof entry === 'string'` branch in the config probe, the admin service,
 * the generation handler and every future caller, and one of them would get it
 * wrong.
 */
export const aiAllowedModelEntrySchema = z
  .union([z.string().trim().min(1).max(128), aiAllowedModelSchema])
  .transform((entry): AiAllowedModel =>
    typeof entry === 'string' ? { id: entry } : entry,
  );

/**
 * Per-provider settings blocks.
 *
 * ONE KEY PER PROVIDER, ALL PRESENT, exactly as `transcriptionProvidersSchema`
 * does and for the same reason: a PATCH that changes one provider's model list
 * must not become invalid for failing to carry another's whole block.
 */
export const aiProvidersSchema = z.object({
  openai: z.object({
    /**
     * The API root this deployment calls.
     *
     * A SETTING RATHER THAN A CONSTANT because the whole point of naming this
     * provider "OpenAI-compatible" in VISION.md is that an OpenAI-compatible
     * gateway — an enterprise proxy, a self-hosted vLLM, Azure's endpoint —
     * speaks the same Chat Completions wire format at a different origin. It is
     * validated as a URL here so a typo is a 400 on the settings page rather
     * than a confusing DNS failure inside a job an hour later.
     */
    baseUrl: z.string().trim().url().max(512),

    /**
     * Which model ids a user of this deployment may generate with.
     *
     * AN ALLOW-LIST, NOT A CATALOGUE. A model the user's own key can reach but
     * this list does not name is refused by this application before a request
     * is made — that is the deployment's lever over cost and over which vendor
     * models its content may be sent to, and it is the only one, since the key
     * and the bill are the user's own.
     *
     * FREE IDS RATHER THAN AN ENUM, for the identical reason
     * `transcription.providers.assemblyai.speechModel` is: vendors add and
     * retire model ids on their own schedule, and an enum here would mean a
     * deployment cannot adopt a new model without a release of this
     * application. Since #78 an entry may also carry the numbers this build
     * needs to budget with — see {@link aiAllowedModelEntrySchema}, and note
     * that a BARE STRING is still accepted and always will be.
     *
     * An EMPTY list is legal and means "nothing is permitted" — a deliberately
     * representable state, so an administrator can close the feature by policy
     * without also flipping `enabled` and losing the rest of the configuration.
     */
    allowedModels: z.array(aiAllowedModelEntrySchema).max(50),

    /**
     * The model a client offers first. It SHOULD be a member of
     * `allowedModels`; that is checked at the service boundary rather than here
     * (a cross-field refinement would make every partial PATCH of one field
     * require the other), and a default outside the list is reported to the
     * admin page rather than silently corrected.
     */
    defaultModel: z.string().trim().min(1).max(128),
  }),
});

export type AiProvidersValue = z.infer<typeof aiProvidersSchema>;

/**
 * How hard a reasoning model may think before it answers (#87).
 *
 * ⚠ ORDERED FROM CHEAPEST TO MOST EXPENSIVE, and `'none'` is FIRST because it
 * is the default — see {@link systemAiSchema.reasoningEffort}. The strings are
 * the vendor's own `reasoning_effort` values and are sent verbatim, so this
 * list is a wire vocabulary rather than a name this application chose.
 */
export const AI_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** One reasoning effort. See {@link AI_REASONING_EFFORTS}. */
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

/**
 * The `ai` system-settings namespace.
 *
 * `enabled` is a MASTER SWITCH separate from every other field, exactly as it
 * is for transcription and email: an administrator can turn AI off for a
 * migration or an incident without losing the model policy they would otherwise
 * have to retype.
 */
export const systemAiSchema = z.object({
  /** Master switch. No completion is requested from any provider while false. */
  enabled: z.boolean(),

  /**
   * The active provider, or `null` when none has been chosen.
   *
   * ⚠ NULLABLE RATHER THAN OPTIONAL, field for field with
   * `systemTranscriptionSchema.provider` and for its reason: "nobody has chosen
   * one" is a PERSISTED FACT the settings page renders, not an absent key whose
   * meaning every reader has to guess. An optional key would make
   * `provider === undefined` mean "unset" in a fresh row, "the merge dropped it"
   * after a partial PATCH, and "this build's schema does not model it" after a
   * rollback — three different situations that a `null` distinguishes from none
   * of them, because it is written down.
   *
   * AN AXIS SEPARATE FROM `enabled`, also as transcription has it: an
   * administrator can switch AI off for a migration or an incident without
   * losing the vendor choice, and can switch vendors without touching the
   * master switch.
   *
   * ⚠ THIS FIELD IS WHY NOTHING ABOVE `ai-provider.registry.ts` MAY HARDCODE
   * `'openai'`. Before it existed, every consumer resolved the one registered
   * provider by name, so adding a second OpenAI-compatible vendor would have
   * meant editing `AiConfigService`, `AiSettingsService` and every future
   * consumer in the same release. The point of the axis is that adding a
   * provider costs one class and one entry in {@link AI_PROVIDER_IDS} — see the
   * `this.registry.get(policy.provider)` calls that replaced those literals.
   */
  provider: z.enum(AI_PROVIDER_IDS).nullable(),

  /** Per-provider configuration; every provider's block is always present. */
  providers: aiProvidersSchema,

  /**
   * Ceiling on the assembled prompt, in tokens (docs/specs/notes.md §3.3).
   *
   * A DEPLOYMENT ceiling that sits UNDER the model's own context window, never
   * over it: the budget check takes the smaller of the two. It exists because
   * the user pays for input tokens on their own account, and a 200,000-token
   * transcript silently costing them several dollars per regeneration is
   * exactly the surprise an operator should be able to bound.
   */
  maxInputTokens: z.number().int().min(256).max(2_000_000),

  /**
   * Ceiling on what one generation may produce, in tokens.
   *
   * Also what §3.3's budget subtracts from the context window to compute the
   * input allowance, which is why it is a policy value rather than a per-request
   * one: the same number has to be knowable at request time, before any job
   * exists.
   */
  maxOutputTokens: z.number().int().min(64).max(200_000),

  /**
   * How long one provider request may take before it is abandoned, in
   * milliseconds.
   *
   * Bounded at an hour. A streamed completion legitimately runs for minutes,
   * so this cannot be an ordinary HTTP timeout — but "no timeout" would let a
   * wedged connection hold a worker slot until the job's own `maxRuntimeMs`
   * expires, which is a much blunter instrument.
   */
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),

  /**
   * How hard a reasoning model may think before it answers (#87).
   *
   * `'none'` — THE DEFAULT, AND THE VENDOR'S OWN — means the parameter is not
   * sent at all, so a deployment that never touches this field puts exactly the
   * same bytes on the wire as it did before this field existed. That matters
   * beyond tidiness: `providers.openai.baseUrl` is a setting precisely so an
   * OpenAI-compatible gateway can be used, and plenty of them have never heard
   * of `reasoning_effort` and will reject a request carrying it. Opting in is
   * an administrator's decision, taken once, for a deployment whose endpoint
   * they know supports it.
   *
   * ⚠ REASONING TOKENS ARE OUTPUT TOKENS. They are billed as output, counted as
   * output, and drawn from the SAME `max_completion_tokens` ceiling the visible
   * answer is drawn from — which, for this application, is
   * `min(maxOutputTokens, the model's own ceiling)` (see
   * `notes/generation/token-budget.ts`). So raising this field does not buy
   * better answers for free; it spends a fixed budget on thinking instead of on
   * prose. At `'high'`, against the default `maxOutputTokens` of 16,384, a
   * generation can legitimately spend most of that budget deliberating and
   * return a truncated note — or almost nothing at all. THAT ARRIVES AS A
   * `length` FINISH REASON, NOT AS AN ERROR: the provider did what it was
   * asked, and this application has no way to tell "the model thought for
   * 15,000 tokens" apart from "the answer was long" after the fact.
   *
   * The fix, when it happens, is to raise `maxOutputTokens` deliberately — this
   * field does not raise it, and must not: that ceiling is a separate policy
   * decision about what one generation may cost on SOMEBODY ELSE'S BILL
   * (docs/specs/notes.md §9), and quietly widening it because a reasoning
   * effort was turned up would be this application spending a user's money on
   * a decision an administrator did not take.
   *
   * IGNORED BY A PROVIDER THAT DOES NOT REASON, and by a model that does not:
   * `AiGenerateRequest.reasoningEffort` is optional, and a non-reasoning model
   * on a vendor that accepts the parameter simply does no thinking to bill for.
   */
  reasoningEffort: z.enum(AI_REASONING_EFFORTS),

  /**
   * Ceiling on one uploaded source document, in bytes (issue #51).
   *
   * ⚠ IT LIVES HERE RATHER THAN IN `storage` BECAUSE IT IS AN AI POLICY, not a
   * storage policy. The reason to bound a source document is not disk — a
   * 200 MB PDF costs pennies to store — it is that every byte of it becomes
   * characters, and those characters become INPUT TOKENS on the uploading
   * user's own vendor account. The deployment-wide ceiling on what may reach a
   * model is `maxInputTokens` two fields above; this is the same decision taken
   * at the only other moment it can be taken cheaply, which is before the
   * bytes are accepted at all.
   *
   * A SECOND, NARROWER ROLE: it is the memory bound on extraction.
   * `note.source.extract` must buffer a whole PDF (pdf.js resolves a
   * cross-reference table that lives at the end of the file, so there is no
   * streaming extraction to do), and a worker slot holding an unbounded
   * document is how one upload takes a process down. That is why the endpoint
   * enforces it AT THE DOOR rather than the job discovering it later.
   *
   * 25 MB by default — comfortably above any ordinary proposal, contract or
   * brief, and far below anything whose extracted text a token budget would
   * accept anyway.
   */
  maxDocumentBytes: z.number().int().min(65_536).max(268_435_456),
});

export type SystemAiValue = z.infer<typeof systemAiSchema>;

/**
 * PATCH counterpart — hand-written, one level deep.
 *
 * Exactly like `systemTranscriptionPatchSchema`: zod v4 removed `deepPartial`,
 * and the nested `providers` block has to be optional both at the block level
 * and field by field so that
 * `{ "ai": { "providers": { "openai": { "defaultModel": "gpt-4o-mini" } } } }`
 * is a legal body.
 *
 * `allowedModels` REPLACES WHOLESALE rather than merging — RFC 7396's rule for
 * arrays, and the only workable one here: a merging list could never express
 * "stop permitting this model", so unchecking one on the admin page would be a
 * no-op.
 */
export const systemAiPatchSchema = z.object({
  enabled: z.boolean().optional(),
  // `.nullable().optional()` — TWO different absences, and the merge in
  // `system-settings.service.ts` must tell them apart with `!== undefined`
  // rather than `??`. `null` is a VALUE here ("no provider is active"), so a
  // `??` merge would make "unset the provider" a silent no-op — the same trap
  // `maintenance.startedAt` and `transcription.defaultLanguage` document.
  provider: z.enum(AI_PROVIDER_IDS).nullable().optional(),
  providers: z
    .object({
      openai: z
        .object({
          baseUrl: z.string().trim().url().max(512).optional(),
          allowedModels: z.array(aiAllowedModelEntrySchema).max(50).optional(),
          defaultModel: z.string().trim().min(1).max(128).optional(),
        })
        .optional(),
    })
    .optional(),
  maxInputTokens: z.number().int().min(256).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(64).max(200_000).optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  // #87. A plain optional enum: absent means "leave it alone", and unlike
  // `provider` above there is no meaningful `null` — "do not reason" is a
  // value in the enum (`'none'`), not an absence.
  reasoningEffort: z.enum(AI_REASONING_EFFORTS).optional(),
  maxDocumentBytes: z.number().int().min(65_536).max(268_435_456).optional(),
});

export type SystemAiPatchValue = z.infer<typeof systemAiPatchSchema>;

// -----------------------------------------------------------------------------
// Compile-time proof that no secret-bearing field crept in
// -----------------------------------------------------------------------------
//
// The same technique `transcription-settings.schema.ts` uses, checked at ALL
// THREE levels for the same reason it checks both of its two:
// `providers.openai.apiKey` is by far the most natural place for somebody to
// put a key, and a proof that only looked at the top level would miss the exact
// mistake it exists to prevent.
//
// THE THIRD LEVEL ARRIVED WITH #78, and it is not a formality. Once an entry of
// `allowedModels` became an OBJECT with its own optional fields, "this one
// model lives on a different account, so give it its own key" became a
// plausible-sounding change somebody could make in one line — and it would be
// the deployment-wide fallback credential docs/specs/notes.md §9 rejected,
// hidden two levels down in a settings blob that is returned wholesale to every
// holder of `system_settings:read`.
//
// If one of these lines has gone red: you are trying to put a secret into a
// settings blob — and in this epic, into a DEPLOYMENT-WIDE one, which is also
// the fallback-key design docs/specs/notes.md §9 rejected. Every AI key belongs
// to a user; use `UserAiCredentialsService`.

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

export type AiSettingsCarriesNoSecret = CarriesNoSecret<SystemAiValue>;

export type OpenAiSettingsCarryNoSecret = CarriesNoSecret<
  AiProvidersValue['openai']
>;

/** #78: one entry of `allowedModels` is an object now, so it is checked too. */
export type AiAllowedModelCarriesNoSecret = CarriesNoSecret<AiAllowedModel>;

export const AI_SETTINGS_CARRIES_NO_SECRET: AiSettingsCarriesNoSecret = true;

export const OPENAI_SETTINGS_CARRY_NO_SECRET: OpenAiSettingsCarryNoSecret = true;

export const AI_ALLOWED_MODEL_CARRIES_NO_SECRET: AiAllowedModelCarriesNoSecret =
  true;
