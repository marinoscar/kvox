import { BadRequestException } from '@nestjs/common';

import type { EvidenceInput } from '../dto/graph-evidence.dto.js';
import type { KvoxGraphTx } from '../data/graph-db.js';
import { EvidenceValidator } from './evidence-validator.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const FOREIGN_NOTE = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT = '44444444-4444-4444-8444-444444444444';
const OTHER_TRANSCRIPT = '55555555-5555-4555-8555-555555555555';
const SEGMENT = '66666666-6666-4666-8666-666666666666';
const ORG = '88888888-8888-4888-8888-888888888888';
const OTHER_OWNER = '99999999-9999-4999-8999-999999999999';
const OWNER_STRANGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SEGMENT = '77777777-7777-4777-8777-777777777777';

const noteEv = (noteId: string, noteVersion = 1) =>
  ({ noteId, noteVersion, charStart: 0, charEnd: 5, quote: 'Hello' }) as EvidenceInput;
const segEv = (transcriptId: string, segmentId: string) =>
  ({ transcriptId, segmentId, quote: 'Hello' }) as EvidenceInput;

/**
 * A fake transaction client answering from fixed data. Readability here is
 * exactly what the real queries encode: the owner's own live notes, versions
 * that exist, and transcripts the owner owns or holds a share on.
 */
function fakeTx() {
  const tx = {
    note: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) =>
        where.id.in.filter((id) => id === NOTE && where.ownerId === OWNER).map((id) => ({ id })),
      ),
    },
    noteVersion: {
      findMany: jest.fn(async ({ where }: { where: { OR: { noteId: string; version: number }[] } }) =>
        where.OR.filter((p) => p.noteId === NOTE && p.version === 1),
      ),
    },
    transcript: {
      // TRANSCRIPT is shared with the owner (the query's OR matches it);
      // OTHER_TRANSCRIPT is somebody else's and not shared.
      // Live transcripts that exist: the one the owner can view and a stranger's.
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => id === TRANSCRIPT || id === OTHER_TRANSCRIPT)
          .map((id) => ({ id, ownerId: id === TRANSCRIPT ? OTHER_OWNER : OWNER_STRANGER, orgId: ORG })),
      ),
    },
    transcriptSegment: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, transcriptId: id === SEGMENT ? TRANSCRIPT : OTHER_TRANSCRIPT })),
      ),
    },
  };
  return tx;
}

describe('EvidenceValidator', () => {
  // The object gateway answers the import-object ownership lookup (#469).
  const managed = { describe: jest.fn(async (_ids: readonly string[]) => new Map<string, { id: string; ownerId: string | null; managedBy: string | null }>()) };
  // The platform's batched decision (#485): the owner holds a viewer share on TRANSCRIPT
  // (owned by someone else) and nothing on OTHER_TRANSCRIPT.
  const transcriptAccess = {
    rolesFor: jest.fn(async (_userId: string, rows: Array<{ id: string }>) =>
      new Map(rows.filter((row) => row.id === TRANSCRIPT).map((row) => [row.id, 'viewer'] as const)),
    ),
  };
  // No test here prefetches (#615), so the root client is never read.
  const validator = new EvidenceValidator(managed as never, transcriptAccess as never, {} as never);

  beforeEach(() => {
    managed.describe.mockClear();
    transcriptAccess.rolesFor.mockClear();
  });

  async function invalidIndexes(evidence: EvidenceInput[], tx = fakeTx()): Promise<number[] | null> {
    try {
      await validator.assertReadable(OWNER, evidence, tx as unknown as KvoxGraphTx);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return ((err as BadRequestException).getResponse() as { details: { invalidEvidence: number[] } }).details
        .invalidEvidence;
    }
  }

  it('accepts an owned note at an existing version, applying the DTO defaults', async () => {
    const tx = fakeTx();
    const parsed = await validator.assertReadable(OWNER, [noteEv(NOTE)], tx as unknown as KvoxGraphTx);
    expect(parsed[0]).toMatchObject({ noteId: NOTE, noteVersion: 1, transcriptId: null, sourceIri: null });
    expect(tx.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: OWNER, status: { not: 'deleting' }, deletedAt: null }),
      }),
    );
  });

  it("refuses another user's note", async () => {
    await expect(invalidIndexes([noteEv(NOTE), noteEv(FOREIGN_NOTE)])).resolves.toEqual([1]);
  });

  it('refuses a note version that does not exist', async () => {
    await expect(invalidIndexes([noteEv(NOTE, 9)])).resolves.toEqual([0]);
  });

  it("accepts a note Context citation (#440): both offsets null on a readable note version", async () => {
    const ctxEv = { noteId: NOTE, noteVersion: 1, charStart: null, charEnd: null, quote: 'EY, Consulting' } as EvidenceInput;
    await expect(invalidIndexes([ctxEv])).resolves.toBeNull();
  });

  it('refuses a note citation with only one offset set', async () => {
    const half = { noteId: NOTE, noteVersion: 1, charStart: 0, charEnd: null, quote: 'Hello' } as EvidenceInput;
    await expect(invalidIndexes([noteEv(NOTE), half])).resolves.toEqual([1]);
  });

  it('accepts a segment of a transcript shared with the owner', async () => {
    const tx = fakeTx();
    await expect(invalidIndexes([segEv(TRANSCRIPT, SEGMENT)], tx)).resolves.toBeNull();
    // Live rows only, then ONE batched decision (the platform's `AccessPolicy`) for the shares.
    expect(tx.transcript.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(transcriptAccess.rolesFor).toHaveBeenCalledTimes(1);
    expect(transcriptAccess.rolesFor).toHaveBeenCalledWith(OWNER, expect.any(Array));
  });

  it('refuses a segment that belongs to another transcript', async () => {
    await expect(invalidIndexes([segEv(TRANSCRIPT, OTHER_SEGMENT)])).resolves.toEqual([0]);
  });

  it('refuses a transcript the owner cannot view', async () => {
    await expect(invalidIndexes([segEv(OTHER_TRANSCRIPT, OTHER_SEGMENT)])).resolves.toEqual([0]);
  });

  it('refuses a row the schema rejects (no anchor at all), by index', async () => {
    await expect(invalidIndexes([noteEv(NOTE), { quote: 'orphan' } as EvidenceInput])).resolves.toEqual([1]);
  });

  it('refuses an import object the owner did not upload', async () => {
    await expect(
      invalidIndexes([{ importObjectId: FOREIGN_NOTE, quote: 'x' } as EvidenceInput]),
    ).resolves.toEqual([0]);
  });

  it('makes at most one query per source table, whatever the batch size', async () => {
    const tx = fakeTx();
    const batch = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? noteEv(NOTE) : segEv(TRANSCRIPT, SEGMENT)));
    await validator.assertReadable(OWNER, batch, tx as unknown as KvoxGraphTx);

    expect(tx.note.findMany).toHaveBeenCalledTimes(1);
    expect(tx.noteVersion.findMany).toHaveBeenCalledTimes(1);
    expect(tx.transcript.findMany).toHaveBeenCalledTimes(1);
    expect(tx.transcriptSegment.findMany).toHaveBeenCalledTimes(1);
    expect(managed.describe).not.toHaveBeenCalled();
  });

  it('queries no table a batch does not cite', async () => {
    const tx = fakeTx();
    await validator.assertReadable(
      OWNER,
      [{ sourceIri: 'https://example.test/x', quote: 'x' } as EvidenceInput],
      tx as unknown as KvoxGraphTx,
    );
    for (const table of Object.values(tx)) expect(table.findMany).not.toHaveBeenCalled();
  });
});

// #615: the ports are asked BEFORE the transaction (`prefetch`); inside it
// `assertReadable` / `viewableTranscriptIds` read only `tx` for every id the access covers.
describe('EvidenceValidator — prefetch and access (#615)', () => {
  const IMPORT_OWNED = 'b0000000-0000-4000-8000-000000000001';
  const IMPORT_OTHER_OWNER = 'b0000000-0000-4000-8000-000000000002';
  const IMPORT_UNMANAGED = 'b0000000-0000-4000-8000-000000000003';
  const IMPORT_UNKNOWN = 'b0000000-0000-4000-8000-000000000004';
  const T_OWNED = 'c0000000-0000-4000-8000-000000000001';
  const T_SHARED = 'c0000000-0000-4000-8000-000000000002';
  const T_NOT_SHARED = 'c0000000-0000-4000-8000-000000000003';
  const T_MISSING = 'c0000000-0000-4000-8000-000000000004'; // missing or soft-deleted: not returned by the live query

  const TRANSCRIPT_ROWS = [
    { id: T_OWNED, ownerId: OWNER, orgId: ORG },
    { id: T_SHARED, ownerId: OTHER_OWNER, orgId: ORG },
    { id: T_NOT_SHARED, ownerId: OWNER_STRANGER, orgId: ORG },
  ];

  const importEv = (importObjectId: string) => ({ importObjectId, quote: 'q' }) as unknown as EvidenceInput;
  // A transcript citation needs a segment of that transcript: 'c…' transcript ↔ 'd…' segment.
  const segmentOf = (transcriptId: string) => transcriptId.replace(/^c/, 'd');
  const transcriptEv = (transcriptId: string) =>
    ({ transcriptId, segmentId: segmentOf(transcriptId), quote: 'q' }) as unknown as EvidenceInput;

  function build() {
    const store = {
      describe: jest.fn(async (ids: readonly string[]) => {
        const all: Record<string, { id: string; ownerId: string | null; managedBy: string | null }> = {
          [IMPORT_OWNED]: { id: IMPORT_OWNED, ownerId: OWNER, managedBy: 'graph-rdf' },
          [IMPORT_OTHER_OWNER]: { id: IMPORT_OTHER_OWNER, ownerId: OTHER_OWNER, managedBy: 'graph-rdf' },
          [IMPORT_UNMANAGED]: { id: IMPORT_UNMANAGED, ownerId: OWNER, managedBy: null },
        };
        return new Map(ids.filter((id) => all[id]).map((id) => [id, all[id]] as const));
      }),
    };
    const access = {
      rolesFor: jest.fn(async (_u: string, rows: Array<{ id: string }>) =>
        new Map(rows.filter((r) => r.id === T_SHARED).map((r) => [r.id, 'viewer'] as const)),
      ),
    };
    const rootFindMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      TRANSCRIPT_ROWS.filter((r) => where.id.in.includes(r.id)),
    );
    const root = { transcript: { findMany: rootFindMany } };
    const validator = new EvidenceValidator(store as never, access as never, root as never);
    const txFindMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      TRANSCRIPT_ROWS.filter((r) => where.id.in.includes(r.id)),
    );
    const tx = {
      transcript: { findMany: txFindMany },
      transcriptSegment: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id, transcriptId: id.replace(/^d/, 'c') })),
        ),
      },
    } as unknown as KvoxGraphTx;
    return { validator, store, access, root, rootFindMany, tx, txFindMany };
  }

  describe('prefetch', () => {
    it('answers import objects: owned and managed true, other owner / unmanaged / unknown false', async () => {
      const { validator } = build();
      const result = await validator.prefetch(OWNER, [
        importEv(IMPORT_OWNED),
        importEv(IMPORT_OTHER_OWNER),
        importEv(IMPORT_UNMANAGED),
        importEv(IMPORT_UNKNOWN),
      ]);
      expect([...result.importObjects]).toEqual([
        [IMPORT_OWNED, true],
        [IMPORT_OTHER_OWNER, false],
        [IMPORT_UNMANAGED, false],
        [IMPORT_UNKNOWN, false],
      ]);
      expect(result.sharedTranscripts.size).toBe(0);
    });

    it('answers transcripts: owned omitted, shared true, not shared false, missing or soft-deleted false', async () => {
      const { validator, access } = build();
      const result = await validator.prefetch(OWNER, [
        transcriptEv(T_OWNED),
        transcriptEv(T_SHARED),
        transcriptEv(T_NOT_SHARED),
        transcriptEv(T_MISSING),
      ]);
      expect(result.sharedTranscripts.has(T_OWNED)).toBe(false);
      expect(result.sharedTranscripts.get(T_SHARED)).toBe(true);
      expect(result.sharedTranscripts.get(T_NOT_SHARED)).toBe(false);
      expect(result.sharedTranscripts.get(T_MISSING)).toBe(false);
      // Only the transcripts the owner does not own reach the sharing decision, in one batch.
      expect(access.rolesFor).toHaveBeenCalledTimes(1);
      expect(access.rolesFor.mock.calls[0][1].map((r) => r.id).sort()).toEqual([T_NOT_SHARED, T_SHARED].sort());
    });

    it('queries live transcripts only, once, and the object store once, whatever the batch size', async () => {
      const { validator, store, rootFindMany } = build();
      await validator.prefetch(OWNER, [
        transcriptEv(T_SHARED),
        transcriptEv(T_SHARED),
        importEv(IMPORT_OWNED),
        importEv(IMPORT_OWNED),
      ]);
      expect(rootFindMany).toHaveBeenCalledTimes(1);
      expect(rootFindMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: { id: { in: [T_SHARED] }, deletedAt: null } }));
      expect(store.describe).toHaveBeenCalledTimes(1);
      expect(store.describe).toHaveBeenCalledWith([IMPORT_OWNED]);
    });

    it('reads nothing for a batch that cites neither imports nor transcripts', async () => {
      const { validator, store, access, rootFindMany } = build();
      const result = await validator.prefetch(OWNER, [noteEv(NOTE)]);
      expect(result.importObjects.size).toBe(0);
      expect(result.sharedTranscripts.size).toBe(0);
      expect(store.describe).not.toHaveBeenCalled();
      expect(rootFindMany).not.toHaveBeenCalled();
      expect(access.rolesFor).not.toHaveBeenCalled();
    });

    it('an all-owned batch never calls rolesFor', async () => {
      const { validator, access } = build();
      const result = await validator.prefetch(OWNER, [transcriptEv(T_OWNED)]);
      expect(access.rolesFor).not.toHaveBeenCalled();
      expect(result.sharedTranscripts.size).toBe(0);
    });
  });

  describe('assertReadable with an access', () => {
    it('makes no port call for ids the access covers (import object and shared transcript)', async () => {
      const { validator, store, access, tx } = build();
      const evidence = [importEv(IMPORT_OWNED), transcriptEv(T_SHARED)];
      const prefetched = await validator.prefetch(OWNER, evidence);
      store.describe.mockClear();
      access.rolesFor.mockClear();

      await expect(validator.assertReadable(OWNER, evidence, tx, prefetched)).resolves.toHaveLength(2);

      expect(store.describe).not.toHaveBeenCalled();
      expect(access.rolesFor).not.toHaveBeenCalled();
    });

    it('refuses what the access says is not the owner\'s, still without a port call', async () => {
      const { validator, store, access, tx } = build();
      const evidence = [importEv(IMPORT_OTHER_OWNER), transcriptEv(T_NOT_SHARED), transcriptEv(T_SHARED)];
      const prefetched = await validator.prefetch(OWNER, evidence);
      store.describe.mockClear();
      access.rolesFor.mockClear();

      const err = await validator.assertReadable(OWNER, evidence, tx, prefetched).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(((err as BadRequestException).getResponse() as { details: { invalidEvidence: number[] } }).details.invalidEvidence).toEqual([0, 1]);
      expect(store.describe).not.toHaveBeenCalled();
      expect(access.rolesFor).not.toHaveBeenCalled();
    });

    it('falls back to the ports for ids the access does not cover', async () => {
      const { validator, store, access, tx } = build();
      const covered = await validator.prefetch(OWNER, [importEv(IMPORT_OWNED), transcriptEv(T_SHARED)]);
      store.describe.mockClear();
      access.rolesFor.mockClear();

      const rows = await validator.assertReadable(
        OWNER,
        [importEv(IMPORT_OWNED), transcriptEv(T_SHARED), importEv(IMPORT_UNMANAGED), transcriptEv(T_NOT_SHARED)],
        tx,
        covered,
      ).catch((e: unknown) => e);

      // The uncovered ones are asked of the ports: exactly them, nothing covered.
      expect(store.describe).toHaveBeenCalledTimes(1);
      expect(store.describe).toHaveBeenCalledWith([IMPORT_UNMANAGED]);
      expect(access.rolesFor).toHaveBeenCalledTimes(1);
      expect(access.rolesFor.mock.calls[0][1].map((r) => r.id)).toEqual([T_NOT_SHARED]);
      // ...and both uncovered ids are unreadable, so the batch is refused naming them.
      expect(rows).toBeInstanceOf(BadRequestException);
      expect(((rows as BadRequestException).getResponse() as { details: { invalidEvidence: number[] } }).details.invalidEvidence).toEqual([2, 3]);
    });

    it('without an access every port is asked, as before', async () => {
      const { validator, store, access, tx } = build();
      await validator.assertReadable(OWNER, [importEv(IMPORT_OWNED), transcriptEv(T_SHARED)], tx);
      expect(store.describe).toHaveBeenCalledWith([IMPORT_OWNED]);
      expect(access.rolesFor).toHaveBeenCalledTimes(1);
    });

    it('never calls rolesFor for an all-owned batch, with or without an access', async () => {
      const { validator, access, tx } = build();
      await validator.assertReadable(OWNER, [transcriptEv(T_OWNED)], tx);
      await validator.assertReadable(OWNER, [transcriptEv(T_OWNED)], tx, { importObjects: new Map(), sharedTranscripts: new Map() });
      expect(access.rolesFor).not.toHaveBeenCalled();
    });

    it('reads transcripts on tx, never on the root client, inside the write', async () => {
      const { validator, rootFindMany, txFindMany, tx } = build();
      const evidence = [transcriptEv(T_SHARED)];
      const prefetched = await validator.prefetch(OWNER, evidence);
      rootFindMany.mockClear();
      await validator.assertReadable(OWNER, evidence, tx, prefetched);
      expect(rootFindMany).not.toHaveBeenCalled();
      expect(txFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('viewableTranscriptIds with an access', () => {
    it('uses the access for shared ids and never calls rolesFor when it covers every non-owned row', async () => {
      const { validator, access, tx } = build();
      const ids = [T_OWNED, T_SHARED, T_NOT_SHARED, T_MISSING];
      const prefetched = await validator.prefetch(OWNER, ids.map(transcriptEv));
      access.rolesFor.mockClear();

      const viewable = await validator.viewableTranscriptIds(OWNER, ids, tx, prefetched);

      expect([...viewable].sort()).toEqual([T_OWNED, T_SHARED].sort());
      expect(access.rolesFor).not.toHaveBeenCalled();
    });

    it('falls back to rolesFor for uncovered non-owned ids only', async () => {
      const { validator, access, tx } = build();
      const viewable = await validator.viewableTranscriptIds(OWNER, [T_OWNED, T_SHARED, T_NOT_SHARED], tx, {
        importObjects: new Map(),
        sharedTranscripts: new Map([[T_NOT_SHARED, false]]),
      });
      expect([...viewable].sort()).toEqual([T_OWNED, T_SHARED].sort());
      expect(access.rolesFor).toHaveBeenCalledTimes(1);
      expect(access.rolesFor.mock.calls[0][1].map((r) => r.id)).toEqual([T_SHARED]);
    });

    it('an all-owned batch never calls rolesFor and an empty batch reads nothing', async () => {
      const { validator, access, tx, txFindMany } = build();
      expect([...(await validator.viewableTranscriptIds(OWNER, [T_OWNED], tx))]).toEqual([T_OWNED]);
      expect(access.rolesFor).not.toHaveBeenCalled();
      txFindMany.mockClear();
      expect((await validator.viewableTranscriptIds(OWNER, [], tx)).size).toBe(0);
      expect(txFindMany).not.toHaveBeenCalled();
    });
  });
});
