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

import { Readable } from 'node:stream';

import { type JobHandler, JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { describeJobHandlerConformance } from '@marinoscar/platform-api/jobs/testing';
import { NoteSourceExtractHandler } from '@marinoscar/kvox-api/notes';

import { createKvoxJobsHarness, platformHandlerOf } from '../helpers/kvox-handler.helper';

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

  // The object-store port as the slice sees it: `describe` reads the stateful row, `openRead`
  // serves the bytes (or fails), `setMetadata` lands on the same row.
  const store = {
    describe: jest.fn(async (ids: readonly string[]) =>
      new Map(
        ids.includes(OBJECT_ID)
          ? [
              [
                OBJECT_ID,
                {
                  id: OBJECT_ID,
                  name: row.name,
                  mimeType: row.mimeType,
                  size: Number(row.size),
                  state: 'ready',
                  ownerId: row.uploadedById,
                  managedBy: 'notes',
                  metadata: row.metadata,
                },
              ],
            ]
          : [],
      ),
    ),
    openRead:
      mode === 'download-fails'
        ? jest.fn().mockRejectedValue(new Error('bucket unreachable'))
        : jest.fn(async () => Readable.from([Buffer.from('# Brief\n\nThe quarterly plan.', 'utf8')])),
    setMetadata: jest.fn(async (_id: string, metadata: Record<string, unknown>) => {
      row.metadata = metadata;
    }),
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

  const harness = createKvoxJobsHarness();

  return platformHandlerOf(harness, new NoteSourceExtractHandler(harness.adapter, store as never, objects as never));
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
