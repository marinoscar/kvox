// =============================================================================
// A scripted platform `stream()` for the Ask evaluation's replay test (#382, #476)
// =============================================================================
//
// Drives `AskRespondHandler.process()` end to end — real handler, real toolset,
// real DB, real `HandleRegistry`/citation plumbing, AND the real `PlatformKvoxAi.chat()`
// mapping — with NO network call and NO real model. What is faked is the layer
// below the port: `AiService.forUser(...).stream()`, which yields the platform's
// own events (`output_text.delta`, `output_item.done` with a `function_call` or a
// `reasoning` item, `response.completed`, `error`). So a replay proves the event
// mapping as well as the loop, the scorer, the seeder's `idMap` and the citation
// mapper, mirroring #362's `--predictions gold` self-test.
//
// One script array per model call. The helpers `text()`, `toolCall()` and `done()`
// keep their names, so a script reads the same as it did over the retired provider.
// =============================================================================

import type { KvoxAiReadiness, KvoxReasoningEffort } from '@marinoscar/kvox-ai';
import type { AiOutputItem, AiRequest, AiResponse, AiStreamEvent } from '@marinoscar/platform-api/ai';

import { PlatformKvoxAi } from '../../src/ai-port/platform-kvox-ai';
import type { KvoxAi } from '../../src/ai-port/kvox-ai';
import { readyReadiness } from '../../src/ai-port/testing/fake-kvox-ai';

export type ChatScript = AiStreamEvent[];

/** What a captured call carries: JSON-safe, with the tools reduced to their names. */
export interface CapturedStreamRequest {
  model: string | undefined;
  instructions: string | undefined;
  input: unknown;
  toolChoice: unknown;
  tools: string[];
  maxOutputTokens: number | undefined;
  reasoning: unknown;
}

/** The scope `AiService.forUser` was called with (the usage row's feature and job). */
export interface CapturedScope {
  userId: string;
  orgId?: string;
  jobId?: string;
  feature?: string;
}

/**
 * Replays a queue of scripts, one per `stream()` call, in order. FIFO across the
 * whole run: the caller sequences them per question.
 */
export class FakeAskStream {
  private queue: ChatScript[] = [];
  readonly requests: CapturedStreamRequest[] = [];
  readonly scopes: CapturedScope[] = [];

  /** Appends one call's worth of events to the queue. */
  enqueue(script: ChatScript): void {
    this.queue.push(script);
  }

  /** Scripts not yet played. */
  get pending(): number {
    return this.queue.length;
  }

  /** Clears captured requests — call between questions so each question's `capturedPrompts` is its own. */
  resetRequests(): void {
    this.requests.length = 0;
    this.scopes.length = 0;
  }

  /** Drops every queued script and every captured request. */
  reset(): void {
    this.queue = [];
    this.resetRequests();
  }

  /** The `AiService` stand-in: `new PlatformKvoxAi(fake.aiService() as never, ...)`, or `.overrideProvider(AiService).useValue(...)`. */
  aiService(): { forUser: (userId: string, scope?: Omit<CapturedScope, 'userId'>) => { stream: FakeAskStream['stream'] } } {
    return {
      forUser: (userId, scope) => {
        this.scopes.push({ userId, ...(scope ?? {}) });
        return { stream: (request, options) => this.stream(request, options) };
      },
    };
  }

  /** The fake of `AiUserClient.stream()`. */
  stream(request: AiRequest, options?: { signal?: AbortSignal }): AsyncIterable<AiStreamEvent> {
    this.requests.push({
      model: request.model,
      instructions: request.instructions,
      input: JSON.parse(JSON.stringify(request.input)) as unknown,
      toolChoice: request.toolChoice,
      tools: (request.tools ?? []).map((tool) => ('name' in tool ? tool.name : tool.type)),
      maxOutputTokens: request.maxOutputTokens,
      reasoning: request.reasoning,
    });
    const script = this.queue.shift() ?? [done('stop', 0, 0)];

    return (async function* () {
      let outputText = '';
      const output: AiOutputItem[] = [];
      for (const event of script) {
        if (options?.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
        if (event.type === 'output_text.delta') outputText += event.delta;
        if (event.type === 'output_item.done') output.push(event.item);
        if (event.type === 'response.completed') {
          // The completed response carries what the stream showed, as a real one does.
          const items: AiOutputItem[] = [
            ...(outputText.length > 0 ? ([{ type: 'message', text: outputText }] as AiOutputItem[]) : []),
            ...output,
          ];
          yield { type: 'response.completed', response: { ...event.response, output: items, outputText } };
        } else {
          yield event;
        }
      }
    })();
  }
}

export const done = (
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop',
  inputTokens = 100,
  outputTokens = 20,
): AiStreamEvent => {
  const response: AiResponse = {
    id: 'resp_fake',
    provider: 'openai',
    model: 'gpt-replay',
    output: [],
    outputText: '',
    usage: { inputTokens, outputTokens },
    finishReason,
  };
  return { type: 'response.completed', response };
};

export const text = (t: string): AiStreamEvent => ({ type: 'output_text.delta', delta: t });

export const toolCall = (id: string, name: string, argumentsJson: string): AiStreamEvent => ({
  type: 'output_item.done',
  item: { type: 'function_call', callId: id, name, arguments: argumentsJson },
});

/** A reasoning item, as a model that reasons emits before its tool calls. */
export const reasoning = (...summary: string[]): AiStreamEvent => ({
  type: 'output_item.done',
  item: { type: 'reasoning', summary },
});

/** The platform's failure event (a 429 is `AI_RATE_LIMITED`). */
export const failure = (code: 'AI_RATE_LIMITED' | 'AI_KEY_INVALID' | 'AI_PROVIDER_UNAVAILABLE', message = 'fake failure'): AiStreamEvent => ({
  type: 'error',
  code,
  message,
});

export interface FakeAskPort {
  /** The `KvoxAi` the handler injects: scripted readiness, the REAL `PlatformKvoxAi.chat()` over the fake stream. */
  ai: KvoxAi;
  /** The settings the handler reads (`get()` and `requestTimeoutMs()`), as the `ai` namespace would answer. */
  settings: { get: () => Promise<Record<string, unknown>>; requestTimeoutMs: () => Promise<number> };
  platform: PlatformKvoxAi;
}

export interface FakeAskPortOptions {
  model?: string;
  reasoningEffort?: KvoxReasoningEffort;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  readiness?: Partial<KvoxAiReadiness>;
}

/**
 * The port the Ask handler needs, with the real chat mapping over a `FakeAskStream`.
 * Readiness is scripted (it needs the database policy, which a replay does not have);
 * everything from `chat()` down is the production code.
 */
export function createFakeAskPort(stream: FakeAskStream, options: FakeAskPortOptions = {}): FakeAskPort {
  const policy = { maxInputTokens: 100_000, maxOutputTokens: 16_000, requestTimeoutMs: 120_000 };
  const settings = {
    get: async () => policy,
    requestTimeoutMs: async () => policy.requestTimeoutMs,
  };
  const platform = new PlatformKvoxAi(stream.aiService() as never, {} as never, {} as never, settings as never);

  const model = options.model ?? 'gpt-replay';
  const readiness = readyReadiness({
    model,
    source: 'task',
    reasoningEffort: options.reasoningEffort ?? 'low',
    contextWindowTokens: options.contextWindowTokens ?? 128_000,
    maxOutputTokens: options.maxOutputTokens ?? 16_000,
    ...(options.readiness ?? {}),
  });

  const ai = {
    readiness: async () => readiness,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    chat: (request: Parameters<KvoxAi['chat']>[0]) => platform.chat(request),
  } as unknown as KvoxAi;

  return { ai, settings, platform };
}
