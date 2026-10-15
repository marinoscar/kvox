// =============================================================================
// `note.source.extract` against the platform handler contract (issue #468)
// =============================================================================
//
// The second NODE-ELIGIBLE KVox type (the first is `media.audio.transcode`).
// `describeJobHandlerConformance` proves the shared contract: dotted type, a
// label, a two-number profile, the schema/persist pair, a settle through the
// queue, an idempotent second run, failure by throwing, dedup.
//
// The behavioural detail (server and node paths leaving the same row, the
// permanent-failure sentences, the persist-only rule) stays in
// `notes/handlers/note-source-extract.handler.spec.ts`.
//
// The world is a stateful fake `storage_objects` row: the handler merges its
// result into `metadata`, and the second run must find that result and do
// nothing, which is exactly what idempotency means for this type.
// =============================================================================

import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';

import { JobHandlerRegistry, JobScope, type JobHandler } from '@marinoscar/platform-api/jobs';
import { describeJobHandlerConformance } from '@marinoscar/platform-api/jobs/testing';

import { NoteSourceExtractHandler } from '../../src/notes/handlers/note-source-extract.handler';
import { NoteObjectsService } from '../../src/notes/note-objects.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

const OBJECT_ID = 'source-object-1';

type Mode = 'ok' | 'download-fails';

let mode: Mode = 'ok';
let row: Record<string, unknown>;
let puts: string[];

async function buildWorld(): Promise<JobHandler> {
  row = {
    id: OBJECT_ID,
    name: 'brief.md',
    mimeType: 'text/markdown',
    storageKey: 'notes/sources/uploads/abc/brief.md',
    uploadedById: 'owner-1',
    managedBy: 'notes',
    metadata: { uploadedFilename: 'brief.md' },
    size: BigInt(16),
  };
  puts = [];

  const prisma = {
    storageObject: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
    },
  };

  const storage = {
    download:
      mode === 'download-fails'
        ? jest.fn().mockRejectedValue(new Error('bucket unreachable'))
        : jest.fn(async () => Readable.from([Buffer.from('# Brief\n\nThe quarterly plan.', 'utf8')])),
  };

  const objects = {
    put: jest.fn(async (input: { storageKey: string }) => {
      puts.push(input.storageKey);

      return { id: 'extracted-object-1' };
    }),
    recordUploaded: jest.fn(async (input: { storageKey: string }) => {
      puts.push(input.storageKey);

      return { id: 'extracted-object-1' };
    }),
  };

  // `storage_objects` access runs inside `JobScope.run(job, fn)`; the stub hands
  // `fn` the same client, so scoped and unscoped handlers behave identically here.
  const jobScope = { run: (_job: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(prisma) };

  const module = await Test.createTestingModule({
    providers: [
      NoteSourceExtractHandler,
      { provide: JobHandlerRegistry, useValue: new JobHandlerRegistry() },
      { provide: JobScope, useValue: jobScope },
      { provide: PrismaService, useValue: prisma },
      { provide: NoteObjectsService, useValue: objects },
      { provide: STORAGE_PROVIDER, useValue: storage },
    ],
  }).compile();

  return module.get(NoteSourceExtractHandler);
}

beforeEach(() => {
  mode = 'ok';
});

describeJobHandlerConformance('note.source.extract', buildWorld, {
  payloads: [
    {
      name: 'a markdown source document',
      payload: { objectId: OBJECT_ID },
      subjectType: 'storage_object',
      subjectId: OBJECT_ID,
      // User-triggered jobs that touch `storage_objects` are enqueued with an organization.
      orgId: 'org-1',
      arrange: () => {
        mode = 'ok';
      },
      observe: () => ({ metadata: JSON.parse(JSON.stringify(row.metadata)), puts: [...puts] }),
    },
    {
      name: 'a source the bucket cannot serve',
      payload: { objectId: OBJECT_ID },
      subjectType: 'storage_object',
      subjectId: OBJECT_ID,
      // User-triggered jobs that touch `storage_objects` are enqueued with an organization.
      orgId: 'org-1',
      arrange: () => {
        mode = 'download-fails';
      },
      expectFailure: 'bucket unreachable',
    },
  ],
});

describe('note.source.extract node eligibility (derived, never declared)', () => {
  it('carries both members that make the type node-eligible', async () => {
    const handler = await buildWorld();

    expect(handler.nodeResultSchema).toBeDefined();
    expect(typeof handler.persistNodeResult).toBe('function');
  });

  it('is absent from the registry server-only list', async () => {
    const handler = await buildWorld();
    const registry = new JobHandlerRegistry();

    registry.register(handler);

    expect(registry.types()).toContain('note.source.extract');
    expect(registry.serverOnlyTypes()).not.toContain('note.source.extract');
  });
});
