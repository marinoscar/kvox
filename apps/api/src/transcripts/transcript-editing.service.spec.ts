// =============================================================================
// TranscriptEditingService — expansion, guards and the read surfaces
// (issue #27, epic #19)
// =============================================================================
//
// The parts of this service that DO need a real database — the concurrency
// race, the idempotent retry, the restore swap, the property test and the
// benchmark — live in `test/transcripts/transcript-corrections.db.spec.ts`,
// because a mocked `$transaction` proves nothing about a transaction.
//
// What is here is everything a real database would only slow down:
//
//   • `transcript.find_replace` EXPANSION, which is the load-bearing decision
//     of spec §4.2 — the recorded version must contain concrete
//     `segment.update_text` ops and never the abstract call — with the case,
//     whole-word and speaker-scope options the issue's acceptance list names;
//   • the guards that answer before any write happens (a stale restore
//     `baseVersion`, a transcript with no transcript yet, a version that does
//     not exist);
//   • the search projection and the version-history cursor.
// =============================================================================

import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { OP_TYPES } from './editing';
import {
  TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
  TranscriptSpeakersIdentifiedEvent,
} from './events/transcript-speakers-identified.event';
import { TranscriptAccessService } from './transcript-access.service';
import {
  TranscriptEditingService,
  decodeVersionCursor,
  encodeVersionCursor,
} from './transcript-editing.service';
import { TranscriptMaterializeService } from './transcript-materialize.service';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';

const TRANSCRIPT_ID = 'transcript-1';
const USER = {
  id: 'user-1',
  email: 'editor@example.test',
  roles: ['Contributor'],
  permissions: ['transcripts:read', 'transcripts:write'],
  isActive: true,
};

const speakerRows = [
  { id: 'A', label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 1 },
  { id: 'B', label: 'B', displayName: 'Speaker B', colorIndex: 1, rev: 1 },
];

const segmentRows = [
  {
    id: 's1',
    speakerId: 'A',
    startMs: 0,
    endMs: 1000,
    ordinal: 1000,
    text: 'Kvox is great',
    words: [],
    wordsAlignment: 'exact',
    confidence: null,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  },
  {
    id: 's2',
    speakerId: 'B',
    startMs: 1000,
    endMs: 2000,
    ordinal: 2000,
    text: 'kvox and Kvoxen',
    words: [],
    wordsAlignment: 'exact',
    confidence: null,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  },
];

describe('TranscriptEditingService', () => {
  let service: TranscriptEditingService;
  let prisma: Record<string, never> & Record<string, unknown>;
  let tx: Record<string, any>;
  let versionCreate: jest.Mock;
  let access: { require: jest.Mock };
  let pipeline: { enqueueSnapshot: jest.Mock; enqueueSearchIndex: jest.Mock };
  let events: { emit: jest.Mock };
  let transcript: { id: string; currentVersion: number };
  /** `transcripts.speaker_identities`, as both the tx-locked read and the
   * out-of-transaction read see it — a `let` so a test can set it BEFORE
   * calling the service and have every mock that reads the row see the
   * change (#323). */
  let speakerIdentities: Record<string, string>;

  beforeEach(async () => {
    transcript = { id: TRANSCRIPT_ID, currentVersion: 3 };
    speakerIdentities = {};
    versionCreate = jest.fn().mockResolvedValue({});

    tx = {
      transcript: {
        findUnique: jest.fn().mockImplementation(async () => ({
          currentVersion: transcript.currentVersion,
          speakerIdentities,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      transcriptSpeaker: {
        findMany: jest.fn().mockResolvedValue(speakerRows),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        // Only `saveIdentifications` (#323) writes through `updateMany`; the
        // versioned path always uses the individual `update` above.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      transcriptSegment: {
        findMany: jest.fn().mockResolvedValue(segmentRows),
        update: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      transcriptVersion: { create: versionCreate },
      $executeRaw: jest.fn().mockResolvedValue(1),
      // `saveIdentifications`'s `SELECT … FOR UPDATE` (#323).
      $queryRaw: jest.fn().mockImplementation(async () => [
        { current_version: transcript.currentVersion, speaker_identities: speakerIdentities },
      ]),
    };

    prisma = {
      $transaction: jest.fn().mockImplementation((fn: (client: unknown) => unknown) => fn(tx)),
      $queryRaw: jest.fn().mockResolvedValue([{ bytes: 0 }]),
      transcript: {
        findUnique: jest.fn().mockImplementation(async () => ({ currentVersion: transcript.currentVersion })),
      },
      transcriptSpeaker: { findMany: jest.fn().mockResolvedValue(speakerRows) },
      transcriptSegment: { findMany: jest.fn().mockResolvedValue(segmentRows) },
      transcriptVersion: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ version: 3 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    } as never;

    access = {
      require: jest.fn().mockImplementation(async () => ({
        transcript: { id: TRANSCRIPT_ID, currentVersion: transcript.currentVersion },
        role: 'owner',
      })),
    };

    pipeline = {
      enqueueSnapshot: jest.fn().mockResolvedValue(true),
      // #188: every committed op batch and every restore re-indexes —
      // unconditionally, unlike the rationed snapshot above.
      enqueueSearchIndex: jest.fn().mockResolvedValue(undefined),
    };

    events = { emit: jest.fn().mockReturnValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptEditingService,
        { provide: EventEmitter2, useValue: events },
        TranscriptMaterializeService,
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptAccessService, useValue: access },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptObjectsService, useValue: { download: jest.fn() } },
      ],
    }).compile();

    service = module.get(TranscriptEditingService);
  });

  /** The ops actually written to `transcript_versions`. */
  const recordedOps = () => versionCreate.mock.calls[0][0].data.ops as Array<Record<string, unknown>>;

  // ===========================================================================
  // find & replace expansion (spec §4.2)
  // ===========================================================================

  describe('transcript.find_replace is expanded before it is recorded', () => {
    const batch = (op: Record<string, unknown>) => ({
      baseVersion: 3,
      clientBatchId: 'batch-0001',
      ops: [{ op: OP_TYPES.FIND_REPLACE, find: 'Kvox', replace: 'KVox', ...op }] as never,
    });

    it('records concrete segment.update_text ops, never the abstract call', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({}) as never, USER);

      const ops = recordedOps();

      // ⚠ THE assertion of spec §4.2: nothing named `transcript.find_replace`
      // may ever reach the version log, because replaying it would run through
      // a FUTURE matcher.
      expect(ops.every((op) => op.op === OP_TYPES.UPDATE_TEXT)).toBe(true);
      expect(ops).toEqual([
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'KVox is great' },
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's2', rev: 1, text: 'KVox and KVoxen' },
      ]);
    });

    it('honours matchCase', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({ matchCase: true }) as never, USER);

      expect(recordedOps()).toEqual([
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'KVox is great' },
        // `kvox` is left alone; only the capitalised `Kvoxen` is rewritten.
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's2', rev: 1, text: 'kvox and KVoxen' },
      ]);
    });

    it('honours wholeWord', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({ wholeWord: true }) as never, USER);

      expect(recordedOps()).toEqual([
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'KVox is great' },
        // `Kvoxen` is not a whole word, so it survives.
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's2', rev: 1, text: 'KVox and Kvoxen' },
      ]);
    });

    it('honours a speaker scope', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({ speakerId: 'B' }) as never, USER);

      expect(recordedOps()).toEqual([
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's2', rev: 1, text: 'KVox and KVoxen' },
      ]);
    });

    it('summarises the replacement rather than its expansion', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({}) as never, USER);

      expect(versionCreate.mock.calls[0][0].data.summary).toBe(
        'Replaced “Kvox” with “KVox” (3 occurrences in 2 lines)',
      );
    });

    it('records an audit event, because one click changed many lines', async () => {
      await service.applyOperations(TRANSCRIPT_ID, batch({}) as never, USER);

      expect((prisma.auditEvent as { create: jest.Mock }).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'transcript.bulk_correction',
            targetType: 'transcript',
            targetId: TRANSCRIPT_ID,
          }),
        }),
      );
    });

    it('writes no version at all when nothing matched', async () => {
      const result = await service.applyOperations(
        TRANSCRIPT_ID,
        batch({ find: 'absent-from-everything' }) as never,
        USER,
      );

      expect(versionCreate).not.toHaveBeenCalled();
      expect(result.version).toBe(3);
      expect(result.summary).toBe('No changes');
    });
  });

  // ===========================================================================
  // Naming a speaker for the first time is not a version (issue #323)
  // ===========================================================================
  //
  // `speakerRows` (this file's fixture) already carries the ingest placeholder
  // for speaker `A` — `displayName: 'Speaker A'` — so an unmodified batch
  // renaming `A` is, by construction, an identification unless a test says
  // otherwise.
  // ===========================================================================

  describe('naming a speaker (#323)', () => {
    const identifyBatch = (
      displayName: string,
      overrides: Record<string, unknown> = {},
      clientBatchId = 'identify-batch',
    ) => ({
      baseVersion: 3,
      clientBatchId,
      ops: [
        { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName, ...overrides },
      ] as never,
    });

    it('writes the name and the identities map, bumps neither the version nor the rev, and never creates a transcript_versions row', async () => {
      const result = await service.applyOperations(
        TRANSCRIPT_ID,
        identifyBatch('Oscar') as never,
        USER,
      );

      expect(versionCreate).not.toHaveBeenCalled();
      expect(tx.transcript.updateMany).not.toHaveBeenCalled();
      expect(result.version).toBe(3);
      expect(result.summary).toBe('Named Speaker A as Oscar');

      // ⚠ `rev` IS NOT PART OF THE PREDICATE'S UPDATE — only the placeholder
      // name and the rev the routing decision saw are, so a rev bump here
      // would be visible in the assertion below and it is not.
      expect(tx.transcriptSpeaker.updateMany).toHaveBeenCalledWith({
        where: { id: 'A', transcriptId: TRANSCRIPT_ID, rev: 1, displayName: 'Speaker A' },
        data: { displayName: 'Oscar' },
      });

      expect(tx.transcript.update).toHaveBeenCalledWith({
        where: { id: TRANSCRIPT_ID },
        data: { speakerIdentities: { A: 'Oscar' } },
      });
    });

    it('enqueues the search index and an audit event, but never a snapshot', async () => {
      await service.applyOperations(TRANSCRIPT_ID, identifyBatch('Oscar') as never, USER);

      expect(pipeline.enqueueSearchIndex).toHaveBeenCalledWith(TRANSCRIPT_ID);
      expect(pipeline.enqueueSnapshot).not.toHaveBeenCalled();

      expect((prisma.auditEvent as { create: jest.Mock }).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'transcript.speaker_identified',
            targetType: 'transcript',
            targetId: TRANSCRIPT_ID,
            meta: { speakers: [{ speakerId: 'A', label: 'A', previousName: 'Speaker A', displayName: 'Oscar' }] },
          }),
        }),
      );
    });

    it('emits transcript.speakers_identified after the save, the search enqueue and the audit (#356)', async () => {
      await service.applyOperations(TRANSCRIPT_ID, identifyBatch('Oscar') as never, USER);

      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
        new TranscriptSpeakersIdentifiedEvent(TRANSCRIPT_ID, USER.id, ['A']),
      );

      // Order: after the search enqueue and the audit row.
      const emitOrder = events.emit.mock.invocationCallOrder[0];
      expect(pipeline.enqueueSearchIndex.mock.invocationCallOrder[0]).toBeLessThan(emitOrder);
      expect(
        (prisma.auditEvent as { create: jest.Mock }).create.mock.invocationCallOrder[0],
      ).toBeLessThan(emitOrder);
    });

    it('still answers the naming when the emit throws (#356)', async () => {
      events.emit.mockImplementation(() => {
        throw new Error('listener exploded');
      });

      const result = await service.applyOperations(
        TRANSCRIPT_ID,
        identifyBatch('Oscar') as never,
        USER,
      );

      expect(result.summary).toBe('Named Speaker A as Oscar');
    });

    it('is idempotent: retrying an identification the speaker already carries writes nothing and enqueues nothing', async () => {
      const alreadyIdentified = [
        { id: 'A', label: 'A', displayName: 'Oscar', colorIndex: 0, rev: 1 },
        speakerRows[1],
      ];

      (prisma.transcriptSpeaker as { findMany: jest.Mock }).findMany.mockResolvedValue(
        alreadyIdentified,
      );
      tx.transcriptSpeaker.findMany.mockResolvedValue(alreadyIdentified);

      const result = await service.applyOperations(
        TRANSCRIPT_ID,
        identifyBatch('Oscar', {}, 'identify-retry') as never,
        USER,
      );

      expect(result.summary).toBe('No changes');
      expect(tx.transcriptSpeaker.updateMany).not.toHaveBeenCalled();
      expect(tx.transcript.update).not.toHaveBeenCalled();
      expect(pipeline.enqueueSearchIndex).not.toHaveBeenCalled();
      expect((prisma.auditEvent as { create: jest.Mock }).create).not.toHaveBeenCalled();
      // #356: nothing was identified, so the graph is not told anything.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('answers a stale rev with the exact 409 shape a versioned conflict uses', async () => {
      // The routing read (outside the lock, still the placeholder) says this
      // is an identification; the LOCKED read inside the transaction sees a
      // rev someone else already moved — the honest 409, not a silent
      // overwrite of whatever they wrote.
      tx.transcriptSpeaker.findMany.mockResolvedValue([
        { id: 'A', label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 2 },
        speakerRows[1],
      ]);

      const conflict = await service
        .applyOperations(TRANSCRIPT_ID, identifyBatch('Oscar', {}, 'identify-stale') as never, USER)
        .catch((error: unknown) => error);

      expect(conflict).toBeInstanceOf(ConflictException);

      const body = (conflict as ConflictException).getResponse() as {
        details: { currentVersion: number; conflicts: Array<Record<string, unknown>> };
      };

      expect(body.details).toEqual({
        currentVersion: 3,
        conflicts: [{ entity: 'speaker', id: 'A', current: 2 }],
      });
      expect(tx.transcriptSpeaker.updateMany).not.toHaveBeenCalled();
      expect(tx.transcript.update).not.toHaveBeenCalled();
    });

    it('keeps a batch versioned when a rename rides along with a text edit', async () => {
      await service.applyOperations(
        TRANSCRIPT_ID,
        {
          baseVersion: 3,
          clientBatchId: 'mixed-batch',
          ops: [
            { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Oscar' },
            { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'updated text' },
          ],
        } as never,
        USER,
      );

      expect(versionCreate).toHaveBeenCalled();
      expect(recordedOps().map((op) => op.op)).toEqual([
        OP_TYPES.RENAME_SPEAKER,
        OP_TYPES.UPDATE_TEXT,
      ]);
      // The identification-only path never ran, so nothing was written to the
      // identities map for this rename — it rode along as an ordinary
      // recorded op instead.
      expect(tx.transcriptSpeaker.updateMany).not.toHaveBeenCalled();
    });

    it('records renaming an already-identified speaker (Oscar -> Joe) as a version, not an identification', async () => {
      const identified = [
        { id: 'A', label: 'A', displayName: 'Oscar', colorIndex: 0, rev: 1 },
        speakerRows[1],
      ];

      (prisma.transcriptSpeaker as { findMany: jest.Mock }).findMany.mockResolvedValue(identified);
      tx.transcriptSpeaker.findMany.mockResolvedValue(identified);

      await service.applyOperations(
        TRANSCRIPT_ID,
        {
          baseVersion: 3,
          clientBatchId: 'oscar-to-joe',
          ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Joe' }],
        } as never,
        USER,
      );

      expect(versionCreate).toHaveBeenCalled();
      expect(recordedOps()).toEqual([
        { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Joe' },
      ]);
      expect(tx.transcriptSpeaker.updateMany).not.toHaveBeenCalled();
    });

    it('retires the identity entry when a versioned rename puts the speaker back on its placeholder', async () => {
      speakerIdentities = { A: 'Oscar' };

      const identified = [
        { id: 'A', label: 'A', displayName: 'Oscar', colorIndex: 0, rev: 1 },
        speakerRows[1],
      ];

      (prisma.transcriptSpeaker as { findMany: jest.Mock }).findMany.mockResolvedValue(identified);
      tx.transcriptSpeaker.findMany.mockResolvedValue(identified);

      await service.applyOperations(
        TRANSCRIPT_ID,
        {
          baseVersion: 3,
          clientBatchId: 'back-to-placeholder',
          ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Speaker A' }],
        } as never,
        USER,
      );

      expect(versionCreate).toHaveBeenCalled();
      // The versioned rename itself:
      expect(recordedOps()).toEqual([
        { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Speaker A' },
      ]);
      // ...and, in the SAME transaction, the now-stale identity entry is gone.
      expect(tx.transcript.update).toHaveBeenCalledWith({
        where: { id: TRANSCRIPT_ID },
        data: { speakerIdentities: {} },
      });
    });
  });

  // ===========================================================================
  // Server-assigned identity (spec §4.4 — a replay must produce the same ids)
  // ===========================================================================

  it('mints the split id server-side and resolves a character offset', async () => {
    await service.applyOperations(
      TRANSCRIPT_ID,
      {
        baseVersion: 3,
        clientBatchId: 'batch-0002',
        ops: [{ op: OP_TYPES.SPLIT, segmentId: 's1', rev: 1, atCharOffset: 5 }],
      } as never,
      USER,
    );

    expect(recordedOps()[0]).toMatchObject({
      op: OP_TYPES.SPLIT,
      segmentId: 's1',
      // `atCharOffset: 5` in "Kvox is great" snaps to the boundary before "is".
      atWordIndex: 1,
    });
    expect(typeof recordedOps()[0].newSegmentId).toBe('string');
    expect(recordedOps()[0].atCharOffset).toBeUndefined();
  });

  it('chooses the new speaker id and the next colour index', async () => {
    await service.applyOperations(
      TRANSCRIPT_ID,
      {
        baseVersion: 3,
        clientBatchId: 'batch-0003',
        ops: [{ op: OP_TYPES.CREATE_SPEAKER, displayName: 'Dana' }],
      } as never,
      USER,
    );

    expect(recordedOps()[0]).toMatchObject({
      op: OP_TYPES.CREATE_SPEAKER,
      displayName: 'Dana',
      // Two existing speakers at 0 and 1.
      colorIndex: 2,
    });
  });

  it('records the caller-supplied summary instead of the ops-derived one (issue #328)', async () => {
    await service.applyOperations(
      TRANSCRIPT_ID,
      {
        baseVersion: 3,
        clientBatchId: 'batch-0005',
        ops: [{ op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'Oscar is great' }],
      } as never,
      USER,
      { summary: 'Applied 1 AI name correction' },
    );

    expect(versionCreate.mock.calls[0][0].data.summary).toBe('Applied 1 AI name correction');
  });

  it('falls back to the ops-derived summary when no override is given', async () => {
    await service.applyOperations(
      TRANSCRIPT_ID,
      {
        baseVersion: 3,
        clientBatchId: 'batch-0006',
        ops: [{ op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'Oscar is great' }],
      } as never,
      USER,
    );

    expect(versionCreate.mock.calls[0][0].data.summary).not.toBe('Applied 1 AI name correction');
    expect(typeof versionCreate.mock.calls[0][0].data.summary).toBe('string');
  });

  // ===========================================================================
  // Guards that answer before anything is written
  // ===========================================================================

  it('refuses to correct a transcript that has no transcript yet', async () => {
    transcript.currentVersion = 0;

    await expect(
      service.applyOperations(
        TRANSCRIPT_ID,
        { baseVersion: 0, clientBatchId: 'batch-0004', ops: [] } as never,
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a restore whose baseVersion is stale', async () => {
    await expect(
      service.restore(TRANSCRIPT_ID, 1, { baseVersion: 2 }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to restore the version that is already current', async () => {
    await expect(
      service.restore(TRANSCRIPT_ID, 3, { baseVersion: 3 }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s a version number that does not exist', async () => {
    await expect(service.getVersion(TRANSCRIPT_ID, 99, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ===========================================================================
  // Search
  // ===========================================================================

  describe('search', () => {
    it('reports the exact total even when the match list is truncated', async () => {
      const result = await service.search(
        TRANSCRIPT_ID,
        { q: 'kvox', matchCase: false, wholeWord: false, limit: 1 },
        USER,
      );

      expect(result.total).toBe(3);
      expect(result.segmentCount).toBe(2);
      expect(result.matches).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it('scopes to one speaker when asked', async () => {
      await service.search(
        TRANSCRIPT_ID,
        { q: 'kvox', matchCase: false, wholeWord: false, speakerId: 'B' },
        USER,
      );

      expect((prisma.transcriptSegment as { findMany: jest.Mock }).findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { transcriptId: TRANSCRIPT_ID, speakerId: 'B' },
        }),
      );
    });

    it('is a view-level read, not an edit', async () => {
      await service.search(
        TRANSCRIPT_ID,
        { q: 'kvox', matchCase: false, wholeWord: false },
        USER,
      );

      expect(access.require).toHaveBeenCalledWith(USER.id, TRANSCRIPT_ID, 'view');
    });
  });

  // ===========================================================================
  // Version history
  // ===========================================================================

  describe('listVersions', () => {
    it('pages backwards from the newest and reports a cursor only when there is more', async () => {
      const rows = Array.from({ length: 3 }, (_, index) => ({
        version: 3 - index,
        kind: 'edit',
        summary: 'x',
        restoredFromVersion: null,
        snapshotObjectId: null,
        ops: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        author: { id: 'user-1', name: 'Ed', email: 'ed@example.test' },
      }));

      (prisma.transcriptVersion as { findMany: jest.Mock }).findMany.mockResolvedValue(rows);

      const page = await service.listVersions(TRANSCRIPT_ID, { limit: 2 }, USER);

      expect(page.items.map((item) => item.version)).toEqual([3, 2]);
      expect(page.nextCursor).toBe(encodeVersionCursor(2));
    });

    it('reports `author: null` for the AI original', async () => {
      (prisma.transcriptVersion as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          version: 1,
          kind: 'ai_original',
          summary: 'Transcribed by AssemblyAI',
          restoredFromVersion: null,
          snapshotObjectId: 'object-1',
          ops: [],
          createdAt: new Date(),
          author: null,
        },
      ]);

      const page = await service.listVersions(TRANSCRIPT_ID, {}, USER);

      expect(page.items[0]).toMatchObject({ author: null, kind: 'ai_original', hasSnapshot: true });
      expect(page.nextCursor).toBeNull();
    });
  });
});

describe('version cursors', () => {
  it('round-trips', () => {
    expect(decodeVersionCursor(encodeVersionCursor(42))).toBe(42);
  });

  it('is null for no cursor', () => {
    expect(decodeVersionCursor(undefined)).toBeNull();
  });

  it('refuses anything else, rather than silently paging from the top', () => {
    expect(() => decodeVersionCursor('not-a-cursor')).toThrow();
  });
});
