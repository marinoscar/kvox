import { describeAskConformance } from '@marinoscar/kvox-api/ask/testing';
import type { ScriptedTurn } from '@marinoscar/kvox-api/ask/testing';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';
import { AiError } from '@marinoscar/platform-ai-providers';

import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';
import { createScriptedRuntime, type ScriptedCreateStep } from '../src/testing/index.js';

// =============================================================================
// describeAskConformance over a `prompted` tool-calling model (#654)
// =============================================================================
//
//   createKvoxAi { toolCallingMode: 'prompted' } -> scripted runtime (create only)
//
// The REAL `AskRespondHandler` (the loop, the caps, the answer hold, the citation check,
// every status-guarded write) runs over `KVOX_AI` bound to an OpenAI-compatible model that
// cannot call tools. The kit's scripted steps become what such a model would SAY, as the
// JSON the prompt asks for:
//
//   tool_call(s)        {"type":"tool_calls","calls":[...]}   (text before the call is dropped,
//                                                              as a native step drops it)
//   delta(s)            {"type":"answer","text":"..."}
//   fail(rate_limit)    the call fails
//
// One rule cannot hold and is named: (d) "a 429 after flushed text". A prompted step is
// one non-streamed call, so text can never have been flushed before it fails. That case is
// skipped here, with this reason, and nowhere else.
// =============================================================================

const MODEL = 'scripted-model';

function modelState(): KvoxAiModelState {
  return {
    provider: 'compat',
    models: [
      {
        id: MODEL,
        label: MODEL,
        structuredOutput: true,
        toolCalling: true,
        toolCallingMode: 'prompted',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
      },
    ],
    policy: {
      enabled: true,
      provider: 'compat',
      defaultModel: MODEL,
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function stepFor(turn: ScriptedTurn): ScriptedCreateStep {
  const usage = { inputTokens: turn.usage?.inputTokens ?? 100, outputTokens: turn.usage?.outputTokens ?? 20 };
  const failure = turn.events.find((event): event is Extract<ScriptedTurn['events'][number], { type: 'fail' }> => event.type === 'fail');
  if (failure !== undefined) {
    if (!(failure.error instanceof KvoxAiError) || failure.error.errorClass !== 'rate_limit') {
      throw new Error(`the scripting does not translate ${failure.error.message}`);
    }
    return { fail: new AiError('AI_RATE_LIMITED', failure.error.message, { retryAfterMs: failure.error.retryAfterMs ?? 1500 }) };
  }
  const calls = turn.events.flatMap((event) => (event.type === 'tool_call' ? [event] : []));
  if (calls.length > 0) {
    const body = {
      type: 'tool_calls',
      calls: calls.map((call) => ({
        name: call.name,
        arguments: typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments,
      })),
    };
    return { response: { outputText: JSON.stringify(body), usage } };
  }
  const text = turn.events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');
  return {
    response: {
      outputText: JSON.stringify({ type: 'answer', text }),
      usage,
      ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}),
    },
  };
}

/** Skips the one case a non-streamed step cannot express, and says why. */
const skipping = (realIt: typeof it): typeof it => {
  const wrapped = ((name: string, fn: (...args: any[]) => any) =>
    name.startsWith('(d) ') ? realIt.skip(name, fn) : realIt(name, fn)) as typeof it;
  return wrapped;
};

const runtimes: ReturnType<typeof createScriptedRuntime>[] = [];

describeAskConformance(
  'createKvoxAi over a prompted tool-calling model',
  () => {
    const runtime = createScriptedRuntime();
    runtimes.push(runtime);
    const port = createKvoxAi({ runtime, taskModels: { load: async () => modelState() } });
    return {
      port,
      script(turns) {
        runtime.reset();
        for (const turn of turns) runtime.queueCreate(stepFor(turn));
        // After the script runs out the kit expects an empty step.
        runtime.queueCreate({ response: { outputText: '{"type":"answer","text":""}' } });
      },
    };
  },
  { describe, it: skipping(it), expect },
);

describe('the prompted Ask run never used the provider tool calling', () => {
  it('made only plain create calls, none carrying tools or a tool choice', () => {
    const calls = runtimes.flatMap((runtime) => runtime.calls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((record) => record.kind === 'create')).toBe(true);
    for (const record of calls) {
      const request = record.request as Record<string, unknown>;
      expect(request.tools).toBeUndefined();
      expect(request.toolChoice).toBeUndefined();
    }
  });
});
