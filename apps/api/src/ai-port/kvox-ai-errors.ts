import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiError } from '@marinoscar/platform-api/ai';

import {
  AiAuthError,
  AiInputError,
  AiRefusedError,
  AiStructuredOutputError,
  RateLimitError,
} from './ai-errors';
import type { KvoxAiFeatureId } from './features';

// =============================================================================
// Platform AiError -> this app's wire codes and job error classes (issue #473)
// =============================================================================
//
// The platform's AI slice throws `AiError` with a platform code
// (`AI_KEY_REQUIRED`, `AI_MODEL_NOT_ENABLED`, ...). This product's clients and
// job handlers have always branched on something else: a 409 or 400 with
// `details.reason` (`ai_not_configured`, `ai_key_missing`, `model_lacks_capability`,
// `graph_disabled`, `model_not_permitted`) on a route, and a small set of domain
// error classes (`AiAuthError`, `AiInputError`, ...) in a job. `mapAiError` is the
// one place the two vocabularies meet, so a caller never inspects an `AiError`
// code itself and the wire contract the web and CLI read does not move.
//
// The response BODIES below are byte-for-byte the ones `AiTaskModelResolver`
// (`ai/ai-task-model-resolver.service.ts`) has always answered with: a message and
// `details.reason`, plus the task/model/missing detail where it had one.
//
// ⚠ Nothing here carries key material or model output. The only free text is the
// `AiError`'s own message, which the platform keeps free of both.
// =============================================================================

/** The five `details.reason` values the product's AI routes answer with. */
export type KvoxAiReason =
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'model_not_permitted'
  | 'model_lacks_capability'
  | 'graph_disabled';

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

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

export interface MapAiErrorContext {
  /** The registered feature the failed call was made for. */
  feature: KvoxAiFeatureId;
  /** True inside a queue job (a domain error class); false on an HTTP route. */
  inJob: boolean;
}

/** The same body the platform built, under the status this product answers with. */
function sameBody(err: AiError, status: number): HttpException {
  return err.getStatus() === status ? err : new HttpException(err.toJSON(), status);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown AI failure');
}

/**
 * Translate whatever a platform AI call threw into what this product's callers
 * branch on.
 *
 * On a route (`inJob: false`) the result is an `HttpException`; in a job
 * (`inJob: true`) it is one of the domain error classes in `ai-errors.ts` (or a
 * plain `Error`, which the queue retries, for a transient provider failure). An
 * error that is not an `AiError` comes back unchanged: the mapper only owns the
 * platform's vocabulary.
 *
 * | Platform code | Route | Job |
 * |---|---|---|
 * | `AI_DISABLED`, `AI_PROVIDER_DISABLED` | 409 `ai_not_configured` | `AiInputError` |
 * | `AI_KEY_REQUIRED` | 409 `ai_key_missing` | `AiAuthError` |
 * | `AI_KEY_INVALID` | 409 `ai_key_missing` (`ai_key_invalid` for search) | `AiAuthError` |
 * | `AI_MODEL_NOT_ENABLED`, `AI_MODEL_NOT_REACHABLE` | 400 `model_not_permitted` | `AiInputError` |
 * | `AI_CAPABILITY_UNSUPPORTED` | 409 `model_lacks_capability` | `AiInputError` |
 * | `AI_RATE_LIMITED` | 429 | `RateLimitError` with `retryAfterMs` |
 * | `AI_CONTENT_FILTERED` | 422 | `AiRefusedError` |
 * | `AI_INVALID_REQUEST`, `AI_TOOL_DISABLED` | 400 | `AiInputError` |
 * | `AI_STRUCTURED_OUTPUT_INVALID` | 502 | `AiStructuredOutputError('invalid_json')` |
 * | `AI_PROVIDER_UNAVAILABLE`, `AI_STORAGE_UNAVAILABLE`, any other | 503 | plain `Error` |
 */
export function mapAiError(err: unknown, ctx: MapAiErrorContext): Error {
  if (!AiError.isAiError(err)) return asError(err);

  return ctx.inJob ? mapForJob(err) : mapForRoute(err, ctx.feature);
}

function mapForRoute(err: AiError, feature: KvoxAiFeatureId): Error {
  switch (err.code) {
    case 'AI_DISABLED':
    case 'AI_PROVIDER_DISABLED':
      return new KvoxAiConflict('ai_not_configured', err.message);
    case 'AI_KEY_REQUIRED':
      return new KvoxAiConflict('ai_key_missing', err.message);
    case 'AI_KEY_INVALID':
      return new KvoxAiConflict(
        feature === 'search_embed' ? 'ai_key_invalid' : 'ai_key_missing',
        err.message,
      );
    case 'AI_MODEL_NOT_ENABLED':
    case 'AI_MODEL_NOT_REACHABLE':
      return new KvoxAiBadRequest(err.message);
    case 'AI_CAPABILITY_UNSUPPORTED':
      return new KvoxAiConflict('model_lacks_capability', err.message);
    case 'AI_RATE_LIMITED':
      return sameBody(err, 429);
    case 'AI_CONTENT_FILTERED':
      return sameBody(err, 422);
    case 'AI_INVALID_REQUEST':
    case 'AI_TOOL_DISABLED':
      return sameBody(err, 400);
    case 'AI_STRUCTURED_OUTPUT_INVALID':
      return sameBody(err, 502);
    default:
      // AI_PROVIDER_UNAVAILABLE, AI_STORAGE_UNAVAILABLE and any code a later
      // platform release adds: a transient or unclassified failure.
      return err.getStatus() === 503
        ? err
        : new ServiceUnavailableException(err.toJSON());
  }
}

function mapForJob(err: AiError): Error {
  switch (err.code) {
    case 'AI_DISABLED':
    case 'AI_PROVIDER_DISABLED':
    case 'AI_MODEL_NOT_ENABLED':
    case 'AI_MODEL_NOT_REACHABLE':
    case 'AI_CAPABILITY_UNSUPPORTED':
    case 'AI_INVALID_REQUEST':
    case 'AI_TOOL_DISABLED':
      return new AiInputError(err.message);
    case 'AI_KEY_REQUIRED':
    case 'AI_KEY_INVALID':
      return new AiAuthError(err.message);
    case 'AI_RATE_LIMITED':
      return new RateLimitError(err.message, err.retryAfterMs);
    case 'AI_CONTENT_FILTERED':
      return new AiRefusedError(err.message);
    case 'AI_STRUCTURED_OUTPUT_INVALID':
      return new AiStructuredOutputError(err.message, 'invalid_json');
    default:
      // AI_PROVIDER_UNAVAILABLE, AI_STORAGE_UNAVAILABLE, anything else: a plain
      // Error is not a domain error, so the queue retries it.
      return new Error(err.message);
  }
}
