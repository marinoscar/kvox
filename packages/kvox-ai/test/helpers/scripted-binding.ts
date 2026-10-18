import { AiError, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import { KvoxAiError, type KvoxAiErrorClass, type KvoxAiPort } from '@marinoscar/kvox-api/ports';
import type { ScriptedTurn } from '@marinoscar/kvox-api/ask/testing';
import type { KvoxPortsUnderTest } from '@marinoscar/kvox-api/testing';
import { z } from 'zod';

import { createKvoxAi, type KvoxAiModelState } from '../../src/index.js';
import {
  completedEvent,
  createScriptedRuntime,
  functionCallEvent,
  textDeltaEvent,
  type KvoxAiConformanceProvider,
  type KvoxAiConformanceUnderTest,
  type ScriptedRuntime,
} from '../../src/testing/index.js';

// =============================================================================
// The package binding the conformance kits run against (issue #579)
// =============================================================================
//
// `createKvoxAi` over `createScriptedRuntime`: the KVOX_AI binding every host
// shares, with the one thing a host differs in (the provider round trip) scripted.
// The three kits (`describeKvoxAiConformance`, `describeKvoxPortsConformance`,
// `describeAskConformance`) each get the same port and a different handle on the
// runtime under it.
// =============================================================================

/** A configured host: AI on, `openai` active, one model enabled with every capability. */
export function scriptedModelState(): KvoxAiModelState {
  return {
    provider: 'openai',
    models: [
      { id: 'scripted-model', label: 'scripted-model', structuredOutput: true, toolCalling: true, contextWindow: 128_000, maxOutputTokens: 16_384 },
    ],
    policy: {
      enabled: true,
      provider: 'openai',
      defaultModel: 'scripted-model',
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

/** `createKvoxAi` over a fresh scripted runtime. */
export function scriptedBinding(options: { requestTimeoutMs?: number; defaultStream?: AiStreamEvent[] } = {}): {
  port: KvoxAiPort;
  runtime: ScriptedRuntime;
} {
  const runtime = createScriptedRuntime(options.defaultStream !== undefined ? { defaultStream: options.defaultStream } : {});
  const port = createKvoxAi({
    runtime,
    taskModels: { load: async () => scriptedModelState() },
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  return { port, runtime };
}

/** The handle `describeKvoxAiConformance` drives. */
export function conformanceUnderTest(options: { requestTimeoutMs?: number } = {}): KvoxAiConformanceUnderTest {
  const { port, runtime } = scriptedBinding(options);
  const provider: KvoxAiConformanceProvider = {
    structuredAnswer: ({ value, finishReason }) =>
      runtime.queueCreate({ response: { parsed: value, ...(finishReason !== undefined ? { finishReason } : {}) } }),
    streamAnswer: (events) => runtime.queueStream({ events }),
    failNext: (error) => runtime.failNext(error),
    hangNext: () => runtime.hangNext(),
    lastStructuredRequest: () => {
      const last = [...runtime.calls].reverse().find((record) => record.kind === 'create');
      const structured = (last?.request as { structuredOutput?: { name: string; schema: unknown; strict: boolean } } | undefined)
        ?.structuredOutput;
      return structured;
    },
  };
  return { port, provider };
}

/** What the provider throws for each port class on a route (the kit's default context has no job). */
const FAILURES: Record<KvoxAiErrorClass, (() => unknown) | { cannot: string }> = {
  auth: () => new KvoxAiError('auth', 'The provider rejected the key.'),
  refusal: () => new AiError('AI_CONTENT_FILTERED', 'The provider declined to answer.'),
  rate_limit: () => new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 1500 }),
  budget: { cannot: "a budget refusal is the caller's pre-flight check (computeTokenBudget), never a provider answer" },
  timeout: () => new DOMException('The provider call outlived its deadline.', 'TimeoutError'),
  not_configured: () => new AiError('AI_DISABLED', 'AI is switched off.'),
  key_missing: () => new AiError('AI_KEY_REQUIRED', 'No key may pay for this call.'),
  capability: () => new AiError('AI_MODEL_NOT_ENABLED', 'The model is not enabled.'),
  truncated: { cannot: 'only a structured call that set an output ceiling reads truncation (describeKvoxAiConformance proves it)' },
  invalid_output: { cannot: 'only a structured call reads an unusable structured answer (describeKvoxAiConformance proves it)' },
  other: () => new AiError('AI_PROVIDER_UNAVAILABLE', 'The provider is having a bad day.'),
};

/** The `ai` section `describeKvoxPortsConformance` needs. */
export function portsAiUnderTest(): NonNullable<KvoxPortsUnderTest['ai']> {
  const { port, runtime } = scriptedBinding();
  return {
    port,
    structured: { schema: z.object({ ok: z.boolean() }), schemaName: 'conformance' },
    failNextWith(errorClass) {
      const failure = FAILURES[errorClass];
      if (typeof failure !== 'function') return false;
      runtime.failNext(failure());
      return true;
    },
    arrangeTextAfterToolCall() {
      runtime.queueStream({
        events: [
          textDeltaEvent('Let me look.'),
          functionCallEvent('call-1', 'lookup', '{}'),
          textDeltaEvent('Text after the call.'),
          completedEvent({ finishReason: 'tool_calls' }),
        ],
      });
    },
  };
}

/** One scripted Ask step as the provider's own stream events (and how it ends). */
export function providerStep(turn: ScriptedTurn): { events: AiStreamEvent[]; thenFail?: unknown } {
  const events: AiStreamEvent[] = [];
  let thenFail: unknown;

  for (const event of turn.events) {
    if (event.type === 'delta') events.push(textDeltaEvent(event.text));
    else if (event.type === 'tool_call') {
      events.push(functionCallEvent(event.id, event.name, typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments)));
    } else if (event.error instanceof KvoxAiError && event.error.errorClass === 'rate_limit') {
      thenFail = new AiError('AI_RATE_LIMITED', event.error.message, {
        ...(event.error.retryAfterMs !== undefined ? { retryAfterMs: event.error.retryAfterMs } : {}),
      });
    } else {
      throw new Error(`the scripting does not translate ${event.error.message}`);
    }
  }
  // A step that failed has no completion.
  if (thenFail === undefined) {
    events.push(
      completedEvent({
        finishReason: turn.finishReason ?? 'stop',
        usage: { inputTokens: turn.usage?.inputTokens ?? 100, outputTokens: turn.usage?.outputTokens ?? 20 },
      }),
    );
  }
  return { events, ...(thenFail !== undefined ? { thenFail } : {}) };
}
