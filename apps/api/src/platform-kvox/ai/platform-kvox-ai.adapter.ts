import { Inject, Injectable, HttpException } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { RateLimitError } from '@marinoscar/platform-api/jobs';
import {
  KvoxAiBudgetError,
  KvoxAiError,
  type KvoxAiCapabilities,
  type KvoxAiContext,
  type KvoxAiErrorClass,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxChatEvent,
  type KvoxChatMessage,
  type KvoxEmbedResult,
  type KvoxStructuredResult,
  type KvoxTextEvent,
  type KvoxToolDef,
} from '@marinoscar/kvox-api/ports';
import {
  isKvoxAiFeature,
  type KvoxAiCallBase,
  type KvoxAiFeatureId,
  type KvoxAiReadiness,
  type KvoxChatMessage as FacadeChatMessage,
  type KvoxToolDefinition,
} from '@marinoscar/kvox-ai';
import type { z } from 'zod';

import { AiAuthError, AiBudgetError, AiInputError, AiRefusedError, AiStructuredOutputError } from '../../ai-port/ai-errors';
import { KVOX_AI as KVOX_AI_FACADE, type KvoxAi } from '../../ai-port/kvox-ai';
import { KvoxAiConflict, KvoxAiBadRequest } from '../../ai-port/kvox-ai-errors';
import { KvoxAiSettings } from '../../ai-port/kvox-ai-settings';

// =============================================================================
// PlatformKvoxAiAdapter: the `KVOX_AI` port over the app's `KvoxAi` facade
// =============================================================================
//
// `@marinoscar/kvox-api/ports` defines the model port a domain slice is written
// against; this class binds it for the web edition. The facade it wraps
// (`ai-port/kvox-ai.ts`, issue #475) is itself the app's one way to the platform
// `AiService.forUser`, with the tool loop on `stream()` (#476), so this adapter
// adds no model call of its own: it renames the features, resolves the target
// through the facade's readiness, and turns every failure into a `KvoxAiError`.
//
// ⚠ A KEY NEVER CROSSES THIS PORT. The context carries a user id; the platform
// resolves that user's own key per call. `scrub` removes anything shaped like a
// provider key from a message before it leaves, as a backstop (the facade's own
// messages carry none).
//
// ⚠ THE STREAMING METHODS ARE NOT `@Trace()`D. The decorator awaits the method,
// which would turn an async generator into a Promise of one; the platform AI
// slice already traces each round trip. Everything that returns a promise is.
// =============================================================================

/** The port's feature names, mapped to the ids this app registered with the platform. */
const FEATURES: Readonly<Record<string, KvoxAiFeatureId>> = {
  'notes.generate': 'note_generate',
  'notes.title': 'note_retitle',
  'transcripts.name_check': 'transcript_name_check',
  'search.embed': 'search_embed',
  'graph.extract': 'graph_extract',
  'graph.adjudicate': 'graph_adjudicate',
  'graph.digest': 'graph_digest',
  'graph.embed': 'graph_embed',
  'graph.agent': 'graph_agent',
  'ask.respond': 'graph_agent',
};

/** Strings shaped like a provider credential. */
const KEY_SHAPES: readonly RegExp[] = [/sk-[A-Za-z0-9_-]{10,}/g, /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+/g];

/** Removes anything shaped like a provider key from text. */
export function scrub(text: string): string {
  return KEY_SHAPES.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text);
}

/** The app's feature id for a port feature or task name, or `undefined` when it is unknown. */
export function featureOf(name: string): KvoxAiFeatureId | undefined {
  return FEATURES[name] ?? (isKvoxAiFeature(name) ? name : undefined);
}

/**
 * Translates whatever the facade (or a platform call under it) threw into the one
 * error type the port promises.
 *
 * @param error - the thrown value.
 * @returns a `KvoxAiError`; one already of that type is returned as it is.
 */
export function toKvoxAiError(error: unknown): KvoxAiError {
  if (error instanceof KvoxAiError) return error;

  const message = scrub(error instanceof Error ? error.message : typeof error === 'string' ? error : 'AI call failed');

  if (error instanceof AiBudgetError) return new KvoxAiBudgetError(error.requiredTokens, error.availableTokens, message);
  if (error instanceof AiAuthError) return new KvoxAiError('auth', message);
  if (error instanceof AiRefusedError) return new KvoxAiError('refusal', message);
  if (error instanceof AiStructuredOutputError) {
    return new KvoxAiError(
      error.reason === 'truncated' ? 'truncated' : 'invalid_output',
      message,
      undefined,
      error.usage !== undefined
        ? { inputTokens: error.usage.promptTokens, outputTokens: error.usage.completionTokens }
        : undefined,
    );
  }
  if (error instanceof RateLimitError) return new KvoxAiError('rate_limit', message, error.retryAfterMs);
  if (error instanceof AiInputError) return new KvoxAiError('other', message);

  if (error instanceof KvoxAiConflict) {
    const byReason: Record<string, KvoxAiErrorClass> = {
      ai_not_configured: 'not_configured',
      graph_disabled: 'not_configured',
      ai_key_missing: 'key_missing',
      ai_key_invalid: 'auth',
      model_lacks_capability: 'capability',
    };
    return new KvoxAiError(byReason[error.reason] ?? 'other', message);
  }
  if (error instanceof KvoxAiBadRequest) return new KvoxAiError('capability', message);

  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 429) return new KvoxAiError('rate_limit', message);
    if (status === 422) return new KvoxAiError('refusal', message);
    return new KvoxAiError('other', message);
  }

  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || /^The AI request timed out/.test(message)) return new KvoxAiError('timeout', message);

  return new KvoxAiError('other', message);
}

@Injectable()
export class PlatformKvoxAiAdapter implements KvoxAiPort {
  constructor(
    @Inject(KVOX_AI_FACADE) private readonly ai: KvoxAi,
    private readonly settings: KvoxAiSettings,
  ) {}

  @Trace()
  async capabilities(ctx: KvoxAiContext): Promise<KvoxAiCapabilities> {
    try {
      const feature = featureOf(ctx.feature);
      const [readiness, graphEnabled] = await Promise.all([
        this.ai.readiness(ctx.userId, feature ?? 'note_generate', null),
        this.settings.graphEnabled(),
      ]);
      const embedding = this.ai.embeddingCapability();
      const reason = capabilityReason(readiness.reason);

      return {
        available: feature !== undefined && readiness.ok,
        ...(reason !== undefined ? { reason } : {}),
        structuredOutput: readiness.ok,
        toolCalling: readiness.ok,
        embeddings: { model: embedding.model, dimensions: embedding.dimensions },
        graphEnabled,
      };
    } catch {
      return {
        available: false,
        reason: 'ai_not_configured',
        structuredOutput: false,
        toolCalling: false,
        embeddings: null,
        graphEnabled: false,
      };
    }
  }

  @Trace()
  async resolveTask(
    ctx: KvoxAiContext,
    task: string,
    opts?: { model?: string; requireKey?: boolean },
  ): Promise<KvoxAiTarget> {
    const feature = featureOf(task) ?? featureOf(ctx.feature);
    if (feature === undefined) {
      throw new KvoxAiError('capability', `The web edition has no AI feature named "${scrub(task)}".`);
    }

    let readiness: KvoxAiReadiness;
    try {
      readiness = await this.ai.readiness(ctx.userId, feature, opts?.model ?? null);
    } catch (error) {
      throw toKvoxAiError(error);
    }
    // `requireKey: false` is for a caller who only counts tokens (a name-check estimate): a
    // missing key still names the model, which is all it needs.
    const keyOptional = opts?.requireKey === false && readiness.reason === 'ai_key_missing';
    if ((!readiness.ok && !keyOptional) || readiness.provider === null || readiness.model === null) {
      throw refusalFor(readiness);
    }

    const embedding = this.ai.embeddingCapability();
    const embeds = readiness.contextWindowTokens === null;
    return {
      provider: readiness.provider,
      model: readiness.model,
      reasoningEffort: readiness.reasoningEffort,
      contextWindowTokens: readiness.contextWindowTokens ?? embedding.maxInputTokens,
      // An embeddings model generates nothing.
      maxOutputTokens: embeds ? 0 : (readiness.maxOutputTokens ?? 0),
      source: readiness.source,
    };
  }

  async *generateText(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; system: string; user: string; maxOutputTokens?: number },
  ): AsyncIterable<KvoxTextEvent> {
    try {
      const stream = this.ai.streamText({
        ...this.base(ctx, req.target),
        system: req.system,
        user: req.user,
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.target.reasoningEffort !== undefined ? { reasoningEffort: req.target.reasoningEffort } : {}),
      });
      for await (const event of stream) {
        if (event.type === 'delta') yield { type: 'delta', text: event.text };
        else yield { type: 'done', usage: event.usage, finishReason: event.finishReason };
      }
    } catch (error) {
      throw toKvoxAiError(error);
    }
  }

  @Trace()
  async generateStructured<T>(
    ctx: KvoxAiContext,
    req: {
      target: KvoxAiTarget;
      system: string;
      user: string;
      schema: z.ZodType<T>;
      schemaName: string;
      jsonSchema?: Record<string, unknown>;
      maxOutputTokens?: number;
    },
  ): Promise<KvoxStructuredResult<T>> {
    try {
      const result = await this.ai.generateStructured({
        ...this.base(ctx, req.target),
        system: req.system,
        user: req.user,
        schema: req.schema,
        schemaName: req.schemaName,
        ...(req.jsonSchema !== undefined ? { jsonSchema: req.jsonSchema } : {}),
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.target.reasoningEffort !== undefined ? { reasoningEffort: req.target.reasoningEffort } : {}),
      });
      return { value: result.value, usage: result.usage };
    } catch (error) {
      throw toKvoxAiError(error);
    }
  }

  async *chat(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; messages: KvoxChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' },
  ): AsyncIterable<KvoxChatEvent> {
    // One chat call is one model step. A tool call ends what the step may say: any text the
    // provider streams after it is held back and dropped, as the port promises.
    let calledTool = false;
    try {
      const stream = this.ai.chat({
        ...this.base(ctx, req.target),
        messages: req.messages.map(toFacadeMessage),
        ...(req.tools.length > 0 ? { tools: req.tools.map(toFacadeTool) } : {}),
        toolChoice: req.toolChoice,
        maxOutputTokens: req.target.maxOutputTokens,
        ...(req.target.reasoningEffort !== undefined ? { reasoningEffort: req.target.reasoningEffort } : {}),
      });
      for await (const event of stream) {
        if (event.kind === 'delta') {
          if (!calledTool) yield { type: 'delta', text: event.text };
        } else if (event.kind === 'tool_call') {
          calledTool = true;
          yield { type: 'tool_call', id: event.id, name: event.name, arguments: parseArguments(event.argumentsJson) };
        } else {
          yield { type: 'step_end' };
          yield {
            type: 'done',
            usage: event.usage,
            finishReason:
              event.finishReason === 'length' || event.finishReason === 'content_filter' ? event.finishReason : 'stop',
          };
        }
      }
    } catch (error) {
      throw toKvoxAiError(error);
    }
  }

  @Trace()
  async embed(ctx: KvoxAiContext, req: { inputs: string[] }): Promise<KvoxEmbedResult> {
    try {
      const result = await this.ai.embed({
        ...this.base(ctx, undefined, 'search_embed'),
        texts: req.inputs,
      });
      return { model: result.model, dimensions: this.ai.embeddingCapability().dimensions, vectors: result.vectors };
    } catch (error) {
      throw toKvoxAiError(error);
    }
  }

  countTokens(target: KvoxAiTarget, text: string): number {
    return this.ai.countTokens(text, target.model);
  }

  /** The fields every facade call carries. */
  private base(ctx: KvoxAiContext, target?: KvoxAiTarget, fallback?: KvoxAiFeatureId): KvoxAiCallBase {
    const feature = featureOf(ctx.feature) ?? fallback;
    if (feature === undefined) {
      throw new KvoxAiError('capability', `The web edition has no AI feature named "${scrub(ctx.feature)}".`);
    }
    return {
      userId: ctx.userId,
      ...(ctx.orgId !== null ? { orgId: ctx.orgId } : {}),
      feature,
      ...(target !== undefined ? { model: target.model } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
    };
  }
}

/** `capabilities().reason` for a readiness reason. */
function capabilityReason(reason: KvoxAiReadiness['reason']): KvoxAiCapabilities['reason'] | undefined {
  if (reason === null) return undefined;
  if (reason === 'ai_key_missing') return 'ai_key_missing';
  if (reason === 'graph_disabled') return 'graph_disabled';
  return 'ai_not_configured';
}

/** The port error for a feature that cannot run. */
function refusalFor(readiness: KvoxAiReadiness): KvoxAiError {
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

function toFacadeMessage(message: KvoxChatMessage): FacadeChatMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              argumentsJson: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
            })),
          }
        : {}),
    };
  }
  return message;
}

function toFacadeTool(tool: KvoxToolDef): KvoxToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** The tool call's arguments as the port promises: parsed when they are JSON, else the raw text. */
function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
