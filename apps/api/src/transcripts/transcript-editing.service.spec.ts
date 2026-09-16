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
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { OP_TYPES } from './editing';
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
  let versionCreate: jest.Mock;
  let access: { require: jest.Mock };
  let pipeline: { enqueueSnapshot: jest.Mock; enqueueSearchIndex: jest.Mock };
  let transcript: { id: string; currentVersion: number };

  beforeEach(async () => {
    transcript = { id: TRANSCRIPT_ID, currentVersion: 3 };
    versionCreate = jest.fn().mockResolvedValue({});

    const tx = {
      transcript: {
        findUnique: jest.fn().mockImplementation(async () => ({ currentVersion: transcript.currentVersion })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      transcriptSpeaker: {
        findMany: jest.fn().mockResolvedValue(speakerRows),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
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

    const module = await Test.createTestingModule({
      providers: [
        TranscriptEditingService,
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
