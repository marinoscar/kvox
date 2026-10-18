import { createDirectRuntime, createKvoxAi } from '@marinoscar/kvox-ai';
import {
  createRecordingAdapter,
  createRecordingRuntime,
  withRecordedFeatures,
  type RecordedProviderRequest,
} from '@marinoscar/kvox-ai/testing';

import {
  PARITY_ASK_SNAPSHOT,
  PARITY_FIXTURES,
  createParityScript,
  loadParitySnapshot,
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
    expect(toolNames).toEqual(['search', 'get_entity', 'neighbors', 'timeline', 'evidence', 'entity_brief', 'list_commitments']);
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
