import { createDirectRuntime, createKvoxAi, type KvoxAiModelState } from '@marinoscar/kvox-ai';
import { createCopilotAdapter, createCopilotMockTransport, type CopilotMockReply } from '@marinoscar/kvox-ai/copilot';
import {
  createRecordingAdapter,
  createRecordingRuntime,
  wrapRecordingAdapter,
  withRecordedFeatures,
  type RecordedProviderRequest,
} from '@marinoscar/kvox-ai/testing';
import { AI_KEYLESS_API_KEY, type AiResponseRequest } from '@marinoscar/platform-ai-providers';
import { z } from 'zod';

import {
  PARITY_ASK_SNAPSHOT,
  PARITY_FIXTURES,
  createParityScript,
  loadParitySnapshot,
  parityModelState,
  parityTaskModelSource,
  runParityScenario,
  writeParitySnapshot,
  type ParityScenarioOptions,
} from '../src/parity/index.js';

// =============================================================================
// Harness parity, DIRECT binding (issue #580, part 2)
// =============================================================================
//
// `createKvoxAi` over `createDirectRuntime` (Desktop's shape) over a RECORDING
// ADAPTER answering from the shared script. The scenario drives the product's real
// notes / extraction / adjudication / Ask code through it; what reaches the adapter
// (normalized, with the feature joined from the runtime layer above) is compared with
// the committed `parity/requests.<fixture>.json`. `apps/api/test/kvox/ai-parity.spec.ts`
// does the same through the WEB binding and compares with the SAME files, so the two
// bindings are equal to each other by transitivity.
//
// `KVOX_EVAL_UPDATE_PARITY=1 npm run test:run -w @marinoscar/kvox-eval -- parity`
// rewrites the snapshots. Do that only when a prompt, schema, tool or limit changed ON
// PURPOSE, and read the diff: it is the change in what every host sends to a provider.
// =============================================================================

const UPDATE = process.env.KVOX_EVAL_UPDATE_PARITY === '1';

/** Runs the scenario through the direct binding and returns what reached the provider. */
async function record(opts: ParityScenarioOptions): Promise<RecordedProviderRequest[]> {
  const script = createParityScript();
  const adapter = createRecordingAdapter(script);
  const runtime = createRecordingRuntime(
    createDirectRuntime({ adapters: { openai: adapter }, keys: async () => ({ apiKey: 'parity-test-key-0000000000' }) }),
  );
  const ai = createKvoxAi({ runtime, taskModels: parityTaskModelSource() });
  await runParityScenario(ai, { ...opts, script });
  return withRecordedFeatures(adapter.requests(), runtime.requests());
}

const countOf = (records: readonly RecordedProviderRequest[], feature: string): number => records.filter((r) => r.feature === feature).length;

describe('harness parity: the direct binding', () => {
  beforeAll(() => {
    // The Ask handler logs through Nest's Logger; the scenario's output is the snapshot, not the log.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@nestjs/common') as typeof import('@nestjs/common')).Logger.overrideLogger(false);
  });

  describe.each([...PARITY_FIXTURES])('golden meeting %s', (id) => {
    it('builds the committed provider requests for notes, extraction and adjudication', async () => {
      const records = await record({ fixtures: [id], questions: [] });

      expect(countOf(records, 'note_generate')).toBeGreaterThan(0);
      expect(countOf(records, 'graph_extract')).toBeGreaterThan(0);
      expect(countOf(records, 'graph_adjudicate')).toBeGreaterThan(0);
      // Each task runs on the model the policy gives it, with that task's effort.
      const byFeature = (feature: string) => records.find((r) => r.feature === feature) as RecordedProviderRequest & { request: { reasoning?: { effort?: string } } };
      expect(byFeature('note_generate').model).toBe('gpt-parity');
      expect(byFeature('note_generate').request.reasoning?.effort).toBe('low');
      expect(byFeature('graph_extract').model).toBe('gpt-parity-extract');
      expect(byFeature('graph_extract').request.reasoning?.effort).toBe('medium');
      expect(byFeature('graph_adjudicate').model).toBe('gpt-parity-adjudicate');
      expect(byFeature('graph_adjudicate').request.reasoning?.effort).toBe('high');

      if (UPDATE) writeParitySnapshot(id, records);
      expect(records).toEqual(loadParitySnapshot(id));
    });
  });

  it('builds the committed provider requests for three Ask questions, each with a tool call and an answer', async () => {
    const records = await record({ fixtures: [], questions: undefined });

    expect(records.every((r) => r.feature === 'graph_agent' && r.model === 'gpt-parity-agent')).toBe(true);
    const withTools = records.filter((r) => (r.request as { tools?: unknown[] }).tools?.length);
    // Three questions, two model calls each: the tool call, then the answer over its result.
    expect(withTools).toHaveLength(6);
    const toolNames = (withTools[0].request as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'get_entity', 'neighbors', 'timeline', 'evidence', 'entity_brief', 'list_commitments', 'list_risks']);
    const answers = withTools.filter((r) => JSON.stringify((r.request as { input: unknown }).input).includes('function_call_output'));
    expect(answers).toHaveLength(3);

    if (UPDATE) writeParitySnapshot(PARITY_ASK_SNAPSHOT, records);
    expect(records).toEqual(loadParitySnapshot(PARITY_ASK_SNAPSHOT));
  });

  it('is sensitive: one changed character in any request fails the comparison', async () => {
    const records = await record({ fixtures: ['m01'], questions: [] });
    const tampered = JSON.parse(JSON.stringify(records)) as RecordedProviderRequest[];
    const first = tampered[0].request as { instructions: string };
    first.instructions = first.instructions.replace('You are', 'You Are');

    expect(tampered).not.toEqual(loadParitySnapshot('m01'));
  });
});


// =============================================================================
// Harness parity, GitHub Copilot adapter (issue #581, Phase 2)
// =============================================================================
//
// The same scenario through `createKvoxAi` over `createDirectRuntime` over the
// COPILOT adapter (on its mock transport), with the task-model state's provider set to
// `copilot`. `wrapRecordingAdapter` records what reaches the adapter, so the comparison
// is with the OpenAI snapshots: a Copilot GPT model gets the very same requests, with `model`
// the only thing allowed to differ. Ask runs too (#654): the adapter bridges its tool steps, so
// the requests that reach it are the very ones of the OpenAI Ask snapshot, and each question is
// ONE Copilot session (the tool step holds it, the answer step continues it).
//
// A prompted (Claude-like) model id changes ONLY what the documented prompted shape changes:
// a structured request loses `structuredOutput` and gains the generic schema block after its
// system prompt; every notes request is still equal. The scripted answers are valid, so the
// one repair never runs and the round trips line up one for one.
// =============================================================================

/** A record without its `model`. */
const withoutModel = (records: readonly RecordedProviderRequest[]) => records.map(({ model: _model, ...rest }) => rest);

/**
 * A strict-schema model answers with EVERY key of the schema, `null` when it has nothing to say; the
 * Copilot adapter validates the answer against the `responseSchema` it sent, as OpenAI's strict mode
 * does server-side. The shared script (written for adapters that never validate) leaves unknown
 * optional keys out, so the mock model fills them with `null`. Only keys are added: no value is
 * changed, so every request built from the answer is the same.
 */
function strictAnswer(value: unknown, schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return value;
  const node = schema as { anyOf?: unknown[]; oneOf?: unknown[]; properties?: Record<string, unknown>; items?: unknown };
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches)) {
    // The branch whose `const` discriminator (`type` or `kind`) matches the row.
    const row = value as Record<string, unknown> | null;
    const branch = branches.find((candidate) => {
      const props = (candidate as { properties?: Record<string, { const?: unknown; enum?: unknown[] }> }).properties ?? {};
      // A discriminator is a `const`, or (the caller JSON Schema) an enum of one.
      const only = (key: string): unknown => props[key]?.const ?? (props[key]?.enum?.length === 1 ? props[key].enum[0] : undefined);
      return ['type', 'kind'].some((key) => only(key) !== undefined && only(key) === row?.[key]);
    });
    return branch === undefined ? value : strictAnswer(value, branch);
  }
  if (Array.isArray(value)) return value.map((item) => strictAnswer(item, node.items));
  if (node.properties !== undefined && value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, child] of Object.entries(node.properties)) out[key] = key in out ? strictAnswer(out[key], child) : null;
    return out;
  }
  return value;
}

/** The scripted provider's answer for the request the recording wrapper just recorded, as a Copilot reply. */
function copilotReplyFor(
  script: ReturnType<typeof createParityScript>,
  record: RecordedProviderRequest,
  indexes: { create: number; stream: number },
  send?: { responseSchema?: Record<string, unknown> },
): CopilotMockReply {
  const recorded = { ...(record.request as Record<string, unknown>), ...(record.model !== undefined ? { model: record.model } : {}) } as unknown as AiResponseRequest;
  if (record.method === 'create') {
    // A prompted request carries no structuredOutput; the schema's name is in its system prompt.
    const name = recorded.structuredOutput?.name ?? /named "([^"]+)"/.exec(recorded.instructions ?? '')?.[1];
    const request = name === undefined ? recorded : { ...recorded, structuredOutput: { name, schema: z.unknown(), strict: true } };
    const parsed = script.create(request, indexes.create++).parsed;
    // A native model is handed the schema as `responseSchema`; a prompted one reads it from its system prompt.
    const block = /named "[^"]+":\n\n([\s\S]*)$/.exec(recorded.instructions ?? '')?.[1];
    const schema = send?.responseSchema ?? (block !== undefined ? (JSON.parse(block) as unknown) : undefined);
    return { kind: 'answer', text: JSON.stringify(strictAnswer(parsed, schema)), chunkSize: 1_000_000 };
  }
  const events = script.stream(recorded, indexes.stream++);
  const text = events.flatMap((event) => (event.type === 'output_text.delta' ? [event.delta] : [])).join('');
  const calls = events.flatMap((event) => (event.type === 'output_item.done' && event.item.type === 'function_call' ? [event.item] : []));
  if (calls.length > 0) {
    return {
      kind: 'toolCalls',
      ...(text.length > 0 ? { text } : {}),
      calls: calls.map((call) => ({ name: call.name, toolCallId: call.callId, arguments: call.arguments })),
      chunkSize: 1_000_000,
    };
  }
  return { kind: 'answer', text, chunkSize: 1_000_000 };
}

/** Runs the scenario through the Copilot adapter and returns what reached it, plus the transport's sessions. */
async function recordCopilot(opts: ParityScenarioOptions, state: KvoxAiModelState) {
  const script = createParityScript();
  const transport = createCopilotMockTransport();
  const copilot = createCopilotAdapter({ optIn: true, transport });
  const adapter = wrapRecordingAdapter(copilot);
  const indexes = { create: 0, stream: 0 };
  // The reply is a function of the request the wrapper recorded just before delegating to the adapter.
  transport.onSend((send) => copilotReplyFor(script, adapter.requests().at(-1)!, indexes, send));

  const runtime = createRecordingRuntime(
    createDirectRuntime({ adapters: { copilot: adapter }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
  );
  const ai = createKvoxAi({ runtime, taskModels: { load: async () => state }, catalog: copilot.kvox.catalog });
  await runParityScenario(ai, { ...opts, script });
  return { records: withRecordedFeatures(adapter.requests(), runtime.requests()), sessions: transport.sessions() };
}

describe('harness parity: the GitHub Copilot adapter', () => {
  describe.each([...PARITY_FIXTURES])('golden meeting %s', (id) => {
    it('sends the OpenAI snapshot requests, `model` removed from both sides the only allowed difference', async () => {
      const { records, sessions } = await recordCopilot({ fixtures: [id], questions: [] }, parityModelState('copilot'));

      expect(records.length).toBeGreaterThan(0);
      expect(withoutModel(records)).toEqual(withoutModel(loadParitySnapshot(id)));

      // The adapter really took the structured calls natively (a responseSchema each) and the notes as text.
      const structured = records.filter((r) => r.method === 'create').length;
      expect(structured).toBeGreaterThan(0);
      expect(sessions.filter((s) => s.prompts[0].responseSchema !== undefined)).toHaveLength(structured);
      expect(sessions).toHaveLength(records.length);
      // Every session was cleaned up, whatever the call.
      expect(sessions.every((s) => s.deleted && s.disconnected)).toBe(true);
      // And the user text reached the model untouched (no datetime prefix).
      expect(sessions.every((s) => s.prompts[0].sentPrompt === s.prompts[0].prompt)).toBe(true);
    });
  });

  it('sends the OpenAI Ask snapshot requests, three questions on one Copilot session each (the tool bridge)', async () => {
    const { records, sessions } = await recordCopilot({ fixtures: [], questions: undefined }, parityModelState('copilot'));

    expect(records.length).toBeGreaterThan(0);
    expect(withoutModel(records)).toEqual(withoutModel(loadParitySnapshot(PARITY_ASK_SNAPSHOT)));

    // Three questions, two model calls each: the tool call, then the answer over its result, on the SAME session.
    expect(records).toHaveLength(6);
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.continuations === 1 && s.toolRuns.length === 1 && s.prompts.length === 1)).toBe(true);
    expect(sessions.every((s) => s.config.availableTools.length === 8 && s.config.availableTools.every((t) => t.startsWith('custom:')))).toBe(true);
    expect(sessions.every((s) => s.deleted && s.disconnected)).toBe(true);
  });

  it('is sensitive: a changed character in one request fails the comparison', async () => {
    const { records } = await recordCopilot({ fixtures: ['m01'], questions: [] }, parityModelState('copilot'));
    const tampered = JSON.parse(JSON.stringify(records)) as RecordedProviderRequest[];
    (tampered[0].request as { instructions: string }).instructions += ' ';
    expect(withoutModel(tampered)).not.toEqual(withoutModel(loadParitySnapshot('m01')));
  });

  it('keeps the notes requests equal and changes only the documented prompted shape for a Claude-like model', async () => {
    // The same state with Claude-like ids: the adapter catalog says `prompted` for them.
    const claudeState = JSON.parse(JSON.stringify(parityModelState('copilot')).replaceAll('gpt-parity', 'claude-parity')) as KvoxAiModelState;
    const { records, sessions } = await recordCopilot({ fixtures: ['m01'], questions: [] }, claudeState);
    const snapshot = loadParitySnapshot('m01');

    expect(records).toHaveLength(snapshot.length);
    expect(records.every((r) => r.model?.startsWith('claude-parity'))).toBe(true);
    expect(snapshot.some((r) => r.method === 'stream')).toBe(true);
    expect(snapshot.some((r) => r.method === 'create')).toBe(true);

    records.forEach((record, i) => {
      const expected = snapshot[i];
      expect(record.method).toBe(expected.method);
      expect(record.feature).toBe(expected.feature);
      const { model: _a, ...actual } = record;
      const { model: _b, ...want } = expected;

      if (expected.method === 'stream') {
        // Notes: identical.
        expect(actual).toEqual(want);
        return;
      }

      const got = record.request as Record<string, unknown>;
      const original = expected.request as Record<string, unknown> & { instructions: string; structuredOutput: { name: string } };
      // The prompted shape: no structuredOutput, the schema block after the same system prompt.
      expect('structuredOutput' in got).toBe(false);
      expect(typeof got.instructions).toBe('string');
      const instructions = got.instructions as string;
      expect(instructions.startsWith(`${original.instructions}\n\n`)).toBe(true);
      const block = instructions.slice(original.instructions.length + 2);
      expect(block).toContain(`named "${original.structuredOutput.name}":`);
      expect(JSON.parse(block.slice(block.indexOf('\n\n') + 2))).toMatchObject({ type: 'object' });
      // Everything else is identical: the user input, the effort, the output ceiling.
      const { instructions: _i, ...gotRest } = got;
      const { instructions: _j, structuredOutput: _s, ...wantRest } = original;
      expect(gotRest).toEqual(wantRest);
      expect(actual.feature).toBe(want.feature);
      expect(actual.method).toBe(want.method);
    });

    // The prompted calls reached the transport without a responseSchema; the scripted answers were valid, so no repair ran.
    const creates = records.filter((r) => r.method === 'create').length;
    expect(creates).toBeGreaterThan(0);
    expect(sessions.filter((s) => s.prompts[0].responseSchema !== undefined)).toHaveLength(0);
    expect(sessions).toHaveLength(records.length);
  });
});
