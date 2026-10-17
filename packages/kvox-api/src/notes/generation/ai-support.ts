import { ConflictException, BadRequestException } from '@nestjs/common';

import { OUTPUT_RESERVE_TOKENS, computeTokenBudget, type TokenBudget } from '../../core/index.js';
import type { KvoxAiTarget, KvoxSettingsPort } from '../../ports/index.js';

// =============================================================================
// What a note needs from the AI port besides the call itself (issue #49; moved onto the
// ports by issue #495, epic #491)
// =============================================================================
//
// `KVOX_AI.resolveTask` says which model a feature runs on and that model's OWN context
// window and output ceiling. The deployment's two spend caps (`ai.maxInputTokens`,
// `ai.maxOutputTokens`) are not part of a model: they are the administrator's policy, read
// through the settings port from the `ai` system-settings namespace. The token budget
// (docs/specs/notes.md §3.3) is computed from both, in one place, so the request-time check
// (`POST /api/notes`) and the job reach one number.
//
// ⚠ NO KEY, NO PROMPT TEXT, NO PROVIDER OBJECT PASSES THROUGH HERE. The helpers take numbers
// and return numbers. NO DEFAULT FOR A POLICY VALUE IS HARD-CODED HERE: the host's settings
// own `ai.maxDocumentBytes` and the two caps.
// =============================================================================

/** The AI feature name a note generation is made for. @stability experimental */
export const NOTE_GENERATE_AI_FEATURE = 'notes.generate';

/** The AI feature name a note titling is made for. @stability experimental */
export const NOTE_TITLE_AI_FEATURE = 'notes.title';

/** The `ai` system-settings namespace, as far as the notes slice reads it. @stability experimental */
export interface NotesAiPolicy {
  /** `ai.maxInputTokens`: the deployment's input ceiling, or `null` for the model's own. */
  maxInputTokens?: number | null;
  /** `ai.maxOutputTokens`: the deployment's output ceiling, or `null` for the model's own. */
  maxOutputTokens?: number | null;
  /** `ai.maxDocumentBytes`: the largest source document an upload may be. */
  maxDocumentBytes?: number;
}

/**
 * The deployment's two spend caps. `null` means "the model's own limit governs".
 *
 * @stability experimental
 */
export interface AiTokenCaps {
  /** `ai.maxInputTokens`. */
  maxInputTokens: number | null;
  /** `ai.maxOutputTokens`. */
  maxOutputTokens: number | null;
}

/**
 * Reads the `ai` namespace through the settings port.
 *
 * @param settings - the settings port.
 * @returns the namespace's value.
 * @stability experimental
 */
export async function readAiPolicy(settings: KvoxSettingsPort): Promise<NotesAiPolicy> {
  return (await settings.readSystem<NotesAiPolicy>('ai')).value ?? {};
}

/**
 * Reads the two spend caps from the `ai` namespace.
 *
 * @param settings - the settings port.
 * @returns the caps.
 * @stability experimental
 */
export async function readAiTokenCaps(settings: KvoxSettingsPort): Promise<AiTokenCaps> {
  const policy = await readAiPolicy(settings);

  return { maxInputTokens: policy.maxInputTokens ?? null, maxOutputTokens: policy.maxOutputTokens ?? null };
}

/**
 * The budget one generation runs under, or `null` when the model's context window is
 * unknown (nothing can be checked against a number nobody can supply).
 *
 * A model whose output ceiling is unknown (0) falls back to the output reserve, the smallest
 * ceiling the budget would hold back anyway, so an unknown ceiling never makes a request
 * larger than the reserve the input was sized for.
 *
 * @param target - the resolved model.
 * @param caps - the deployment's spend caps.
 * @returns the budget, or `null`.
 * @stability experimental
 */
export function budgetFromTarget(target: KvoxAiTarget, caps: AiTokenCaps): TokenBudget | null {
  if (!(target.contextWindowTokens > 0)) return null;

  return computeTokenBudget({
    contextWindowTokens: target.contextWindowTokens,
    modelMaxOutputTokens:
      target.maxOutputTokens > 0
        ? target.maxOutputTokens
        : Math.min(target.contextWindowTokens, OUTPUT_RESERVE_TOKENS),
    policyMaxOutputTokens: caps.maxOutputTokens,
    policyMaxInputTokens: caps.maxInputTokens,
    // #436: the effort THIS call sends, so a typed output cap gets its reasoning headroom on top.
    reasoningEffort: target.reasoningEffort ?? 'none',
  });
}

/**
 * The vendor's display name, for a notification. Unknown ids are shown as they are.
 *
 * @param providerId - the provider id, or `null`.
 * @returns the name.
 * @stability experimental
 */
export function providerLabelOf(providerId: string | null): string {
  if (providerId === null) return 'the AI provider';

  return providerId === 'openai' ? 'OpenAI' : providerId;
}

/** The reasons a route answers an unready AI feature with (`details.reason`). @stability experimental */
export type NoteAiConflictReason = 'ai_not_configured' | 'ai_key_missing' | 'model_lacks_capability';

/**
 * A 409 with `details.reason`, the shape every AI conflict of the product has always had.
 *
 * @stability experimental
 */
export class NoteAiConflict extends ConflictException {
  /** Why the feature cannot run. */
  readonly reason: NoteAiConflictReason;

  /**
   * @param reason - the `details.reason` value.
   * @param message - the sentence to show.
   */
  constructor(reason: NoteAiConflictReason, message: string) {
    super({ message, details: { reason } });
    this.reason = reason;
  }
}

/**
 * A 400 for a model the deployment has not enabled (`details.reason: model_not_permitted`).
 *
 * @param model - the model the caller asked for.
 * @returns the exception.
 * @stability experimental
 */
export function notPermittedBadRequest(model: string | null): BadRequestException {
  return new BadRequestException({
    message: `The model "${model ?? 'none'}" is not one this deployment permits. Choose another model, or leave it blank to use the deployment default.`,
    details: { reason: 'model_not_permitted' },
  });
}

/**
 * The generation cannot run because of what was asked for, not because of the provider: the
 * source is gone, empty or still being read, or the template no longer exists. The job records
 * it as a refusal ("This request") and does not retry. The message is written for a person.
 *
 * @stability experimental
 */
export class NoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteInputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
