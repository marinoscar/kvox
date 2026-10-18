import {
  AI_KEYLESS_API_KEY,
  AiError,
  type AiEmbeddingRequest,
  type AiProviderAdapter,
  type AiStreamEvent,
} from '@marinoscar/platform-ai-providers';

import { createCopilotAdapter, createCopilotMockTransport, type CopilotMockReply, type CopilotMockTransport } from '../src/copilot/index.js';
import { createDirectRuntime } from '../src/direct/index.js';
import { EMBEDDING_DIMENSIONS } from '../src/embedding/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';
import {
  describeKvoxAiConformance,
  wrapRecordingAdapter,
  type KvoxAiConformanceProvider,
  type KvoxAiConformanceUnderTest,
} from '../src/testing/index.js';

// =============================================================================
// describeKvoxAiConformance over the GitHub Copilot adapter (#581, Phase 2)
// =============================================================================
//
//   createKvoxAi
//     -> createDirectRuntime { copilot: wrapRecordingAdapter(createCopilotAdapter(mock transport)),
//                              openai:  an embeddings-only stand-in (the KVOX_EMBEDDING provider) }
//
// The task-model state names `copilot` as the provider and one native GPT model. The
// kit's provider controls are mapped onto what the Copilot runtime would SAY, in the
// SDK's own event shapes (the mock transport), never onto an AiError handed straight
// to the port:
//
//   structuredAnswer({ value })     an answer whose text is the JSON, finishing as asked
//   streamAnswer(events)            the deltas as text, the completion's finish reason; an in-band
//                                   error event becomes a session.error after the partial text
//   failNext(AiError)               AI_RATE_LIMITED   -> session.error rate_limit / 429
//                                   AI_KEY_INVALID    -> session.error authentication / 401
//                                   AI_KEY_REQUIRED   -> the runtime reports nobody signed in
//                                   AI_CONTENT_FILTERED -> session.error content_filter
//                                   AI_STRUCTURED_OUTPUT_INVALID -> an answer that fails the JSON /
//                                                       schema check as its issues imply
//                                   anything else     -> session.error of an unknown type
//   failNext(Error | string)        `send` throws it
//   hangNext()                      the session never answers
//
// The embeddings stand-in consumes an armed failure or hang when an embed is the next
// round trip, so `failNext` means "the next round trip of any kind" as the kit says.
//
// OPT-OUTS (each with its reason, never a skip):
//   chat_tool_calls  Copilot ships with tool calling off (the #581 decision): the adapter refuses
//                    tools and the Ask loop stays on OpenAI.
//   rate_limit_job   the case needs the provider's retry hint to reach the queue. SDK 1.0.22 puts no
//                    retry-after on session.error or model.call_failure, so the adapter cannot
//                    produce one (it honours a numeric hint when a later release adds it: proved in
//                    copilot-errors.spec.ts).
// =============================================================================

const MODEL = 'gpt-5-mini';

function modelState(): KvoxAiModelState {
  return {
    provider: 'copilot',
    models: [
      {
        id: MODEL,
        label: MODEL,
        structuredOutput: true,
        // Copilot ships with tool calling off (#581): the Ask loop stays on OpenAI.
        toolCalling: false,
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        structuredOutputMode: 'native',
      },
    ],
    policy: {
      enabled: true,
      provider: 'copilot',
      defaultModel: MODEL,
      graphEnabled: false,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

/** What the kit armed for the next round trip. */
type Armed =
  | { kind: 'answer'; value: unknown; finishReason?: 'stop' | 'length' | 'content_filter' }
  | { kind: 'stream'; events: AiStreamEvent[] }
  | { kind: 'fail'; error: unknown }
  | { kind: 'hang' };

/** The session.error shape of a platform error code. */
function sessionErrorFor(error: AiError): Extract<CopilotMockReply, { kind: 'sessionError' }> {
  const base = { kind: 'sessionError' as const, message: error.message };
  switch (error.code) {
    case 'AI_RATE_LIMITED':
      return { ...base, errorType: 'rate_limit', statusCode: 429 };
    case 'AI_KEY_INVALID':
      return { ...base, errorType: 'authentication', statusCode: 401 };
    case 'AI_CONTENT_FILTERED':
      return { ...base, errorType: 'content_filter' };
    case 'AI_PROVIDER_UNAVAILABLE':
      return { ...base, errorType: 'query', statusCode: 503 };
    default:
      return { ...base, errorType: 'query', statusCode: 500 };
  }
}

/** What the Copilot runtime would do for a failure the kit asked for. */
function replyForFailure(error: unknown, structured: boolean): CopilotMockReply {
  if (!AiError.isAiError(error)) return { kind: 'throw', error };
  if (error.code === 'AI_KEY_REQUIRED') return { kind: 'throw', error: new Error('User is not authenticated') };
  if (error.code === 'AI_STRUCTURED_OUTPUT_INVALID' && structured) {
    const issues = (error.toJSON().details.issues as Array<{ code?: string }> | undefined) ?? [];
    const notJson = issues.length > 0 && issues.every((issue) => issue.code === 'invalid_json');
    // Not JSON at all, or well-formed JSON that fails the schema (the fixture requires a verdict).
    return { kind: 'answer', text: notJson ? '{"verdict": "ye' : '{}' };
  }
  return sessionErrorFor(error);
}

/** A stream the kit scripted, as the Copilot session's events. */
function replyForStream(events: AiStreamEvent[]): CopilotMockReply {
  const deltas = events.flatMap((event) => (event.type === 'output_text.delta' ? [event.delta] : []));
  const failure = events.find((event): event is Extract<AiStreamEvent, { type: 'error' }> => event.type === 'error');
  if (failure !== undefined) {
    const mapped = sessionErrorFor(new AiError(failure.code, failure.message));
    const { kind: _kind, ...data } = mapped;
    return {
      kind: 'events',
      events: [
        ...deltas.map((deltaContent) => ({ type: 'assistant.message_delta', data: { deltaContent } })),
        { type: 'session.error', data },
      ],
    };
  }
  const completed = events.find((event): event is Extract<AiStreamEvent, { type: 'response.completed' }> => event.type === 'response.completed');
  const finish = completed?.response.finishReason;
  return {
    kind: 'answer',
    text: deltas.join(''),
    finishReason: finish === 'length' || finish === 'content_filter' ? finish : 'stop',
    ...(completed?.response.usage !== undefined
      ? { usage: { inputTokens: completed.response.usage.inputTokens ?? 1, outputTokens: completed.response.usage.outputTokens ?? 1 } }
      : {}),
  };
}

function conformanceUnderTest(options: { requestTimeoutMs?: number } = {}): KvoxAiConformanceUnderTest {
  const transport = createCopilotMockTransport();
  let armed: Armed | null = null;
  const take = (): Armed | null => {
    const next = armed;
    armed = null;
    return next;
  };

  // The sign-in check is the first thing a call does: a signed-out failure is reported there.
  const copilotTransport: CopilotMockTransport = {
    ...transport,
    async getAuthStatus() {
      if (armed?.kind === 'fail' && AiError.isAiError(armed.error) && armed.error.code === 'AI_KEY_REQUIRED') {
        armed = null;
        return { isAuthenticated: false };
      }
      return transport.getAuthStatus();
    },
  };
  transport.onSend((send) => {
    const next = take();
    if (next === null) return undefined;
    switch (next.kind) {
      case 'answer': {
        // A null value is "no usable text" (length / content_filter finishes).
        const text = next.value === null ? '' : JSON.stringify(next.value);
        return { kind: 'answer', text, ...(next.finishReason !== undefined ? { finishReason: next.finishReason } : {}) };
      }
      case 'stream':
        return replyForStream(next.events);
      case 'fail':
        return replyForFailure(next.error, send.responseSchema !== undefined);
      case 'hang':
        return { kind: 'hang' };
    }
  });

  const copilot = wrapRecordingAdapter(createCopilotAdapter({ optIn: true, transport: copilotTransport }));

  // The embeddings model is OpenAI's (KVOX_EMBEDDING): a stand-in serves it, and takes an armed failure or hang.
  const embedder = {
    id: 'openai',
    displayName: 'Embeddings stand-in',
    listModels: async () => [],
    verifyKey: async () => ({ ok: true as const }),
    classifyModel: () => null,
    embeddings: {
      async embed(req: AiEmbeddingRequest, ctx: { signal?: AbortSignal }) {
        const next = armed?.kind === 'fail' || armed?.kind === 'hang' ? take() : null;
        if (next?.kind === 'fail') throw next.error;
        if (next?.kind === 'hang') {
          await new Promise<never>((_resolve, reject) => {
            ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
          });
        }
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const vectors = inputs.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01));
        return { provider: 'openai', model: req.model, vectors, dimensions: EMBEDDING_DIMENSIONS, usage: { inputTokens: 1 } };
      },
    },
  } as unknown as AiProviderAdapter;

  const port = createKvoxAi({
    runtime: createDirectRuntime({
      adapters: { copilot, openai: embedder },
      keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }),
    }),
    taskModels: { load: async () => modelState() },
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });

  const provider: KvoxAiConformanceProvider = {
    structuredAnswer: ({ value, finishReason }) => {
      armed = { kind: 'answer', value, ...(finishReason !== undefined ? { finishReason } : {}) };
    },
    streamAnswer: (events) => {
      armed = { kind: 'stream', events };
    },
    failNext: (error) => {
      armed = { kind: 'fail', error };
    },
    hangNext: () => {
      armed = { kind: 'hang' };
    },
    // The request the ADAPTER received (the structured output it was handed), as the other bindings report it.
    lastStructuredRequest: () => {
      const last = [...copilot.requests()].reverse().find((record) => record.method === 'create');
      return (last?.request as { structuredOutput?: { name: string; schema: unknown; strict: boolean } } | undefined)?.structuredOutput;
    },
  };

  return { port, provider };
}

describeKvoxAiConformance(
  'createKvoxAi over the GitHub Copilot adapter',
  (options) => conformanceUnderTest(options),
  { describe, it, expect },
  {
    optOut: {
      chat_tool_calls:
        'Copilot ships with tool calling off (the #581 decision): the adapter refuses tools, so the Ask loop stays on OpenAI.',
      rate_limit_job:
        'The case needs the provider retry hint to reach the queue; Copilot SDK 1.0.22 exposes no retry-after on session.error or model.call_failure, so the adapter cannot produce one.',
    },
  },
);
