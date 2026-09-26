import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { computeEffectiveSchema } from '@app/shared/ontology';

import { nextUserRef, ProposalsService } from './proposals.service';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const OWNER = '0a000000-0000-4000-8000-000000000001';
const P = '0b000000-0000-4000-8000-000000000001';
const SARAH = '0f000000-0000-4000-8000-000000000001';
const ACME = '0f000000-0000-4000-8000-000000000002';
const JOE = '0f000000-0000-4000-8000-000000000003';

const user = { id: OWNER, email: 'o@example.test', roles: [], permissions: ['graph:read', 'graph:write'], isActive: true };

type Row = Record<string, any>;

function item(id: string, over: Row): Row {
  return {
    id,
    kind: 'entity',
    origin: 'ai',
    decision: 'pending',
    payload: {},
    editedPayload: null,
    resolution: null,
    mergeIntoId: null,
    distinctFrom: [],
    flags: [],
    committedRefId: null,
    sortOrder: 0,
    ...over,
  };
}

const E1 = 'e0000000-0000-4000-8000-000000000001';
const E2 = 'e0000000-0000-4000-8000-000000000002';
const R1 = 'e0000000-0000-4000-8000-000000000003';
const PF = 'e0000000-0000-4000-8000-000000000004';
const C1 = 'e0000000-0000-4000-8000-000000000005';

function baseItems(): Row[] {
  return [
    item(E1, {
      decision: 'accept',
      payload: { ref: 'e1', type: 'Person', label: 'Sarah Chen', aliases: [], props: {}, occurredAt: null },
      resolution: {
        ref: SARAH,
        score: 0.9,
        source: 'alias',
        candidates: [
          { entityId: SARAH, label: 'Sarah Chen', type: 'Person', score: 0.9, signals: [] },
          { entityId: JOE, label: 'Sarah C', type: 'Person', score: 0.5, signals: [] },
        ],
        adjudication: null,
      },
    }),
    item(E2, { decision: 'reject', payload: { ref: 'e2', type: 'Organization', label: 'Acme', aliases: [], props: {}, occurredAt: null } }),
    item(R1, {
      kind: 'relation',
      decision: 'accept',
      payload: { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { entityId: ACME }, props: {}, validFrom: null, validTo: null, precision: 'unknown' },
    }),
    item(PF, {
      kind: 'item',
      payload: {
        ref: 'k1', kind: 'person_fact', title: 'Health', statement: 'Sarah has a condition', subject: { ref: 'e1' }, owner: null,
        counterparty: null, meeting: null, status: null, occurredAt: null, dueAt: null, sensitivity: 'sensitive', statementHash: 'h',
        props: {}, validFrom: null, validTo: null, precision: 'unknown',
      },
    }),
    item(C1, { kind: 'closing', payload: { relationId: ACME } }),
  ];
}

function setup(opts: { status?: string; items?: Row[]; evidence?: string[]; entities?: Row[] } = {}) {
  const items = opts.items ?? baseItems();
  const entities = opts.entities ?? [
    { id: SARAH, type: 'Person', ownerId: OWNER },
    { id: ACME, type: 'Organization', ownerId: OWNER },
    { id: JOE, type: 'Person', ownerId: OWNER },
  ];
  const tx: Row = {
    $queryRaw: jest.fn(async () => [{ status: opts.status ?? 'draft' }]),
    kgProposalItem: {
      findMany: jest.fn(async ({ where }: Row) => items.filter((i) => !where.id?.in || where.id.in.includes(i.id))),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async ({ where }: Row) => ({ count: where.id.in.length })),
      create: jest.fn(async () => ({ id: 'e0000000-0000-4000-8000-0000000000ff' })),
    },
    kgEntity: {
      findFirst: jest.fn(async ({ where }: Row) => entities.find((e) => e.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: Row) => entities.filter((e) => where.id.in.includes(e.id))),
      count: jest.fn(async ({ where }: Row) => entities.filter((e) => where.id.in.includes(e.id)).length),
    },
    kgEvidence: {
      findMany: jest.fn(async () => (opts.evidence ?? ['e1ev']).map((id) => ({ id }))),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const prisma: Row = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    kgProposal: { findUniqueOrThrow: jest.fn(async () => ({ id: P, ownerId: OWNER })) },
  };
  const access = { require: jest.fn(async () => ({ id: P, ownerId: OWNER, noteId: 'n', status: 'draft' })) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schema) };
  const spans = { validate: jest.fn(async (_tx: unknown, _s: unknown, list: unknown[]) => list.map(() => ({ quote: 'q' }))) };
  const service = new ProposalsService(prisma as never, access as never, {} as never, ontology as never, spans as never);
  jest.spyOn(service, 'detail').mockImplementation(async () => ({
    proposal: { counts: { total: items.length } } as never,
    items: items.map((i) => ({ id: i.id }) as never).concat([{ id: 'e0000000-0000-4000-8000-0000000000ff' } as never]),
    context: null,
  }));
  const updateData = () => tx.kgProposalItem.update.mock.calls[0][0].data as Row;
  return { service, tx, prisma, spans, updateData };
}

const reason = (e: unknown) => ((e as BadRequestException).getResponse() as Row).details?.reason;
const issues = (e: unknown) => ((e as BadRequestException).getResponse() as Row).details?.issues as Row[];

describe('ProposalsService — decisions', () => {
  it('edit changing an entity type clears the link, keeps candidates of the new type, flags type_changed', async () => {
    const { service, updateData } = setup();
    await service.decide(user, P, E1, {
      decision: 'edit',
      editedPayload: { ref: 'ignored', type: 'Organization', label: 'Sarah Chen Ltd', aliases: [], props: {}, occurredAt: null },
    });
    const data = updateData();
    expect(data.decision).toBe('edit');
    expect(data.editedPayload).toEqual(expect.objectContaining({ ref: 'e1', type: 'Organization' }));
    expect(data.resolution).toEqual(expect.objectContaining({ ref: null, candidates: [] }));
    expect(data.flags).toContain('type_changed');
    expect(data.mergeIntoId).toBeNull();
  });

  it('edit with an undeclared prop is 400 with issues (closed props)', async () => {
    const { service } = setup();
    const err = await service
      .decide(user, P, E1, { decision: 'edit', editedPayload: { type: 'Person', label: 'Sarah', props: { shoeSize: 42 } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(issues(err)[0].path).toMatch(/^props/);
  });

  it('edit to a type not in the effective schema is 400', async () => {
    const { service } = setup();
    const err = await service
      .decide(user, P, E1, { decision: 'edit', editedPayload: { type: 'Spaceship', label: 'X' } })
      .catch((e: unknown) => e);
    expect(issues(err)).toEqual([expect.objectContaining({ path: 'type' })]);
  });

  it.each([
    ['edit without editedPayload', { decision: 'edit' }],
    ['editedPayload with accept', { decision: 'accept', editedPayload: {} }],
    ['merge_into without mergeIntoId', { decision: 'merge_into' }],
  ])('%s is 400 before any write', async (_n, dto) => {
    const { service, prisma } = setup();
    await expect(service.decide(user, P, E1, dto as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a proposal that is not a draft is 409 proposal_not_draft', async () => {
    const { service } = setup({ status: 'committed' });
    const err = await service.decide(user, P, E1, { decision: 'accept' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(reason(err)).toBe('proposal_not_draft');
  });

  it('an unknown item is 404', async () => {
    const { service } = setup();
    await expect(service.decide(user, P, 'e0000000-0000-4000-8000-000000000099', { decision: 'accept' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('merge_into: the target must be a live entity of the same type', async () => {
    const { service, updateData } = setup();
    const wrong = await service.decide(user, P, E1, { decision: 'merge_into', mergeIntoId: ACME }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(BadRequestException);
    await expect(
      service.decide(user, P, E1, { decision: 'merge_into', mergeIntoId: 'e0000000-0000-4000-8000-000000000077' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await service.decide(user, P, E1, { decision: 'merge_into', mergeIntoId: JOE });
    expect(updateData()).toEqual(expect.objectContaining({ decision: 'merge_into', mergeIntoId: JOE }));
  });

  it('merge_into on a relation row is 400', async () => {
    const { service } = setup();
    await expect(service.decide(user, P, R1, { decision: 'merge_into', mergeIntoId: JOE })).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('relinkTo', () => {
    it('re-points an endpoint into editedPayload', async () => {
      const { service, updateData } = setup();
      await service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'from', target: { entityId: SARAH } } });
      expect(updateData().editedPayload).toEqual(expect.objectContaining({ from: { entityId: SARAH }, to: { entityId: ACME } }));
    });

    it('refuses a rejected proposal ref', async () => {
      const { service } = setup({
        items: [
          ...baseItems().slice(0, 2),
          item(R1, { kind: 'relation', payload: { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { entityId: ACME }, props: {}, validFrom: null, validTo: null, precision: 'unknown' } }),
        ],
      });
      const err = await service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'to', target: { ref: 'e2' } } }).catch((e: unknown) => e);
      expect(issues(err)).toEqual([expect.objectContaining({ path: 'to', code: 'endpoint_not_accepted' })]);
    });

    it('refuses an endpoint of the wrong type', async () => {
      const { service } = setup();
      const err = await service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'to', target: { entityId: JOE } } }).catch((e: unknown) => e);
      expect(issues(err)).toEqual([expect.objectContaining({ path: 'to' })]);
    });

    it('refuses a field the row does not have, a null subject, and an entity that is not yours', async () => {
      const { service } = setup();
      await expect(service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'subject', target: { entityId: SARAH } } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'from', target: null } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.decide(user, P, R1, { decision: 'accept', relinkTo: { field: 'from', target: { entityId: 'e0000000-0000-4000-8000-000000000066' } } }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('distinctFrom removes the candidate and clears a ref pointing at it', async () => {
    const { service, updateData } = setup();
    await service.decide(user, P, E1, { decision: 'accept', distinctFrom: [SARAH] });
    const data = updateData();
    expect(data.distinctFrom).toEqual([SARAH]);
    expect(data.resolution).toEqual(expect.objectContaining({ ref: null }));
    expect(data.resolution.candidates.map((c: Row) => c.entityId)).toEqual([JOE]);
  });

  it('removing the last citation is 400 would_orphan', async () => {
    const { service, tx } = setup({ evidence: ['e0000000-0000-4000-8000-0000000000e1'] });
    const err = await service
      .decide(user, P, E1, { decision: 'accept', evidence: { add: [], remove: ['e0000000-0000-4000-8000-0000000000e1'] } })
      .catch((e: unknown) => e);
    expect(reason(err)).toBe('would_orphan');
    expect(tx.kgEvidence.deleteMany).not.toHaveBeenCalled();
  });

  it('removing a citation that is not the row\'s is 404; replacing one is fine', async () => {
    const { service, tx, spans } = setup({ evidence: ['e0000000-0000-4000-8000-0000000000e1'] });
    await expect(
      service.decide(user, P, E1, { decision: 'accept', evidence: { add: [], remove: ['e0000000-0000-4000-8000-0000000000e2'] } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await service.decide(user, P, E1, {
      decision: 'accept',
      evidence: { add: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }], remove: ['e0000000-0000-4000-8000-0000000000e1'] },
    });
    expect(spans.validate).toHaveBeenCalled();
    expect(tx.kgEvidence.createMany).toHaveBeenCalled();
    expect(tx.kgEvidence.deleteMany).toHaveBeenCalled();
  });

  it('a closing can only be accepted, rejected or left pending', async () => {
    const { service } = setup();
    await expect(service.decide(user, P, C1, { decision: 'edit', editedPayload: {} })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProposalsService — bulk', () => {
  it('never bulk-accepts a sensitive person fact or a closing; names unknown ids', async () => {
    const { service, tx } = setup();
    const missing = 'e0000000-0000-4000-8000-000000000055';
    const res = await service.bulk(user, P, { itemIds: [E1, PF, C1, missing], decision: 'accept' });
    expect(res.updated).toBe(1);
    expect(res.skipped).toEqual([
      { itemId: PF, reason: 'sensitive_requires_individual_accept' },
      { itemId: C1, reason: 'closing_requires_individual_accept' },
      { itemId: missing, reason: 'not_found' },
    ]);
    expect(tx.kgProposalItem.updateMany).toHaveBeenCalledWith({ where: { proposalId: P, id: { in: [E1] } }, data: { decision: 'accept', mergeIntoId: null } });
  });

  it('rejecting in bulk includes them', async () => {
    const { service } = setup();
    const res = await service.bulk(user, P, { itemIds: [PF, C1], decision: 'reject' });
    expect(res).toEqual(expect.objectContaining({ updated: 2, skipped: [] }));
  });
});

describe('ProposalsService — add from span', () => {
  it('assigns the next user ref', () => {
    expect(nextUserRef([])).toBe('u1');
    expect(nextUserRef([{ payload: { ref: 'u1' } }, { payload: { ref: 'u7' } }, { payload: { ref: 'e3' } }])).toBe('u8');
  });

  it('adds an accepted user row with server ref and evidence', async () => {
    const { service, tx } = setup();
    await service.addItem(user, P, {
      kind: 'relation',
      payload: { ref: 'mine', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { entityId: ACME }, validFrom: null, validTo: null, precision: 'unknown' },
      evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }],
    });
    const data = tx.kgProposalItem.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({ kind: 'relation', decision: 'accept', origin: 'user', sortOrder: 1 }));
    expect(data.payload.ref).toBe('u1');
    expect(tx.kgEvidence.createMany.mock.calls[0][0].data[0]).toEqual(expect.objectContaining({ subjectKind: 'proposal_item', ownerId: OWNER }));
  });

  it('existingEntityId → merge_into; a different type is 400; not on a relation', async () => {
    const { service, tx } = setup();
    await service.addItem(user, P, {
      kind: 'entity',
      payload: { type: 'Person', label: 'S. Chen' },
      existingEntityId: SARAH,
      evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }],
    });
    expect(tx.kgProposalItem.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ decision: 'merge_into', mergeIntoId: SARAH }));
    await expect(
      service.addItem(user, P, { kind: 'entity', payload: { type: 'Person', label: 'X' }, existingEntityId: ACME, evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.addItem(user, P, { kind: 'relation', payload: {}, existingEntityId: ACME, evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an item payload gets its statement hash computed, never trusted', async () => {
    const { service, tx } = setup();
    await service.addItem(user, P, {
      kind: 'item',
      payload: {
        kind: 'claim', title: 'Budget', statement: 'The budget was cut.', subject: { entityId: ACME }, owner: null, counterparty: null,
        meeting: null, status: null, occurredAt: null, dueAt: null, sensitivity: null, statementHash: 'forged', props: {},
        validFrom: null, validTo: null, precision: 'unknown',
      },
      evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 2, quote: 'ab' }],
    });
    expect(tx.kgProposalItem.create.mock.calls[0][0].data.payload.statementHash).not.toBe('forged');
  });
});
