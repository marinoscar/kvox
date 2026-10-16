import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { ListCommitmentsTool } from './list-commitments.tool';

// =============================================================================
// `list_commitments` (#377): the owner-scoped where/order built from the
// arguments, defaults, party handles (unreadable parties hidden), evidence
// refs, truncation and a uuid-free result. Ordering against real rows is in
// test/ask/ask-tools.db.spec.ts.
// =============================================================================

const SARAH = uid(1);
const ACME = uid(2);
const C1 = uid(3);
const C2 = uid(4);

const party = (id: string, label: string, over: Record<string, unknown> = {}) => ({ id, label, reviewStatus: 'accepted', mergedIntoId: null, ...over });

function build(rows?: object[]) {
  const prisma = {
    kgItem: {
      findMany: jest.fn(async () =>
        rows ?? [
          {
            id: C1,
            title: null,
            statement: 'Send the signed contract',
            status: 'open',
            dueAt: new Date('2026-10-01T00:00:00Z'),
            occurredAt: new Date('2026-09-10T00:00:00Z'),
            ownerPerson: party(SARAH, 'Sarah'),
            counterparty: party(ACME, 'Acme'),
          },
          {
            id: C2,
            title: 'Intro',
            statement: 'Introduce Bob to the CFO',
            status: 'open',
            dueAt: null,
            occurredAt: null,
            ownerPerson: party(uid(9), 'Old Sarah', { reviewStatus: 'merged', mergedIntoId: SARAH }),
            counterparty: null,
          },
        ],
      ),
    },
    kgEvidence: {
      findMany: jest.fn(async () => [
        { id: uid(20), subjectId: C1 },
        { id: uid(21), subjectId: C1 },
        { id: uid(22), subjectId: C1 },
        { id: uid(23), subjectId: C2 },
      ]),
    },
  };
  return { tool: new ListCommitmentsTool(prisma as never), prisma };
}

const ORDER = [{ dueAt: { sort: 'asc', nulls: 'last' } }, { occurredAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];

describe('ListCommitmentsTool', () => {
  it('defaults to every open commitment of the owner', async () => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    await tool.run(ctx, tool.input.parse({ entity: null, direction: null, status: null, dueBefore: null, limit: null }));
    expect(prisma.kgItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: ctx.user.id, kind: 'commitment', reviewStatus: { in: ['accepted', 'edited'] }, status: 'open' },
        orderBy: ORDER,
        take: 16,
      }),
    );
  });

  it.each([
    ['owned_by', { ownerPersonId: SARAH }],
    ['owed_to', { counterpartyId: SARAH }],
    ['any', { OR: [{ ownerPersonId: SARAH }, { counterpartyId: SARAH }] }],
  ])('direction %s', async (direction, clause) => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, SARAH, 'Sarah');
    await tool.run(ctx, tool.input.parse({ entity: h, direction, status: 'any', dueBefore: '2026-10-01', limit: 5 }));
    const where = (prisma.kgItem.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject(clause);
    expect(where).not.toHaveProperty('status');
    expect(where.dueAt).toEqual({ lte: new Date('2026-10-01T23:59:59.999Z') });
  });

  it('maps rows to handles and hides unreadable parties', async () => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({}));
    expect(prisma.kgEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: ctx.user.id, subjectKind: 'item', subjectId: { in: [C1, C2] } } }),
    );
    expect(res.data).toEqual([
      {
        ref: 'itm1',
        statement: 'Send the signed contract',
        status: 'open',
        due: '2026-10-01',
        owner: { ref: 'ent1', label: 'Sarah' },
        counterparty: { ref: 'ent2', label: 'Acme' },
        madeOn: '2026-09-10',
        evidence: ['ev1', 'ev2'],
      },
      {
        ref: 'itm2',
        statement: 'Intro: Introduce Bob to the CFO',
        status: 'open',
        due: null,
        owner: null,
        counterparty: null,
        madeOn: null,
        evidence: ['ev3'],
      },
    ]);
    expect(res.summary).toBe('Listed 2 open commitments');
    expect(res.truncated).toBe(false);
    expectNoUuid(res.data);
  });

  it('flags truncation from the extra row', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ limit: 1 }));
    expect((res.data as unknown[]).length).toBe(1);
    expect(res.truncated).toBe(true);
    expect(res.summary).toBe('Listed 1 open commitment');
  });

  it('refuses an unknown entity handle and bad enums', async () => {
    const { tool, prisma } = build();
    await expect(tool.run(makeCtx(), tool.input.parse({ entity: 'ent3' }))).rejects.toThrow('Unknown entity reference ent3');
    expect(prisma.kgItem.findMany).not.toHaveBeenCalled();
    expect(tool.input.safeParse({ status: 'late' }).success).toBe(false);
    expect(tool.input.safeParse({ direction: 'sideways' }).success).toBe(false);
    expect(tool.input.safeParse({ dueBefore: 'next week' }).success).toBe(false);
  });
});
