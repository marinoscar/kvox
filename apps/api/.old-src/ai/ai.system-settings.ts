// =============================================================================
// The `ai` system settings namespace (issue #459, issue #47, epic #45)
//
// PLATFORM-ADOPTION-SHIM(3.1): this app registers its OWN `ai` declaration under the
// key `ai` until #473 adopts the platform's `AI_SYSTEM_SETTINGS`. Registered by
// `apps/api/src/app-registrations/settings.ts` as `KVOX_AI_SYSTEM_SETTINGS`.
// =============================================================================
//
// The deployment AI policy: whether AI is on, which endpoint is called, which
// models are permitted and the token/time ceilings on one request. It stays a
// CORE declaration in `ai/` for now: its `taskModels` keys (`graph.extract`,
// `graph.adjudicate`, `graph.digest`, `graph.agent`) and `graphEnabled` are
// connected-knowledge fields that Epic 3 issue 3.1 turns into an `ai` namespace
// extension registered by the graph module. They are strings here, not imports.
//
// The stored and PATCH shapes are `systemAiSchema` / `systemAiPatchSchema` from
// `ai-settings.schema.ts` (a leaf that carries the compile-time proof that no
// secret-bearing field exists). The PUT and PATCH request-body branches were
// cut from `settings/dto/update-system-settings.dto.ts`, the response branch
// from `system-settings-response.dto.ts` and the defaults from
// `DEFAULT_SYSTEM_SETTINGS.ai`.
//
// ⚠ NO API KEY ANYWHERE IN THIS NAMESPACE, and unlike `transcription` not even
// one in the shared `credentials` table: every AI key belongs to an individual
// user and lives in `user_ai_credentials`. Registration also walks every schema
// below for secret-named fields.
// =============================================================================

import { z } from 'zod';

import type { SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import {
  systemAiPatchSchema,
  systemAiSchema,
  type SystemAiValue,
} from './ai-settings.schema';

/**
 * One `allowedModels` entry, RESTATED from `ai/ai-settings.schema.ts` (#78).
 *
 * ⚠ THE BARE-STRING FORM IS NOT OPTIONAL POLISH. Every deployment that has
 * already saved an AI policy has `["gpt-4o", …]` in the `global` row's JSONB,
 * and a body schema that rejected it would make the settings page unable to
 * echo back what it was just given. The transform normalises both forms to an
 * object so the service's merge — and `SystemSettingsValue` — see one shape.
 *
 * Restated rather than imported, exactly as the `settings/dto` request bodies
 * it was cut from do: these are the OpenAPI-visible request schemas, and the
 * composed-equivalence spec fails the build when the copies drift.
 */
const aiAllowedModelEntry = z
  .union([
    z.string().trim().min(1).max(128),
    z.object({
      id: z.string().trim().min(1).max(128),
      label: z.string().trim().min(1).max(128).optional(),
      contextWindowTokens: z.number().int().min(1_024).max(10_000_000).optional(),
      maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
    }),
  ])
  .transform((entry) => (typeof entry === 'string' ? { id: entry } : entry));

/**
 * AI policy (#47, epic #45).
 *
 * RESTATED HERE rather than imported from `ai/ai-settings.schema.ts`, exactly
 * like the five blocks above and for the reason at the top of this file: these
 * are the OpenAPI-visible request schemas that `createZodDto` reads, and the
 * service validates against the shared schema again on the way in. The two
 * copies must move together — `common/schemas/settings-parity.spec.ts` is what
 * fails the build when they do not.
 *
 * ⚠ NO `apiKey` FIELD, HERE OR ANYWHERE IN THIS NAMESPACE — and in this epic
 * not even a write-only one, because there is no deployment AI key at all.
 * Every AI key belongs to an individual user and is written through
 * `PUT /api/ai-credentials` into `user_ai_credentials`. A key accepted by THIS
 * body would be persisted into the settings blob, which is the exact failure
 * `ai-settings.schema.ts`'s compile-time proof exists to prevent.
 */
const aiPutSchema = z.object({
  enabled: z.boolean(),
  // The ACTIVE provider (#78), nullable exactly as `transcription.provider`
  // above is: `null` is the persisted "nobody has chosen one", not an absent
  // key. Missing this line would make a full PUT silently drop the vendor
  // choice, which `SystemSettingsService.replaceSettings` would then carry
  // forward blind.
  provider: z.enum(['openai']).nullable(),
  providers: z.object({
    openai: z.object({
      baseUrl: z.string().trim().url().max(512),
      allowedModels: z.array(aiAllowedModelEntry).max(50),
      defaultModel: z.string().trim().min(1).max(128),
    }),
  }),
  // #436: `null` = "the selected model's own maximum"; a number is an
  // administrator's spend cap. Nullable here too, or a full PUT could never
  // clear one.
  maxInputTokens: z.number().int().min(256).max(2_000_000).nullable(),
  maxOutputTokens: z.number().int().min(64).max(200_000).nullable(),
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  // How hard a reasoning model may think before it answers (#87). Restated
  // from `ai-settings.schema.ts`, like every field around it. `'none'` is the
  // vendor's default and means the parameter is not sent at all; every other
  // value spends output tokens on thinking, and since #436 the budget adds
  // that effort's headroom on top of any typed `maxOutputTokens` cap above.
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
  // Ceiling on one uploaded note source document, in bytes (#51). See
  // `ai-settings.schema.ts` for why an AI policy and not a storage one.
  maxDocumentBytes: z.number().int().min(65_536).max(268_435_456),
  // Per-task models (#360), restated from `ai-settings.schema.ts`. A partial
  // record — an absent task key means "use the provider's defaultModel".
  taskModels: z.partialRecord(
    z.enum(['graph.extract', 'graph.adjudicate', 'graph.digest', 'graph.agent']),
    z.object({
      model: z.string().trim().min(1).max(128),
      reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    }),
  ),
  // The connected-knowledge spending switch (#360).
  graphEnabled: z.boolean(),
});

const aiWirePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    // `.nullable().optional()` for the reason `transcription.provider` and
    // `maintenance.startedAt` are (#78): `null` means "no provider is
    // active" and absent means "leave the choice alone", and the service's
    // merge distinguishes them with `!== undefined` rather than `??`.
    provider: z.enum(['openai']).nullable().optional(),
    providers: z
      .object({
        openai: z
          .object({
            baseUrl: z.string().trim().url().max(512).optional(),
            allowedModels: z.array(aiAllowedModelEntry).max(50).optional(),
            defaultModel: z.string().trim().min(1).max(128).optional(),
          })
          .optional(),
      })
      .optional(),
    // #436. `.nullable().optional()`: absent = leave alone, `null` = clear
    // the cap back to the model's own maximum.
    maxInputTokens: z
      .number()
      .int()
      .min(256)
      .max(2_000_000)
      .nullable()
      .optional(),
    maxOutputTokens: z.number().int().min(64).max(200_000).nullable().optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
    // #87. Missing this line is the silent no-op this file's header warns
    // about: `PATCH { "ai": { "reasoningEffort": "medium" } }` would parse to
    // `{}`, the merge would apply nothing, and the endpoint would answer 200
    // with a body that looked right.
    reasoningEffort: z
      .enum(['none', 'low', 'medium', 'high', 'xhigh'])
      .optional(),
    maxDocumentBytes: z.number().int().min(65_536).max(268_435_456).optional(),
    // #360. Missing either line is this file's silent no-op: `PATCH { "ai":
    // { "graphEnabled": true } }` would parse to `{}` and answer 200.
    // `taskModels` REPLACES WHOLESALE, like `allowedModels`.
    taskModels: z
      .partialRecord(
        z.enum([
          'graph.extract',
          'graph.adjudicate',
          'graph.digest',
          'graph.agent',
        ]),
        z.object({
          model: z.string().trim().min(1).max(128),
          reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
        }),
      )
      .optional(),
    graphEnabled: z.boolean().optional(),
  });

const aiResponseSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['openai']).nullable(),
  providers: z.object({
    openai: z.object({
      baseUrl: z.string(),
      // #78: an entry may carry its own numbers, so this deployment can
      // permit a model no release of this application knows about. The bare
      // string form is still what every pre-#78 row contains, and this
      // response echoes back whichever shape was stored — normalised to
      // objects by the schema the service reads with.
      allowedModels: z.array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          contextWindowTokens: z.number().optional(),
          maxOutputTokens: z.number().optional(),
        }),
      ),
      defaultModel: z.string(),
    }),
  }),
  // #436: `null` = "the selected model's own maximum".
  maxInputTokens: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  requestTimeoutMs: z.number(),
  maxDocumentBytes: z.number(),
  // #360: per-task models (absent key = the provider's defaultModel) and the
  // connected-knowledge spending switch.
  taskModels: z.partialRecord(
    z.enum(['graph.extract', 'graph.adjudicate', 'graph.digest', 'graph.agent']),
    z.object({
      model: z.string(),
      reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    }),
  ),
  graphEnabled: z.boolean(),
});

type AiPatch = z.infer<typeof aiWirePatchSchema>;

/**
 * The `ai` PATCH merge, field by field (the body of the old
 * `SystemSettingsService.patchSettings` block, moved verbatim by #466).
 *
 * `provider`, `maxInputTokens` and `maxOutputTokens` test `!== undefined`, never
 * `??` (#78, #436): `null` is a VALUE there ("no provider is active", "the
 * selected model's own maximum"), so `??` would make clearing one a 200 that
 * changed nothing. `allowedModels` and `taskModels` REPLACE wholesale when
 * present (RFC 7396's rule for arrays), so `[]` / `{}` clears them.
 */
export function mergeAiSettings(current: SystemAiValue, patch?: AiPatch): SystemAiValue {
  return {
    enabled: patch?.enabled ?? current.enabled,
    provider: patch?.provider !== undefined ? patch.provider : current.provider,
    providers: {
      openai: {
        baseUrl: patch?.providers?.openai?.baseUrl ?? current.providers.openai.baseUrl,
        allowedModels:
          (patch?.providers?.openai?.allowedModels as SystemAiValue['providers']['openai']['allowedModels'] | undefined) ??
          current.providers.openai.allowedModels,
        defaultModel: patch?.providers?.openai?.defaultModel ?? current.providers.openai.defaultModel,
      },
    },
    maxInputTokens:
      patch?.maxInputTokens !== undefined ? patch.maxInputTokens : current.maxInputTokens,
    maxOutputTokens:
      patch?.maxOutputTokens !== undefined ? patch.maxOutputTokens : current.maxOutputTokens,
    requestTimeoutMs: patch?.requestTimeoutMs ?? current.requestTimeoutMs,
    reasoningEffort: patch?.reasoningEffort ?? current.reasoningEffort,
    maxDocumentBytes: patch?.maxDocumentBytes ?? current.maxDocumentBytes,
    taskModels: patch?.taskModels ?? current.taskModels,
    graphEnabled: patch?.graphEnabled ?? current.graphEnabled,
  };
}

export const KVOX_AI_SYSTEM_SETTINGS: SystemSettingsNamespace<'ai', SystemAiValue, AiPatch> = {
  key: 'ai',
  description: 'Deployment AI policy: the active provider, permitted models and request ceilings. Carries no API key.',
  storedSchema: systemAiSchema,
  patchSchema: systemAiPatchSchema,
  putSchema: aiPutSchema,
  wirePatchSchema: aiWirePatchSchema,
  responseSchema: aiResponseSchema,
  defaults: {
    enabled: false,
    // `'openai'` RATHER THAN `null`, which is the one place this namespace's
    // defaults deliberately diverge from `transcription` above (#78).
    //
    // The inertness a fresh deployment needs is already carried twice over, by
    // `enabled: false` and by an empty `allowedModels` — so a null provider
    // would buy no additional safety and would cost an administrator a second
    // decision ("which vendor?") to turn on a feature this build has exactly
    // one implementation of. Transcription defaults to `null` because choosing
    // AssemblyAI commits a deployment to sending audio to a specific named
    // company; choosing "the OpenAI-compatible provider" here commits it to
    // nothing until a model is permitted and a user pastes their own key.
    //
    // The field is still nullable, and unsetting it is still meaningful — see
    // `ai-settings.schema.ts`. This is a default, not a claim that `null`
    // cannot happen.
    provider: 'openai',
    providers: {
      openai: {
        // OpenAI's own API root, including the version segment. An
        // OpenAI-compatible gateway is the reason this is a setting at all.
        baseUrl: 'https://api.openai.com/v1',
        // EMPTY on purpose. Naming a model here would be this application
        // choosing which vendor model a deployment's content may be sent to,
        // which is precisely the decision the allow-list exists to leave to an
        // administrator.
        allowedModels: [],
        // A sensible first offer once an administrator permits it (#87: the
        // GPT-5.4 family's mid-size member, rather than `gpt-4o`). Harmless
        // while `allowedModels` is empty: the config probe only ever returns a
        // default that survived the intersection with the allow-list, and
        // since #83 a default naming nothing in an empty list is savable and
        // REPORTED rather than refused — so this names the model a deployment
        // should reach for first without pre-permitting anything.
        defaultModel: 'gpt-5.4-mini',
      },
    },
    // `null` — "the selected model's own context window" (#436). A number
    // here is an administrator's deliberate spend cap, never a default: the
    // old 100,000 governed every request with a ceiling nobody chose.
    maxInputTokens: null,
    // `null` — "the selected model's own output ceiling" (#436). The old
    // 16,384 was sized for prose notes and cut structured graph extraction
    // off mid-answer (#435); an administrator who wants to bound a runaway
    // completion on somebody's own bill types a number deliberately.
    maxOutputTokens: null,
    // Ten minutes. A streamed completion legitimately runs for minutes; this is
    // the backstop for a wedged connection, not an ordinary HTTP timeout.
    requestTimeoutMs: 600_000,
    // `'none'` — THE VENDOR'S OWN DEFAULT (#87), which is why it is this one.
    // The provider omits the parameter entirely at this value, so an upgrade
    // changes neither the bytes on the wire nor anybody's bill, and a gateway
    // that has never heard of `reasoning_effort` keeps working untouched.
    // Raising it spends output tokens on thinking; since #436 the budget adds
    // that effort's headroom on top of any typed `maxOutputTokens` cap — see
    // `ai-settings.schema.ts` and `ai/ai-token-budget.ts`.
    reasoningEffort: 'none',
    // 25 MB (#51). Comfortably above any ordinary proposal, contract or brief,
    // and far below anything whose extracted text a token budget would let
    // through anyway — a document is bounded here because every byte of it
    // becomes input tokens on the uploading user's own vendor account, and
    // because `note.source.extract` has to hold a whole PDF in memory to read
    // it.
    maxDocumentBytes: 26_214_400,
    // EMPTY (#360): every connected-knowledge task uses
    // `providers.<id>.defaultModel` until an administrator picks one per task.
    taskModels: {},
    // OFF (#360). Turning it on spends every user's OWN key on automatic graph
    // extraction, which is an administrator's decision to take, never a default.
    graphEnabled: false,
  },
  requiredOnPut: false,
  merge: mergeAiSettings,
};
