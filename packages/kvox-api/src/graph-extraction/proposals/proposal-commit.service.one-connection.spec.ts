// =============================================================================
// ProposalCommitService.commit on a ONE-CONNECTION pool (#615)
// =============================================================================
//
// Proving a citation readable asks two ports: `KVOX_OBJECT_STORE.describe` for
// an import object and `TranscriptAccessService.rolesFor` for a transcript the
// owner does not own. Both read the database through the root client, and on a
// one-connection pool (PGlite) a root-client read inside the commit's
// interactive transaction waits forever for the connection it holds. Simulated:
// `$transaction` sets an "inside" flag; the root client, the object store and
// the sharing decision throw while it is set. The GraphWriteService double
// applies the same two-phase rule the real EvidenceValidator does
// (`prefetchEvidence` before; the evidence check inside takes only `tx` and the
// `evidenceAccess`, and asks a port only for what the access does not cover).
// The real validator's own two phases are pinned in evidence-validator.service.spec.ts
// (this slice may not import it) and over a real one-connection database by the
// bare host's graph-ask e2e, steps 11b and 11c.
// =============================================================================

import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import { ProposalCommitService } from './proposal-commit.service.js';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const OWNER = '0a000000-0000-4000-8000-000000000001';
const SHARER = '0a000000-0000-4000-8000-000000000002';
const ORG = '0a000000-0000-4000-8000-0000000000f0';
const P = '0b000000-0000-4000-8000-000000000001';
const NOTE = '0b000000-0000-4000-8000-0000000000aa';
const ITEM = 'e0000000-0000-4000-8000-000000000001';
const IMPORT_OBJECT = 'b0000000-0000-4000-8000-000000000001';
const SHARED_TRANSCRIPT = 'c0000000-0000-4000-8000-000000000001';
const SEGMENT = 'd0000000-0000-4000-8000-000000000001';

type Row = Record<string, any>;

const anchors = { noteId: null, noteVersion: null, charStart: null, charEnd: null, transcriptId: null, segmentId: null, segmentRev: null, startMs: null, endMs: null, importObjectId: null, sourceIri: null };
const evidenceRows = [
  { ...anchors, subjectId: ITEM, importObjectId: IMPORT_OBJECT, quote: 'imported' },
  { ...anchors, subjectId: ITEM, transcriptId: SHARED_TRANSCRIPT, segmentId: SEGMENT, segmentRev: 1, startMs: 0, endMs: 900, quote: 'shared line' },
];

function onePool() {
  let inside = false;
  const phase = () => (inside ? 'inside' : 'before');
  const calls: Array<{ what: string; phase: string }> = [];
  const outsideOnly = <T>(what: string, value: T): T => {
    calls.push({ what, phase: phase() });
    if (inside) throw new Error(`${what} called inside the transaction: it would wait for the only connection`);
    return value;
  };

  const tx: Row = {
    $queryRaw: jest.fn(async () => [{ status: 'draft' }]),
    kgProposal: {
      findUniqueOrThrow: jest.fn(async () => ({ id: P, ownerId: OWNER, kind: 'extraction', noteId: NOTE, stats: {} })),
      update: jest.fn(async () => ({})),
    },
    kgProposalItem: {
      findMany: jest.fn(async () => [
        {
          id: ITEM, kind: 'entity', origin: 'ai', decision: 'accept', editedPayload: null, resolution: null, mergeIntoId: null,
          distinctFrom: [], flags: [], committedRefId: null, sortOrder: 0,
          payload: { ref: 'e1', type: 'Person', label: 'Sarah Chen', aliases: [], props: {}, occurredAt: null },
        },
      ]),
      update: jest.fn(async () => ({})),
    },
    kgEvidence: {
      findMany: jest.fn(async ({ where }: Row) => (where.subjectKind === 'proposal_item' ? evidenceRows : [{ id: 'ev' }])),
      groupBy: jest.fn(async ({ where }: Row) => where.OR.map((s: Row) => ({ ...s, _count: { _all: 1 } }))),
    },
    kgEntity: { findMany: jest.fn(async () => []) },
    kgRelation: { findFirst: jest.fn(async () => null) },
    kgItem: { findFirst: jest.fn(async () => null) },
    kgMention: { findMany: jest.fn(async () => []), createManyAndReturn: jest.fn(async ({ data }: Row) => data.map((_: unknown, i: number) => ({ id: `m${i}` }))) },
    // The write reads the transcript and segment rows on tx (the owner check, the segment's transcript).
    transcript: { findMany: jest.fn(async () => [{ id: SHARED_TRANSCRIPT, ownerId: SHARER, orgId: ORG }]) },
    transcriptSegment: { findMany: jest.fn(async () => [{ id: SEGMENT, transcriptId: SHARED_TRANSCRIPT }]) },
  };

  // The root client: every model method throws while the transaction is open.
  const prisma: Row = {
    kgProposalItem: { findMany: jest.fn(async () => outsideOnly('prisma.kgProposalItem.findMany', [{ id: ITEM }])) },
    kgEvidence: { findMany: jest.fn(async () => outsideOnly('prisma.kgEvidence.findMany', evidenceRows)) },
    transcript: { findMany: jest.fn(async () => outsideOnly('prisma.transcript.findMany', [{ id: SHARED_TRANSCRIPT, ownerId: SHARER, orgId: ORG }])) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      inside = true;
      try {
        return await fn(tx);
      } finally {
        inside = false;
      }
    }),
  };

  // The DB-backed ports.
  const store = {
    describe: jest.fn(async (ids: readonly string[]) =>
      outsideOnly(
        'KVOX_OBJECT_STORE.describe',
        new Map(ids.map((id) => [id, { id, ownerId: OWNER, managedBy: 'graph-rdf' }] as const)),
      ),
    ),
  };
  const transcriptAccess = {
    // The owner holds a share on the transcript SHARER owns.
    rolesFor: jest.fn(async (_u: string, rows: Array<{ id: string }>) =>
      outsideOnly('TranscriptSharing.rolesFor', new Map(rows.map((r) => [r.id, 'viewer'] as const))),
    ),
  };
  type Access = { importObjects: Map<string, boolean>; sharedTranscripts: Map<string, boolean> };
  const validator = {
    // Before the transaction: ask the ports, once, for every cited import object and every foreign transcript.
    prefetch: async (ownerId: string, evidence: Array<{ importObjectId: string | null; transcriptId: string | null }>): Promise<Access> => {
      const importIds = [...new Set(evidence.flatMap((e) => (e.importObjectId ? [e.importObjectId] : [])))];
      const transcriptIds = [...new Set(evidence.flatMap((e) => (e.transcriptId ? [e.transcriptId] : [])))];
      const objects = importIds.length ? await store.describe(importIds) : new Map();
      const rows = transcriptIds.length ? await prisma.transcript.findMany({ where: { id: { in: transcriptIds } } }) : [];
      const foreign = rows.filter((r: Row) => r.ownerId !== ownerId);
      const roles = foreign.length ? await transcriptAccess.rolesFor(ownerId, foreign) : new Map();
      return {
        importObjects: new Map(importIds.map((id) => [id, objects.get(id)?.ownerId === ownerId] as const)),
        sharedTranscripts: new Map(foreign.map((r: Row) => [r.id, roles.has(r.id)] as const)),
      };
    },
    // Inside the transaction: tx and the access only; a port is asked (and, on one connection, fails) only when the access is missing.
    assertReadable: async (ownerId: string, evidence: Array<{ importObjectId: string | null; transcriptId: string | null }>, t: Row, access?: Access) => {
      for (const e of evidence) {
        if (e.importObjectId) {
          const known = access?.importObjects.get(e.importObjectId);
          const owned = known ?? (await store.describe([e.importObjectId])).get(e.importObjectId)?.ownerId === ownerId;
          if (!owned) throw new Error('import object not readable');
        }
        if (e.transcriptId) {
          const [row] = await t.transcript.findMany({ where: { id: { in: [e.transcriptId] } } });
          const shared = row.ownerId === ownerId || (access?.sharedTranscripts.get(row.id) ?? (await transcriptAccess.rolesFor(ownerId, [row])).has(row.id));
          if (!shared) throw new Error('transcript not readable');
        }
      }
    },
  };

  const accesses: unknown[] = [];
  const write = {
    prefetchEvidence: jest.fn((ownerId: string, evidence: never[]) => validator.prefetch(ownerId, evidence)),
    createEntity: jest.fn(async (t: unknown, input: Row) => {
      accesses.push(input.evidenceAccess);
      await validator.assertReadable(input.ownerId, input.evidence, t as Row, input.evidenceAccess);
      return { id: 'ent-new' };
    }),
    addEvidence: jest.fn(async () => []),
  };

  const service = new ProposalCommitService(
    prisma as never,
    { require: jest.fn(async () => ({ id: P, ownerId: OWNER })) } as never,
    { effectiveSchemaFor: jest.fn(async () => schema) } as never,
    write as never,
    { recordLink: jest.fn(async () => 'alias-1') } as never,
    { record: jest.fn() } as never,
    { merge: jest.fn(), afterMerge: jest.fn() } as never,
    { enqueue: jest.fn(), isRegistered: jest.fn(() => false) } as never,
    { graphEnabled: jest.fn(async () => false) } as never,
    { summary: jest.fn(async () => ({ id: P, status: 'committed' })) } as never,
    { record: jest.fn(async () => undefined) } as never,
    { emit: jest.fn(), subscribe: jest.fn() } as never,
  );
  return { service, prisma, tx, store, transcriptAccess, write, calls, accesses };
}

const user = { id: OWNER, email: 'o@example.test', roles: [], permissions: ['graph:read', 'graph:write'], isActive: true };

describe('ProposalCommitService.commit on a one-connection pool (#615)', () => {
  it('completes when the evidence cites an import object and a transcript shared with (not owned by) the owner', async () => {
    const { service, tx } = onePool();

    const response = await service.commit(user, P);

    expect(response.result.created.entities).toBe(1);
    expect(tx.kgProposal.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'committed' }) }));
  });

  it('asks describe and rolesFor exactly once each, both before the transaction, none inside it', async () => {
    const { service, prisma, store, transcriptAccess, calls } = onePool();

    await service.commit(user, P);

    expect(store.describe).toHaveBeenCalledTimes(1);
    expect(store.describe).toHaveBeenCalledWith([IMPORT_OBJECT]);
    expect(transcriptAccess.rolesFor).toHaveBeenCalledTimes(1);
    expect(transcriptAccess.rolesFor.mock.calls[0][0]).toBe(OWNER);
    expect(transcriptAccess.rolesFor.mock.calls[0][1].map((r: { id: string }) => r.id)).toEqual([SHARED_TRANSCRIPT]);
    expect(calls.filter((c) => c.phase === 'inside')).toEqual([]);
    expect(store.describe.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    expect(transcriptAccess.rolesFor.mock.invocationCallOrder[0]).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
  });

  it('threads the prefetched access into the evidence-carrying write', async () => {
    const { service, write, accesses } = onePool();

    await service.commit(user, P);

    expect(write.prefetchEvidence).toHaveBeenCalledTimes(1);
    expect(write.prefetchEvidence).toHaveBeenCalledWith(OWNER, [
      expect.objectContaining({ importObjectId: IMPORT_OBJECT }),
      expect.objectContaining({ transcriptId: SHARED_TRANSCRIPT, segmentId: SEGMENT }),
    ]);
    expect(accesses).toHaveLength(1);
    const access = accesses[0] as { importObjects: Map<string, boolean>; sharedTranscripts: Map<string, boolean> };
    expect(access.importObjects.get(IMPORT_OBJECT)).toBe(true);
    expect(access.sharedTranscripts.get(SHARED_TRANSCRIPT)).toBe(true);
  });

  it('control: a commit that skips the prefetch hits the ports inside the transaction and fails (the guard has teeth)', async () => {
    const { service, write } = onePool();
    write.prefetchEvidence.mockResolvedValue(undefined as never);

    await expect(service.commit(user, P)).rejects.toThrow(/inside the transaction/);
  });

  it('commitIn without an access still works for owned evidence and asks the ports for the rest', async () => {
    const { service, tx, store } = onePool();
    await service.commitIn(tx as never, OWNER, P, schema);
    // No access was handed in: the ports answer (here, off the one-connection simulation).
    expect(store.describe).toHaveBeenCalledTimes(1);
  });
});
