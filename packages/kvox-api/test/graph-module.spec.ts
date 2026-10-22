import { Test, type TestingModule } from '@nestjs/testing';

import { NoteAccessService, NotesModule } from '../src/notes/index.js';
import { SearchIndexingModule } from '../src/search/index.js';
import { TranscriptsModule } from '../src/transcripts/index.js';
import { KVOX_JOBS, type KvoxJobHandler } from '../src/ports/index.js';
import {
  GraphAccessService,
  GraphModule,
  GraphUserDataService,
  GraphWriteService,
  KG_ENTITY_DIGEST_JOB_TYPE,
  KG_GRAPH_LAYOUT_JOB_TYPE,
  KG_MIGRATE_JOB_TYPE,
  KG_PURGE_JOB_TYPE,
  KG_SPEAKER_LINK_JOB_TYPE,
} from '../src/graph/index.js';
import { describeGraphConformance } from '../src/graph/testing/index.js';
import { GraphExtractionModule, GraphExtractionService } from '../src/graph-extraction/index.js';
import { describeGraphExtractionConformance } from '../src/graph-extraction/testing/index.js';
import { GraphRdfModule } from '../src/graph-rdf/index.js';
import { describeGraphRdfConformance } from '../src/graph-rdf/testing/index.js';
import { createFakeKvoxAi, createFakeKvoxIdentity, createKvoxTestingModule, type FakeKvoxJobs } from '../src/testing/index.js';

// =============================================================================
// GraphModule, GraphExtractionModule and GraphRdfModule over the fake ports (issue #496, epic #491)
// =============================================================================
//
// What the three modules promise a host: they boot on the ports and the peer slices they are given,
// register every job type through the job port, never provide a notes class again (the graph reads
// notes through the notes slice's own exports), and pass the three conformance suites.
// =============================================================================

async function boot(): Promise<TestingModule> {
  // One object per peer, as a host holds them: a slice imported twice with separately built
  // options would register its handlers twice.
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({ schedules: false, peers: { searchIndexing } });
  const notes = NotesModule.forRoot({ schedules: false, peers: { transcripts, searchIndexing } });
  const graph = GraphModule.forRoot({ schedules: false, peers: { transcripts, notes } });
  const extraction = GraphExtractionModule.forRoot({ peers: { graph, notes } });
  const rdf = GraphRdfModule.forRoot({ schedules: false, peers: { graph, extraction, transcripts, notes } });

  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity(), ai: createFakeKvoxAi() } }),
      searchIndexing,
      transcripts,
      notes,
      graph,
      extraction,
      rdf,
    ],
  }).compile();

  await moduleRef.init();

  return moduleRef;
}

let moduleRef: TestingModule | undefined;

afterAll(async () => {
  await moduleRef?.close();
});

async function handlers(): Promise<readonly KvoxJobHandler[]> {
  moduleRef ??= await boot();

  return (moduleRef.get(KVOX_JOBS) as FakeKvoxJobs).handlers;
}

describe('the graph modules over the fake ports', () => {
  it('boot and export the services the other slices and the host use', async () => {
    moduleRef ??= await boot();

    expect(moduleRef.get(GraphWriteService, { strict: false })).toBeInstanceOf(GraphWriteService);
    expect(moduleRef.get(GraphAccessService, { strict: false })).toBeInstanceOf(GraphAccessService);
    expect(moduleRef.get(GraphUserDataService, { strict: false })).toBeInstanceOf(GraphUserDataService);
    expect(moduleRef.get(GraphExtractionService, { strict: false })).toBeInstanceOf(GraphExtractionService);
  });

  it('are not global', () => {
    expect(GraphModule.forRoot({ schedules: false }).global).toBe(false);
    expect(GraphExtractionModule.forRoot().global).toBe(false);
    expect(GraphRdfModule.forRoot({ schedules: false }).global).toBe(false);
  });

  it('never provide a notes class: the notes slice is the only provider of NoteAccessService', () => {
    const providers = (module: { providers?: unknown[] }) => (module.providers ?? []) as unknown[];

    for (const module of [GraphModule.forRoot({ schedules: false }), GraphExtractionModule.forRoot(), GraphRdfModule.forRoot({ schedules: false })]) {
      expect(providers(module)).not.toContain(NoteAccessService);
    }
  });

  it('register every job type through the job port when they start', async () => {
    const registered = (await handlers()).map((handler) => handler.type);

    for (const type of [
      KG_SPEAKER_LINK_JOB_TYPE,
      KG_PURGE_JOB_TYPE,
      KG_GRAPH_LAYOUT_JOB_TYPE,
      KG_MIGRATE_JOB_TYPE,
      KG_ENTITY_DIGEST_JOB_TYPE,
      'kg.extract',
      'kg.resolve',
      'kg.topics_promote',
      'kg.embed',
      'kg.export',
      'kg.import',
    ]) {
      expect(registered).toContain(type);
    }
  });
});

describeGraphConformance('the package binding over the fake ports', async () => ({ handlers: await handlers() }), { describe, it, expect });

describeGraphExtractionConformance(
  'the package binding over the fake ports',
  async () => ({ handlers: await handlers() }),
  { describe, it, expect },
);

describeGraphRdfConformance('the package binding over the fake ports', async () => ({ handlers: await handlers() }), { describe, it, expect });
