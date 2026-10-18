import type { KvoxAiModelState, KvoxTaskModelSource } from '@marinoscar/kvox-ai';

// =============================================================================
// What both bindings are configured with (issue #580, part 2)
// =============================================================================
//
// The harness-parity check builds the SAME task-model state twice: as a static
// `KvoxTaskModelSource` for the direct (Desktop-style) binding, and as the web
// edition's system-settings value plus `ai_models` rows. These constants are the
// single description both are built from, so a difference between the two
// bindings' requests can only come from a binding, never from the state.
//
// Different tasks run on different models and efforts ON PURPOSE: a binding that
// ignored `ai.taskModels` (or its per-task effort) would send the default model
// and fail the comparison.
// =============================================================================

/**
 * The provider both bindings run on.
 *
 * @stability experimental
 */
export const PARITY_PROVIDER = 'openai';

/**
 * One model of the parity state.
 *
 * @stability experimental
 */
export interface ParityModel {
  /** The provider's model id. */
  id: string;
  /** The context window in tokens. */
  contextWindow: number;
  /** The output ceiling in tokens. */
  maxOutputTokens: number;
}

/**
 * The enabled models: all structured-output and tool-calling capable.
 *
 * @stability experimental
 */
export const PARITY_MODELS: readonly ParityModel[] = Object.freeze([
  { id: 'gpt-parity', contextWindow: 128_000, maxOutputTokens: 16_000 },
  { id: 'gpt-parity-extract', contextWindow: 200_000, maxOutputTokens: 32_000 },
  { id: 'gpt-parity-adjudicate', contextWindow: 64_000, maxOutputTokens: 8_000 },
  { id: 'gpt-parity-agent', contextWindow: 128_000, maxOutputTokens: 12_000 },
]);

/**
 * The deployment's default model and effort (notes generation runs on them).
 *
 * @stability experimental
 */
export const PARITY_DEFAULT_MODEL = 'gpt-parity';

/**
 * The deployment-wide reasoning effort.
 *
 * @stability experimental
 */
export const PARITY_DEFAULT_EFFORT = 'low' as const;

/**
 * The per-task models and efforts (`ai.taskModels`).
 *
 * @stability experimental
 */
export const PARITY_TASK_MODELS = Object.freeze({
  'graph.extract': { model: 'gpt-parity-extract', reasoningEffort: 'medium' },
  'graph.adjudicate': { model: 'gpt-parity-adjudicate', reasoningEffort: 'high' },
  'graph.agent': { model: 'gpt-parity-agent', reasoningEffort: 'low' },
} as const);

/**
 * The user every parity call is made for. Host-specific, never compared.
 *
 * @stability experimental
 */
export const PARITY_USER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The task-model state of a parity run: AI on, the graph switch on, the models above, the tasks above.
 *
 * @returns a fresh state.
 * @stability experimental
 */
export function parityModelState(): KvoxAiModelState {
  return {
    provider: PARITY_PROVIDER,
    models: PARITY_MODELS.map((m) => ({
      id: m.id,
      label: m.id,
      structuredOutput: true,
      toolCalling: true,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
    })),
    policy: {
      enabled: true,
      provider: PARITY_PROVIDER,
      defaultModel: PARITY_DEFAULT_MODEL,
      graphEnabled: true,
      taskModels: { ...PARITY_TASK_MODELS },
      reasoningEffort: PARITY_DEFAULT_EFFORT,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

/**
 * The same state as a static task-model source, for `createKvoxAi({ taskModels })` of the direct binding.
 *
 * @returns a source whose `load()` always answers {@link parityModelState}.
 * @stability experimental
 */
export function parityTaskModelSource(): KvoxTaskModelSource {
  return { load: async () => parityModelState() };
}
