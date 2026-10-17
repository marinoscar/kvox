// =============================================================================
// Harness parity, WEB binding (issue #580, part 2)
// =============================================================================
//
// The web edition's `KVOX_AI` (`createWebKvoxAi`) over the REAL `PlatformAiRuntime`
// and the REAL `PlatformTaskModelSource`, with only the two things a unit tier cannot
// have faked replaced: `AiService.forUser(...)` (a scripted client) and the database
// and settings reads under the task-model source (fake `ai_models` rows and a fake
// `ai` system-settings value). The shared scenario of `@marinoscar/kvox-eval/parity`
// drives the product's real notes / extraction / adjudication / Ask code through it,
// the scripted client records what it RECEIVES (the request the platform would send to
// its gates, key resolver and provider adapter) and answers from the SAME script the
// direct binding's adapter answers from.
//
// The recording must deep-equal the committed snapshots in the PACKAGE
// (`packages/kvox-eval/parity/requests.<fixture>.json`, `requests.ask.json`): the
// single source of truth that `packages/kvox-eval/test/parity.spec.ts` holds the
// DIRECT (Desktop-style) binding to. Two bindings equal to one file are equal to each
// other: the system prompt, the user prompt or input, the strict JSON Schema, the tool
// definitions, the model, the reasoning effort and the output ceiling are the same
// bytes. To refresh the files after an intended change to a prompt, schema or limit,
// run the package spec with `KVOX_EVAL_UPDATE_PARITY=1` (never this one).
//
// COMPARED: method, feature, model, and the whole request (instructions, input,
//   structuredOutput, tools, toolChoice, reasoning, maxOutputTokens).
// NOT COMPARED, because host-specific by nature and never part of what a provider
//   sees: user id, organization id, job id, abort signal (the recorder takes none), the
//   provider id (the web runtime sends only the MODEL; the platform's target resolver
//   picks the provider, while the direct runtime selects its adapter by it), and the API
//   key (the platform resolves it per call; the direct runtime is handed it).
// NORMALIZED (numbered placeholders, never dropped): UUIDs, ISO timestamps, request ids.
// =============================================================================

import '../../src/kvox.manifest';

import { Logger } from '@nestjs/common';
import { AI_SYSTEM_SETTINGS } from '@marinoscar/platform-api/ai';
import {
  PARITY_ASK_SNAPSHOT,
  PARITY_DEFAULT_EFFORT,
  PARITY_DEFAULT_MODEL,
  PARITY_FIXTURES,
  PARITY_MODELS,
  PARITY_PROVIDER,
  PARITY_TASK_MODELS,
  createParityScript,
  loadParitySnapshot,
  runParityScenario,
  type ParityScenarioOptions,
} from '@marinoscar/kvox-eval/parity';
import {
  completeScriptedResponse,
  createRecordedValueNormalizer,
  recordProviderRequest,
  type RecordedProviderRequest,
} from '@marinoscar/kvox-ai/testing';

import { KVOX_AI_POLICY } from '../../src/ai-port/ai-policy';
import { PlatformAiRuntime } from '../../src/ai-port/platform-ai-runtime';
import { PlatformTaskModelSource } from '../../src/ai-port/platform-task-model-source';
import { KVOX_AI_EXTENSION_DEFAULTS } from '../../src/platform/ai/ai-settings.extension';
import { createWebKvoxAi } from '../../src/platform-kvox/ai/web-kvox-ai';

/** The `ai` system-settings value an administrator who configured the parity state would have saved. */
function aiNamespace() {
  const base = (AI_SYSTEM_SETTINGS as unknown as { defaults: Record<string, unknown> }).defaults;
  return KVOX_AI_POLICY.storedSchema.parse({
    ...base,
    ...KVOX_AI_EXTENSION_DEFAULTS,
    enabled: true,
    providers: { ...(base.providers as Record<string, unknown>), [PARITY_PROVIDER]: { enabled: true } },
    defaultModel: PARITY_DEFAULT_MODEL,
    graphEnabled: true,
    reasoningEffort: PARITY_DEFAULT_EFFORT,
    taskModels: { ...PARITY_TASK_MODELS },
  });
}

/** The enabled `ai_models` rows for the provider, as the task-model source selects them. */
function aiModelRows() {
  return [...PARITY_MODELS]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      modelId: m.id,
      displayName: null,
      capabilities: { capabilities: ['structured_output', 'tools'] },
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
    }));
}

/** Runs the scenario through the web binding and returns what its platform client received. */
async function record(opts: ParityScenarioOptions): Promise<{ records: RecordedProviderRequest[]; scopes: Array<{ userId: string; feature?: string }> }> {
  const script = createParityScript();
  const normalize = createRecordedValueNormalizer();
  const records: RecordedProviderRequest[] = [];
  const scopes: Array<{ userId: string; feature?: string }> = [];
  const counts = { stream: 0, create: 0 };

  // `AiService.forUser(userId, scope)` -> the client the platform would gate, key and trace.
  const forUser = (userId: string, scope: { feature?: string }) => {
    scopes.push({ userId, ...(scope.feature !== undefined ? { feature: scope.feature } : {}) });
    return {
      stream: (request: never) => {
        records.push(recordProviderRequest('stream', request, normalize, scope.feature));
        const events = script.stream(request, counts.stream++);
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
      respond: async (request: never) => {
        records.push(recordProviderRequest('create', request, normalize, scope.feature));
        return completeScriptedResponse(script.create(request, counts.create++));
      },
      embed: async () => {
        throw new Error('The parity scenario makes no embeddings call.');
      },
    };
  };

  const runtime = new PlatformAiRuntime({ forUser } as never, { userAiKey: { findUnique: async () => ({ id: 'key-1' }) } } as never);
  const taskModels = new PlatformTaskModelSource(
    { aiModel: { findMany: async () => aiModelRows() } } as never,
    { getNamespace: async () => aiNamespace() } as never,
  );
  const ai = createWebKvoxAi({
    runtime,
    taskModels,
    settings: { requestTimeoutMs: async () => 600_000, graphEnabled: async () => true },
    logger: { warn: () => undefined },
  });

  await runParityScenario(ai, { ...opts, script });
  return { records, scopes };
}

const countOf = (records: readonly RecordedProviderRequest[], feature: string): number => records.filter((r) => r.feature === feature).length;

describe('harness parity: the web binding (PlatformAiRuntime + PlatformTaskModelSource)', () => {
  beforeAll(() => {
    // The Ask handler and the adjudication service log through Nest's Logger.
    Logger.overrideLogger(false);
  });

  describe.each([...PARITY_FIXTURES])('golden meeting %s', (id) => {
    it('sends the same provider requests as the committed (direct binding) snapshot', async () => {
      const { records, scopes } = await record({ fixtures: [id], questions: [] });

      expect(countOf(records, 'note_generate')).toBeGreaterThan(0);
      expect(countOf(records, 'graph_extract')).toBeGreaterThan(0);
      expect(countOf(records, 'graph_adjudicate')).toBeGreaterThan(0);
      // The platform client was opened per round trip, for the user, with the feature.
      expect(scopes).toHaveLength(records.length);
      expect(scopes.every((s) => s.feature !== undefined && s.userId.length > 0)).toBe(true);

      expect(records).toEqual(loadParitySnapshot(id));
    });
  });

  it('sends the same provider requests for three Ask questions as the committed snapshot', async () => {
    const { records } = await record({ fixtures: [], questions: undefined });

    // Three questions, two model calls each, all on the agent task's model.
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.method === 'stream' && r.feature === 'graph_agent' && r.model === 'gpt-parity-agent')).toBe(true);

    expect(records).toEqual(loadParitySnapshot(PARITY_ASK_SNAPSHOT));
  });
});
