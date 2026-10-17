import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

import { AiService } from '@marinoscar/platform-api/ai';
import { JobHandlerRegistry, type Job } from '@marinoscar/platform-api/jobs';

import { KVOX_AI, type KvoxAi } from '../../src/ai-port/kvox-ai';
import { KvoxAiTargetResolver } from '../../src/ai-port/kvox-ai-target-resolver';
import { KVOX_AI_FEATURES, type KvoxAiFeatureId } from '../../src/ai-port/features';
import { AdjudicationService, GraphEmbedder } from '@marinoscar/kvox-api/graph-extraction';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// kvox's own AI job types (issue #477, epic #472)
// =============================================================================
//
// The platform conformance suites (`test/ai-conformance.spec.ts`) cover the `ai.*` job types the
// platform registers. This app has ten of its own that spend a user's key through `KvoxAi`, and the
// three rules those suites prove for `ai.*` must hold for them too:
//
//   (a) none is node-eligible. A remote machine must never hold a user's provider key, and no
//       vendor offers a job-scoped sub-key to broker: no `nodeResultSchema`, no
//       `persistNodeResult`, and the registry derives the type as server-only.
//   (b) with `ai.enabled = false`, processing the job makes no model call. The real handler runs
//       in the real app (real `KvoxAi`, real target resolver, real settings read) over a FAKE
//       platform `AiService` whose `forUser` and every client method are counted. The user holds a
//       key and a model is enabled, so the kill switch is the only thing missing. Each case also
//       proves the handler REACHED the readiness gate (it asked `KvoxAi.readiness` for its feature),
//       so a job that returned early for a missing row cannot pass for a job that was gated.
//       A control run with AI on proves the counters count.
//   (c) the per-user throttle key (`aiProviderThrottleKey`) is registered before the first call:
//       every source file of THIS application that calls the model registers it above the call.
//       The packaged slices (`@marinoscar/kvox-api/*`) have no throttle service to register with: a
//       rate limit there is a `KvoxRateLimitError` naming the per-user bucket, which the job adapter
//       registers (`search.index`: `search-index.handler.spec.ts` in the package).
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const GUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Each kvox AI job type, the feature(s) its model calls run under, and how the case drives it. */
const AI_JOB_TYPES = [
  { type: 'note.generate', features: ['note_generate'], drive: 'handler' },
  { type: 'note.retitle', features: ['note_retitle'], drive: 'handler' },
  { type: 'transcript.name_check', features: ['transcript_name_check'], drive: 'handler' },
  { type: 'kg.extract', features: ['graph_extract'], drive: 'handler' },
  // `kg.resolve` and `kg.import` reach the model through the shared resolution services (the
  // embedder and the adjudicator); a real run needs a populated graph, so those two services are
  // driven directly, which is the only code in either job that can spend a key.
  { type: 'kg.resolve', features: ['graph_embed', 'graph_adjudicate'], drive: 'services' },
  { type: 'kg.embed', features: ['graph_embed'], drive: 'handler' },
  { type: 'kg.entity_digest', features: ['graph_digest'], drive: 'handler' },
  { type: 'kg.import', features: ['graph_adjudicate'], drive: 'services' },
  { type: 'ask.respond', features: ['graph_agent'], drive: 'handler' },
  { type: 'search.index', features: ['search_embed'], drive: 'handler' },
] as const satisfies ReadonlyArray<{ type: string; features: readonly KvoxAiFeatureId[]; drive: 'handler' | 'services' }>;

const FULL = { capabilities: ['responses', 'streaming', 'structured_output', 'tools'] };

function modelRow(modelId: string) {
  return {
    id: `row-${modelId}`,
    provider: 'openai',
    modelId,
    displayName: null,
    capabilities: FULL,
    capabilitySource: 'catalogue',
    enabled: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  };
}

function storedSettings(ai: Record<string, unknown>) {
  return {
    id: 'settings-1',
    key: 'global',
    value: { ...DEFAULT_SYSTEM_SETTINGS, ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, ...ai } },
    version: 7,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedByUserId: null,
    updatedByUser: null,
  };
}

/** AI switched OFF, everything else in place: a slot, a model, the connected-knowledge switch. */
const AI_OFF = {
  enabled: false,
  graphEnabled: true,
  providers: { ...DEFAULT_SYSTEM_SETTINGS.ai.providers, openai: { enabled: true } },
  defaultModel: 'gpt-5.4-mini',
};

/** The control: AI ON. */
const AI_ON = { ...AI_OFF, enabled: true };

/** The fake platform `AiService`: it counts `forUser` and every method of the client it hands out. */
function createFakeAiService() {
  const clientCalls: string[] = [];
  const client = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === 'then') return undefined;
        return (..._args: unknown[]) => {
          clientCalls.push(String(name));
          throw new Error(`fake AiService: a model call (${String(name)}) was made`);
        };
      },
    },
  );
  const forUser = jest.fn(() => client);
  return { service: { forUser }, forUser, clientCalls };
}

const fakeAi = createFakeAiService();

describe('kvox AI job types (#477)', () => {
  let context: TestContext;
  let registry: JobHandlerRegistry;
  let kvoxAi: KvoxAi;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: AiService, useValue: fakeAi.service }],
    });
    registry = context.module.get(JobHandlerRegistry);
    kvoxAi = context.module.get<KvoxAi>(KVOX_AI);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
    fakeAi.clientCalls.length = 0;
    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    // The user HOLDS a key and a model is enabled: AI being off is the only gap.
    prismaMock.userAiKey.findUnique.mockResolvedValue({ id: 'key-1' } as never);
    prismaMock.aiModel.findMany.mockResolvedValue([modelRow('gpt-5.4-mini')] as never);
    // The resolver caches the policy for a few seconds per process.
    context.module.get(KvoxAiTargetResolver, { strict: false }).invalidateCache();
  });

  function setAi(ai: Record<string, unknown>): void {
    prismaMock.systemSettings.findUnique.mockResolvedValue(storedSettings(ai) as never);
    context.module.get(KvoxAiTargetResolver, { strict: false }).invalidateCache();
  }

  // ---------------------------------------------------------------------------
  // (a) server-only
  // ---------------------------------------------------------------------------

  describe('(a) every kvox AI job type is server-only', () => {
    it.each(AI_JOB_TYPES.map((entry) => [entry.type]))('%s is registered and carries no node members', (type) => {
      const handler = registry.get(type);

      expect(handler).toBeDefined();
      expect(handler).not.toHaveProperty('nodeResultSchema');
      expect(handler).not.toHaveProperty('persistNodeResult');
    });

    it('the registry derives every one of them as server-only', () => {
      const serverOnly = new Set(registry.serverOnlyTypes());

      expect(AI_JOB_TYPES.map((entry) => entry.type).filter((type) => !serverOnly.has(type))).toEqual([]);
    });

    it('covers every feature this app registers (a new feature needs a job type or a reason here)', () => {
      const covered = new Set<string>(AI_JOB_TYPES.flatMap((entry) => entry.features));

      // `graph_embed` is also the embedding gate of `kg.resolve`; every feature has a job type.
      expect(KVOX_AI_FEATURES.filter((feature) => !covered.has(feature))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) AI off: no model call
  // ---------------------------------------------------------------------------

  describe('(b) with ai.enabled = false, processing the job makes no model call', () => {
    const job = (type: string, payload: Record<string, unknown>): Job => ({ id: GUID(900), type, payload }) as unknown as Job;

    /** The features `readiness` was asked about for USER (the third argument, a model pick, varies). */
    const askedFor = (spy: jest.SpyInstance): unknown[] =>
      spy.mock.calls.filter(([user]) => user === USER).map(([, feature]) => feature);

    /** What each handler needs to get as far as its readiness gate. */
    const SEEDS: Record<string, () => { payload: Record<string, unknown> }> = {
      'note.generate': () => {
        prismaMock.noteGeneration.findUnique.mockResolvedValue({
          id: GUID(1),
          status: 'pending',
          model: 'gpt-5.4-mini',
          templateId: null,
          note: { id: GUID(2), ownerId: USER, deletedAt: null, status: 'draft' },
        } as never);
        return { payload: { generationId: GUID(1) } };
      },
      'note.retitle': () => {
        prismaMock.note.findUnique.mockResolvedValue({
          id: GUID(2),
          ownerId: USER,
          body: 'A short note about the quarterly plan and who owns each part of it.',
          status: 'ready',
          titleSource: 'derived',
          deletedAt: null,
          provider: 'openai',
          model: 'gpt-5.4-mini',
        } as never);
        return { payload: { noteId: GUID(2) } };
      },
      'transcript.name_check': () => {
        prismaMock.transcriptNameCheck.findUnique.mockResolvedValue({
          id: GUID(3),
          status: 'pending',
          transcriptId: GUID(4),
          requestedById: USER,
          model: null,
          mode: 'quick',
          terms: [],
        } as never);
        // The slice reads the run and its transcript separately (it has no relation to include).
        prismaMock.transcript.findUnique.mockResolvedValue({ id: GUID(4), status: 'ready', deletedAt: null } as never);
        prismaMock.transcriptNameCheck.updateMany.mockResolvedValue({ count: 1 } as never);
        return { payload: { checkId: GUID(3) } };
      },
      'kg.extract': () => {
        prismaMock.kgProposal.findUnique.mockResolvedValue({ id: GUID(5), status: 'extracting', ownerId: USER } as never);
        prismaMock.note.findUnique.mockResolvedValue({
          id: GUID(2),
          ownerId: USER,
          deletedAt: null,
          status: 'ready',
        } as never);
        return {
          payload: {
            proposalId: GUID(5),
            noteId: GUID(2),
            noteVersion: 1,
            userId: USER,
            model: 'gpt-5.4-mini',
            reason: 'user_request',
          },
        };
      },
      'kg.embed': () => ({ payload: { userId: USER, subjectKind: 'entity', ids: [GUID(6)] } }),
      'kg.entity_digest': () => {
        prismaMock.kgEntity.findFirst.mockResolvedValue({
          id: GUID(6),
          type: 'Person',
          label: 'Ada',
          reviewStatus: 'accepted',
          mergedIntoId: null,
        } as never);
        return { payload: { entityId: GUID(6), ownerId: USER } };
      },
      'ask.respond': () => {
        prismaMock.askMessage.findFirst.mockResolvedValue({
          id: GUID(7),
          status: 'pending',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          conversation: { id: GUID(8), scopeEntityId: null },
        } as never);
        prismaMock.askMessage.updateMany.mockResolvedValue({ count: 1 } as never);
        return {
          payload: {
            assistantMessageId: GUID(7),
            conversationId: GUID(8),
            userId: USER,
            model: 'gpt-5.4-mini',
            providerId: 'openai',
          },
        };
      },
      'search.index': () => {
        // The handler reads the owner of the document with raw SQL (the transcripts table belongs to
        // another slice; #494), so the double answers the statement rather than a delegate.
        prismaMock.$queryRaw.mockResolvedValue([{ owner_id: USER }]);
        return { payload: { documentType: 'transcript', documentId: GUID(4) } };
      },
    };

    it.each(AI_JOB_TYPES.filter((entry) => entry.drive === 'handler').map((entry) => [entry.type, entry.features] as const))(
      '%s asks readiness for its feature and stops: no AiService call',
      async (type, features) => {
        setAi(AI_OFF);
        const readiness = jest.spyOn(kvoxAi, 'readiness');
        const handler = registry.get(type);
        const { payload } = SEEDS[type]();

        // A job may settle by returning or by failing (its own domain failure); only the model matters.
        await handler!.process(job(type, payload)).catch(() => undefined);

        expect(askedFor(readiness)).toContain(features[0]);
        expect(fakeAi.forUser).not.toHaveBeenCalled();
        expect(fakeAi.clientCalls).toEqual([]);
        // The gate said no for the right reason: the switch, not a missing key or model.
        const verdict = await readiness.mock.results[0].value;
        expect(verdict).toMatchObject({ ok: false, reason: 'ai_not_configured', provider: null });
      },
    );

    it.each(AI_JOB_TYPES.filter((entry) => entry.drive === 'services').map((entry) => [entry.type, entry.features] as const))(
      '%s: its embedder and adjudicator refuse before any AiService call',
      async (_type, features) => {
        setAi(AI_OFF);
        const readiness = jest.spyOn(kvoxAi, 'readiness');

        if ((features as readonly string[]).includes('graph_embed')) {
          const embedder = context.module.get(GraphEmbedder, { strict: false });
          await expect(embedder.resolve(USER, GUID(900))).resolves.toMatchObject({ ok: false });
        }
        if ((features as readonly string[]).includes('graph_adjudicate')) {
          const adjudication = context.module.get(AdjudicationService, { strict: false });
          const pair = { pairId: 'p1', type: 'Person' } as never;
          await expect(adjudication.adjudicate(USER, [pair], { jobType: _type, jobId: GUID(900) })).rejects.toBeDefined();
        }

        for (const feature of features) {
          expect(askedFor(readiness)).toContain(feature);
        }
        expect(fakeAi.forUser).not.toHaveBeenCalled();
        expect(fakeAi.clientCalls).toEqual([]);
      },
    );

    it('control: with AI on the same port reaches the AiService, so the counters above count', async () => {
      setAi(AI_ON);

      const verdict = await kvoxAi.readiness(USER, 'note_generate', null);
      expect(verdict).toMatchObject({ ok: true, reason: null, provider: 'openai' });

      await expect(
        (async () => {
          for await (const event of kvoxAi.streamText({
            userId: USER,
            feature: 'note_generate',
            system: 's',
            user: 'u',
          })) {
            void event;
          }
        })(),
      ).rejects.toBeDefined();

      expect(fakeAi.forUser).toHaveBeenCalledTimes(1);
      expect(fakeAi.clientCalls).toEqual(['stream']);
    });
  });
});

// =============================================================================
// (c) the per-user throttle key is registered before the first call
// =============================================================================

const SRC = resolve(__dirname, '../../src');

/** Receivers that are the `KvoxAi` port, or the embedder closure that wraps it. */
const AI_RECEIVER = /(^|\.)(ai|embedder)$/;
const AI_METHODS = new Set(['generateStructured', 'streamText', 'embed', 'chat']);

/**
 * Files with a model call that are exempt from "register above the call", each with the reason and
 * where the order is proved instead.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'platform-kvox/ai/platform-kvox-ai.adapter.ts':
    'the `KVOX_AI` port adapter (#490) is a pass-through for a slice that calls the model; the bucket is registered per job by `PlatformKvoxJobsAdapter` from the job row `provider_key` (set by `enqueue({ throttleKey })`) before the handler runs, proved in test/platform-kvox/platform-kvox-adapters.spec.ts',
};

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) files.push(full);
  }
  return files;
}

interface Positions {
  calls: number[];
  registrations: number[];
}

function positionsIn(file: string): Positions {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Positions = { calls: [], registrations: [] };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(source);
      if (AI_METHODS.has(method) && AI_RECEIVER.test(receiver)) {
        found.calls.push(node.getStart(source));
      } else if (method === 'registerProviderKey' && node.arguments.some((arg) => arg.getText(source).includes('aiProviderThrottleKey'))) {
        found.registrations.push(node.getStart(source));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

describe('(c) the per-user throttle key is registered before the first model call (#477)', () => {
  const files = walk(SRC)
    .map((full) => ({ rel: relative(SRC, full).split(sep).join('/'), full }))
    .filter(({ rel }) => !rel.startsWith('ai-port/'))
    .map((file) => ({ ...file, ...positionsIn(file.full) }))
    .filter(({ calls }) => calls.length > 0);

  it('finds the model call sites at all, so a broken scan cannot pass vacuously', () => {
    // The Ask handler and the `KVOX_AI` adapter: the graph's calls moved into `@marinoscar/kvox-api` (#496), scanned below.
    expect(files.map(({ rel }) => rel).sort()).toEqual(['ask/handlers/ask-respond.handler.ts', 'platform-kvox/ai/platform-kvox-ai.adapter.ts']);
  });

  it('every file that calls the model registers the key above its first call (or is exempt, with a reason)', () => {
    const offenders = files
      .filter(({ rel }) => !(rel in EXEMPT))
      .filter(({ calls, registrations }) => registrations.length === 0 || Math.min(...registrations) > Math.min(...calls))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('every exemption is still needed', () => {
    const calling = new Set(files.map(({ rel }) => rel));

    expect(Object.keys(EXEMPT).filter((rel) => !calling.has(rel))).toEqual([]);
  });
});

// =============================================================================
// (c) for the graph slices, which moved into the package (#496)
// =============================================================================
//
// `@marinoscar/kvox-api/graph*` has no throttle registry: a provider rate limit leaves a handler as a
// `KvoxRateLimitError` on the caller's own bucket (`rethrowRateLimit(error, userId)` builds it from
// `aiProviderThrottleKey(userId)`), and `PlatformKvoxJobsAdapter` registers that bucket from the error
// (proved in test/platform-kvox/platform-kvox-adapters.spec.ts). So the executable form of "the per-user key
// is registered before the model call" for these files is: every file that calls the model also routes
// the failure through `rethrowRateLimit`, so one busy account's quota never parks another's jobs.
// =============================================================================

const PACKAGE_SRC = resolve(__dirname, '../../../../packages/kvox-api/src');
const GRAPH_SLICES = ['graph', 'graph-extraction', 'graph-rdf'];

/** Files of the graph slices that are not tests, fixtures or testing entries. */
function graphSliceFiles(): string[] {
  return GRAPH_SLICES.flatMap((slice) => {
    const walkSlice = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return entry === 'testing' || entry === '__fixtures__' ? [] : walkSlice(full);
        return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [full] : [];
      });
    return walkSlice(join(PACKAGE_SRC, slice));
  });
}

describe('(c) the graph slices route a rate limit onto the caller\'s own bucket (#477, #496)', () => {
  /** A closure the calling job wraps: the callers are checked instead. */
  const CLOSURES: Readonly<Record<string, string>> = {
    'graph-extraction/resolution/graph-embedder.service.ts':
      'the closure `GraphEmbedder.resolve` returns to the job that calls it; its callers (kg-embed.handler.ts, resolution.service.ts) call `rethrowRateLimit`',
  };

  const files = graphSliceFiles()
    .map((full) => ({ rel: relative(PACKAGE_SRC, full).split(sep).join('/'), full }))
    .map((file) => ({ ...file, ...positionsIn(file.full), text: readFileSync(file.full, 'utf8') }))
    .filter(({ calls }) => calls.length > 0);

  it('finds the model call sites at all, so a broken scan cannot pass vacuously', () => {
    expect(files.map(({ rel }) => rel).sort()).toEqual([
      'graph-extraction/handlers/kg-embed.handler.ts',
      'graph-extraction/handlers/kg-extract.handler.ts',
      'graph-extraction/resolution/adjudication.service.ts',
      'graph-extraction/resolution/graph-embedder.service.ts',
      'graph-extraction/resolution/resolution.service.ts',
      'graph/brief/entity-digest.handler.ts',
    ]);
  });

  it('every file that calls the model also calls `rethrowRateLimit` (or is a closure its callers wrap)', () => {
    const offenders = files.filter(({ rel }) => !(rel in CLOSURES)).filter(({ text }) => !text.includes('rethrowRateLimit(')).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('every closure exemption is still needed', () => {
    const calling = new Set(files.map(({ rel }) => rel));

    expect(Object.keys(CLOSURES).filter((rel) => !calling.has(rel))).toEqual([]);
  });

  it('rethrowRateLimit builds the bucket from aiProviderThrottleKey', () => {
    const support = readFileSync(join(PACKAGE_SRC, 'graph', 'graph-ai-support.ts'), 'utf8');

    expect(support).toMatch(/new KvoxRateLimitError\(aiProviderThrottleKey\(/);
  });
});
