import type { z } from 'zod';

import {
  KvoxAiError,
  type KvoxAiCapabilities,
  type KvoxAiContext,
  type KvoxAiErrorClass,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxAiUsage,
  type KvoxChatDeltaEvent,
  type KvoxChatEvent,
  type KvoxChatMessage,
  type KvoxChatToolCallEvent,
  type KvoxEmbedResult,
  type KvoxStructuredResult,
  type KvoxTextEvent,
  type KvoxToolDef,
} from '../ports/index.js';

/**
 * What a fake model answers. Every field is optional; the defaults give a
 * working model that says `fake answer`.
 *
 * @stability experimental
 */
export interface FakeKvoxAiScript {
  /** The text `generateText` streams, as one delta or as several. */
  text?: string | string[];
  /** The value `generateStructured` returns; it is validated against the call's schema. */
  structured?: unknown;
  /**
   * The content events of each `chat` call, one array per call in order; the last
   * array repeats. The fake appends `step_end` and `done`, and drops any `delta`
   * that follows a `tool_call` in the same step, as the port requires.
   */
  chat?: Array<Array<KvoxChatDeltaEvent | KvoxChatToolCallEvent>>;
  /** The vector width `embed` returns. Defaults to 8. */
  embeddingDimensions?: number;
  /** The embeddings model id. Defaults to `fake-embed`. */
  embeddingModel?: string;
  /** Overrides for what `capabilities` reports. */
  capabilities?: Partial<KvoxAiCapabilities>;
  /** Overrides for the target `resolveTask` returns. */
  target?: Partial<KvoxAiTarget>;
  /**
   * Makes every call except `capabilities` and `countTokens` throw. A class name
   * builds a {@link KvoxAiError} of that class; an error is thrown as given.
   */
  failWith?: KvoxAiErrorClass | KvoxAiError;
}

/**
 * One call a {@link FakeKvoxAi} received.
 *
 * @stability experimental
 */
export interface FakeKvoxAiCall {
  /** The port method. */
  method: 'capabilities' | 'resolveTask' | 'generateText' | 'generateStructured' | 'chat' | 'embed' | 'countTokens';
  /** The context, when the method takes one. */
  ctx?: KvoxAiContext;
  /** The request, as the caller passed it. */
  req?: unknown;
}

/**
 * A scripted {@link KvoxAiPort} that records every call.
 *
 * @stability experimental
 */
export interface FakeKvoxAi extends KvoxAiPort {
  /** Every call so far, in order. */
  readonly calls: FakeKvoxAiCall[];
  /** The live script; assign fields to change what the next call does. */
  script: FakeKvoxAiScript;
  /** Forgets the recorded calls. */
  reset(): void;
}

const USAGE: KvoxAiUsage = { inputTokens: 1, outputTokens: 1 };

function errorFor(failWith: KvoxAiErrorClass | KvoxAiError): KvoxAiError {
  return failWith instanceof KvoxAiError
    ? failWith
    : new KvoxAiError(failWith, `Scripted ${failWith} failure`, failWith === 'rate_limit' ? 1000 : undefined);
}

/**
 * Builds a fake model port. Its text, structured value, chat events and
 * embeddings come from `script`; it records every call; it can throw each
 * {@link KvoxAiError} class.
 *
 * @param options - the initial script.
 * @returns the fake.
 * @stability experimental
 */
export function createFakeKvoxAi(options: { script?: FakeKvoxAiScript } = {}): FakeKvoxAi {
  const calls: FakeKvoxAiCall[] = [];
  let chatCalls = 0;

  const fake: FakeKvoxAi = {
    calls,
    script: { ...options.script },

    reset(): void {
      calls.length = 0;
      chatCalls = 0;
    },

    async capabilities(ctx: KvoxAiContext): Promise<KvoxAiCapabilities> {
      calls.push({ method: 'capabilities', ctx });
      const dimensions = fake.script.embeddingDimensions ?? 8;
      return {
        available: true,
        structuredOutput: true,
        toolCalling: true,
        embeddings: { model: fake.script.embeddingModel ?? 'fake-embed', dimensions },
        graphEnabled: true,
        ...fake.script.capabilities,
      };
    },

    async resolveTask(ctx: KvoxAiContext, task: string, opts?: { model?: string }): Promise<KvoxAiTarget> {
      calls.push({ method: 'resolveTask', ctx, req: { task, ...opts } });
      if (fake.script.failWith) throw errorFor(fake.script.failWith);
      return {
        provider: 'fake',
        model: opts?.model ?? 'fake-model',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        source: opts?.model ? 'requested' : 'default',
        ...fake.script.target,
      };
    },

    async *generateText(ctx, req): AsyncIterable<KvoxTextEvent> {
      calls.push({ method: 'generateText', ctx, req });
      if (fake.script.failWith) throw errorFor(fake.script.failWith);
      const text = fake.script.text ?? 'fake answer';
      for (const piece of Array.isArray(text) ? text : [text]) {
        if (piece.length > 0) yield { type: 'delta', text: piece };
      }
      yield { type: 'done', usage: USAGE, finishReason: 'stop' };
    },

    async generateStructured<T>(
      ctx: KvoxAiContext,
      req: { target: KvoxAiTarget; system: string; user: string; schema: z.ZodType<T>; schemaName: string },
    ): Promise<KvoxStructuredResult<T>> {
      calls.push({ method: 'generateStructured', ctx, req });
      if (fake.script.failWith) throw errorFor(fake.script.failWith);
      const parsed = req.schema.safeParse(fake.script.structured);
      if (!parsed.success) {
        throw new KvoxAiError('other', `The scripted value does not match the schema "${req.schemaName}".`);
      }
      return { value: parsed.data, usage: USAGE };
    },

    async *chat(
      ctx: KvoxAiContext,
      req: { target: KvoxAiTarget; messages: KvoxChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' },
    ): AsyncIterable<KvoxChatEvent> {
      calls.push({ method: 'chat', ctx, req });
      if (fake.script.failWith) throw errorFor(fake.script.failWith);
      const steps = fake.script.chat ?? [[{ type: 'delta', text: 'fake answer' }]];
      const step = steps[Math.min(chatCalls, steps.length - 1)] ?? [];
      chatCalls += 1;

      let calledTool = false;
      for (const event of step) {
        if (event.type === 'tool_call') calledTool = true;
        else if (calledTool) continue; // no text after a tool call within a step
        yield event;
      }
      yield { type: 'step_end' };
      yield { type: 'done', usage: USAGE };
    },

    async embed(ctx: KvoxAiContext, req: { inputs: string[] }): Promise<KvoxEmbedResult> {
      calls.push({ method: 'embed', ctx, req });
      if (fake.script.failWith) throw errorFor(fake.script.failWith);
      const dimensions = fake.script.embeddingDimensions ?? 8;
      return {
        model: fake.script.embeddingModel ?? 'fake-embed',
        dimensions,
        vectors: req.inputs.map((input) => vectorOf(input, dimensions)),
      };
    },

    countTokens(target: KvoxAiTarget, text: string): number {
      calls.push({ method: 'countTokens', req: { model: target.model, length: text.length } });
      return Math.ceil(text.length / 4);
    },
  };

  return fake;
}

/** A deterministic vector: the same text always embeds to the same numbers. */
function vectorOf(text: string, dimensions: number): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return Array.from({ length: dimensions }, (_, index) => {
    seed = Math.imul(seed ^ (index + 1), 2654435761);
    return ((seed >>> 0) % 2000) / 1000 - 1;
  });
}
