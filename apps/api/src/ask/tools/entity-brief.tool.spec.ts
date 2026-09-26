import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { EntityBriefTool } from './entity-brief.tool';

// =============================================================================
// `entity_brief` (#377): read-only call options, the section/digest mapping,
// personal PersonFacts dropped, the stale-digest summary, uuid-free output.
// =============================================================================

const ACME = uid(1);
const SARAH = uid(2);
const EV = (n: number) => uid(100 + n);

const entry = (itemId: string, kind: string, statement: string, over: Record<string, unknown> = {}) => ({
  itemId,
  kind,
  title: null,
  statement,
  occurredAt: '2026-09-10T00:00:00.000Z',
  precision: 'day',
  status: 'open',
  dueAt: null,
  ownerPerson: null,
  counterparty: null,
  superseded: false,
  evidenceIds: [EV(1), EV(2), EV(3)],
  ...over,
});

const brief = (digestStale: boolean) => ({
  entity: { id: ACME, label: 'Acme', type: 'Organization' },
  window: { since: '2026-08-27T12:00:00.000Z', sinceSource: 'default', asOf: '2026-09-26T12:00:00.000Z', lastViewedAt: null },
  digest: { statements: [{ text: 'Acme is renewing.', evidenceIds: [EV(4)] }], coversUntil: '2026-09-01T00:00:00.000Z', generatedAt: '2026-09-02T00:00:00.000Z', model: 'gpt' },
  digestStale,
  digestPending: false,
  digestUnavailable: null,
  sections: {
    whatChanged: [entry(uid(10), 'decision', 'Renew for a year'), entry(uid(11), 'person_fact', 'Sarah is on leave')],
    decisions: [entry(uid(10), 'decision', 'Renew for a year', { title: 'Renewal' })],
    openCommitments: {
      theirs: [entry(uid(12), 'commitment', 'Send the contract', { dueAt: '2026-10-01T00:00:00.000Z' })],
      yours: [],
    },
    risksClaims: [entry(uid(13), 'claim', 'Budget is tight', { precision: 'month' })],
    peopleChanges: [
      {
        relationId: uid(20),
        type: 'HAS_ROLE',
        change: 'started',
        at: '2026-09-05T00:00:00.000Z',
        precision: 'day',
        person: { id: SARAH, label: 'Sarah', type: 'Person' },
        other: { id: ACME, label: 'Acme', type: 'Organization' },
        title: 'CTO',
        evidenceIds: [EV(5)],
      },
    ],
  },
  related: [{ kind: 'transcript', id: uid(50), title: 'Weekly', snippetHtml: null, startMs: null, score: 1, inGraph: true, occurredAt: null }],
});

function build(opts: { stale?: boolean; sensitivity?: string } = {}) {
  const service = { getBrief: jest.fn(async () => brief(opts.stale ?? false)) };
  const prisma = { kgItem: { findMany: jest.fn(async () => [{ id: uid(11), sensitivity: opts.sensitivity ?? 'personal' }]) } };
  return { tool: new EntityBriefTool(service as never, prisma as never), service, prisma };
}

describe('EntityBriefTool', () => {
  it('calls the brief read-only, with null → undefined', async () => {
    const { tool, service } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, ACME);
    await tool.run(ctx, tool.input.parse({ entity: h, since: null, asOf: null }));
    expect(service.getBrief).toHaveBeenCalledWith(ctx.user, ACME, { since: undefined, asOf: undefined, markViewed: false, enqueueStaleDigest: false });
    await tool.run(ctx, tool.input.parse({ entity: h, since: '2026-01-01', asOf: '2026-06-01' }));
    expect(service.getBrief).toHaveBeenLastCalledWith(ctx.user, ACME, { since: '2026-01-01', asOf: '2026-06-01', markViewed: false, enqueueStaleDigest: false });
  });

  it('maps sections and the digest to handles, dropping personal facts', async () => {
    const { tool } = build();
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, ACME, 'Acme') }));
    const data = res.data as Record<string, any>;
    expect(data.window).toEqual({ since: '2026-08-27', asOf: '2026-09-26' });
    expect(data.digest).toEqual([{ text: 'Acme is renewing.', evidence: ['ev1'] }]);
    expect(data.digestStale).toBe(false);
    expect(data.digestGeneratedAt).toBe('2026-09-02');
    expect(data.whatChanged).toEqual([
      { ref: 'itm1', kind: 'decision', text: 'Renew for a year', at: '2026-09-10', evidence: ['ev2', 'ev3'] },
    ]);
    expect(data.decisions[0]).toMatchObject({ ref: 'itm1', text: 'Renewal: Renew for a year' });
    expect(data.openCommitments.theirs[0]).toMatchObject({ ref: 'itm2', due: '2026-10-01' });
    expect(data.openCommitments.yours).toEqual([]);
    expect(data.risksClaims[0]).toMatchObject({ ref: 'itm3', precision: 'month' });
    expect(data.peopleChanges).toEqual([
      {
        ref: 'rel1',
        text: 'Sarah started HAS_ROLE (CTO) with Acme',
        person: { ref: 'ent2', label: 'Sarah' },
        other: { ref: 'ent1', label: 'Acme' },
        at: '2026-09-05',
        evidence: ['ev4'],
      },
    ]);
    expect(data).not.toHaveProperty('related');
    expect(JSON.stringify(data)).not.toContain('on leave');
    expect(res.summary).toBe('Brief for Acme · 1 changes, 1 decisions, 1 open commitments');
    expect(res.resultCount).toBe(5);
    expectNoUuid(res.data);
  });

  it('keeps a business PersonFact, and a personal one with the opt-in', async () => {
    const business = build({ sensitivity: 'business' });
    const ctx1 = makeCtx();
    const r1 = await business.tool.run(ctx1, business.tool.input.parse({ entity: seedEntity(ctx1, ACME) }));
    expect(JSON.stringify(r1.data)).toContain('on leave');

    const personal = build();
    const ctx2 = makeCtx({ personalFactsAllowed: true });
    const r2 = await personal.tool.run(ctx2, personal.tool.input.parse({ entity: seedEntity(ctx2, ACME) }));
    expect(JSON.stringify(r2.data)).toContain('on leave');
  });

  it('says when the stored digest may be out of date', async () => {
    const { tool } = build({ stale: true });
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, ACME) }));
    expect((res.data as { digestStale: boolean }).digestStale).toBe(true);
    expect(res.summary).toMatch(/summary may be out of date$/);
  });
});
