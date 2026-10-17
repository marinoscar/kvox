import { BadRequestException, ConflictException } from '@nestjs/common';
import type { KvoxAiReason } from '@marinoscar/kvox-ai';

// =============================================================================
// This product's AI 409 / 400 bodies (issue #473; the mapper left with #579)
// =============================================================================
//
// This product's clients have always branched on a 409 or 400 with
// `details.reason` (`ai_not_configured`, `ai_key_missing`, `model_lacks_capability`,
// `graph_disabled`, `model_not_permitted`) when an AI route cannot run. The
// platform's target resolver hook (`KvoxAiTargetResolver`) and `/api/ai-tasks/*`
// answer with the exceptions below, so the wire contract the web and CLI read does
// not move.
//
// WHAT LEFT (#579). `mapAiError` (platform `AiError` code -> these bodies on a route,
// or a domain error class in a job) and the job classes it produced
// (`ai-errors.ts`) are gone: a model call now goes through `KVOX_AI`
// (`createKvoxAi` of `@marinoscar/kvox-ai`), whose one translation
// (`toKvoxAiError`) answers the port's `KvoxAiError` classes directly, proven equal
// to the old composition by `packages/kvox-ai/test/fixtures/error-parity.v1.json`.
// `PlatformAiRuntime` turns these exceptions into that class when the platform
// raises them under a model call (`translateHostError`).
//
// The response BODIES below are byte-for-byte the ones `AiTaskModelResolver`
// (`ai/ai-task-model-resolver.service.ts`) has always answered with: a message and
// `details.reason`, plus the task/model/missing detail where it had one.
//
// ⚠ Nothing here carries key material or model output.
// =============================================================================

// The five `details.reason` values the product's AI routes answer with are
// `KvoxAiReason` of `@marinoscar/kvox-ai` (moved there with `KvoxAiReadiness`, #579).

/**
 * The 409 reasons. `ai_key_invalid` is the search indexer's own spelling of a
 * rejected key (`SEARCH_REASON_KEY_INVALID`), used for the `search_embed` feature
 * only.
 */
export type KvoxAiConflictReason =
  | Exclude<KvoxAiReason, 'model_not_permitted'>
  | 'ai_key_invalid';

/** A 409 with `details.reason`, the shape every AI conflict has always had. */
export class KvoxAiConflict extends ConflictException {
  readonly reason: KvoxAiConflictReason;

  constructor(
    reason: KvoxAiConflictReason,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super({ message, details: { reason, ...details } });
    this.reason = reason;
  }
}

/**
 * A 400 with `details.reason`: `model_not_permitted` for a model the deployment has
 * not enabled (the default), `model_lacks_capability` for a save-time task model
 * that lacks a required capability.
 */
export class KvoxAiBadRequest extends BadRequestException {
  readonly reason: 'model_not_permitted' | 'model_lacks_capability';

  constructor(
    message: string,
    details: Record<string, unknown> = {},
    reason: 'model_not_permitted' | 'model_lacks_capability' = 'model_not_permitted',
  ) {
    super({ message, details: { reason, ...details } });
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// The sentences (copied from AiTaskModelResolver)
// ---------------------------------------------------------------------------

/** What a refusal calls the work, lower-cased mid-sentence. */
export interface KvoxAiSubject {
  /** `Graph extraction`, `Ask (graph agent)`; absent for a feature with no task. */
  label?: string;
}

function lower(subject: KvoxAiSubject): string {
  return (subject.label ?? 'this feature').toLowerCase();
}

function capitalised(subject: KvoxAiSubject): string {
  return subject.label ?? 'This feature';
}

/** `graph_disabled`. */
export function graphDisabledConflict(): KvoxAiConflict {
  return new KvoxAiConflict(
    'graph_disabled',
    'Connected knowledge is switched off for this deployment. An administrator can enable it in AI settings.',
  );
}

/** `ai_not_configured`. */
export function notConfiguredConflict(subject: KvoxAiSubject = {}): KvoxAiConflict {
  return new KvoxAiConflict(
    'ai_not_configured',
    `AI features are not configured for this deployment, so ${lower(subject)} cannot run. An administrator can enable them in AI settings.`,
  );
}

/** `ai_key_missing`. */
export function keyMissingConflict(subject: KvoxAiSubject = {}): KvoxAiConflict {
  return new KvoxAiConflict(
    'ai_key_missing',
    `You have not saved an AI API key. ${capitalised(subject)} runs on your own provider account, so it needs your key. Add one in your settings and try again.`,
  );
}

/** `model_lacks_capability`, naming the task, the model and what it lacks. */
export function lacksCapabilityConflict(input: {
  subject?: KvoxAiSubject;
  task: string;
  model: string;
  missing: readonly string[];
}): KvoxAiConflict {
  return new KvoxAiConflict(
    'model_lacks_capability',
    `The model "${input.model}" cannot be used for ${lower(input.subject ?? {})}: it lacks ${input.missing.join(', ')}. Choose a model that supports it, or ask an administrator to change the task model.`,
    { task: input.task, model: input.model, missing: [...input.missing] },
  );
}

/** `model_not_permitted`, listing the models the caller may choose. */
export function notPermittedBadRequest(input: {
  model: string | null;
  permitted: readonly string[];
  task?: string;
}): KvoxAiBadRequest {
  return new KvoxAiBadRequest(
    `The model "${input.model ?? 'none'}" is not one this deployment permits. Choose one of: ${input.permitted.join(', ')}.`,
    input.task !== undefined ? { task: input.task, model: input.model } : {},
  );
}
