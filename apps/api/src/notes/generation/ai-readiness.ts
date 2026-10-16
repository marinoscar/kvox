import {
  computeTokenBudget,
  OUTPUT_RESERVE_TOKENS,
  type TokenBudget,
} from '../../ai-port/ai-token-budget';
import type { KvoxAiReadiness } from '../../ai-port/kvox-ai';
import type { KvoxAiSettings } from '../../ai-port/kvox-ai-settings';

// =============================================================================
// What a note (or a name check) needs from the AI port besides the call itself
// =============================================================================
//
// `KvoxAi.readiness()` says whether a feature can run, on which model, and the
// model's OWN context window and output ceiling. The deployment's two spend caps
// (`ai.maxInputTokens`, `ai.maxOutputTokens`) are not part of a model: they are
// the administrator's policy, read from the `ai` system-settings namespace. The
// token budget (docs/specs/notes.md §3.3) is computed from both, in one place,
// so the request-time check (`POST /api/notes`) and the job reach one number.
//
// ⚠ NO KEY, NO PROMPT TEXT, NO PROVIDER OBJECT PASSES THROUGH HERE. The helpers
// take numbers and return numbers.
// =============================================================================

/** The deployment's two spend caps. `null` means "the model's own limit governs". */
export interface AiTokenCaps {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

/** Reads the two spend caps from the `ai` namespace (extended by this app). */
export async function readAiTokenCaps(settings: KvoxAiSettings): Promise<AiTokenCaps> {
  const policy = await settings.get();

  return { maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens };
}

/**
 * The budget one generation runs under, or `null` when the model's context
 * window is unknown (nothing can be checked against a number nobody can supply).
 *
 * A model whose output ceiling is unknown falls back to the output reserve, the
 * smallest ceiling the budget would hold back anyway, so an unknown ceiling
 * never makes a request larger than the reserve the input was sized for.
 */
export function budgetFromReadiness(
  readiness: Pick<KvoxAiReadiness, 'contextWindowTokens' | 'maxOutputTokens' | 'reasoningEffort'>,
  caps: AiTokenCaps,
): TokenBudget | null {
  if (readiness.contextWindowTokens === null) return null;

  return computeTokenBudget({
    contextWindowTokens: readiness.contextWindowTokens,
    modelMaxOutputTokens:
      readiness.maxOutputTokens ?? Math.min(readiness.contextWindowTokens, OUTPUT_RESERVE_TOKENS),
    policyMaxOutputTokens: caps.maxOutputTokens,
    policyMaxInputTokens: caps.maxInputTokens,
    // #436: the effort THIS call sends, so a typed output cap gets its reasoning
    // headroom on top.
    reasoningEffort: readiness.reasoningEffort,
  });
}

/** The vendor's display name, for a notification. Unknown ids are shown as they are. */
export function providerLabelOf(providerId: string | null): string {
  if (providerId === null) return 'the AI provider';

  return providerId === 'openai' ? 'OpenAI' : providerId;
}
