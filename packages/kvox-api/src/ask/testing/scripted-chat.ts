import {
  KvoxAiError,
  type KvoxAiCapabilities,
  type KvoxAiContext,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxAiUsage,
  type KvoxChatEvent,
  type KvoxChatMessage,
  type KvoxToolDef,
} from '../../ports/index.js';

// =============================================================================
// The scripted chat model (issue #497, epic #491)
// =============================================================================
//
// A fake `KvoxAiPort.chat` that replays one scripted step per call, in order, and records every
// request. It is what the Ask replay and conformance runs drive the handler with: no network,
// no model, but the real loop, caps, hold rule and citation plumbing above it.
//
// A STEP is the events of one model round trip: text deltas and tool calls, optionally a failure
// partway through (a provider 429 after some text). The fake appends `step_end` and `done`, and
// drops any `delta` after a `tool_call` in the same step, as the port requires.
// =============================================================================

/**
 * One event of a scripted step.
 *
 * @stability experimental
 */
export type ScriptedEvent =
  | {
      /** A piece of streamed text. */
      type: 'delta';
      /** The text. */
      text: string;
    }
  | {
      /** A tool the model calls. */
      type: 'tool_call';
      /** The call id. */
      id: string;
      /** The tool name. */
      name: string;
      /** The arguments: an object, or text that is not JSON. */
      arguments: unknown;
    }
  | {
      /** The call fails here, after the events before it were delivered. */
      type: 'fail';
      /** What the call throws. */
      error: Error;
    };

/**
 * One scripted model round trip: its events and how it ends.
 *
 * @stability experimental
 */
export interface ScriptedTurn {
  /** The events, in order. */
  events: ScriptedEvent[];
  /** Why the model stopped. Default `stop`. */
  finishReason?: 'stop' | 'length' | 'content_filter';
  /** What the call consumed. Default 100 in, 20 out. */
  usage?: KvoxAiUsage;
}

/**
 * The context of a recorded call: the port's context with the signal reduced to whether one was given.
 *
 * @stability experimental
 */
export interface ScriptedChatContext extends Omit<KvoxAiContext, 'signal'> {
  /** Whether the call carried an abort signal (the per-call time backstop). */
  signal: boolean;
}

/**
 * A request the scripted model received, copied so later mutation cannot change it.
 *
 * @stability experimental
 */
export interface ScriptedChatRequest {
  /** The context the call was made with (the signal is reduced to whether one was given). */
  ctx: ScriptedChatContext;
  /** The model target. */
  target: KvoxAiTarget;
  /** The history sent. */
  messages: KvoxChatMessage[];
  /** The names of the tools offered. */
  tools: string[];
  /** The tool choice. */
  toolChoice: 'auto' | 'none';
}

/**
 * What {@link createScriptedChat} answers with besides `chat`.
 *
 * @stability experimental
 */
export interface ScriptedChatOptions {
  /** The model id `resolveTask` answers with unless the caller picks one. Default `scripted-model`. */
  model?: string;
  /** The provider id. Default `openai`. */
  provider?: string;
  /** The context window. Default 128 000. */
  contextWindowTokens?: number;
  /** The output ceiling. Default 16 000. */
  maxOutputTokens?: number;
  /** Overrides for what `capabilities` reports. */
  capabilities?: Partial<KvoxAiCapabilities>;
  /** Makes `resolveTask` throw, like a host whose model is not ready. */
  resolveFailure?: KvoxAiError;
}

/**
 * The scripted model: the parts of the AI port an Ask turn uses.
 *
 * @stability experimental
 */
export interface ScriptedChat extends Pick<KvoxAiPort, 'chat' | 'resolveTask' | 'capabilities' | 'countTokens'> {
  /** Every `chat` request so far, in order. */
  readonly requests: ScriptedChatRequest[];
  /** Steps not yet played. */
  readonly pending: number;
  /** Appends steps to the end of the script. */
  enqueue(...turns: ScriptedTurn[]): void;
  /** Drops the unplayed steps and the recorded requests. */
  reset(): void;
}

/**
 * A step that streams text.
 *
 * @stability experimental
 */
export const text = (value: string): ScriptedEvent => ({ type: 'delta', text: value });

/**
 * A step event that calls a tool.
 *
 * @stability experimental
 */
export const toolCall = (id: string, name: string, args: unknown = {}): ScriptedEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: args,
});

/**
 * A step event that fails the call.
 *
 * @stability experimental
 */
export const failWith = (error: Error): ScriptedEvent => ({ type: 'fail', error });

/**
 * A scripted step.
 *
 * @param events - the events of the step.
 * @param finishReason - how it ends.
 * @returns the step.
 *
 * @stability experimental
 */
export function step(events: ScriptedEvent[], finishReason?: ScriptedTurn['finishReason']): ScriptedTurn {
  return { events, ...(finishReason ? { finishReason } : {}) };
}

/**
 * Builds the scripted model.
 *
 * @param script - the steps, one per `chat` call. When they run out the model answers with an
 *   empty step.
 * @param options - what `resolveTask` and `capabilities` answer.
 * @returns the fake.
 * @stability experimental
 */
export function createScriptedChat(script: ScriptedTurn[] = [], options: ScriptedChatOptions = {}): ScriptedChat {
  let queue = [...script];
  const requests: ScriptedChatRequest[] = [];

  return {
    requests,

    get pending(): number {
      return queue.length;
    },

    enqueue(...turns: ScriptedTurn[]): void {
      queue.push(...turns);
    },

    reset(): void {
      queue = [];
      requests.length = 0;
    },

    async capabilities(): Promise<KvoxAiCapabilities> {
      return {
        available: true,
        structuredOutput: true,
        toolCalling: true,
        embeddings: null,
        graphEnabled: true,
        ...options.capabilities,
      };
    },

    async resolveTask(_ctx, _task, opts): Promise<KvoxAiTarget> {
      if (options.resolveFailure) throw options.resolveFailure;

      return {
        provider: options.provider ?? 'openai',
        model: opts?.model ?? options.model ?? 'scripted-model',
        reasoningEffort: 'low',
        contextWindowTokens: options.contextWindowTokens ?? 128_000,
        maxOutputTokens: options.maxOutputTokens ?? 16_000,
        source: opts?.model ? 'requested' : 'task',
      };
    },

    async *chat(
      ctx: KvoxAiContext,
      req: { target: KvoxAiTarget; messages: KvoxChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' },
    ): AsyncIterable<KvoxChatEvent> {
      requests.push({
        ctx: { ...ctx, signal: ctx.signal !== undefined },
        target: { ...req.target },
        messages: JSON.parse(JSON.stringify(req.messages)) as KvoxChatMessage[],
        tools: req.tools.map((tool) => tool.name),
        toolChoice: req.toolChoice,
      });

      const turn = queue.shift() ?? { events: [] };
      let calledTool = false;

      for (const event of turn.events) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('aborted');
        if (event.type === 'fail') throw event.error;
        if (event.type === 'tool_call') {
          calledTool = true;
          yield event;
        } else if (!calledTool) {
          yield event;
        }
      }

      yield { type: 'step_end' };
      yield {
        type: 'done',
        usage: turn.usage ?? { inputTokens: 100, outputTokens: 20 },
        ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
      };
    },

    countTokens(_target: KvoxAiTarget, value: string): number {
      return Math.ceil(value.length / 4);
    },
  };
}
