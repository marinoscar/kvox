import { BadRequestException } from '@nestjs/common';
import { computeEffectiveSchema } from '@app/shared/ontology';

import { CommitRowError, isSerializationFailure, ProposalCommitService } from './proposal-commit.service';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const OWNER = '0a000000-0000-4000-8000-000000000001';
const P = '0b000000-0000-4000-8000-000000000001';
const ACME = '0f000000-0000-4000-8000-000000000002';
const OLD = '0f000000-0000-4000-8000-000000000009';
const X1 = '0f000000-0000-4000-8000-000000000011';
const X2 = '0f000000-0000-4000-8000-000000000012';

type Row = Record<string, any>;

const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const temporalNone = { validFrom: null, validTo: null, precision: 'unknown' };

function items(): Row[] {
  const base = { origin: 'ai', editedPayload: null, resolution: null, mergeIntoId: null, distinctFrom: [], flags: [], committedRefId: null };
  return [
    // Deliberately out of commit order: the commit must still go entities → relations → items → closings.
    { ...base, id: id(5), kind: 'closing', decision: 'accept', sortOrder: 0, payload: { relationId: OLD, relationType: 'WORKS_FOR', closeAt: '2026-03-01', precision: 'month', closedByRef: 'r1' } },
    { ...base, id: id(4), kind: 'item', decision: 'accept', sortOrder: 1, payload: { ref: 'i1', kind: 'claim', title: 'Joined', statement: 'Sarah joined Acme.', subject: { ref: 'e1' }, owner: null, counterparty: null, meeting: null, status: null, occurredAt: null, dueAt: null, sensitivity: null, statementHash: 'x', props: {}, ...temporalNone } },
    { ...base, id: id(3), kind: 'relation', decision: 'accept', sortOrder: 2, payload: { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { ref: 'e2' }, props: {}, validFrom: '2026-03-01', validTo: null, precision: 'month' } },
    { ...base, id: id(1), kind: 'entity', decision: 'accept', sortOrder: 3, payload: { ref: 'e1', type: 'Person', label: 'Sarah Chen', aliases: ['Sarah'], props: {}, occurredAt: null } },
    { ...base, id: id(2), kind: 'entity', decision: 'accept', sortOrder: 4, payload: { ref: 'e2', type: 'Organization', label: 'ACME Inc', aliases: [], props: {}, occurredAt: null }, resolution: { ref: ACME, score: 0.95, source: 'alias', candidates: [], adjudication: null } },
    { ...base, id: id(6), kind: 'entity', decision: 'pending', sortOrder: 5, payload: { ref: 'e3', type: 'Project', label: 'Pilot' } },
  ];
}

function setup(rows: Row[], opts: { kind?: string; liveEntities?: Row[] } = {}) {
  const calls: string[] = [];
  const cite = { noteId: 'n', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab', transcriptId: null, segmentId: null, segmentRev: null, startMs: null, endMs: null, importObjectId: null, sourceIri: null };
  const live = opts.liveEntities ?? [{ id: ACME, type: 'Organization' }];
  const tx: Row = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM kg_proposals')) return [{ status: 'draft' }];
      if (sql.includes('FOR UPDATE')) return [{ id: OLD, valid: '["2019-01-01 00:00:00+00",)', valid_precision: 'year', superseded_by_id: null }];
      return [{ valid: '["2019-01-01 00:00:00+00","2026-03-01 00:00:00+00")', valid_precision: 'year', superseded_by_id: 'rel-new' }];
    }),
    kgProposal: {
      findUniqueOrThrow: jest.fn(async () => ({ id: P, ownerId: OWNER, kind: opts.kind ?? 'extraction', noteId: 'n', stats: {} })),
      update: jest.fn(async () => ({})),
    },
    kgProposalItem: { findMany: jest.fn(async () => rows), update: jest.fn(async () => ({})) },
    kgEvidence: {
      findMany: jest.fn(async ({ where }: Row) =>
        where.subjectKind === 'proposal_item' ? rows.map((r) => ({ ...cite, subjectId: r.id })) : [{ id: 'ev' }],
      ),
      groupBy: jest.fn(async ({ where }: Row) => where.OR.map((s: Row) => ({ ...s, _count: { _all: 1 } }))),
    },
    kgEntity: { findMany: jest.fn(async ({ where }: Row) => live.filter((e) => where.id.in.map((x: string) => x.toLowerCase()).includes(e.id.toLowerCase()))) },
    kgRelation: { findFirst: jest.fn(async () => null) },
    kgItem: { findFirst: jest.fn(async () => null) },
    kgMention: { findMany: jest.fn(async () => []), createManyAndReturn: jest.fn(async ({ data }: Row) => data.map((_: unknown, i: number) => ({ id: `m${i}` }))) },
  };
  const write = {
    createEntity: jest.fn(async (_t: unknown, input: Row) => { calls.push(`entity:${input.label}`); return { id: 'ent-new' }; }),
    createRelation: jest.fn(async (_t: unknown, input: Row) => { calls.push(`relation:${input.type}`); return { id: 'rel-new' }; }),
    createItem: jest.fn(async (_t: unknown, input: Row) => { calls.push(`item:${input.kind}`); return { id: 'item-new' }; }),
    closeRelation: jest.fn(async (_t: unknown, _o: string, relId: string) => { calls.push(`close:${relId}`); }),
    addEvidence: jest.fn(async (_t: unknown, _o: string, kind: string, subjectId: string, ev: unknown[]) => { calls.push(`evidence:${kind}:${subjectId}`); return ev.map((_, i) => ({ id: `ev${i}` })); }),
    updateItemState: jest.fn(),
  };
  const aliases = { recordLink: jest.fn(async () => 'alias-1') };
  const distinct = { record: jest.fn(async (_t: unknown, _o: string, a: string, b: string) => ({ aId: a, bId: b, created: true })) };
  const merges = {
    merge: jest.fn(async (input: Row, _tx?: unknown) => ({ merge: { id: `merge-${input.mergedId}`, survivorId: input.survivorId, mergedId: input.mergedId, createdAt: '' }, survivor: {} })),
    afterMerge: jest.fn(),
  };
  const service = new ProposalCommitService(
    {} as never,
    {} as never,
    {} as never,
    write as never,
    aliases as never,
    distinct as never,
    merges as never,
    { enqueue: jest.fn() } as never,
    { get: () => undefined } as never,
    { get: async () => ({}) } as never,
    {} as never,
  );
  return { service, tx, write, aliases, distinct, merges, calls };
}

describe('ProposalCommitService', () => {
  it('commits entities → relations → items → closings, whatever the row order', async () => {
    const { service, tx, calls, aliases } = setup(items());
    const outcome = await service.commitIn(tx as never, OWNER, P, schema);

    expect(calls).toEqual([
      'entity:Sarah Chen',
      `evidence:entity:${ACME}`,
      'relation:WORKS_FOR',
      'item:claim',
      `close:${OLD}`,
    ]);
    expect(aliases.recordLink).toHaveBeenCalledWith(tx, ACME, 'ACME Inc', 'extraction');
    expect(outcome.result).toEqual(
      expect.objectContaining({
        created: { entities: 1, relations: 1, items: 1 },
        linked: 1,
        closingsApplied: 1,
        skippedPending: 1,
        aliasesAdded: 1,
      }),
    );
    expect(outcome.log.closings).toEqual([expect.objectContaining({ relationId: OLD })]);
    const committed = tx.kgProposal.update.mock.calls[0][0].data;
    expect(committed).toEqual(expect.objectContaining({ status: 'committed', commitLog: outcome.log }));
    expect(committed.stats.commit).toEqual(outcome.result);
  });

  it('refuses a relation or item naming a pending or rejected entity row, writing nothing', async () => {
    const rows = items();
    rows.find((r) => r.id === id(1))!.decision = 'reject';
    const { service, tx, write } = setup(rows);
    const err = await service.commitIn(tx as never, OWNER, P, schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitRowError);
    const problems = (err as CommitRowError).rows;
    expect(problems.map((p) => p.itemId).sort()).toEqual([id(3), id(4)]);
    expect(problems.every((p) => p.issues.some((i) => i.code === 'endpoint_not_accepted'))).toBe(true);
    expect(write.createEntity).not.toHaveBeenCalled();
  });

  it('a merge_into row whose target was forgotten fails merge_target_gone', async () => {
    const rows = items().filter((r) => r.kind === 'entity');
    rows[0].decision = 'merge_into';
    rows[0].mergeIntoId = null;
    const { service, tx } = setup(rows);
    const err = await service.commitIn(tx as never, OWNER, P, schema).catch((e: unknown) => e);
    expect((err as CommitRowError).rows[0].issues[0].code).toBe('merge_target_gone');
  });

  it('a created row with no citation is a no-orphans violation, never a 400', async () => {
    const rows = items().filter((r) => r.kind === 'entity');
    const { service, tx } = setup(rows);
    tx.kgEvidence.findMany.mockImplementation(async () => []);
    await expect(service.commitIn(tx as never, OWNER, P, schema)).rejects.toThrow(/no-orphans invariant violated: entity/);
  });

  it('the in-transaction assertion refuses a written row that has no evidence', async () => {
    const rows = items().filter((r) => r.kind === 'entity');
    const { service, tx } = setup(rows);
    tx.kgEvidence.groupBy.mockImplementation(async () => []);
    await expect(service.commitIn(tx as never, OWNER, P, schema)).rejects.toThrow(/no-orphans invariant violated: entity/);
  });

  it('a resolution proposal dispatches merge_into / accepted suggestions to MergeService and rejects to a distinct pair', async () => {
    const base = { kind: 'entity', origin: 'ai', editedPayload: null, flags: [], distinctFrom: [], committedRefId: null };
    const rows = [
      { ...base, id: id(1), decision: 'merge_into', mergeIntoId: X2, sortOrder: 0, payload: { ref: 'x1', type: 'Person', label: 'A', existingEntityId: X1 }, resolution: { ref: X2 } },
      { ...base, id: id(2), decision: 'accept', mergeIntoId: null, sortOrder: 1, payload: { ref: 'x2', type: 'Organization', label: 'B', existingEntityId: ACME }, resolution: { ref: OLD } },
      { ...base, id: id(3), decision: 'reject', mergeIntoId: null, sortOrder: 2, payload: { ref: 'x3', type: 'Person', label: 'C', existingEntityId: X1 }, resolution: { ref: null, candidates: [{ entityId: X2 }] } },
    ];
    const { service, tx, merges, distinct } = setup(rows, {
      kind: 'resolution',
      liveEntities: [
        { id: X1, type: 'Person' },
        { id: X2, type: 'Person' },
        { id: ACME, type: 'Organization' },
        { id: OLD, type: 'Organization' },
      ],
    });
    const outcome = await service.commitIn(tx as never, OWNER, P, schema);
    expect(merges.merge.mock.calls.map((c) => [c[0].mergedId, c[0].survivorId, c[0].source])).toEqual([
      [X1, X2, 'resolution_proposal'],
      [ACME, OLD, 'resolution_proposal'],
    ]);
    expect(merges.merge.mock.calls[0][1]).toBe(tx);
    expect(distinct.record).toHaveBeenCalledWith(tx, OWNER, X1, X2);
    expect(outcome.log.merges).toHaveLength(2);
    expect(outcome.result.linked).toBe(2);
  });

  it('recognises a serialization failure in the shapes the driver reports', () => {
    expect(isSerializationFailure({ code: 'P2034' })).toBe(true);
    expect(isSerializationFailure({ message: 'could not serialize access due to concurrent update' })).toBe(true);
    expect(isSerializationFailure({ meta: { driverAdapterError: { cause: { originalCode: '40001' } } } })).toBe(true);
    expect(isSerializationFailure(new BadRequestException('x'))).toBe(false);
  });
});
