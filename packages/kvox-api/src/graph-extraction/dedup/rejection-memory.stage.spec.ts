import { ProposalStageRegistry } from '../extraction/proposal-stage.js';
import { FakeProposalDb, NOTE, OWNER, entityPayload, linked } from '../__fixtures__/dedup-fakes.js';
import { RejectionMemoryStage } from './rejection-memory.stage.js';

const JOE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACME = 'aaaaaaaa-0000-4000-8000-000000000002';
const OLD = 'eeeeeeee-0000-4000-8000-000000000001';

function fact(ref: string, hash: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    kind: 'person_fact',
    title: 'Fact',
    statement: `statement ${hash}`,
    subject: { ref: 'e1' },
    owner: null,
    counterparty: null,
    meeting: null,
    status: null,
    occurredAt: null,
    dueAt: null,
    sensitivity: 'personal',
    statementHash: hash,
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...over,
  };
}

function build() {
  const db = new FakeProposalDb();
  db.add('entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(JOE) });
  const registry = new ProposalStageRegistry();
  const stage = new RejectionMemoryStage(registry);
  stage.onModuleInit();
  return { db, stage, registry };
}

describe('rejection-memory stage', () => {
  it('registers at order 400', () => {
    expect(build().registry.ordered().map((s) => [s.name, s.order])).toEqual([['rejection-memory', 400]]);
  });

  it('removes a person fact the owner rejected in any committed proposal, evidence and all', async () => {
    const { db, stage } = build();
    const rejected = db.add('item', fact('p1', 'h-rejected'));
    db.cite(rejected, 'Joe has a new hobby');
    db.add('item', fact('p2', 'h-fresh'));
    db.rejectedPersonFactHashes = ['h-rejected'];
    const ctx = db.ctx();
    await stage.run(ctx);

    expect(db.rows.map((r) => r.payload.ref)).toEqual(['e1', 'p2']);
    expect(db.evidence).toEqual([]);
    expect(ctx.stats).toMatchObject({ suppressedPersonFacts: 1, previouslyRejected: 0 });
    // Owner-scoped, committed proposals only, this proposal excluded.
    const sql = (db.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]);
    const text = sql[0].join('?');
    expect(text).toContain("p.status = 'committed'");
    expect(text).toContain("pi.decision = 'reject'");
    expect(sql.slice(1)).toContain(OWNER);
  });

  it('a person fact known to the graph is never suppressed', async () => {
    const { db, stage } = build();
    db.add('item', fact('p1', 'h-rejected'), { flags: ['known'] });
    db.rejectedPersonFactHashes = ['h-rejected'];
    await stage.run(db.ctx());
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.byRef('p1')).toBeDefined();
  });

  it('flags a row rejected before in a committed proposal for the same note, and defaults it to reject', async () => {
    const { db, stage } = build();
    db.add('relation', { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { entityId: ACME }, props: {}, validFrom: null, validTo: null, precision: 'unknown' });
    db.add('item', { ...fact('c1', 'h-claim'), kind: 'claim' });
    db.add('item', { ...fact('c2', 'h-other'), kind: 'claim' });
    // The earlier proposal's own entity row became JOE (committed), and it
    // rejected the WORKS_FOR and the claim.
    db.pastRows = [
      { proposalId: OLD, kind: 'entity', payload: entityPayload('x7', 'Person', 'Joseph'), resolution: linked(null), committedRefId: JOE, mergeIntoId: null },
      { proposalId: OLD, kind: 'relation', payload: { ref: 'r9', type: 'WORKS_FOR', from: { ref: 'x7' }, to: { entityId: ACME }, props: {} }, resolution: null, committedRefId: null, mergeIntoId: null },
      { proposalId: OLD, kind: 'item', payload: { kind: 'claim', subject: { entityId: JOE }, statementHash: 'h-claim' }, resolution: null, committedRefId: null, mergeIntoId: null },
    ];
    const ctx = db.ctx();
    await stage.run(ctx);

    expect(db.byRef('r1')).toMatchObject({ flags: ['previously_rejected'], decision: 'reject' });
    expect(db.byRef('c1')).toMatchObject({ flags: ['previously_rejected'], decision: 'reject' });
    expect(db.byRef('c2')).toMatchObject({ flags: [], decision: 'pending' });
    expect(ctx.stats).toMatchObject({ previouslyRejected: 2 });

    // Same note, committed, owner-scoped, never this proposal.
    const where = (db.kgProposalItem.findMany.mock.calls.at(-1)![0] as { where: { proposal: unknown } }).where;
    expect(where.proposal).toEqual({ ownerId: OWNER, noteId: NOTE, status: 'committed', id: { not: expect.any(String) } });
  });

  it('covers the stakeholder relations and a Risk: a rejected stance, and a rejected risk, come back flagged (#665)', async () => {
    const { db, stage } = build();
    const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000003';
    const rel = (ref: string, props: Record<string, unknown>) => ({
      ref,
      type: 'INVOLVED_IN',
      from: { ref: 'e1' },
      to: { entityId: PROJECT },
      props,
      validFrom: null,
      validTo: null,
      precision: 'unknown',
    });
    db.add('relation', rel('r1', { role: 'stakeholder', stance: 'skeptical' }));
    db.add('relation', rel('r2', { role: 'stakeholder', stance: 'supportive' }));
    db.add('item', { ...fact('k1', 'h-risk'), kind: 'risk', subject: { entityId: PROJECT }, status: 'open', props: { riskKind: 'blocker' } });
    db.pastRows = [
      { proposalId: OLD, kind: 'entity', payload: entityPayload('x7', 'Person', 'Joe'), resolution: linked(null), committedRefId: JOE, mergeIntoId: null },
      // The reviewer said no to Joe being skeptical, and to the risk.
      { proposalId: OLD, kind: 'relation', payload: { ref: 'r9', type: 'INVOLVED_IN', from: { ref: 'x7' }, to: { entityId: PROJECT }, props: { role: 'stakeholder', stance: 'skeptical' } }, resolution: null, committedRefId: null, mergeIntoId: null },
      { proposalId: OLD, kind: 'item', payload: { kind: 'risk', subject: { entityId: PROJECT }, statementHash: 'h-risk' }, resolution: null, committedRefId: null, mergeIntoId: null },
    ];
    await stage.run(db.ctx());

    expect(db.byRef('r1')).toMatchObject({ flags: ['previously_rejected'], decision: 'reject' });
    // A different stance is a different claim: a rejected "skeptical" never shadows "supportive".
    expect(db.byRef('r2')).toMatchObject({ flags: [], decision: 'pending' });
    expect(db.byRef('k1')).toMatchObject({ flags: ['previously_rejected'], decision: 'reject' });
  });

  it('a discarded proposal’s rejections are never remembered (only committed ones are queried)', async () => {
    const { db, stage } = build();
    db.add('item', { ...fact('c1', 'h-claim'), kind: 'claim' });
    db.pastRows = []; // what the committed-only query returns when the reject lives in a discarded proposal
    await stage.run(db.ctx());
    expect(db.byRef('c1').flags).toEqual([]);
  });
});
