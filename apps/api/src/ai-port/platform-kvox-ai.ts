import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiError, AiService, type AiUserClient } from '@marinoscar/platform-api/ai';

import { PrismaService } from '../prisma/prisma.service';
import { AiInputError, AiRefusedError, AiStructuredOutputError } from './ai-errors';
import { countTokens } from './count-tokens';
import { EmbeddingShapeError, KVOX_EMBEDDING } from './embedding-catalog';
import { KVOX_EMBEDDING_FEATURES, KVOX_FEATURE_TASK, type KvoxAiFeatureId } from './features';
import type {
  JsonSchema,
  KvoxAi,
  KvoxAiCallBase,
  KvoxAiReadiness,
  KvoxChatEvent,
  KvoxChatRequest,
  KvoxEmbeddingCapability,
  KvoxReasoningEffort,
  KvoxTextEvent,
  KvoxUsage,
} from './kvox-ai';
import { mapAiError, type KvoxAiReason } from './kvox-ai-errors';
import { KVOX_AI_EXTENSION_DEFAULTS } from '../platform/ai/ai-settings.extension';
import { KvoxAiSettings } from './kvox-ai-settings';
import {
  KVOX_AI_PROVIDER,
  KvoxAiTargetResolver,
  type KvoxAiResolverState,
} from './kvox-ai-target-resolver';
import { chooseTaskModel, toPlatformReasoningEffort } from './task-models';

// =============================================================================
// PlatformKvoxAi: `KvoxAi` over the platform `AiService.forUser` (issue #475)
// =============================================================================
//
// THE ONE ADAPTER BETWEEN THIS APP AND THE PLATFORM'S AI RUNTIME. A caller hands it
// a user, a registered feature and a prompt; the platform runs every gate, resolves
// the user's own key, records one usage row per round trip and traces the call.
// Nothing here ever holds a key, and nothing here logs a prompt.
//
// WHAT THIS CLASS OWNS, AND WHAT IT DOES NOT.
//   • It decides the reasoning effort (`none` omits the parameter, `xhigh` is
//     clamped to `high`), because the resolver answers only (provider, model).
//   • It owns the request timeout (`ai.requestTimeoutMs`), combined with the
//     caller's signal.
//   • It translates every failure through `mapAiError` (platform `AiError` ->
//     this app's job error classes or wire codes) and adds the four
//     structured-output rules below.
//   • It does NOT budget tokens (`assertWithinBudget` stays the caller's, fed by
//     `readiness()` and `countTokens()`), register the throttle key (the handler
//     does, immediately before the call) or pick a model (the resolver does).
//
// STRUCTURED OUTPUT, and what the platform cannot tell us.
//   • A caller may pass a strict JSON Schema (`jsonSchema`) next to its Zod
//     validator. The platform wants Zod, so the JSON Schema is turned into Zod with
//     `z.fromJSONSchema` (the call the platform's own HTTP layer makes) and sent as
//     the constrained schema; the parsed value is then validated AGAIN with the
//     caller's schema, so this app's validation is unchanged. A JSON Schema Zod
//     cannot round-trip falls back to the caller's schema, `strict: true` kept.
//   • ⚠ THE PLATFORM LOSES THE FINISH REASON ON A BAD STRUCTURED ANSWER. Its
//     adapters parse the text whatever the finish reason was, so a truncated answer
//     arrives as `AI_STRUCTURED_OUTPUT_INVALID` with a "not valid JSON" issue and no
//     `length` marker. Under a strict schema the vendor guarantees well-formed JSON
//     unless it was cut off, so a not-valid-JSON failure of a call that set a
//     `maxOutputTokens` ceiling is reported as `AiStructuredOutputError('truncated')`
//     (the case the extraction retry exists for). A schema mismatch is
//     `'invalid_json'`. If a later platform release surfaces `finishReason:
//     'length'` on the response, that is honoured first.
//
// PLATFORM-ADOPTION-SHIM(#475): the truncation heuristic above, until the platform's
// `AI_STRUCTURED_OUTPUT_INVALID` error carries the response's finish reason.
// =============================================================================

/** The conservative floor for a model whose `ai_models` row carries no numbers. */
const FLOOR_CONTEXT_WINDOW_TOKENS = 128_000;
const FLOOR_MAX_OUTPUT_TOKENS = 16_384;

/** The platform `AiError` code of a structured answer that is not usable. */
const STRUCTURED_INVALID = 'AI_STRUCTURED_OUTPUT_INVALID';

/** A `signal` plus what is needed to tell a timeout from a caller abort afterwards. */
interface CallGuard {
  signal: AbortSignal;
  timeoutMs: number;
  callerSignal: AbortSignal | undefined;
  /** True when the backstop fired and the caller did not abort first. */
  timedOut: () => boolean;
}

/** What the failure translator needs to know about the call. */
interface FailureContext {
  feature: KvoxAiFeatureId;
  inJob: boolean;
  guard: CallGuard;
  /** Set for a structured call that set an output ceiling. */
  structuredCeiling?: boolean;
}

@Injectable()
export class PlatformKvoxAi implements KvoxAi {
  private readonly logger = new Logger(PlatformKvoxAi.name);

  constructor(
    private readonly ai: AiService,
    private readonly resolver: KvoxAiTargetResolver,
    private readonly prisma: PrismaService,
    private readonly settings: KvoxAiSettings,
  ) {}

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  async readiness(
    userId: string,
    feature: KvoxAiFeatureId,
    requested?: string | null,
  ): Promise<KvoxAiReadiness> {
    const asked = requested ?? null;
    const state = await this.resolver.loadState();

    // Existence only: `secret` is never selected.
    const key = await this.prisma.userAiKey.findUnique({
      where: { userId_provider: { userId, provider: KVOX_AI_PROVIDER } },
      select: { id: true },
    });
    const hasKey = key !== null;

    const notConfigured = state.provider === null || state.models.length === 0;
    const task = KVOX_FEATURE_TASK[feature];

    let model: string | null = null;
    let source: KvoxAiReadiness['source'] = 'none';
    let reasoningEffort: KvoxReasoningEffort = state.policy.reasoningEffort;
    let reason: KvoxAiReason | null = null;

    if (KVOX_EMBEDDING_FEATURES.includes(feature)) {
      // The catalog, not the policy, picks an embeddings model.
      model = KVOX_EMBEDDING.model;
      source = 'default';
      reason = state.provider === null ? 'ai_not_configured' : !hasKey ? 'ai_key_missing' : null;
    } else if (task !== null) {
      // Order, as the retired resolver had it: graph switch, configured, key,
      // permitted, any model, capability.
      const choice = chooseTaskModel({ policy: state.policy, models: state.models, task, requested: asked });
      model = choice.model;
      source = choice.source;
      reasoningEffort = choice.reasoningEffort;

      if (choice.problem === 'graph_disabled') reason = 'graph_disabled';
      else if (notConfigured) reason = 'ai_not_configured';
      else if (!hasKey) reason = 'ai_key_missing';
      else if (choice.problem === 'not_permitted') reason = 'model_not_permitted';
      else if (choice.problem === 'no_model' || choice.model === null) reason = 'ai_not_configured';
      else if (choice.problem === 'lacks_capability') reason = 'model_lacks_capability';
    } else {
      // No task: the requested model when enabled, else the default model.
      if (notConfigured) reason = 'ai_not_configured';
      else if (!hasKey) reason = 'ai_key_missing';

      const wanted = asked ?? state.policy.defaultModel;
      const enabled = wanted !== null && state.models.some((entry) => entry.id === wanted);
      if (enabled) {
        model = wanted;
        source = asked !== null ? 'requested' : 'default';
      } else if (reason === null) {
        reason = asked !== null ? 'model_not_permitted' : 'ai_not_configured';
        model = asked;
        source = asked !== null ? 'requested' : 'none';
      }
    }

    const row = model !== null ? state.models.find((entry) => entry.id === model) : undefined;
    const embedding = KVOX_EMBEDDING_FEATURES.includes(feature);

    return {
      ok: reason === null,
      reason,
      provider: state.provider,
      model,
      source,
      // The model's OWN numbers (what `computeTokenBudget` takes), floored for a row
      // that carries none. Null only when there is no model, or for an embeddings model.
      contextWindowTokens:
        model === null || embedding ? null : (row?.contextWindow ?? FLOOR_CONTEXT_WINDOW_TOKENS),
      maxOutputTokens:
        model === null || embedding ? null : (row?.maxOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS),
      reasoningEffort,
      hasKey,
    };
  }

  // ---------------------------------------------------------------------------
  // Streamed text
  // ---------------------------------------------------------------------------

  async *streamText(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      maxOutputTokens?: number;
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): AsyncIterable<KvoxTextEvent> {
    const guard = await this.guard(req.signal);
    const ctx: FailureContext = { feature: req.feature, inJob: req.jobId !== undefined, guard };

    try {
      const effort = await this.effortFor(req.feature, req.model ?? null, req.reasoningEffort);
      const stream = this.client(req).stream(
        {
          ...this.target(req),
          instructions: req.system,
          input: req.user,
          ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(effort !== undefined ? { reasoning: { effort } } : {}),
        },
        { signal: guard.signal },
      );

      let completed = false;
      for await (const event of stream) {
        if (event.type === 'output_text.delta') {
          yield { type: 'delta', text: event.delta };
        } else if (event.type === 'error') {
          throw new AiError(event.code, event.message);
        } else if (event.type === 'response.completed') {
          completed = true;
          const response = event.response;

          if (response.finishReason === 'content_filter') {
            throw new AiError('AI_CONTENT_FILTERED', 'The provider declined to answer this request.');
          }
          if (response.finishReason === 'error') {
            throw new Error('The provider ended the response with an error.');
          }

          yield {
            type: 'done',
            finishReason: response.finishReason === 'length' ? 'length' : 'stop',
            model: response.model,
            usage: usageOf(response.usage),
          };
        }
      }

      if (!completed) {
        // The same rule the retired provider followed: a stream that ends without a
        // finish reason is a dead socket, never a finished answer.
        throw new Error('The provider closed the stream without finishing the response; the answer was truncated.');
      }
    } catch (err) {
      throw this.fail(err, ctx);
    }
  }

  // ---------------------------------------------------------------------------
  // Structured output
  // ---------------------------------------------------------------------------

  async generateStructured<T>(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      schemaName: string;
      schema: z.ZodType<T>;
      jsonSchema?: JsonSchema;
      maxOutputTokens?: number;
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): Promise<{ value: T; model: string; usage: KvoxUsage }> {
    const guard = await this.guard(req.signal);
    const ctx: FailureContext = {
      feature: req.feature,
      inJob: req.jobId !== undefined,
      guard,
      structuredCeiling: req.maxOutputTokens !== undefined,
    };

    try {
      const effort = await this.effortFor(req.feature, req.model ?? null, req.reasoningEffort);
      const response = await this.client(req).respondStructured(
        {
          ...this.target(req),
          instructions: req.system,
          input: req.user,
          schema: this.constrainedSchema(req.jsonSchema, req.schema),
          schemaName: req.schemaName,
          strict: true,
          ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(effort !== undefined ? { reasoning: { effort } } : {}),
        },
        { signal: guard.signal },
      );

      if (response.finishReason === 'length') {
        throw new AiStructuredOutputError(
          `The structured answer for "${req.schemaName}" was cut off at the output ceiling before the JSON was complete.`,
          'truncated',
          response.provider,
          usageEstimate(response.usage),
        );
      }
      if (response.finishReason === 'content_filter') {
        throw new AiError('AI_CONTENT_FILTERED', 'The provider declined to produce this structured answer.');
      }

      // The caller's own validation, unchanged: the vendor was held to the strict JSON
      // Schema, this app's Zod schema decides what the value must satisfy.
      const checked = req.schema.safeParse(response.parsed);
      if (!checked.success) {
        throw new AiStructuredOutputError(
          `The structured answer for "${req.schemaName}" does not match the requested schema.`,
          'invalid_json',
          response.provider,
          usageEstimate(response.usage),
        );
      }

      return { value: checked.data, model: response.model, usage: usageOf(response.usage) };
    } catch (err) {
      throw this.fail(err, ctx);
    }
  }

  /**
   * The Zod schema the platform sends the vendor and validates with.
   *
   * A JSON Schema is converted with `z.fromJSONSchema`; one Zod cannot read, or
   * cannot write back out as JSON Schema (the platform converts it back for the
   * wire), falls back to the caller's own schema. Both paths keep `strict: true`.
   */
  private constrainedSchema<T>(jsonSchema: JsonSchema | undefined, fallback: z.ZodType<T>): z.ZodType {
    if (jsonSchema === undefined) return fallback;

    try {
      const converted = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
      // Prove the round trip now (the platform repeats it on the wire).
      z.toJSONSchema(converted, { unrepresentable: 'throw' });
      return converted;
    } catch (err) {
      this.logger.warn({
        msg: 'JSON Schema did not round-trip through Zod; using the caller schema',
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Embeddings
  // ---------------------------------------------------------------------------

  async embed(
    req: KvoxAiCallBase & { texts: string[] },
  ): Promise<{ vectors: number[][]; promptTokens: number | null; model: string }> {
    // Refused locally, before a request is spent on the user's own account.
    if (req.texts.length === 0) {
      throw new AiInputError('An embedding batch must contain at least one text.');
    }
    if (req.texts.length > KVOX_EMBEDDING.maxBatchSize) {
      throw new AiInputError(
        `An embedding batch holds at most ${KVOX_EMBEDDING.maxBatchSize} texts; got ${req.texts.length}.`,
      );
    }

    const guard = await this.guard(req.signal);
    const ctx: FailureContext = { feature: req.feature, inJob: req.jobId !== undefined, guard };

    try {
      const result = await this.client(req).embed(
        {
          provider: KVOX_EMBEDDING.provider,
          model: KVOX_EMBEDDING.model,
          input: req.texts,
          dimensions: KVOX_EMBEDDING.dimensions,
        },
        { signal: guard.signal },
      );

      // MAKE the contract true, never assume it: a short or reordered batch would
      // store one text's vector against another's chunk, and nothing would ever error.
      if (result.vectors.length !== req.texts.length) {
        throw new EmbeddingShapeError(
          'count',
          `The embeddings provider returned ${result.vectors.length} vectors for ${req.texts.length} texts.`,
        );
      }
      for (const vector of result.vectors) {
        if (vector.length !== KVOX_EMBEDDING.dimensions || !vector.every((c) => Number.isFinite(c))) {
          throw new EmbeddingShapeError(
            'dimension',
            `The embeddings provider returned a ${vector.length}-dimension vector; this app stores exactly ${KVOX_EMBEDDING.dimensions} finite components.`,
          );
        }
      }

      return {
        vectors: result.vectors,
        promptTokens: result.usage?.inputTokens ?? null,
        model: result.model ?? KVOX_EMBEDDING.model,
      };
    } catch (err) {
      throw this.fail(err, ctx);
    }
  }

  embeddingCapability(): KvoxEmbeddingCapability {
    return {
      model: KVOX_EMBEDDING.model,
      dimensions: KVOX_EMBEDDING.dimensions,
      maxInputTokens: KVOX_EMBEDDING.maxInputTokens,
      maxBatchSize: KVOX_EMBEDDING.maxBatchSize,
    };
  }

  // ---------------------------------------------------------------------------
  // Token estimate and chat
  // ---------------------------------------------------------------------------

  countTokens(text: string, model: string): number {
    return countTokens(text, model);
  }

  chat(_req: KvoxChatRequest): AsyncIterable<KvoxChatEvent> {
    // Implemented by issue #476 (the Ask tool loop). Until then the Ask handler stays on
    // its own provider path and nothing calls this.
    throw new Error('KvoxAi.chat is implemented by the Ask tool loop (issue #476).');
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  /** One platform client bound to the call's user, org, feature and job. */
  private client(req: KvoxAiCallBase): AiUserClient {
    return this.ai.forUser(req.userId, {
      ...(req.orgId !== undefined ? { orgId: req.orgId } : {}),
      ...(req.jobId !== undefined ? { jobId: req.jobId } : {}),
      feature: req.feature,
    });
  }

  /** The per-run model pick, when there is one; absent lets the resolver decide. */
  private target(req: KvoxAiCallBase): { model?: string } {
    return typeof req.model === 'string' && req.model.length > 0 ? { model: req.model } : {};
  }

  /**
   * The platform reasoning effort for a call, or `undefined` to omit the parameter.
   * A caller's own `reasoningEffort` (a short titling call that must not spend its
   * ceiling thinking) is honoured first.
   * The resolver answers (provider, model) only, so the effort is decided here with
   * the same chooser the resolver uses: a task's own effort applies only when the
   * chosen model IS that task's configured model.
   */
  private async effortFor(
    feature: KvoxAiFeatureId,
    requested: string | null,
    override?: KvoxReasoningEffort,
  ) {
    if (KVOX_EMBEDDING_FEATURES.includes(feature)) return undefined;
    // A per-call override wins over the policy (`'none'` omits reasoning), and needs
    // no settings read.
    if (override !== undefined) return toPlatformReasoningEffort(override);

    const state: KvoxAiResolverState = await this.resolver.loadState();
    const task = KVOX_FEATURE_TASK[feature];
    const effort: KvoxReasoningEffort =
      task === null
        ? state.policy.reasoningEffort
        : chooseTaskModel({ policy: state.policy, models: state.models, task, requested }).reasoningEffort;

    return toPlatformReasoningEffort(effort);
  }

  /** The caller's signal combined with the `ai.requestTimeoutMs` backstop. */
  private async guard(callerSignal: AbortSignal | undefined): Promise<CallGuard> {
    let timeoutMs = KVOX_AI_EXTENSION_DEFAULTS.requestTimeoutMs;
    try {
      timeoutMs = await this.settings.requestTimeoutMs();
    } catch {
      // A settings read that fails must not fail the call: the default backstop applies.
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    return {
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      timeoutMs,
      callerSignal,
      timedOut: () => timeout.aborted && callerSignal?.aborted !== true,
    };
  }

  /** Every failure leaves through here: abort and timeout first, then `mapAiError`. */
  private fail(err: unknown, ctx: FailureContext): Error {
    // Already one of this app's own errors (a local refusal inside the try).
    if (isOwnError(err)) return err;

    if (ctx.guard.callerSignal?.aborted) {
      // The platform reports a cancellation as an `AiError`; the caller's own abort
      // reason (a `TimeoutError` from its `AbortSignal.timeout`, an `AbortError`) is
      // what its handler checks for, so surface that.
      const reason: unknown = ctx.guard.callerSignal.reason;
      if (isErrorLike(reason)) return reason;
    }
    if (ctx.guard.timedOut()) {
      return new Error(`The AI request timed out after ${ctx.guard.timeoutMs} ms.`);
    }

    if (AiError.isAiError(err) && err.code === STRUCTURED_INVALID && ctx.structuredCeiling !== undefined) {
      return structuredFailure(err, ctx.structuredCeiling);
    }

    return mapAiError(err, { feature: ctx.feature, inJob: ctx.inJob });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absent usage is `null`, never `0` (0 means free). */
function usageOf(usage: { inputTokens?: number; outputTokens?: number } | undefined): KvoxUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

/** What `AiStructuredOutputError.usage` carries: counts, or `undefined` when none were reported. */
function usageEstimate(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): { promptTokens: number; completionTokens: number } | undefined {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens };
}

/** An `Error`, or a `DOMException` (which is not an `Error` across every runtime realm). */
function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { name?: unknown }).name === 'string' &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}

/** True for the error classes this class (or a collaborator) throws on purpose. */
function isOwnError(err: unknown): err is Error {
  return (
    err instanceof AiStructuredOutputError ||
    err instanceof AiInputError ||
    err instanceof AiRefusedError ||
    err instanceof EmbeddingShapeError
  );
}

/**
 * `AI_STRUCTURED_OUTPUT_INVALID` -> `AiStructuredOutputError`.
 *
 * ⚠ SEE THE FILE HEADER: the platform does not say why. An answer that is not valid
 * JSON at all, from a call that set an output ceiling, is read as a truncation (the
 * vendor guarantees well-formed JSON under a strict schema unless it was cut off);
 * a well-formed answer that fails the schema is `invalid_json`.
 */
function structuredFailure(err: AiError, hadCeiling: boolean): AiStructuredOutputError {
  const issues = err.toJSON().details?.issues;
  const notJson =
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every((issue) => (issue as { code?: unknown }).code === 'invalid_json');

  return notJson && hadCeiling
    ? new AiStructuredOutputError(
        'The structured answer was cut off at the output ceiling before the JSON was complete.',
        'truncated',
      )
    : new AiStructuredOutputError(err.message, 'invalid_json');
}
