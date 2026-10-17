import type { KvoxAiFeatureId } from '../features/index.js';

// =============================================================================
// The KvoxAi facade's value types (issue #475, moved by #579)
// =============================================================================
//
// The types every call into a model and every answer out of one is written in:
// the call base, the readiness answer, usage, text and chat events, tool
// definitions and the embedding capability. They were the type half of
// `apps/api/src/ai-port/kvox-ai.ts`; the facade interface (`KvoxAi`) and its
// injection token (`KVOX_AI`, which names the app slug) stay in the app until
// the port is bound to `createKvoxAi` (#579, step 7).
//
// ⚠ NO PLATFORM TYPE APPEARS HERE. This file imports only the package's own
// feature ids, so a host that never installs the platform can still name every
// shape the domain packages exchange with a model.
// ⚠ A CALLER NEVER SEES A KEY. Nothing here carries one.
// =============================================================================

/**
 * A JSON Schema object (the strict subset the structured-output calls use).
 *
 * @stability experimental
 */
export type JsonSchema = Record<string, unknown>;

/**
 * How hard a reasoning model may think, cheapest first. `none` omits the
 * parameter; `xhigh` is clamped to `high` on the wire
 * ({@link toPlatformReasoningEffort}).
 *
 * @stability experimental
 */
export type KvoxReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Why a feature cannot run for a user right now, in the wire vocabulary of the
 * 409/400 responses (`details.reason`). The values are persisted by clients and
 * read by the web and the CLI: never rename one.
 *
 * @stability experimental
 */
export type KvoxAiReason =
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'model_not_permitted'
  | 'model_lacks_capability'
  | 'graph_disabled';

/**
 * Fields every call carries.
 *
 * @stability experimental
 */
export interface KvoxAiCallBase {
  /** The user whose own key pays for the call. */
  userId: string;
  /** The organization the call is billed and audited under. Default org when absent. */
  orgId?: string;
  /** The AI feature the call is made for; it rides on the usage row. */
  feature: KvoxAiFeatureId;
  /** The queue job running the call, so the platform span and usage row link to it. */
  jobId?: string;
  /** A per-run model pick. `null` or absent: the resolver decides. */
  model?: string | null;
  /** Aborts the call. */
  signal?: AbortSignal;
}

/**
 * Whether a feature can run for a user right now, and on which model. Never
 * throws.
 *
 * @remarks
 * This is the facade's rich readiness answer (model, source, token limits,
 * effort). A runtime's own, narrower answer ("is there a key for this user and
 * provider?") is {@link KvoxAiKeyReadiness}.
 *
 * @stability experimental
 */
export interface KvoxAiReadiness {
  /** True when the feature can run now. */
  ok: boolean;
  /** Why not, in the wire vocabulary of the 409/400 responses. `null` when `ok`. */
  reason: KvoxAiReason | null;
  /** The active provider, or `null` while AI is off. */
  provider: string | null;
  /** The model the feature would run on, or `null` when none can be chosen. */
  model: string | null;
  /** Where the model came from: the caller's pick, the task's model, the default, or nowhere. */
  source: 'requested' | 'task' | 'default' | 'none';
  /** The model's context window in tokens, floored when unknown; `null` without a model or for embeddings. */
  contextWindowTokens: number | null;
  /** The model's output ceiling in tokens, floored when unknown; `null` without a model or for embeddings. */
  maxOutputTokens: number | null;
  /** The effort the call would send. */
  reasoningEffort: KvoxReasoningEffort;
  /** Whether the user has a key for the provider (existence only; the key is never read). */
  hasKey: boolean;
}

/**
 * Token usage of one call.
 *
 * @stability experimental
 */
export interface KvoxUsage {
  /** `null` means the provider did not report it. Never `0` for "unknown" (0 means free). */
  inputTokens: number | null;
  /** `null` means the provider did not report it. */
  outputTokens: number | null;
}

/**
 * One event of a streamed plain-text answer: a text delta, then exactly one
 * `done`.
 *
 * @stability experimental
 */
export type KvoxTextEvent =
  | {
      /** A piece of the answer. */
      type: 'delta';
      /** The text of this piece. */
      text: string;
    }
  | {
      /** The answer is complete. */
      type: 'done';
      /** `stop`: the model finished; `length`: it hit the output ceiling. */
      finishReason: 'stop' | 'length';
      /** The model that answered. */
      model: string;
      /** Token usage of the call. */
      usage: KvoxUsage;
    };

// -- Multi-turn chat with tools (the Ask loop, issue #476) -------------------

/**
 * A function tool the model may call.
 *
 * @stability experimental
 */
export interface KvoxToolDefinition {
  /** The tool's name, as the model calls it. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** An OBJECT schema in the strict subset. */
  parameters: JsonSchema;
}

/**
 * Whether, and which, tool the model must call: a mode, or one tool by name.
 *
 * @stability experimental
 */
export type KvoxToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      /** The one tool the model must call. */
      name: string;
    };

/**
 * One tool call the model made.
 *
 * @stability experimental
 */
export interface KvoxToolCall {
  /** The provider's call id, echoed back on the tool's answer. */
  id: string;
  /** The tool called. */
  name: string;
  /** Raw, UNTRUSTED model output: parse and validate before use. */
  argumentsJson: string;
}

/**
 * One message of a chat transcript. The caller owns the transcript and sends
 * the whole of it every call.
 *
 * @stability experimental
 */
export type KvoxChatMessage =
  | {
      /** An instruction from the caller. */
      role: 'system';
      /** The instruction. */
      content: string;
    }
  | {
      /** A user turn. */
      role: 'user';
      /** The user's text. */
      content: string;
    }
  | {
      /** A model turn, replayed. */
      role: 'assistant';
      /** The model's text, or `null` when it only called tools. */
      content: string | null;
      /** The tool calls the model made in this turn. */
      toolCalls?: KvoxToolCall[];
    }
  | {
      /** A tool's answer to one call. */
      role: 'tool';
      /** The call this answers ({@link KvoxToolCall.id}). */
      toolCallId: string;
      /** The tool's output, as text. */
      content: string;
    };

/**
 * One streamed, possibly tool-calling, chat turn.
 *
 * @stability experimental
 */
export interface KvoxChatRequest extends KvoxAiCallBase {
  /** The full transcript, oldest first. */
  messages: KvoxChatMessage[];
  /** The tools offered this turn. */
  tools?: KvoxToolDefinition[];
  /** Whether, and which, tool the model must call. */
  toolChoice?: KvoxToolChoice;
  /** The output ceiling of this turn, in tokens. */
  maxOutputTokens: number;
  /** A per-call backstop, combined with `ai.requestTimeoutMs` (the smaller applies). */
  timeoutMs?: number;
  /** The effort this turn sends. Absent: the port decides, as for every other call. */
  reasoningEffort?: KvoxReasoningEffort;
}

/**
 * Why a chat turn ended.
 *
 * @stability experimental
 */
export type KvoxChatFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls';

/**
 * One event of a chat turn: text deltas and tool calls, then exactly one
 * `done`.
 *
 * @stability experimental
 */
export type KvoxChatEvent =
  | {
      /** A piece of the answer text. */
      kind: 'delta';
      /** The text of this piece. */
      text: string;
    }
  | {
      /** A finished tool call, emitted once per call. */
      kind: 'tool_call';
      /** The provider's call id. */
      id: string;
      /** The tool called. */
      name: string;
      /** Raw, UNTRUSTED model output: parse and validate before use. */
      argumentsJson: string;
    }
  | {
      /** The turn is complete. */
      kind: 'done';
      /** Why the turn ended. */
      finishReason: KvoxChatFinishReason;
      /** The model that answered. */
      model: string;
      /** Token usage of the turn. */
      usage: KvoxUsage;
    };

/**
 * What the embedding model can do, as a static description.
 *
 * @stability experimental
 */
export interface KvoxEmbeddingCapability {
  /** The embedding model id (permanent once vectors are stored under it). */
  model: string;
  /** The width of every vector: the `vector(1536)` column. */
  dimensions: 1536;
  /** The longest input the model accepts, in tokens. */
  maxInputTokens: number;
  /** The most texts one call carries. */
  maxBatchSize: number;
}
