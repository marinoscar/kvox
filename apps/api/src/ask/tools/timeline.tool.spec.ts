import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { TimelineTool } from './timeline.tool';

// =============================================================================
// `timeline` (#377): never includeSensitive, null → defaults, personal facts
// dropped, superseded flagged, ≤ 2 evidence quotes per event, uuid-free.
// =============================================================================

const SARAH = uid(1);
const ACME = uid(2);
const DECISION = uid(3);
const FACT = uid(4);
const REL = uid(5);
const MEETING = uid(6);
const EV = [uid(20), uid(21), uid(22)];

const ref = (id: string, label: string, type: string) => ({ id, label, type });

const events = [
  {
    id: DECISION,
    eventKind: 'item',
    at: '2026-08-01T00:00:00.000Z',
    precision: 'day',
    item: {
      id: DECISION,
      kind: 'decision',
      title: 'Go with Acme',
      statement: 'We will sign with Acme for the pilot.',
      status: 'active',
      dueAt: null,
      ownerPerson: null,
      counterparty: null,
      sensitivity: null,
      superseded: true,
      supersededById: uid(30),
    },
    evidenceIds: EV,
    evidenceCount: 3,
  },
  {
    id: FACT,
    eventKind: 'item',
    at: '2026-07-01T00:00:00.000Z',
    precision: 'day',
    item: { id: FACT, kind: 'person_fact', title: null, statement: 'Moving house', status: 'active', dueAt: null, ownerPerson: null, counterparty: null, sensitivity: 'personal', superseded: false, supersededById: null },
    evidenceIds: [],
    evidenceCount: 0,
  },
  {
    id: `rel:${REL}:start`,
    eventKind: 'relation_started',
    at: '2019-03-01T00:00:00.000Z',
    precision: 'month',
    relation: { id: REL, type: 'WORKS_AT', direction: 'out', other: ref(ACME, 'Acme', 'Organization'), valid: null },
    evidenceIds: [],
    evidenceCount: 0,
  },
  {
    id: MEETING,
    eventKind: 'meeting',
    at: null,
    precision: 'unknown',
    meeting: ref(MEETING, 'Kickoff', 'Meeting'),
    evidenceIds: [],
    evidenceCount: 0,
  },
];

function build(nextCursor: string | null = 'next') {
  const graphRead = { timeline: jest.fn(async () => ({ items: events, nextCursor, asOf: '2026-09-26T12:00:00.000Z' })) };
  const prisma = {
    kgEvidence: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, quote: `quote for ${id.slice(-2)} ${'q'.repeat(400)}` })),
      ),
    },
  };
  return { tool: new TimelineTool(graphRead as never, prisma as never), graphRead, prisma };
}

describe('TimelineTool', () => {
  it('never asks for sensitive facts and maps null to defaults', async () => {
    const { tool, graphRead } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, SARAH, 'Sarah');
    await tool.run(ctx, tool.input.parse({ entity: h, asOf: null, kinds: null, limit: null }));
    expect(graphRead.timeline).toHaveBeenCalledWith(ctx.user, SARAH, { as_of: undefined, kinds: undefined, includeSensitive: false, limit: 15 });
  });

  it('passes kinds as CSV and caps the limit at 25', async () => {
    const { tool, graphRead } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, SARAH);
    await tool.run(ctx, tool.input.parse({ entity: h, kinds: ['decision', 'meeting'], asOf: '2026-01-01', limit: 25 }));
    expect(graphRead.timeline).toHaveBeenCalledWith(ctx.user, SARAH, { as_of: '2026-01-01', kinds: 'decision,meeting', includeSensitive: false, limit: 25 });
    expect(tool.input.safeParse({ entity: h, limit: 26 }).success).toBe(false);
  });

  it('shapes events, drops personal facts, flags superseded, keeps two quotes', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, SARAH, 'Sarah');
    const res = await tool.run(ctx, tool.input.parse({ entity: h }));
    const data = res.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      ref: 'itm1',
      event: 'decision',
      text: 'Go with Acme: We will sign with Acme for the pilot.',
      status: 'active',
      superseded: true,
      at: '2026-08-01',
    });
    expect(data[0]).not.toHaveProperty('precision');
    const evidence = data[0].evidence as Array<{ ref: string; quote: string }>;
    expect(evidence.map((e) => e.ref)).toEqual(['ev1', 'ev2']);
    expect(evidence[0].quote.length).toBeLessThanOrEqual(300);
    expect(data[1]).toMatchObject({
      ref: 'rel1',
      event: 'relation_started',
      text: 'WORKS_AT → Acme (Organization) started',
      other: { ref: 'ent2', label: 'Acme' },
      at: '2019-03-01',
      precision: 'month',
    });
    expect(data[2]).toMatchObject({ ref: 'ent3', event: 'meeting', text: 'Kickoff', at: null, precision: 'unknown' });
    expect(JSON.stringify(data)).not.toContain('Moving house');
    expect(res.truncated).toBe(true);
    expect(res.summary).toBe('Timeline of Sarah · 3 events');
    expectNoUuid(res.data);
  });

  it('keeps personal facts with the opt-in', async () => {
    const { tool } = build(null);
    const ctx = makeCtx({ personalFactsAllowed: true });
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, SARAH) }));
    expect(JSON.stringify(res.data)).toContain('Moving house');
    expect(res.truncated).toBe(false);
  });
});
