import { describeAskConformance } from '@marinoscar/kvox-api/ask/testing';
import type { ScriptedTurn } from '@marinoscar/kvox-api/ask/testing';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';
import { AI_KEYLESS_API_KEY } from '@marinoscar/platform-ai-providers';

import {
  createCopilotAdapter,
  createCopilotMockTransport,
  type CopilotMockReply,
  type CopilotMockTransport,
} from '../src/copilot/index.js';
import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';

// =============================================================================
// describeAskConformance over the GitHub Copilot adapter (#654)
// =============================================================================
//
//   createKvoxAi
//     -> createDirectRuntime { copilot: createCopilotAdapter(mock transport) }
//
// The REAL `AskRespondHandler` (the loop, the caps, the answer hold, the citation check,
// every status-guarded write) runs over `KVOX_AI` bound to Copilot. The kit's scripted
// steps become what the Copilot runtime would SAY, in the SDK's own event shapes:
//
//   delta(s) then tool_call(s)   one `toolCalls` reply: the preamble, an assistant message
//                                listing every call, the usage, and the tool events; the
//                                runtime then WAITS for the session's tool handlers
//   delta(s)                     an answer (with the step's finish reason)
//   fail(rate_limit)             a `session.error` rate_limit / 429, after the text when
//                                there was some
//
// Every scripted step is the NEXT model call of the runtime, whether the adapter starts a
// fresh session for it or continues the one holding the previous step's tool calls: the
// mock plays its queue in order either way, so the kit cannot tell, and that is the point:
// the loop is unchanged. The ninth call (`toolChoice: 'none'`) is a fresh session that
// renders the transcript, and the held session of the step before it is released.
// =============================================================================

const MODEL = 'scripted-model';

function modelState(): KvoxAiModelState {
  return {
    provider: 'copilot',
    models: [
      {
        id: MODEL,
        label: MODEL,
        structuredOutput: true,
        toolCalling: true,
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        structuredOutputMode: 'native',
      },
    ],
    policy: {
      enabled: true,
      provider: 'copilot',
      defaultModel: MODEL,
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

/** One scripted Ask step as the reply the Copilot runtime would make. */
function replyFor(turn: ScriptedTurn): CopilotMockReply {
  const usage = { inputTokens: turn.usage?.inputTokens ?? 100, outputTokens: turn.usage?.outputTokens ?? 20 };
  const calls = turn.events.flatMap((event) => (event.type === 'tool_call' ? [event] : []));
  const failure = turn.events.find((event): event is Extract<ScriptedTurn['events'][number], { type: 'fail' }> => event.type === 'fail');
  const firstCall = turn.events.findIndex((event) => event.type === 'tool_call');
  const preamble = turn.events
    .slice(0, firstCall === -1 ? undefined : firstCall)
    .flatMap((event) => (event.type === 'delta' ? [event.text] : []))
    .join('');

  if (failure !== undefined) {
    const rateLimited = failure.error instanceof KvoxAiError && failure.error.errorClass === 'rate_limit';
    if (!rateLimited) throw new Error(`the scripting does not translate ${failure.error.message}`);
    const data = { errorType: 'rate_limit', statusCode: 429, message: failure.error.message };
    return preamble.length === 0
      ? { kind: 'sessionError', ...data }
      : {
          kind: 'events',
          events: [{ type: 'assistant.message_delta', data: { deltaContent: preamble } }, { type: 'session.error', data }, { type: 'session.idle', data: {} }],
        };
  }
  if (calls.length > 0) {
    return {
      kind: 'toolCalls',
      ...(preamble.length > 0 ? { text: preamble } : {}),
      calls: calls.map((call) => ({ name: call.name, arguments: call.arguments, toolCallId: call.id })),
      usage,
    };
  }
  return { kind: 'answer', text: preamble, usage, ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}) };
}

/** The transports built so far, so the afterAll check can read them. */
const built: Array<{ transport: CopilotMockTransport; adapter: ReturnType<typeof createCopilotAdapter> }> = [];

describeAskConformance(
  'createKvoxAi over the GitHub Copilot adapter',
  () => {
    const transport = createCopilotMockTransport();
    // A short idle timeout: a turn the kit abandons (the conversation deleted mid-turn) leaves a held session behind.
    const adapter = createCopilotAdapter({ optIn: true, transport, bridge: { idleTimeoutMs: 100, batchGraceMs: 100 } });
    built.push({ transport, adapter });
    const port = createKvoxAi({
      runtime: createDirectRuntime({ adapters: { copilot: adapter }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
      taskModels: { load: async () => modelState() },
      catalog: adapter.kvox.catalog,
    });
    return {
      port,
      script(turns) {
        transport.reset();
        for (const turn of turns) transport.queue(replyFor(turn));
      },
    };
  },
  { describe, it, expect },
);

describe('the Ask conformance run left nothing behind', () => {
  it('every session of every run is deleted once the idle timeout has passed', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(built.length).toBeGreaterThan(0);
    for (const { transport, adapter } of built) {
      expect(adapter.bridge.heldSessions()).toBe(0);
      for (const session of transport.sessions()) expect(session).toMatchObject({ disconnected: true, deleted: true });
    }
  });

  it('the loop really ran on the bridge: one session carried the eight tool steps of the step-cap case', () => {
    const sessions = built.flatMap(({ transport }) => transport.sessions());
    // Eight tool steps = the fresh session plus seven continuations; the forced ninth call is its own session.
    expect(Math.max(0, ...sessions.map((session) => session.continuations))).toBe(7);
    const forced = sessions.filter((session) => session.prompts.some((prompt) => prompt.prompt.startsWith('Conversation so far:')));
    expect(forced.length).toBeGreaterThan(0);
    expect(forced.every((session) => session.config.availableTools.length === 0)).toBe(true);
  });
});
