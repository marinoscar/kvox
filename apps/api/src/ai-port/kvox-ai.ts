import { APP_SLUG } from '@app/shared';
import type { z } from 'zod';
import type { KvoxAiFeatureId } from './features';
import type { KvoxAiReason } from './kvox-ai-errors';

// =============================================================================
// KvoxAi: the one way this app's code reaches a model (issue #475, epic #472)
// =============================================================================
//
// Every feature that calls a model (notes, transcripts, search, the graph, Ask)
// goes through this interface. It is implemented over the platform
// `AiService.forUser(...)` by `PlatformKvoxAi`, and it is the shape the later
// domain-package phase publishes as the `KVOX_AI` port.
//
// ⚠ NO PLATFORM TYPE APPEARS HERE. This file imports only Zod and the app's own
// ai-port types, so the port can be lifted into its own package unchanged.
// ⚠ A CALLER NEVER SEES A KEY. The platform resolves the user's key per call.
// =============================================================================

/** Injection token of the port. */
export const KVOX_AI = Symbol.for(`${APP_SLUG}/KVOX_AI`);

/** A JSON Schema object (the strict subset the structured-output calls use). */
export type JsonSchema = Record<string, unknown>;

export type KvoxReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/** Fields every call carries. */
export interface KvoxAiCallBase {
  userId: string;
  /** The organization the call is billed and audited under. Default org when absent. */
  orgId?: string;
  feature: KvoxAiFeatureId;
  /** The queue job running the call, so the platform span and usage row link to it. */
  jobId?: string;
  /** A per-run model pick. `null` or absent: the resolver decides. */
  model?: string | null;
  signal?: AbortSignal;
}

/** Whether a feature can run for a user right now, and on which model. Never throws. */
export interface KvoxAiReadiness {
  ok: boolean;
  /** Why not, in the wire vocabulary of the 409/400 responses. `null` when `ok`. */
  reason: KvoxAiReason | null;
  provider: string | null;
  model: string | null;
  source: 'requested' | 'task' | 'default' | 'none';
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: KvoxReasoningEffort;
  hasKey: boolean;
}

export interface KvoxUsage {
  /** `null` means the provider did not report it. Never `0` for "unknown" (0 means free). */
  inputTokens: number | null;
  outputTokens: number | null;
}

export type KvoxTextEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: 'stop' | 'length'; model: string; usage: KvoxUsage };

// -- Multi-turn chat with tools (implemented by issue #476) -------------------

export interface KvoxToolDefinition {
  name: string;
  description: string;
  /** An OBJECT schema in the strict subset. */
  parameters: JsonSchema;
}

export type KvoxToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface KvoxToolCall {
  id: string;
  name: string;
  /** Raw, UNTRUSTED model output: parse and validate before use. */
  argumentsJson: string;
}

export type KvoxChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: KvoxToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface KvoxChatRequest extends KvoxAiCallBase {
  messages: KvoxChatMessage[];
  tools?: KvoxToolDefinition[];
  toolChoice?: KvoxToolChoice;
  maxOutputTokens: number;
  timeoutMs?: number;
}

export type KvoxChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; id: string; name: string; argumentsJson: string }
  | {
      kind: 'done';
      finishReason: 'stop' | 'length' | 'tool_calls';
      model: string;
      usage: KvoxUsage;
    };

export interface KvoxEmbeddingCapability {
  model: string;
  dimensions: 1536;
  maxInputTokens: number;
  maxBatchSize: number;
}

export interface KvoxAi {
  /** The readiness of `feature` for `userId`, with the model it would run on. Never throws. */
  readiness(
    userId: string,
    feature: KvoxAiFeatureId,
    requested?: string | null,
  ): Promise<KvoxAiReadiness>;

  /** Streamed plain text. Throws a mapped error on a refusal, a bad key or a rate limit. */
  streamText(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      maxOutputTokens?: number;
      /** A per-call override of the deployment's effort; `'none'` omits reasoning. */
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): AsyncIterable<KvoxTextEvent>;

  /**
   * One structured answer. `schema` validates the parsed value (the caller's own
   * validation is unchanged); `jsonSchema`, when given, is what the vendor is
   * constrained to.
   */
  generateStructured<T>(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      schemaName: string;
      schema: z.ZodType<T>;
      jsonSchema?: JsonSchema;
      maxOutputTokens?: number;
      /** A per-call override of the deployment's effort; `'none'` omits reasoning. */
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): Promise<{ value: T; model: string; usage: KvoxUsage }>;

  /** One vector per text, in order, each `embeddingCapability().dimensions` wide. */
  embed(
    req: KvoxAiCallBase & { texts: string[] },
  ): Promise<{ vectors: number[][]; promptTokens: number | null; model: string }>;

  embeddingCapability(): KvoxEmbeddingCapability;

  /** A local estimate (no network). Budgets are checked against it. */
  countTokens(text: string, model: string): number;

  /** Streamed, possibly tool-calling, chat turn (the Ask loop). Implemented by #476. */
  chat(req: KvoxChatRequest): AsyncIterable<KvoxChatEvent>;
}
