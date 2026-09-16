// =============================================================================
// Real-Postgres test: corrections, concurrency, restore and the invariant
// (issue #27, epic #19, spec §4-§5)
// =============================================================================
//
// Four of issue #27's acceptance criteria cannot be proved against a mock, and
// they are the four this file exists for:
//
//   1. **Two editors changing DIFFERENT segments both succeed.** That is a
//      claim about what happens when two transactions race for the same
//      `UPDATE transcripts SET current_version = $n+1 WHERE current_version =
//      $n` — the loser must block on the row, see `count === 0`, and be
//      re-applied against the winner's state. A mocked `$transaction` that
//      calls its callback inline has no rows, no locks and no losers.
//
//   2. **The same segment gives 409 with conflict details**, from the same
//      race — which is only meaningful if (1) is also true, because a scheme
//      that 409s EVERYTHING would pass (2) alone.
//
//   3. **A retried `clientBatchId` does not duplicate.** The guarantee is
//      ultimately `transcript_versions`' `@@unique([transcript_id,
//      client_batch_id])`, which exists only in a migrated database.
//
//   4. **`materialize(currentVersion) == the live tables`** after a random
//      sequence of ops (spec §4.4). The point of the property is that the
//      persist path writes exactly what the reducer produced and nothing else;
//      comparing a reducer to itself in memory would prove nothing.
//
// Plus the benchmark on a 10-hour fixture, and the snapshot job's policy and
// idempotency.
//
// This is a `*.db.spec.ts` file, excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` and run by `npm run test:db` (CI's `Smoke` job). See
// `../jobs/db-test-support.ts` for the reachability probe.
// =============================================================================

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import type { StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { TranscriptPipelineService } from '../../src/transcripts/transcript-pipeline.service';
import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { TranscriptEditingService } from '../../src/transcripts/transcript-editing.service';
import { TranscriptMaterializeService } from '../../src/transcripts/transcript-materialize.service';
import { TranscriptObjectsService } from '../../src/transcripts/transcript-objects.service';
import { TranscriptSnapshotHandler } from '../../src/transcripts/handlers/transcript-snapshot.handler';
import { ORDINAL_GAP, OP_TYPES, sortByOrdinal } from '../../src/transcripts/editing';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';

const { describeWithDb } = resolveDbSuite('transcript-corrections.db.spec');

/** Everything this suite creates is prefixed so cleanup is unambiguous. */
const TITLE_PREFIX = 'i27-corrections-';
const EMAIL_PREFIX = 'i27-corrections';
const KEY_PREFIX = 'i27-corrections/';

describeWithDb('Transcript corrections (real Postgres)', () => {
  let prisma: PrismaClient;
  /** A SECOND, independent pool — the other editor in the concurrency tests. */
  let otherPrisma: PrismaClient;
  let baseDir: string;
  let storage: StorageProvider;

  let editing: TranscriptEditingService;
  let otherEditing: TranscriptEditingService;
  let materialize: TranscriptMaterializeService;
  let snapshotHandler: TranscriptSnapshotHandler;
  let enqueueSnapshot: jest.Mock;

  let user: RequestUser;
  let ownerId: string;
  let sourceObjectId: string;

  /** Build the whole correction stack over one client. */
  function stackFor(client: PrismaClient) {
    const service = client as unknown as PrismaService;
    const objects = new TranscriptObjectsService(
      service,
      { deleteManagedObject: jest.fn() } as unknown as ObjectsService,
      new ConfigService({}),
      storage,
    );
    const materializeService = new TranscriptMaterializeService(service, objects);
    const access = new TranscriptAccessService(service);
    const pipeline = {
      enqueueSnapshot,
      // #188's semantic re-index, stubbed. `TranscriptEditingService` calls it
      // after every committed op batch and after a restore; the real one queues
      // a `search.index` job, which this suite has no worker for. It is not
      // merely unused here — the service AWAITS it, so a missing member is a
      // TypeError that fails every test in the file rather than a silent no-op.
      enqueueSearchIndex: jest.fn().mockResolvedValue(undefined),
    } as unknown as TranscriptPipelineService;

    return {
      objects,
      materialize: materializeService,
      editing: new TranscriptEditingService(service, access, materializeService, pipeline),
    };
  }

  beforeAll(async () => {
    prisma = createDbClient();
    otherPrisma = createDbClient();
    await Promise.all([prisma.$connect(), otherPrisma.$connect()]);

    baseDir = await mkdtemp(join(tmpdir(), 'i27-corrections-'));
    storage = new TmpDirStorageProvider(baseDir);
    enqueueSnapshot = jest.fn().mockResolvedValue(true);

    const mine = stackFor(prisma);
    const theirs = stackFor(otherPrisma);

    editing = mine.editing;
    materialize = mine.materialize;
    otherEditing = theirs.editing;

    snapshotHandler = new TranscriptSnapshotHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      prisma as unknown as PrismaService,
      mine.materialize,
      mine.objects,
    );

    const account = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${randomUUID()}@example.test` },
    });

    ownerId = account.id;
    user = {
      id: account.id,
      email: account.email,
      roles: ['Contributor'],
      permissions: ['transcripts:read', 'transcripts:write'],
      isActive: true,
    };

    const source = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: account.id,
      },
    });

    sourceObjectId = source.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await Promise.all([prisma.$disconnect(), otherPrisma.$disconnect()]);
    await rm(baseDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await cleanup();
    enqueueSnapshot.mockClear();
  });

  async function cleanup(): Promise<void> {
    const where = { transcript: { title: { startsWith: TITLE_PREFIX } } };

    await prisma.transcriptVersion.deleteMany({ where });
    await prisma.transcriptSegment.deleteMany({ where });
    await prisma.transcriptSpeaker.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'transcript' } });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({
      where: { storageKey: { startsWith: 'transcripts/' }, managedBy: 'transcripts', uploadedById: ownerId },
    });
  }

  // ---------------------------------------------------------------------------
  // Seeding: a transcript that has just been ingested, at version 1
  // ---------------------------------------------------------------------------

  interface Seed {
    transcriptId: string;
    speakerIds: string[];
    segmentIds: string[];
  }

  async function seedTranscript(
    options: { segments?: number; speakers?: number; wordsPerSegment?: number } = {},
  ): Promise<Seed> {
    const segmentCount = options.segments ?? 4;
    const speakerCount = options.speakers ?? 2;
    const wordsPerSegment = options.wordsPerSegment ?? 6;

    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: `${TITLE_PREFIX}${randomUUID()}`,
        sourceObjectId,
        provider: 'assemblyai',
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
        speakerCount,
        wordCount: segmentCount * wordsPerSegment,
      },
    });

    const speakerIds: string[] = [];

    for (let index = 0; index < speakerCount; index += 1) {
      const speaker = await prisma.transcriptSpeaker.create({
        data: {
          transcriptId: transcript.id,
          label: String.fromCharCode(65 + index),
          displayName: `Speaker ${String.fromCharCode(65 + index)}`,
          colorIndex: index,
        },
      });

      speakerIds.push(speaker.id);
    }

    const segmentIds: string[] = [];
    const rows = [];

    for (let index = 0; index < segmentCount; index += 1) {
      const id = randomUUID();
      const startMs = index * 5_000;
      const words = Array.from({ length: wordsPerSegment }, (_, wordIndex) => ({
        t: `word${index}-${wordIndex}`,
        s: startMs + wordIndex * 500,
        e: startMs + (wordIndex + 1) * 500,
        c: 0.9,
      }));

      segmentIds.push(id);
      rows.push({
        id,
        transcriptId: transcript.id,
        speakerId: speakerIds[index % speakerCount],
        startMs,
        endMs: startMs + wordsPerSegment * 500,
        ordinal: (index + 1) * ORDINAL_GAP,
        text: words.map((word) => word.t).join(' '),
        words: words as never,
        wordsAlignment: 'exact' as const,
        confidence: 0.9,
        origin: 'ai' as const,
      });
    }

    await prisma.transcriptSegment.createMany({ data: rows });

    await prisma.transcriptVersion.create({
      data: {
        transcriptId: transcript.id,
        version: 1,
        kind: 'ai_original',
        // NULL means the AI (spec §4.5).
        authorId: null,
        summary: 'Transcribed by AssemblyAI',
        ops: [] as never,
      },
    });

    // Version 1 is the ONE version no sequence of ops can rebuild, so the
    // snapshot job runs here exactly as `transcription.ingest` would have it
    // run — without it, no earlier version is materializable at all.
    await snapshotHandler.process({
      id: 'seed-snapshot',
      payload: { transcriptId: transcript.id, version: 1 },
    } as never);

    return { transcriptId: transcript.id, speakerIds, segmentIds };
  }

  /** The live tables, normalised for comparison against a materialization. */
  async function liveState(transcriptId: string) {
    const [speakers, segments] = await Promise.all([
      prisma.transcriptSpeaker.findMany({
        where: { transcriptId },
        orderBy: { colorIndex: 'asc' },
        select: { id: true, label: true, displayName: true, colorIndex: true, rev: true },
      }),
      prisma.transcriptSegment.findMany({
        where: { transcriptId },
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          speakerId: true,
          startMs: true,
          endMs: true,
          ordinal: true,
          text: true,
          words: true,
          wordsAlignment: true,
          confidence: true,
          origin: true,
          rev: true,
        },
      }),
    ]);

    return { speakers, segments };
  }

  const batch = (clientBatchId: string, baseVersion: number, ops: unknown[]) =>
    ({ clientBatchId, baseVersion, ops }) as never;

  // ===========================================================================
  // 1-2. Concurrency (spec §5)
  // ===========================================================================

  describe('two editors at once', () => {
    it('both succeed when they change DIFFERENT segments', async () => {
      const seed = await seedTranscript();

      // Both start from the same `baseVersion`; neither has seen the other.
      const [first, second] = await Promise.all([
        editing.applyOperations(
          seed.transcriptId,
          batch('editor-one-batch', 1, [
            { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'corrected by one' },
          ]),
          user,
        ),
        otherEditing.applyOperations(
          seed.transcriptId,
          batch('editor-two-batch', 1, [
            { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[2], rev: 1, text: 'corrected by two' },
          ]),
          user,
        ),
      ]);

      // Two versions, 2 and 3 in some order — the conditional bump allocated
      // them, so they cannot collide.
      expect([first.version, second.version].sort()).toEqual([2, 3]);

      const after = await liveState(seed.transcriptId);

      expect(after.segments.find((row) => row.id === seed.segmentIds[0])?.text).toBe(
        'corrected by one',
      );
      expect(after.segments.find((row) => row.id === seed.segmentIds[2])?.text).toBe(
        'corrected by two',
      );

      const transcript = await prisma.transcript.findUniqueOrThrow({
        where: { id: seed.transcriptId },
      });

      expect(transcript.currentVersion).toBe(3);
    });

    it('the second editor of the SAME segment gets 409 with the real rev', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        batch('first-writer', 1, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'mine' },
        ]),
        user,
      );

      const conflict = await otherEditing
        .applyOperations(
          seed.transcriptId,
          // Still holding rev 1, which is now stale.
          batch('second-writer', 1, [
            { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'theirs' },
          ]),
          user,
        )
        .catch((error: unknown) => error);

      expect(conflict).toBeInstanceOf(ConflictException);

      const body = (conflict as ConflictException).getResponse() as {
        details: { currentVersion: number; conflicts: Array<Record<string, unknown>> };
      };

      expect(body.details).toEqual({
        currentVersion: 2,
        conflicts: [{ entity: 'segment', id: seed.segmentIds[0], current: 2 }],
      });

      // The loser wrote NOTHING — not a version row, not a segment.
      const versions = await prisma.transcriptVersion.count({
        where: { transcriptId: seed.transcriptId },
      });

      expect(versions).toBe(2);
      expect(
        (await liveState(seed.transcriptId)).segments.find(
          (row) => row.id === seed.segmentIds[0],
        )?.text,
      ).toBe('mine');
    });

    it('a merge bumps every re-pointed segment, so a stale editor of one of them 409s', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        batch('merge-batch', 1, [
          {
            op: OP_TYPES.MERGE_SPEAKERS,
            sourceIds: [seed.speakerIds[1]],
            targetId: seed.speakerIds[0],
          },
        ]),
        user,
      );

      await expect(
        otherEditing.applyOperations(
          seed.transcriptId,
          batch('stale-after-merge', 1, [
            { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[1], rev: 1, text: 'x' },
          ]),
          user,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const after = await liveState(seed.transcriptId);

      expect(after.speakers).toHaveLength(1);
      expect(after.segments.every((row) => row.speakerId === seed.speakerIds[0])).toBe(true);
    });
  });

  // ===========================================================================
  // 3. Idempotency (spec §5)
  // ===========================================================================

  describe('a retried clientBatchId', () => {
    it('returns the original version and creates no second one', async () => {
      const seed = await seedTranscript();
      const ops = [
        { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'saved once' },
      ];

      const first = await editing.applyOperations(
        seed.transcriptId,
        batch('retry-me', 1, ops),
        user,
      );

      const retry = await editing.applyOperations(
        seed.transcriptId,
        batch('retry-me', 1, ops),
        user,
      );

      expect(first.version).toBe(2);
      expect(retry.version).toBe(2);
      expect(retry.idempotentReplay).toBe(true);
      expect(retry.summary).toBe(first.summary);

      const versions = await prisma.transcriptVersion.count({
        where: { transcriptId: seed.transcriptId },
      });

      expect(versions).toBe(2);
      // And the segment was corrected exactly ONCE — rev 2, not 3.
      expect(
        (await liveState(seed.transcriptId)).segments.find(
          (row) => row.id === seed.segmentIds[0],
        )?.rev,
      ).toBe(2);
    });

    it('survives two identical batches racing, via the unique index', async () => {
      const seed = await seedTranscript();
      const ops = [
        { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'raced' },
      ];

      const [a, b] = await Promise.all([
        editing.applyOperations(seed.transcriptId, batch('raced-batch', 1, ops), user),
        otherEditing.applyOperations(seed.transcriptId, batch('raced-batch', 1, ops), user),
      ]);

      expect(a.version).toBe(2);
      expect(b.version).toBe(2);

      const versions = await prisma.transcriptVersion.count({
        where: { transcriptId: seed.transcriptId },
      });

      expect(versions).toBe(2);
    });
  });

  // ===========================================================================
  // 4. Restore (spec §4.5)
  // ===========================================================================

  describe('restore', () => {
    it('appends a version, leaves history alone, and keeps v1 retrievable forever', async () => {
      const seed = await seedTranscript();
      const originalText = (await liveState(seed.transcriptId)).segments[0].text;

      await editing.applyOperations(
        seed.transcriptId,
        batch('edit-one', 1, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'first edit' },
        ]),
        user,
      );
      await editing.applyOperations(
        seed.transcriptId,
        batch('edit-two', 2, [
          { op: OP_TYPES.DELETE, segmentId: seed.segmentIds[3], rev: 1 },
        ]),
        user,
      );

      const restored = await editing.restore(seed.transcriptId, 1, { baseVersion: 3 }, user);

      // A restore is `current + 1`, appended — never a rewind.
      expect(restored.version).toBe(4);

      const versions = await prisma.transcriptVersion.findMany({
        where: { transcriptId: seed.transcriptId },
        orderBy: { version: 'asc' },
      });

      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
      expect(versions[3]).toMatchObject({ kind: 'restore', restoredFromVersion: 1 });
      expect(versions[3].ops).toEqual([{ op: 'restore', fromVersion: 1 }]);
      // The versions in between are untouched: history is never rewritten.
      expect(versions[1].summary).toBe('Corrected 1 line');
      expect(versions[2].summary).toBe('Deleted 1 line');

      // The live tables are version 1's content again, deleted segment included.
      const live = await liveState(seed.transcriptId);

      expect(live.segments).toHaveLength(4);
      expect(live.segments[0].text).toBe(originalText);

      // And v1 is still reachable as a version in its own right.
      const v1 = await materialize.materialize(seed.transcriptId, 1);

      expect(v1.state.segments[0].text).toBe(originalText);
      expect(v1.state.segments).toHaveLength(4);

      // A restore ALWAYS snapshots (spec §4.3).
      expect(enqueueSnapshot).toHaveBeenCalledWith(seed.transcriptId, 4);
      // And it is audited.
      const audits = await prisma.auditEvent.findMany({
        where: { targetId: seed.transcriptId, action: 'transcript.version_restored' },
      });

      expect(audits).toHaveLength(1);
    });

    it('can be materialized past, and a later restore chain still resolves', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        batch('e1', 1, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'v2 text' },
        ]),
        user,
      );

      await editing.restore(seed.transcriptId, 1, { baseVersion: 2 }, user);
      // v3 is a restore of v1. Now edit again on top of it…
      await editing.applyOperations(
        seed.transcriptId,
        batch('e2', 3, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[1], rev: 1, text: 'v4 text' },
        ]),
        user,
      );
      // …and restore the version that was itself produced by a restore.
      await editing.restore(seed.transcriptId, 3, { baseVersion: 4 }, user);

      const v5 = await materialize.materialize(seed.transcriptId, 5);

      // v5 == v3 == v1: neither edit survives.
      expect(v5.state.segments.find((row) => row.id === seed.segmentIds[0])?.text).not.toBe(
        'v2 text',
      );
      expect(v5.state.segments.find((row) => row.id === seed.segmentIds[1])?.text).not.toBe(
        'v4 text',
      );
      // But v4 is still exactly what it was.
      const v4 = await materialize.materialize(seed.transcriptId, 4);

      expect(v4.state.segments.find((row) => row.id === seed.segmentIds[1])?.text).toBe('v4 text');
    });
  });

  // ===========================================================================
  // 5. The invariant (spec §4.4) — a property test
  // ===========================================================================

  describe('materialize(currentVersion) == the live tables', () => {
    it('holds after a random sequence of op batches', async () => {
      // A fixed seed: a property test that cannot be re-run on the sequence
      // that broke it is a flake report, not a test.
      let seedValue = 0x2b7e1516;
      const random = (): number => {
        seedValue = (seedValue * 1_103_515_245 + 12_345) & 0x7fffffff;

        return seedValue / 0x7fffffff;
      };
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

      const seed = await seedTranscript({ segments: 10, speakers: 3, wordsPerSegment: 8 });

      for (let round = 0; round < 25; round += 1) {
        const live = await liveState(seed.transcriptId);

        if (live.segments.length < 3) break;

        const transcript = await prisma.transcript.findUniqueOrThrow({
          where: { id: seed.transcriptId },
        });

        const ordered = sortByOrdinal(live.segments);
        const index = Math.floor(random() * (ordered.length - 1));
        const target = ordered[index];
        const choice = Math.floor(random() * 7);

        const ops: unknown[] = [];

        if (choice === 0) {
          ops.push({
            op: OP_TYPES.UPDATE_TEXT,
            segmentId: target.id,
            rev: target.rev,
            text: `${target.text} extra${round}`,
          });
        } else if (choice === 1) {
          ops.push({
            op: OP_TYPES.SET_SPEAKER,
            segmentId: target.id,
            rev: target.rev,
            speakerId: pick(live.speakers).id,
          });
        } else if (choice === 2 && target.text.split(/\s+/).length > 2) {
          ops.push({
            op: OP_TYPES.SPLIT,
            segmentId: target.id,
            rev: target.rev,
            atWordIndex: 1,
          });
        } else if (choice === 3) {
          ops.push({
            op: OP_TYPES.JOIN,
            segmentIds: [target.id, ordered[index + 1].id],
            revs: [target.rev, ordered[index + 1].rev],
          });
        } else if (choice === 4 && ordered.length > 4) {
          ops.push({ op: OP_TYPES.DELETE, segmentId: target.id, rev: target.rev });
        } else if (choice === 5) {
          ops.push({
            op: OP_TYPES.RENAME_SPEAKER,
            speakerId: live.speakers[0].id,
            rev: live.speakers[0].rev,
            displayName: `Renamed ${round}`,
          });
        } else {
          ops.push({ op: OP_TYPES.CREATE_SPEAKER, displayName: `Added ${round}` });
        }

        await editing.applyOperations(
          seed.transcriptId,
          batch(`prop-${round}`, transcript.currentVersion, ops),
          user,
        );
      }

      const transcript = await prisma.transcript.findUniqueOrThrow({
        where: { id: seed.transcriptId },
      });

      expect(transcript.currentVersion).toBeGreaterThan(10);

      const replayed = await materialize.materialize(
        seed.transcriptId,
        transcript.currentVersion,
      );
      const live = await liveState(seed.transcriptId);

      // ⚠ THE INVARIANT. Not "replay works" — that no reducer has a side effect
      // the version log does not capture, and that the persist path writes
      // exactly what the reducer produced.
      expect(sortByOrdinal(replayed.state.segments)).toEqual(sortByOrdinal(live.segments));
      expect(replayed.state.speakers.sort(byId)).toEqual([...live.speakers].sort(byId));
    });

    it('holds for EVERY intermediate version, not just the newest', async () => {
      const seed = await seedTranscript({ segments: 5 });
      const snapshots: Array<Awaited<ReturnType<typeof liveState>>> = [];

      for (let round = 0; round < 4; round += 1) {
        const transcript = await prisma.transcript.findUniqueOrThrow({
          where: { id: seed.transcriptId },
        });
        const live = await liveState(seed.transcriptId);
        const target = sortByOrdinal(live.segments)[round];

        await editing.applyOperations(
          seed.transcriptId,
          batch(`step-${round}`, transcript.currentVersion, [
            {
              op: OP_TYPES.UPDATE_TEXT,
              segmentId: target.id,
              rev: target.rev,
              text: `round ${round}`,
            },
          ]),
          user,
        );

        snapshots.push(await liveState(seed.transcriptId));
      }

      for (let round = 0; round < snapshots.length; round += 1) {
        const version = round + 2;
        const replayed = await materialize.materialize(seed.transcriptId, version);

        expect(sortByOrdinal(replayed.state.segments)).toEqual(
          sortByOrdinal(snapshots[round].segments),
        );
      }
    });
  });

  // ===========================================================================
  // 6. The snapshot job
  // ===========================================================================

  describe('transcript.snapshot', () => {
    it('writes a gzipped object, links it, and is idempotent on a second run', async () => {
      const seed = await seedTranscript();

      // `seedTranscript` already ran it once for v1.
      const v1 = await prisma.transcriptVersion.findUniqueOrThrow({
        where: { transcriptId_version: { transcriptId: seed.transcriptId, version: 1 } },
      });

      expect(v1.snapshotObjectId).not.toBeNull();

      const object = await prisma.storageObject.findUniqueOrThrow({
        where: { id: v1.snapshotObjectId as string },
      });

      expect(object.mimeType).toBe('application/gzip');
      expect(object.managedBy).toBe('transcripts');
      expect(object.storageKey).toBe(`transcripts/${seed.transcriptId}/snapshots/v1.json.gz`);

      const objectsBefore = await prisma.storageObject.count({
        where: { managedBy: 'transcripts', storageKey: { startsWith: `transcripts/${seed.transcriptId}/` } },
      });

      await snapshotHandler.process({
        id: 'again',
        payload: { transcriptId: seed.transcriptId, version: 1 },
      } as never);

      const objectsAfter = await prisma.storageObject.count({
        where: { managedBy: 'transcripts', storageKey: { startsWith: `transcripts/${seed.transcriptId}/` } },
      });

      expect(objectsAfter).toBe(objectsBefore);
      expect(
        (
          await prisma.transcriptVersion.findUniqueOrThrow({
            where: { transcriptId_version: { transcriptId: seed.transcriptId, version: 1 } },
          })
        ).snapshotObjectId,
      ).toBe(v1.snapshotObjectId);
    });

    it('materializes from the snapshot rather than from an empty base', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        batch('after-snapshot', 1, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'changed' },
        ]),
        user,
      );

      // v1 has the snapshot; v2 replays one op on top of it.
      const v2 = await materialize.materialize(seed.transcriptId, 2);

      expect(v2.state.segments.find((row) => row.id === seed.segmentIds[0])?.text).toBe('changed');

      const v1 = await materialize.materialize(seed.transcriptId, 1);

      expect(v1.state.segments.find((row) => row.id === seed.segmentIds[0])?.text).not.toBe(
        'changed',
      );
    });

    it('follows the policy: an ordinary save just after a snapshot does not trigger one', async () => {
      const seed = await seedTranscript();

      enqueueSnapshot.mockClear();

      await editing.applyOperations(
        seed.transcriptId,
        batch('ordinary', 1, [
          { op: OP_TYPES.UPDATE_TEXT, segmentId: seed.segmentIds[0], rev: 1, text: 'small' },
        ]),
        user,
      );

      expect(enqueueSnapshot).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 7. The 10-hour benchmark
  // ===========================================================================

  describe('a 10-hour transcript (about 6,000 segments)', () => {
    // The ceilings issue #27 names are 500 ms for a batch and 2 s for a
    // materialize. Those are the TARGETS; the numbers asserted here are
    // deliberately generous multiples of them, because a shared CI runner
    // under an unrelated load is not evidence about this code and a flaky
    // wall-clock assertion is worse than none. The measured numbers are
    // printed, so a regression of an order of magnitude is visible in the log
    // even when the assertion still passes.
    const BATCH_CEILING_MS = 5_000;
    const MATERIALIZE_CEILING_MS = 20_000;

    jest.setTimeout(600_000);

    it('applies a batch and materializes inside the ceilings', async () => {
      const seed = await seedTranscript({ segments: 6_000, speakers: 4, wordsPerSegment: 15 });

      const transcript = await prisma.transcript.findUniqueOrThrow({
        where: { id: seed.transcriptId },
      });

      const batchStart = Date.now();

      await editing.applyOperations(
        seed.transcriptId,
        batch('bench-batch', transcript.currentVersion, [
          {
            op: OP_TYPES.UPDATE_TEXT,
            segmentId: seed.segmentIds[3_000],
            rev: 1,
            text: 'a corrected line in the middle of a ten hour recording',
          },
          {
            op: OP_TYPES.SET_SPEAKER,
            segmentId: seed.segmentIds[3_001],
            rev: 1,
            speakerId: seed.speakerIds[1],
          },
        ]),
        user,
      );

      const batchMs = Date.now() - batchStart;

      const materializeStart = Date.now();
      const replayed = await materialize.materialize(seed.transcriptId, 2);
      const materializeMs = Date.now() - materializeStart;

      // eslint-disable-next-line no-console
      console.log(
        `[i27 benchmark] 6,000 segments: operations batch ${batchMs} ms, ` +
          `materialize ${materializeMs} ms`,
      );

      expect(replayed.state.segments).toHaveLength(6_000);
      expect(batchMs).toBeLessThan(BATCH_CEILING_MS);
      expect(materializeMs).toBeLessThan(MATERIALIZE_CEILING_MS);
    });
  });
});

const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
