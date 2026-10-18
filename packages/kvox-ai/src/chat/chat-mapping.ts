import { z } from 'zod';

import {
  AiError,
  type AiFunctionTool,
  type AiInputItem,
  type AiOutputItem,
  type AiReasoningItem,
  type AiResponse,
  type AiStreamEvent,
  type AiToolChoice,
} from '@marinoscar/platform-ai-providers';

import type {
  KvoxChatEvent,
  KvoxChatFinishReason,
  KvoxChatMessage,
  KvoxToolChoice,
  KvoxToolDefinition,
  KvoxUsage,
} from '../types/index.js';

// =============================================================================
// Chat mapping: a KvoxAi chat turn <-> one platform `stream()` call (issue #476)
// =============================================================================
//
// PURE. Nothing here touches the network, a key, a clock the caller cannot inject
// or a logger, so every rule of the mapping is a unit test (`chat-mapping.spec.ts`)
// and `PlatformKvoxAi.chat()` (`apps/api/src/ai-port/platform-kvox-ai.ts`) stays a
// thin loop over `fromPlatformEvent`.
//
// WHY FULL HISTORY, EVERY CALL. The Ask loop owns its transcript (`messages`, its
// token accounting, its forced-answer line), so each call sends the whole of it
// and never `previousResponseId`. That also works for a provider that stores
// nothing.
//
// REASONING ITEMS. A model that reasons emits `reasoning` output items before its
// `function_call`s. A stateless provider (Anthropic thinking blocks, Gemini
// thought signatures) refuses a replayed tool call whose reasoning is missing, so
// the items are kept per tool-call id and put back in front of that call when the
// next request replays the step. They are OPAQUE PROVIDER STATE: never logged,
// never written to a row, and kept as the very same object (a spread is safe, a
// rebuild is not: the provider state travels under a symbol key).
//   NOTE: the installed OpenAI Responses adapter drops a replayed reasoning item
//   (it cannot send it back); the replay is a no-op there and is not harmful.
// =============================================================================

// -- Tools --------------------------------------------------------------------

interface CachedTool {
  /** The JSON Schema the Zod form was built from; a changed schema rebuilds it. */
  source: string;
  parameters: z.ZodType;
}

/** One conversion per process per tool name (the toolset is fixed at boot). */
const TOOL_CACHE = new Map<string, CachedTool>();

/**
 * Test seam: forget every cached conversion.
 *
 * @stability experimental
 */
export function clearToolCache(): void {
  TOOL_CACHE.clear();
}

/**
 * The Zod form of a tool's JSON Schema, which the platform converts back for the
 * wire and validates the call's arguments with.
 *
 * The tool's own Zod `input` is deliberately NOT used: it carries `.transform`
 * (null to undefined), which JSON Schema cannot express. The JSON Schema is the
 * hint the model sees; the toolset still validates every call with the real
 * `input` before running it.
 */
function parametersOf(def: KvoxToolDefinition): z.ZodType {
  const source = JSON.stringify(def.parameters);
  const cached = TOOL_CACHE.get(def.name);
  if (cached !== undefined && cached.source === source) return cached.parameters;

  let parameters: z.ZodType;
  try {
    parameters = z.fromJSONSchema(def.parameters as Parameters<typeof z.fromJSONSchema>[0]);
    // Prove the way back now: the platform repeats it on the wire.
    z.toJSONSchema(parameters, { unrepresentable: 'throw' });
  } catch (err) {
    // Fix the tool's JSON Schema, never this mapping.
    throw new Error(
      `The JSON Schema of tool "${def.name}" cannot be converted for the platform: ${
        err instanceof Error ? err.message.slice(0, 200) : 'unknown'
      }`,
    );
  }

  TOOL_CACHE.set(def.name, { source, parameters });
  return parameters;
}

/**
 * The port's tool definitions as platform function tools, strict, each with the
 * Zod form of its JSON Schema (converted once per process per tool name).
 *
 * @stability experimental
 */
export function toPlatformTools(defs: readonly KvoxToolDefinition[]): AiFunctionTool[] {
  return defs.map((def) => ({
    type: 'function' as const,
    name: def.name,
    description: def.description,
    parameters: parametersOf(def),
    strict: true,
  }));
}

/**
 * The port's tool choice as the platform's: a mode passes through, a named tool
 * becomes a function choice.
 *
 * @stability experimental
 */
export function toPlatformToolChoice(choice: KvoxToolChoice): AiToolChoice {
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.name };
}

// -- Messages -> input items --------------------------------------------------

/**
 * A chat transcript as one platform request carries it.
 *
 * @stability experimental
 */
export interface PlatformChatInput {
  /** The leading `system` messages, joined by a blank line; `undefined` when there are none. */
  instructions: string | undefined;
  /** Every other message, in order, as platform input items. */
  input: AiInputItem[];
}

/**
 * The leading `system` messages become `instructions` (joined by a blank line);
 * the rest become input items in order. A `system` message that comes later (the
 * forced-answer line) is a `developer` message, so it stays where the loop put it.
 *
 * `reasoning` maps a tool-call id to the reasoning items captured with the step
 * that made it; they are replayed immediately before that call's `function_call`.
  *
  * @stability experimental
 */
export function toPlatformInput(
  messages: readonly KvoxChatMessage[],
  reasoning: ReadonlyMap<string, readonly unknown[]> = new Map(),
): PlatformChatInput {
  let lead = 0;
  while (lead < messages.length && messages[lead].role === 'system') lead += 1;

  const instructionParts: string[] = [];
  for (const message of messages.slice(0, lead)) {
    if (message.role === 'system' && message.content.length > 0) instructionParts.push(message.content);
  }
  const instructions = instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined;

  const input: AiInputItem[] = [];
  for (const message of messages.slice(lead)) {
    switch (message.role) {
      case 'system':
        input.push({ type: 'message', role: 'developer', content: [{ type: 'text', text: message.content }] });
        break;
      case 'user':
        input.push({ type: 'message', role: 'user', content: [{ type: 'text', text: message.content }] });
        break;
      case 'assistant':
        if (typeof message.content === 'string' && message.content.length > 0) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: message.content }] });
        }
        for (const call of message.toolCalls ?? []) {
          for (const item of reasoning.get(call.id) ?? []) input.push(item as AiReasoningItem);
          input.push({ type: 'function_call', callId: call.id, name: call.name, arguments: call.argumentsJson });
        }
        break;
      case 'tool':
        input.push({ type: 'function_call_output', callId: message.toolCallId, output: message.content });
        break;
    }
  }

  return { instructions, input };
}

/**
 * Every tool-call id the messages replay, so the reasoning cache is read once per request.
 *
 * @stability experimental
 */
export function toolCallIdsOf(messages: readonly KvoxChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) ids.push(call.id);
  }
  return ids;
}

// -- Events back --------------------------------------------------------------

/**
 * What one platform stream needs to remember between events.
 *
 * @stability experimental
 */
export interface ChatMappingState {
  /** Argument deltas per call id, the fallback when the finished item carries none. */
  argumentBuffers: Map<string, string>;
  /** Call ids already emitted: a call is never emitted twice. */
  emittedCalls: Set<string>;
  /** Reasoning items seen since the last tool call, waiting for the call they belong to. */
  pendingReasoning: unknown[];
  /** The reasoning to replay with each emitted call, keyed by call id. */
  reasoningByCall: Map<string, unknown[]>;
  /** True once `response.completed` was mapped. */
  completed: boolean;
}

/**
 * A fresh mapping state for one platform stream.
 *
 * @stability experimental
 */
export function createChatMappingState(): ChatMappingState {
  return {
    argumentBuffers: new Map(),
    emittedCalls: new Set(),
    pendingReasoning: [],
    reasoningByCall: new Map(),
    completed: false,
  };
}

/** Absent usage is `null`, never `0` (0 means free). */
function usageOf(usage: { inputTokens?: number; outputTokens?: number } | undefined): KvoxUsage {
  return { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
}

function finishReasonOf(response: AiResponse): KvoxChatFinishReason {
  switch (response.finishReason) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
      return response.finishReason;
    case 'error':
      throw new Error('The provider ended the response with an error.');
    default:
      // A finish reason a later platform release adds: read as a plain stop.
      return 'stop';
  }
}

/** A finished `function_call` item as the port's tool-call event, once. Takes over the pending reasoning. */
function emitCall(
  item: Extract<AiOutputItem, { type: 'function_call' }>,
  state: ChatMappingState,
): KvoxChatEvent | null {
  if (state.emittedCalls.has(item.callId)) return null;
  state.emittedCalls.add(item.callId);

  // The item's full arguments win; deltas are the fallback for a provider that only streams them.
  const argumentsJson =
    typeof item.arguments === 'string' && item.arguments.length > 0
      ? item.arguments
      : (state.argumentBuffers.get(item.callId) ?? '');
  state.argumentBuffers.delete(item.callId);

  // Reasoning belongs to the FIRST call after it; later calls of the same response carry none.
  if (state.pendingReasoning.length > 0) {
    state.reasoningByCall.set(item.callId, state.pendingReasoning);
    state.pendingReasoning = [];
  }

  return { kind: 'tool_call', id: item.callId, name: item.name, argumentsJson };
}

/**
 * One platform event as the port event it becomes, or `null` when it only updates
 * the state. Throws for `error` and for a response that ended with `error`.
  *
  * @stability experimental
 */
export function fromPlatformEvent(event: AiStreamEvent, state: ChatMappingState): KvoxChatEvent | null {
  switch (event.type) {
    case 'output_text.delta':
      return event.delta.length > 0 ? { kind: 'delta', text: event.delta } : null;

    case 'function_call.arguments.delta':
      state.argumentBuffers.set(event.callId, (state.argumentBuffers.get(event.callId) ?? '') + event.delta);
      return null;

    case 'output_item.done':
      if (event.item.type === 'reasoning') {
        state.pendingReasoning.push(event.item);
        return null;
      }
      if (event.item.type === 'function_call') return emitCall(event.item, state);
      return null;

    case 'response.completed':
      state.completed = true;
      return {
        kind: 'done',
        finishReason: finishReasonOf(event.response),
        model: event.response.model,
        usage: usageOf(event.response.usage),
      };

    case 'error':
      // `mapAiError` (in the adapter's failure path) turns this into the app's error classes.
      throw new AiError(event.code, event.message);

    default:
      // response.created, reasoning_summary.delta: nothing to hand the caller.
      return null;
  }
}

/**
 * The tool calls a completed response carries that no `output_item.done` announced
 * (an adapter that reports items only in the final response). Call before mapping
 * `response.completed`, so a call is never lost and never emitted twice.
  *
  * @stability experimental
 */
export function missingToolCalls(response: AiResponse, state: ChatMappingState): KvoxChatEvent[] {
  const events: KvoxChatEvent[] = [];
  for (const item of response.output) {
    if (item.type !== 'function_call') continue;
    const emitted = emitCall(item, state);
    if (emitted !== null) events.push(emitted);
  }
  return events;
}

// -- Reasoning replay across calls ---------------------------------------------

interface ReplayEntry {
  items: unknown[];
  expiresAt: number;
}

/**
 * Where a turn's reasoning waits between two `chat()` calls. Keyed by (user, job,
 * call id), so one user's items can never be replayed into another's request; bounded
 * in size and in age, so an abandoned turn leaks nothing for long.
  *
  * @stability experimental
 */
export class ReasoningReplayCache {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    // Three times an Ask turn's whole runtime.
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private static key(scope: string, callId: string): string {
    return `${scope}\u0000${callId}`;
  }

  /**
   * Keeps the reasoning items of each tool call of one step, for the TTL.
   *
   * @param scope - the request's scope ({@link replayScope}).
   * @param byCall - the reasoning items per tool-call id (kept as the same objects).
   */
  remember(scope: string, byCall: ReadonlyMap<string, unknown[]>): void {
    if (byCall.size === 0) return;
    const expiresAt = this.now() + this.ttlMs;
    for (const [callId, items] of byCall) {
      const key = ReasoningReplayCache.key(scope, callId);
      this.entries.delete(key); // re-insert at the end
      this.entries.set(key, { items, expiresAt });
    }
    this.evict();
  }

  /**
   * The unexpired reasoning items of the given tool calls.
   *
   * @param scope - the request's scope ({@link replayScope}).
   * @param callIds - the tool-call ids the next request replays.
   * @returns the items per call id; a call with none is absent.
   */
  recall(scope: string, callIds: Iterable<string>): Map<string, unknown[]> {
    const found = new Map<string, unknown[]>();
    const now = this.now();
    for (const callId of callIds) {
      const entry = this.entries.get(ReasoningReplayCache.key(scope, callId));
      if (entry !== undefined && entry.expiresAt > now) found.set(callId, entry.items);
    }
    return found;
  }

  /** How many tool calls the cache holds (expired ones included until evicted). */
  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      // Insertion order is age order, so the first live entry ends the sweep.
      if (entry.expiresAt > now) break;
      this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The cache scope of a request: one user's one job.
 *
 * @stability experimental
 */
export function replayScope(req: { userId: string; jobId?: string }): string {
  return `${req.userId}\u0000${req.jobId ?? ''}`;
}
