import { z } from 'zod';

import type { SystemSettingsNamespaceExtension } from '@marinoscar/platform-api/settings';

import {
  AI_REASONING_EFFORTS,
  aiTaskModelsSchema,
} from '../../ai-port/ai-task-keys';

// =============================================================================
// The `ai` namespace extension (issue #473, epic #472)
// =============================================================================
//
// The platform's `ai` system-settings namespace has provider slots, a key
// policy, call defaults, hosted tools and limits. This product also routes AI by
// TASK and bounds a request, and stores those choices in the same `ai` block of
// the `global` row. Those fields are added to the platform namespace here, with
// `extendSystemSettingsNamespace` (listed in `APP_SYSTEM_SETTINGS_EXTENSIONS`):
//
//   taskModels         the model (and optional effort) per connected-knowledge
//                      task; an absent task key means "use `defaultModel`".
//                      REPLACES WHOLESALE on a patch, so `{}` clears it.
//   graphEnabled       the connected-knowledge spending switch; OFF by default.
//   defaultModel       the model a task falls back to. It had no platform home
//                      (the old `providers.openai.defaultModel`); null = unset.
//   maxInputTokens     optional spend cap on the assembled prompt; null = the
//   maxOutputTokens    model's own window / output ceiling.
//   requestTimeoutMs   the backstop for a wedged connection (ten minutes).
//   reasoningEffort    how hard a reasoning model thinks; `none` omits the
//                      parameter, `xhigh` is clamped to `high` on the wire.
//   maxDocumentBytes   ceiling on one uploaded note source (25 MB).
//
// STORED NAMES AND BOUNDS ARE THE OLD ONES, field for field, and the `ai` key of
// the `global` row is the same row before and after: a saved `taskModels` survives
// with no rewrite. The merge is the platform default for an extension (the base
// merge, then each added field replaced when the patch carries it; `undefined`
// keeps the stored value, `null` is a value for the three nullable fields).
//
// ⚠ NO FIELD HERE CAN HOLD A KEY, and none may ever be added: every AI key is a
// user's own, in `user_ai_keys`. `ai-settings.extension.spec.ts` walks this schema
// for a secret-looking name.
// =============================================================================

export const kvoxAiStoredSchema = z.object({
  taskModels: aiTaskModelsSchema,
  graphEnabled: z.boolean(),
  defaultModel: z.string().trim().min(1).max(128).nullable(),
  maxInputTokens: z.number().int().min(256).max(2_000_000).nullable(),
  maxOutputTokens: z.number().int().min(64).max(200_000).nullable(),
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  reasoningEffort: z.enum(AI_REASONING_EFFORTS),
  maxDocumentBytes: z.number().int().min(65_536).max(268_435_456),
});

export type KvoxAiExtensionValue = z.infer<typeof kvoxAiStoredSchema>;

/** The added fields' defaults: kvox's defaults before the move to the platform namespace. */
export const KVOX_AI_EXTENSION_DEFAULTS: KvoxAiExtensionValue = {
  // EMPTY: every task uses `defaultModel` until an administrator picks one.
  taskModels: {},
  // OFF: turning it on spends every user's OWN key on automatic graph
  // extraction, which is an administrator's decision, never a default.
  graphEnabled: false,
  defaultModel: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  // Ten minutes. A streamed completion legitimately runs for minutes.
  requestTimeoutMs: 600_000,
  // `none`: the vendor's own default; the parameter is not sent at all.
  reasoningEffort: 'none',
  // 25 MB.
  maxDocumentBytes: 26_214_400,
};

export const KVOX_AI_SETTINGS_EXTENSION: SystemSettingsNamespaceExtension = {
  key: 'ai',
  storedSchema: kvoxAiStoredSchema,
  defaults: KVOX_AI_EXTENSION_DEFAULTS,
};
