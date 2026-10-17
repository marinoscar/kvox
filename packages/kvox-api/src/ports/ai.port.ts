import type { z } from 'zod';

// =============================================================================
// KVOX_AI: the model port (issue 5.4, epic 486)
// =============================================================================
//
// Everything a domain slice asks of a language model goes through this port:
// streamed text, one structured answer, a tool-calling chat step, embeddings and
// the capability probe. The web edition binds it over the platform AI slice;
// KVox Desktop binds it over the Copilot SDK.
//
// A KEY NEVER CROSSES THIS PORT. A call carries a user id; the adapter resolves
// that user's credential on its own side and drops it when the call returns. No
// event, error message or capability below may hold a key (the conformance kit
// asserts it).
// =============================================================================

/**
 * Injection token of {@link KvoxAiPort}. A `Symbol.for` key, so two copies of
 * this package agree on identity; the description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_AI = Symbol.for('@marinoscar/kvox/KVOX_AI');

/**
 * The feature a model call is made for. The adapter uses it to pick the model,
 * to meter the call and to label it in usage reports. The string union lists
 * the features the domain slices use today; a host may accept more.
 *
 * @stability experimental
 */
export type KvoxAiFeature =
  | 'notes.generate'
  | 'notes.title'
  | 'transcripts.name_check'
  | 'search.embed'
  | 'graph.extract'
  | 'graph.adjudicate'
  | 'graph.digest'
  | 'graph.embed'
  | 'ask.respond'
  | (string & {});

/**
 * How hard a reasoning model may think, cheapest first. `none` omits the
 * parameter. Shared by the target, the token budget and the adapters.
 *
 * @stability experimental
 */
export type KvoxReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Who a call is made for and what it is for.
 *
 * @stability experimental
 */
export interface KvoxAiContext {
  /** The user whose own credential and limits apply. */
  userId: string;
  /** The organization the call is billed and audited under, or `null` for none. */
  orgId: string | null;
  /** What the call is for. */
  feature: KvoxAiFeature;
  /** Aborts the call. An adapter also applies its own timeout. */
  signal?: AbortSignal;
}

/**
 * The embeddings model a host offers.
 *
 * @stability experimental
 */
export interface KvoxEmbeddingsInfo {
  /** The embeddings model id. */
  model: string;
  /** The width of every vector it returns. */
  dimensions: number;
}

/**
 * What the AI port can do for a user right now. Never throws to produce.
 *
 * @stability experimental
 */
export interface KvoxAiCapabilities {
  /** True when a call for the context's feature can run. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: 'ai_not_configured' | 'ai_key_missing' | 'graph_disabled';
  /** Whether `generateStructured` is supported. */
  structuredOutput: boolean;
  /** Whether `chat` accepts tools. */
  toolCalling: boolean;
  /**
   * The embeddings model and its vector width, or `null` when the host has none
   * (search then answers with full-text only).
   */
  embeddings: KvoxEmbeddingsInfo | null;
  /** Whether the connected-knowledge features are switched on. */
  graphEnabled: boolean;
}

/**
 * The model a call runs on, as {@link KvoxAiPort.resolveTask} resolved it.
 *
 * @stability experimental
 */
export interface KvoxAiTarget {
  /** The provider id (`openai`, `copilot`). */
  provider: string;
  /** The model id. */
  model: string;
  /** The effort to send, when the model reasons. */
  reasoningEffort?: KvoxReasoningEffort;
  /** The model's context window, in tokens. */
  contextWindowTokens: number;
  /** The model's output ceiling, in tokens. */
  maxOutputTokens: number;
  /** Which rule chose the model (`requested`, `task`, `default`). */
  source: string;
}

/**
 * Token counts of one call. `null` means the provider did not report it; never
 * `0` for "unknown" (zero means free).
 *
 * @stability experimental
 */
export interface KvoxAiUsage {
  /** Prompt tokens, or `null` when unreported. */
  inputTokens: number | null;
  /** Completion tokens, or `null` when unreported. */
  outputTokens: number | null;
}

/**
 * A piece of streamed text.
 *
 * @stability experimental
 */
export interface KvoxTextDeltaEvent {
  /** Discriminant. */
  type: 'delta';
  /** The text appended. */
  text: string;
}

/**
 * The end of a streamed text answer.
 *
 * @stability experimental
 */
export interface KvoxTextDoneEvent {
  /** Discriminant. */
  type: 'done';
  /** What the call consumed. */
  usage: KvoxAiUsage;
  /** `length` means the answer was cut off at the output ceiling. */
  finishReason: 'stop' | 'length';
}

/**
 * One event of a streamed text answer: zero or more `delta`, then one `done`.
 *
 * @stability experimental
 */
export type KvoxTextEvent = KvoxTextDeltaEvent | KvoxTextDoneEvent;

/**
 * A tool the model may call, with a JSON Schema for its arguments.
 *
 * @stability experimental
 */
export interface KvoxToolDef {
  /** The tool name the model calls. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** An object JSON Schema (the strict subset) for the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * A system instruction in a chat history.
 *
 * @stability experimental
 */
export interface KvoxSystemMessage {
  /** Discriminant. */
  role: 'system';
  /** The instruction. */
  content: string;
}

/**
 * A user turn in a chat history.
 *
 * @stability experimental
 */
export interface KvoxUserMessage {
  /** Discriminant. */
  role: 'user';
  /** What the user said. */
  content: string;
}

/**
 * A tool call the model made, as it appears in the history.
 *
 * @stability experimental
 */
export interface KvoxToolCallRef {
  /** The call id the tool result answers. */
  id: string;
  /** The tool name. */
  name: string;
  /** The arguments, parsed. Untrusted model output. */
  arguments: unknown;
}

/**
 * A model turn in a chat history.
 *
 * @stability experimental
 */
export interface KvoxAssistantMessage {
  /** Discriminant. */
  role: 'assistant';
  /** The text, or `null` for a turn that only called tools. */
  content: string | null;
  /** The tools the turn called. */
  toolCalls?: KvoxToolCallRef[];
}

/**
 * A tool result in a chat history.
 *
 * @stability experimental
 */
export interface KvoxToolMessage {
  /** Discriminant. */
  role: 'tool';
  /** The call this answers. */
  toolCallId: string;
  /** The result, as text. */
  content: string;
}

/**
 * One message of a chat history. The whole history is sent on every call.
 *
 * @stability experimental
 */
export type KvoxChatMessage =
  | KvoxSystemMessage
  | KvoxUserMessage
  | KvoxAssistantMessage
  | KvoxToolMessage;

/**
 * A piece of streamed text in a chat step.
 *
 * @stability experimental
 */
export interface KvoxChatDeltaEvent {
  /** Discriminant. */
  type: 'delta';
  /** The text appended. */
  text: string;
}

/**
 * A tool the model asked to call.
 *
 * @stability experimental
 */
export interface KvoxChatToolCallEvent {
  /** Discriminant. */
  type: 'tool_call';
  /** The call id. */
  id: string;
  /** The tool name. */
  name: string;
  /** The arguments, parsed when they were JSON. Untrusted model output: validate before use. */
  arguments: unknown;
}

/**
 * The end of a chat step's content.
 *
 * @stability experimental
 */
export interface KvoxChatStepEndEvent {
  /** Discriminant. */
  type: 'step_end';
}

/**
 * The end of a chat call.
 *
 * @stability experimental
 */
export interface KvoxChatDoneEvent {
  /** Discriminant. */
  type: 'done';
  /** What the call consumed. */
  usage: KvoxAiUsage;
}

/**
 * One event of a chat step: text deltas or tool calls, then `step_end`, then one
 * `done`. After a `tool_call` of a step no further `delta` of that step is
 * yielded.
 *
 * @stability experimental
 */
export type KvoxChatEvent =
  | KvoxChatDeltaEvent
  | KvoxChatToolCallEvent
  | KvoxChatStepEndEvent
  | KvoxChatDoneEvent;

/**
 * Why an AI call failed, in the vocabulary a slice branches on.
 *
 * - `auth`: the provider refused the user's credential.
 * - `refusal`: the provider declined to answer.
 * - `rate_limit`: the provider's limit was hit; retry later.
 * - `budget`: the prompt does not fit the model.
 * - `timeout`: the call outlived its backstop.
 * - `not_configured`: AI is switched off or no model is set up.
 * - `key_missing`: the user has saved no key.
 * - `capability`: the model lacks a capability the call needs.
 * - `other`: anything else (transient; retryable).
 *
 * @stability experimental
 */
export type KvoxAiErrorClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'budget'
  | 'timeout'
  | 'not_configured'
  | 'key_missing'
  | 'capability'
  | 'other';

/**
 * Every {@link KvoxAiErrorClass}, for validation and for the conformance kit.
 *
 * @stability experimental
 */
export const KVOX_AI_ERROR_CLASSES: readonly KvoxAiErrorClass[] = [
  'auth',
  'refusal',
  'rate_limit',
  'budget',
  'timeout',
  'not_configured',
  'key_missing',
  'capability',
  'other',
];

/**
 * What `generateStructured` returns.
 *
 * @stability experimental
 */
export interface KvoxStructuredResult<T> {
  /** The value, validated against the caller's schema. */
  value: T;
  /** What the call consumed. */
  usage: KvoxAiUsage;
}

/**
 * What `embed` returns.
 *
 * @stability experimental
 */
export interface KvoxEmbedResult {
  /** The embeddings model that produced the vectors. */
  model: string;
  /** The width of every vector. */
  dimensions: number;
  /** One vector per input, in order. */
  vectors: number[][];
}

/**
 * The one error type the AI port throws. Its message never holds a credential.
 * @stability experimental
 */
export class KvoxAiError extends Error {
  /** The failure's class. */
  readonly errorClass: KvoxAiErrorClass;

  /** How long to wait before retrying, for `rate_limit`, when the provider said. */
  readonly retryAfterMs?: number;

  /**
   * @param errorClass - the failure's class.
   * @param message - a sentence for the log and the user. Never key material.
   * @param retryAfterMs - the provider's retry hint, in milliseconds.
   */
  constructor(errorClass: KvoxAiErrorClass, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'KvoxAiError';
    this.errorClass = errorClass;
    this.retryAfterMs = retryAfterMs;
    // Required under a downlevelled target, or `instanceof` is false.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The prompt does not fit the budget. Carries both numbers, because "too large,
 * by this much" is actionable and "too large" is not. Never silent truncation.
 * @stability experimental
 */
export class KvoxAiBudgetError extends KvoxAiError {
  /** The measured prompt, in tokens. */
  readonly required: number;

  /** The tokens available for input. */
  readonly available: number;

  /**
   * @param required - the measured prompt, in tokens.
   * @param available - the tokens available for input.
   * @param message - the sentence to show; defaults to one naming both numbers.
   */
  constructor(required: number, available: number, message?: string) {
    super(
      'budget',
      message ??
        `The prompt is approximately ${required} tokens; ${available} are available for input.`,
    );
    this.name = 'KvoxAiBudgetError';
    this.required = required;
    this.available = available;
  }
}

/**
 * The model port. Implemented by the host's adapter, consumed by the slices.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxAiPort {
  /**
   * What the port can do for the context's user. Never throws: a failure to
   * find out is reported as `available: false`.
   *
   * @param ctx - who and what for.
   */
  capabilities(ctx: KvoxAiContext): Promise<KvoxAiCapabilities>;

  /**
   * Resolves the model a task runs on.
   *
   * @param ctx - who and what for.
   * @param task - the task or feature name.
   * @param opts - `model` is a per-run pick, honoured when the host permits it.
   *   `requireKey: false` resolves the model for a caller who has saved no key
   *   (an estimate counts tokens but spends none); the default is true.
   * @throws KvoxAiError `not_configured`, `key_missing` or `capability`.
   */
  resolveTask(
    ctx: KvoxAiContext,
    task: string,
    opts?: { model?: string; requireKey?: boolean },
  ): Promise<KvoxAiTarget>;

  /**
   * A streamed plain-text answer: `delta` events, then one `done`.
   *
   * @param ctx - who and what for.
   * @param req - the target, the prompts and an output ceiling.
   * @throws KvoxAiError on any failure, while iterating.
   */
  generateText(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; system: string; user: string; maxOutputTokens?: number },
  ): AsyncIterable<KvoxTextEvent>;

  /**
   * One structured answer, validated against `schema`.
   *
   * @param ctx - who and what for.
   * @param req - the target, the prompts, the Zod schema and its name.
   * @throws KvoxAiError on any failure.
   */
  generateStructured<T>(
    ctx: KvoxAiContext,
    req: {
      target: KvoxAiTarget;
      system: string;
      user: string;
      schema: z.ZodType<T>;
      schemaName: string;
    },
  ): Promise<KvoxStructuredResult<T>>;

  /**
   * One chat step with tools. The caller owns the loop and sends the whole
   * history every call.
   *
   * @param ctx - who and what for.
   * @param req - the target, the history, the tools and the tool choice.
   * @throws KvoxAiError on any failure, while iterating.
   */
  chat(
    ctx: KvoxAiContext,
    req: {
      target: KvoxAiTarget;
      messages: KvoxChatMessage[];
      tools: KvoxToolDef[];
      toolChoice: 'auto' | 'none';
    },
  ): AsyncIterable<KvoxChatEvent>;

  /**
   * One vector per input, in order, each `dimensions` wide.
   *
   * @param ctx - who and what for.
   * @param req - the texts to embed.
   * @throws KvoxAiError on any failure.
   */
  embed(ctx: KvoxAiContext, req: { inputs: string[] }): Promise<KvoxEmbedResult>;

  /**
   * A local token estimate (no network). Budgets are checked against it.
   *
   * @param target - the model the text will be sent to.
   * @param text - the text to measure.
   */
  countTokens(target: KvoxAiTarget, text: string): number;
}
