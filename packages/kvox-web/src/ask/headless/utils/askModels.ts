/**
 * The model choices of the Ask composer: which models it offers, which one is
 * the default and which one a person picked for a conversation. Pure (the one
 * browser reference is `sessionStorage`, guarded), so the page and the entity
 * panel read one definition.
 */

import type { AskAiConfig, AskAiModel } from '../clients/askAiConfig.js';

const MODEL_KEY_PREFIX = 'ask.model.';

/**
 * The model a user picked for one conversation, if any (per tab).
 *
 * @param conversationId - The conversation, or none yet.
 * @returns The model id, or `null`.
 *
 * @stability experimental
 */
export function recallAskModel(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  try {
    return window.sessionStorage.getItem(MODEL_KEY_PREFIX + conversationId);
  } catch {
    return null;
  }
}

/**
 * Remembers (or, with `null`, forgets) the model picked for one conversation.
 *
 * @param conversationId - The conversation.
 * @param model - The model id, or `null` to forget.
 *
 * @stability experimental
 */
export function rememberAskModel(conversationId: string, model: string | null): void {
  try {
    if (model) window.sessionStorage.setItem(MODEL_KEY_PREFIX + conversationId, model);
    else window.sessionStorage.removeItem(MODEL_KEY_PREFIX + conversationId);
  } catch {
    // Storage blocked (private mode, an embedded preview): the choice lasts
    // for this page only, which is the honest fallback.
  }
}

/**
 * The models Ask may use: tool-capable ones (#360's `toolCalling`).
 *
 * @param config - The viewer's AI availability, when known.
 * @returns The models to offer.
 *
 * @stability experimental
 */
export function askModelOptions(config: AskAiConfig | null | undefined): AskAiModel[] {
  return (config?.models ?? []).filter((model) => model.toolCalling !== false);
}

/**
 * The administrator's `graph.agent` model, else the deployment default.
 *
 * @param config - The viewer's AI availability, when known.
 * @returns The model id, or `null`.
 *
 * @stability experimental
 */
export function askDefaultModel(config: AskAiConfig | null | undefined): string | null {
  return config?.taskModels?.['graph.agent']?.model ?? config?.defaultModel ?? null;
}
