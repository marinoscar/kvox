import { AiError } from '@marinoscar/platform-api/ai';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import type { KvoxAiFeatureId } from '../features/index.js';
import type { KvoxAiReadiness } from '../types/index.js';

// =============================================================================
// The one translation into KvoxAiError (issue #579)
// =============================================================================
//
// Every failure that leaves `createKvoxAi` is a `KvoxAiError` (or its
// `KvoxAiBudgetError` subclass) of `@marinoscar/kvox-api/ports`, with one of the
// EXISTING `KvoxAiErrorClass` values. This file is the one place a thrown value
// becomes one. Before #579 the web edition did it in two hops: `mapAiError`
// (`apps/api/src/ai-port/kvox-ai-errors.ts`: platform `AiError` code -> this app's
// HTTP conflicts and job error classes) and `toKvoxAiError` of the port adapter
// (`apps/api/src/platform-kvox/ai/platform-kvox-ai.adapter.ts`: those -> the port
// class). {@link toKvoxAiError} is the COMPOSITION of the two, written as one
// table, and `test/fixtures/error-parity.v1.json` (captured from the old path,
// every `AiErrorCode` by call kind and context) proves it answers the same.
//
// WHY THE CONTEXT MATTERS. The old first hop answered a route and a queue job
// differently (a route got the product's 409/400 bodies, a job got a domain error
// class), and the second hop read the class off whatever came back. So the same
// platform code lands on a different port class inside a job:
//
//   | Platform code                                   | Route (no jobId)   | Job (jobId)            |
//   |---|---|---|
//   | AI_DISABLED, AI_PROVIDER_DISABLED               | not_configured     | other                  |
//   | AI_KEY_REQUIRED                                 | key_missing        | auth                   |
//   | AI_KEY_INVALID                                  | key_missing (auth for search_embed) | auth  |
//   | AI_MODEL_NOT_ENABLED, AI_MODEL_NOT_REACHABLE,   | capability         | other                  |
//   |   AI_CAPABILITY_UNSUPPORTED                     |                    |                        |
//   | AI_RATE_LIMITED                                 | rate_limit         | rate_limit + retryAfterMs |
//   | AI_CONTENT_FILTERED                             | refusal            | refusal                |
//   | AI_STRUCTURED_OUTPUT_INVALID                    | other              | invalid_output         |
//   | AI_INVALID_REQUEST, AI_TOOL_DISABLED, any other | other              | other (timeout when the message is the timeout sentence) |
//
// A structured call reads `AI_STRUCTURED_OUTPUT_INVALID` itself first (the
// truncation heuristic in `port/`), so the row above applies to the other calls.
//
// WHAT IS NOT HERE. A host's own exceptions (the web edition's 409 bodies from its
// target resolver, the queue's `RateLimitError`) are the host runtime's to
// translate before they leave it: `KvoxAiRuntime` throws a `KvoxAiError` for
// them, which passes through unchanged. So this file imports no platform job
// class and no Nest exception.
//
// ⚠ NO KEY IN ANY MESSAGE. Every message that leaves goes through {@link scrub},
// which removes anything shaped like a provider credential, as a backstop: the
// platform's own messages carry none.
// =============================================================================

/** Strings shaped like a provider credential. */
const KEY_SHAPES: readonly RegExp[] = [/sk-[A-Za-z0-9_-]{10,}/g, /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+/g];

/** The sentence a request-timeout backstop throws, which the old second hop read as `timeout`. */
const TIMEOUT_SENTENCE = /^The AI request timed out/;

/**
 * Removes anything shaped like a provider key (`sk-...`, `ghp_...`, `gho_...`,
 * `github_pat_...`) from a text.
 *
 * @param text - a message about to leave the port.
 * @returns the text with every key-shaped run replaced by `[redacted]`.
 * @stability experimental
 */
export function scrub(text: string): string {
  return KEY_SHAPES.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text);
}

/**
 * What the translation needs to know about the failed call.
 *
 * @stability experimental
 */
export interface KvoxAiErrorContext {
  /** The registered feature the call was made for (`search_embed` spells a rejected key apart). */
  feature: KvoxAiFeatureId;
  /** True inside a queue job (the call carried a `jobId`); false on a route. */
  inJob: boolean;
}

/**
 * True for an `Error`, or for an error-shaped value such as a `DOMException`
 * (which is not an `Error` across every runtime realm).
 *
 * @param value - anything caught.
 * @returns whether it carries a string `name` and `message`.
 * @stability experimental
 */
export function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { name?: unknown }).name === 'string' &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}

/**
 * Translates whatever a runtime or provider threw into the one error type the
 * port promises.
 *
 * @remarks
 * A `KvoxAiError` is returned as it is (a runtime that already classified its own
 * failure). A platform `AiError` is classified by its code and the call's context
 * (the table in this file's header). Anything else is `timeout` when it is named
 * `TimeoutError` or carries the timeout sentence, and `other` (retryable)
 * otherwise. The message is always scrubbed.
 *
 * @param error - the thrown value.
 * @param ctx - the call's feature and whether it ran inside a job.
 * @returns a `KvoxAiError` of an existing class.
 * @stability experimental
 */
export function toKvoxAiError(error: unknown, ctx: KvoxAiErrorContext): KvoxAiError {
  if (error instanceof KvoxAiError) return error;
  if (AiError.isAiError(error)) return fromAiError(error, ctx);

  const message = scrub(
    isErrorLike(error) ? error.message : typeof error === 'string' ? error : 'Unknown AI failure',
  );
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || TIMEOUT_SENTENCE.test(message)) return new KvoxAiError('timeout', message);
  return new KvoxAiError('other', message);
}

/** A platform `AiError`, by code, route or job. */
function fromAiError(err: AiError, ctx: KvoxAiErrorContext): KvoxAiError {
  const message = scrub(err.message);

  if (!ctx.inJob) {
    switch (err.code) {
      case 'AI_DISABLED':
      case 'AI_PROVIDER_DISABLED':
        return new KvoxAiError('not_configured', message);
      case 'AI_KEY_REQUIRED':
        return new KvoxAiError('key_missing', message);
      case 'AI_KEY_INVALID':
        // The search indexer's own spelling of a rejected key (`ai_key_invalid`) read as `auth`.
        return new KvoxAiError(ctx.feature === 'search_embed' ? 'auth' : 'key_missing', message);
      case 'AI_MODEL_NOT_ENABLED':
      case 'AI_MODEL_NOT_REACHABLE':
      case 'AI_CAPABILITY_UNSUPPORTED':
        return new KvoxAiError('capability', message);
      case 'AI_RATE_LIMITED':
        // A route answered the platform's own 429, which carried no retry hint across.
        return new KvoxAiError('rate_limit', message);
      case 'AI_CONTENT_FILTERED':
        return new KvoxAiError('refusal', message);
      default:
        // AI_INVALID_REQUEST, AI_TOOL_DISABLED, AI_STRUCTURED_OUTPUT_INVALID, the
        // unavailable codes and any code a later platform release adds.
        return new KvoxAiError('other', message);
    }
  }

  switch (err.code) {
    case 'AI_DISABLED':
    case 'AI_PROVIDER_DISABLED':
    case 'AI_MODEL_NOT_ENABLED':
    case 'AI_MODEL_NOT_REACHABLE':
    case 'AI_CAPABILITY_UNSUPPORTED':
    case 'AI_INVALID_REQUEST':
    case 'AI_TOOL_DISABLED':
      return new KvoxAiError('other', message);
    case 'AI_KEY_REQUIRED':
    case 'AI_KEY_INVALID':
      return new KvoxAiError('auth', message);
    case 'AI_RATE_LIMITED':
      // The queue defers on the provider's own hint.
      return new KvoxAiError('rate_limit', message, err.retryAfterMs);
    case 'AI_CONTENT_FILTERED':
      return new KvoxAiError('refusal', message);
    case 'AI_STRUCTURED_OUTPUT_INVALID':
      return new KvoxAiError('invalid_output', message);
    default:
      // AI_PROVIDER_UNAVAILABLE, AI_STORAGE_UNAVAILABLE, anything else: retryable.
      return new KvoxAiError(TIMEOUT_SENTENCE.test(message) ? 'timeout' : 'other', message);
  }
}

/**
 * The port error for a feature whose readiness says it cannot run.
 *
 * @param readiness - the not-ready readiness (its `reason`).
 * @returns `key_missing`, `capability` or `not_configured`, with the product's sentence.
 * @stability experimental
 */
export function refusalFor(readiness: Pick<KvoxAiReadiness, 'reason'>): KvoxAiError {
  switch (readiness.reason) {
    case 'ai_key_missing':
      return new KvoxAiError('key_missing', 'You have not saved an AI API key. Add one in your settings and try again.');
    case 'model_lacks_capability':
    case 'model_not_permitted':
      return new KvoxAiError('capability', 'The chosen model cannot be used for this feature.');
    case 'graph_disabled':
      return new KvoxAiError('not_configured', 'Connected knowledge is switched off for this deployment.');
    default:
      return new KvoxAiError('not_configured', 'AI features are not configured for this deployment.');
  }
}
