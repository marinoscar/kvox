// =============================================================================
// ProposalsService on a ONE-CONNECTION pool (#615)
// =============================================================================
//
// PGlite (KVox Desktop, the bare host's pglite leg) has one connection. An
// interactive transaction holds it, so a root-client read, or a call into a
// port that reads through the root client, made inside the transaction
// callback waits forever. Simulated here: `$transaction` sets an "inside"
// flag, and the root client's model methods and the origin service throw while
// it is set. The real SpanValidator and the real ProposalsService run on top;
// only `tx` may be touched inside.
// =============================================================================

import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import { ProposalsService } from './proposals.service.js';
import { SpanValidator } from './span-validator.js';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const OWNER = '0a000000-0000-4000-8000-000000000001';
const P = '0b000000-0000-4000-8000-000000000001';
const NOTE = '0b000000-0000-4000-8000-0000000000aa';
const TRANSCRIPT = '0c000000-0000-4000-8000-000000000001';
const SEG = '0d000000-0000-4000-8000-000000000001';
const ITEM = 'e0000000-0000-4000-8000-000000000001';
const EVIDENCE = 'e0000000-0000-4000-8000-0000000000e1';
const SEG_TEXT = "Hi, I'm Sarah Chen.";

const user = { id: OWNER, email: 'o@example.test', roles: [], permissions: ['graph:read', 'graph:write'], isActive: true };
const SEGMENT_SPAN = { source: 'segment' as const, segmentId: SEG, segmentRev: 3, charStart: 8, charEnd: 18, quote: 'Sarah Chen' };

type Row = Record<string, any>;

function onePool() {
  let inside = false;
  const outsideOnly = <T>(what: string, value: T): T => {
    if (inside) throw new Error(`${what} called inside the transaction: it would wait for the only connection`);
    return value;
  };

  const tx: Row = {
    $queryRaw: jest.fn(async () => [{ status: 'draft' }]),
    note: { findFirst: jest.fn(async () => ({ id: NOTE, currentVersion: 2 })) },
    noteVersion: { findUnique: jest.fn(async () => null) },
    transcriptSegment: {
      findFirst: jest.fn(async () => ({ id: SEG, transcriptId: TRANSCRIPT, rev: 3, text: SEG_TEXT, startMs: 100, endMs: 900 })),
    },
    kgProposalItem: {
      findMany: jest.fn(async () => [
        {
          id: ITEM, kind: 'entity', origin: 'ai', decision: 'pending', editedPayload: null, resolution: null, mergeIntoId: null,
          distinctFrom: [], flags: [], committedRefId: null, sortOrder: 0,
          payload: { ref: 'e1', type: 'Person', label: 'Sarah Chen', aliases: [], props: {}, occurredAt: null },
        },
      ]),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 'e0000000-0000-4000-8000-0000000000ff' })),
    },
    kgEntity: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    kgEvidence: {
      findMany: jest.fn(async () => [{ id: EVIDENCE }]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
  };

  // The root client: every model method throws while the transaction is open.
  const rootModel = (rows: unknown) =>
    new Proxy({} as Record<string, jest.Mock>, {
      get: (_t, method) => jest.fn(async () => outsideOnly(`prisma.${String(method)}`, rows)),
    });
  const rootNoteFindFirst = jest.fn(async () =>
    outsideOnly('prisma.note.findFirst', { id: NOTE, sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT, sourceNoteId: null }),
  );
  const prisma: Row = {
    note: { findFirst: rootNoteFindFirst },
    transcript: rootModel([]),
    kgProposal: rootModel({ id: P, ownerId: OWNER }),
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      inside = true;
      try {
        return await fn(tx);
      } finally {
        inside = false;
      }
    }),
  };
  // NoteOriginService: root-client reads and the TranscriptSharing port.
  const origin = { resolve: jest.fn(async () => outsideOnly('NoteOriginService.resolve', { id: TRANSCRIPT })) };
  const spans = new SpanValidator(origin as never, prisma as never);
  const access = { require: jest.fn(async () => ({ id: P, ownerId: OWNER, noteId: NOTE, status: 'draft' })) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schema) };
  const service = new ProposalsService(
    prisma as never,
    access as never,
    {} as never,
    ontology as never,
    spans as never,
    { record: jest.fn(async () => undefined) } as never,
  );
  jest.spyOn(service, 'detail').mockImplementation(async () => ({
    proposal: { counts: { total: 1 } } as never,
    items: [{ id: ITEM } as never, { id: 'e0000000-0000-4000-8000-0000000000ff' } as never],
    context: null,
  }));
  return { service, tx, prisma, origin, rootNoteFindFirst };
}

describe('ProposalsService with a transcript-segment span on a one-connection pool (#615)', () => {
  it('addItem completes: the origin is resolved before the transaction, never inside it', async () => {
    const { service, tx, prisma, origin, rootNoteFindFirst } = onePool();

    await expect(
      service.addItem(user, P, {
        kind: 'entity',
        payload: { type: 'Person', label: 'Sarah Chen' },
        evidence: [SEGMENT_SPAN],
      }),
    ).resolves.toBeDefined();

    expect(origin.resolve).toHaveBeenCalledTimes(1);
    expect(rootNoteFindFirst).toHaveBeenCalledTimes(1);
    expect(origin.resolve.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    expect(rootNoteFindFirst.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    // The segment was proven against the origin transcript, on tx, and stored.
    expect(tx.transcriptSegment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SEG, transcriptId: TRANSCRIPT } }));
    expect(tx.kgEvidence.createMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ transcriptId: TRANSCRIPT, segmentId: SEG, subjectKind: 'proposal_item', ownerId: OWNER }),
    );
  });

  it('decide completes: adding a segment span resolves the origin before the transaction, never inside it', async () => {
    const { service, tx, prisma, origin, rootNoteFindFirst } = onePool();

    await expect(
      service.decide(user, P, ITEM, { decision: 'accept', evidence: { add: [SEGMENT_SPAN], remove: [] } }),
    ).resolves.toBeDefined();

    expect(origin.resolve).toHaveBeenCalledTimes(1);
    expect(rootNoteFindFirst).toHaveBeenCalledTimes(1);
    expect(origin.resolve.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    expect(tx.kgEvidence.createMany.mock.calls[0][0].data[0]).toEqual(expect.objectContaining({ segmentId: SEG, subjectId: ITEM }));
  });

  it('a decision that adds no span reads nothing through the root client before or inside the transaction', async () => {
    const { service, origin, rootNoteFindFirst } = onePool();
    await service.decide(user, P, ITEM, { decision: 'accept' });
    expect(origin.resolve).not.toHaveBeenCalled();
    expect(rootNoteFindFirst).not.toHaveBeenCalled();
  });

  it('control: a double that lets the origin resolve inside the transaction does fail (the guard has teeth)', async () => {
    const { service, origin, prisma } = onePool();
    // Simulate the pre-fix behaviour: the origin is resolved from within the callback.
    const original = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) =>
      original(async (t: unknown) => {
        await origin.resolve();
        return fn(t);
      }),
    );
    await expect(
      service.addItem(user, P, { kind: 'entity', payload: { type: 'Person', label: 'Sarah Chen' }, evidence: [SEGMENT_SPAN] }),
    ).rejects.toThrow(/inside the transaction/);
  });
});
