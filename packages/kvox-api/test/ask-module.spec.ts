import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_JOBS } from '../src/ports/index.js';
import { GraphModule } from '../src/graph/index.js';
import { NotesModule } from '../src/notes/index.js';
import { SearchIndexingModule, SearchModule } from '../src/search/index.js';
import { TranscriptsModule } from '../src/transcripts/index.js';
import {
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_RESPOND_JOB_TYPE,
  ASK_WALL_CLOCK_SOFT_MS,
  AskAccessService,
  AskConversationsService,
  AskModule,
  AskUserDataService,
  resolveAskOptions,
} from '../src/ask/index.js';
import { createFakeKvoxAi, createFakeKvoxIdentity, createKvoxTestingModule, type FakeKvoxJobs } from '../src/testing/index.js';

// =============================================================================
// AskModule over the fake ports (issue #497, epic #491)
// =============================================================================
//
// What the module promises a host: it boots on the ports and the peer slices it is given,
// registers `ask.respond` through the job port (server-only, one attempt), exports the services
// the host's binding uses, and refuses a cap above the product's own value at boot.
// =============================================================================

async function boot(): Promise<TestingModule> {
  // One object per peer, as a host holds them.
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({ schedules: false, peers: { searchIndexing } });
  const notes = NotesModule.forRoot({ schedules: false, peers: { transcripts, searchIndexing } });
  const search = SearchModule.forRoot();
  const graph = GraphModule.forRoot({ schedules: false, peers: { transcripts, notes, search } });
  const ask = AskModule.forRoot({ peers: { graph, notes, search } });

  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity(), ai: createFakeKvoxAi() } }),
      searchIndexing,
      search,
      transcripts,
      notes,
      graph,
      ask,
    ],
  }).compile();

  await moduleRef.init();

  return moduleRef;
}

let moduleRef: TestingModule | undefined;

afterAll(async () => {
  await moduleRef?.close();
});

describe('AskModule over the fake ports', () => {
  it('boots and exports the services the host uses', async () => {
    moduleRef ??= await boot();

    expect(moduleRef.get(AskAccessService, { strict: false })).toBeInstanceOf(AskAccessService);
    expect(moduleRef.get(AskConversationsService, { strict: false })).toBeInstanceOf(AskConversationsService);
    expect(moduleRef.get(AskUserDataService, { strict: false })).toBeInstanceOf(AskUserDataService);
  });

  it('registers ask.respond through the job port: one attempt, five minutes, no node members', async () => {
    moduleRef ??= await boot();

    const handler = (moduleRef.get(KVOX_JOBS) as FakeKvoxJobs).handlers.find((h) => h.type === ASK_RESPOND_JOB_TYPE);

    expect(handler?.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 1 });
    expect(handler?.usesAi).toBe(true);
    expect(handler?.nodeResultSchema).toBeUndefined();
    expect(handler?.persistNodeResult).toBeUndefined();
  });
});

describe('resolveAskOptions', () => {
  it('defaults to today\'s caps', () => {
    expect(resolveAskOptions().limits).toEqual({
      maxSteps: ASK_MAX_TOOL_STEPS,
      maxCallsPerStep: ASK_MAX_TOOL_CALLS_PER_STEP,
      softClockMs: ASK_WALL_CLOCK_SOFT_MS,
    });
    expect(resolveAskOptions().stream).toEqual({ pollIntervalMs: 250, heartbeatMs: 25_000 });
  });

  it('lets a host lower a cap', () => {
    expect(resolveAskOptions({ limits: { maxSteps: 3 }, stream: { pollIntervalMs: 50 } })).toMatchObject({
      limits: { maxSteps: 3, maxCallsPerStep: ASK_MAX_TOOL_CALLS_PER_STEP },
      stream: { pollIntervalMs: 50 },
    });
  });

  it.each([
    ['maxSteps', { maxSteps: ASK_MAX_TOOL_STEPS + 1 }],
    ['maxCallsPerStep', { maxCallsPerStep: ASK_MAX_TOOL_CALLS_PER_STEP + 1 }],
    ['softClockMs', { softClockMs: ASK_WALL_CLOCK_SOFT_MS + 1 }],
  ])('refuses to raise %s above the product\'s value, at boot', (_name, limits) => {
    expect(() => AskModule.forRoot({ limits })).toThrow(/may only be lowered/);
  });

  it.each([0, -1, 1.5])('refuses a cap of %s', (value) => {
    expect(() => resolveAskOptions({ limits: { maxSteps: value } })).toThrow(/positive integer/);
  });
});
