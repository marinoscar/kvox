// =============================================================================
// The GitHub Copilot model catalog: a small FALLBACK list (issue #581)
// =============================================================================
//
// What the adapter knows about a Copilot model when the live listing
// (`transport.listModels()`) does not say: the context window, the output
// ceiling and how structured output is held (`native`: the runtime constrains
// the answer to `responseSchema`; `prompted`: it cannot, so kvox-ai puts the
// schema in the prompt and repairs once).
//
// ⚠ THESE NUMBERS ARE CONSERVATIVE FALLBACKS, NOT FACTS. The live listing's
// limits always win (`classifyModel` reads them first). Re-verify the list
// against a live `listModels()` when bumping COPILOT_CATALOG_VERSION.
// ⚠ AN UNKNOWN MODEL IS `prompted` unless its id looks like an OpenAI one
// (`gpt-*`, `o<digit>*`): the prompted path works on every model, the native one
// only where the runtime enforces the schema.
// =============================================================================

/**
 * The date the fallback catalog was last checked against a live listing.
 *
 * @stability experimental
 */
export const COPILOT_CATALOG_VERSION = '2026-10-17';

/**
 * One fallback catalog entry.
 *
 * @stability experimental
 */
export interface CopilotCatalogEntry {
  /** The Copilot model id. */
  id: string;
  /** What a picker shows. */
  label: string;
  /** The context window in tokens (a conservative fallback). */
  contextWindow: number;
  /** The output ceiling in tokens (a conservative fallback). */
  maxOutputTokens: number;
  /** How structured output is held for this model. */
  structuredOutputMode: 'native' | 'prompted';
}

/**
 * The fallback catalog, frozen. The live listing's limits win over these numbers.
 *
 * @stability experimental
 */
export const COPILOT_CATALOG: readonly CopilotCatalogEntry[] = Object.freeze(
  [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', contextWindow: 128_000, maxOutputTokens: 16_384, structuredOutputMode: 'native' },
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 128_000, maxOutputTokens: 16_384, structuredOutputMode: 'native' },
    {
      id: 'claude-sonnet-4.5',
      label: 'Claude Sonnet 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      structuredOutputMode: 'prompted',
    },
    {
      id: 'claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      structuredOutputMode: 'prompted',
    },
  ].map((entry) => Object.freeze(entry as CopilotCatalogEntry)),
);

/** The id shape of a model the runtime holds to a schema natively. */
const NATIVE_ID = /^(gpt-|o\d)/i;

/**
 * The fallback entry of a model id, or `undefined`.
 *
 * @param modelId - the Copilot model id.
 * @param catalog - the catalog to read. Default {@link COPILOT_CATALOG}.
 * @returns the entry, or `undefined`.
 * @stability experimental
 */
export function copilotCatalogEntry(
  modelId: string,
  catalog: readonly CopilotCatalogEntry[] = COPILOT_CATALOG,
): CopilotCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === modelId);
}

/**
 * How structured output is held for a Copilot model: the catalog entry's mode,
 * else `native` for an OpenAI-shaped id (`gpt-*`, `o<digit>*`), else `prompted`.
 *
 * @example
 * ```ts
 * copilotStructuredOutputMode('gpt-5-mini');       // 'native'
 * copilotStructuredOutputMode('claude-sonnet-4.5'); // 'prompted'
 * copilotStructuredOutputMode('gemini-2.5-pro');    // 'prompted' (unknown: the path that works everywhere)
 * ```
 *
 * @param modelId - the Copilot model id.
 * @param catalog - the catalog to read. Default {@link COPILOT_CATALOG}.
 * @returns `native` or `prompted`.
 * @stability experimental
 */
export function copilotStructuredOutputMode(
  modelId: string,
  catalog: readonly CopilotCatalogEntry[] = COPILOT_CATALOG,
): 'native' | 'prompted' {
  const entry = copilotCatalogEntry(modelId, catalog);
  if (entry !== undefined) return entry.structuredOutputMode;
  return NATIVE_ID.test(modelId) ? 'native' : 'prompted';
}
