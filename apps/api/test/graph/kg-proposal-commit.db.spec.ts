// =============================================================================
// Real-Postgres test: committing a graph proposal (issue #366)
// =============================================================================
//
// What only a real database can show: the whole commit in one Serializable
// transaction — entities linked and created, a relation, items per #365's
// commit semantics (`known`, `same` with a due-date change), a closing that
// rewrites a `tstzrange` — and afterwards NO accepted/edited row without
// evidence. The no-orphans violation (a proposal row whose citations were
// deleted) is a full rollback, and two concurrent commits give one success
// and one `proposal_not_draft`.
// =============================================================================

import { ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { resolveDbSuite } from '../jobs/db-test-support';
import { buildServices, cleanup, orphans, seedFixture, snapshot } from './kg-proposal-db-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-proposal-commit.db.spec');
const PREFIX = 'kg-proposal-commit-test';

describeWithDb('graph proposal commit (real Postgres)', () => {
  let prisma: PrismaClient;
  let services: ReturnType<typeof buildServices>;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...env } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
    await prisma.$connect();
    services = buildServices(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanup(prisma, PREFIX, services.purge);
  });

  it('commits every branch in one transaction, and leaves no orphan', async () => {
    const f = await seedFixture(prisma, PREFIX);
    const { proposal, result } = await services.commits.commit(f.caller, f.proposal.id);

    expect(proposal.status).toBe('committed');
    expect(proposal.committedAt).not.toBeNull();
    expect(result).toEqual({
      created: { entities: 2, relations: 1, items: 1 },
      linked: 1,
      evidenceAdded: expect.any(Number),
      closingsApplied: 1,
      closingsSkipped: 0,
      superseded: 0,
      aliasesAdded: 1,
      distinctPairsRecorded: 0,
      skippedPending: 1,
    });
    // 4 created rows' own citations + e1's link + the known claim + the same commitment.
    expect(result.evidenceAdded).toBe(7);

    // Every accepted/edited row of the owner carries evidence.
    expect(await orphans(prisma, f.ownerId)).toEqual([]);

    // The linked entity learned the proposed label; the pending Project was not created.
    const aliases = await prisma.kgEntityAlias.findMany({ where: { entityId: f.existing.sarah }, select: { alias: true } });
    expect(aliases.map((a) => a.alias).sort()).toEqual(['S. Chen', 'Sarah Chen']);
    expect(await prisma.kgEntity.count({ where: { ownerId: f.ownerId, type: 'Project' } })).toBe(0);

    // Items per #365: the new commitment names its owner and meeting columns; `known` only cites.
    const items = await prisma.kgProposalItem.findMany({ where: { proposalId: f.proposal.id } });
    const ref = (key: string) => items.find((i) => i.id === f.itemIds[key])!.committedRefId;
    expect(ref('e1')).toBe(f.existing.sarah);
    expect(ref('i2')).toBe(f.existing.claim);
    expect(ref('i3')).toBe(f.existing.commitment);
    expect(ref('e3')).toBeNull();
    const created = await prisma.kgItem.findUniqueOrThrow({ where: { id: ref('i1')! } });
    expect(created).toEqual(expect.objectContaining({ kind: 'commitment', ownerPersonId: f.existing.sarah, meetingId: ref('meeting'), status: 'open' }));
    expect(await prisma.kgEvidence.count({ where: { subjectKind: 'item', subjectId: f.existing.claim } })).toBe(2);

    // `same` applied the due-date change.
    const commitment = await prisma.kgItem.findUniqueOrThrow({ where: { id: f.existing.commitment } });
    expect(commitment.dueAt?.toISOString()).toBe('2026-03-13T00:00:00.000Z');

    // The new edge is a continuing state; the old one closed at March 2026 and points at it.
    const [edge] = await prisma.$queryRaw<Array<{ valid: string; valid_precision: string }>>`
      SELECT valid::text AS valid, valid_precision::text AS valid_precision FROM kg_relations WHERE id = ${ref('r1')}::uuid`;
    expect(edge.valid_precision).toBe('month');
    expect(edge.valid).toMatch(/^\["2026-03-01 00:00:00\+00",\)$/);
    const [old] = await prisma.$queryRaw<Array<{ valid: string; superseded_by_id: string }>>`
      SELECT valid::text AS valid, superseded_by_id::text AS superseded_by_id FROM kg_relations WHERE id = ${f.existing.oldEdge}::uuid`;
    expect(old.valid).toBe('["2019-01-01 00:00:00+00","2026-03-01 00:00:00+00")');
    expect(old.superseded_by_id).toBe(ref('r1'));

    // Mentions for every entity touched, and the commit log for the revert.
    expect(await prisma.kgMention.count({ where: { noteId: f.note.id } })).toBe(3);
    const row = await prisma.kgProposal.findUniqueOrThrow({ where: { id: f.proposal.id } });
    const log = row.commitLog as Record<string, any>;
    expect(log.created.entities).toHaveLength(2);
    expect(log.closings).toEqual([expect.objectContaining({ relationId: f.existing.oldEdge })]);
    expect(log.itemChanges).toEqual([expect.objectContaining({ itemId: f.existing.commitment })]);
    expect((row.stats as Record<string, unknown>).commit).toEqual(result);

    // The detail view reflects the commit.
    const detail = await services.proposals.get(f.caller, f.proposal.id, false);
    expect(detail.proposal.status).toBe('committed');
    expect(detail.items.find((i) => i.id === f.itemIds.e2)?.committedRefId).toBe(ref('e2'));
  });

  it('refuses a relation whose entity row is still pending, writing nothing', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await prisma.kgProposalItem.update({ where: { id: f.itemIds.e2 }, data: { decision: 'pending' } });
    const before = await snapshot(prisma, f.ownerId);

    const err = await services.commits.commit(f.caller, f.proposal.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const details = (err as BadRequestException).getResponse() as { details: { items: Array<{ itemId: string; issues: Array<{ code?: string }> }> } };
    expect(details.details.items).toEqual([
      { itemId: f.itemIds.r1, issues: [expect.objectContaining({ code: 'endpoint_not_accepted' })] },
    ]);
    expect(await snapshot(prisma, f.ownerId)).toEqual(before);
    expect((await prisma.kgProposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).status).toBe('draft');
  });

  it('a row whose evidence was deleted violates no-orphans: 500 and a full rollback', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await prisma.kgEvidence.deleteMany({ where: { subjectKind: 'proposal_item', subjectId: f.itemIds.i1 } });
    const before = await snapshot(prisma, f.ownerId);

    const err = await services.commits.commit(f.caller, f.proposal.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { getStatus?: unknown }).getStatus).toBeUndefined(); // not an HttpException → 500
    expect((err as Error).message).toMatch(/no-orphans invariant violated: item/);

    expect(await snapshot(prisma, f.ownerId)).toEqual(before);
    const row = await prisma.kgProposal.findUniqueOrThrow({ where: { id: f.proposal.id } });
    expect(row.status).toBe('draft');
    expect(row.commitLog).toBeNull();
  });

  it('two concurrent commits: one succeeds, one answers proposal_not_draft', async () => {
    const f = await seedFixture(prisma, PREFIX);
    const outcomes = await Promise.allSettled([
      services.commits.commit(f.caller, f.proposal.id),
      services.commits.commit(f.caller, f.proposal.id),
    ]);
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect(((failed[0].reason as ConflictException).getResponse() as { details: { reason: string } }).details.reason).toBe('proposal_not_draft');
    expect(await prisma.kgEntity.count({ where: { ownerId: f.ownerId, type: 'Organization', label: 'Northwind Robotics' } })).toBe(1);
  });

  it('add-from-span: validated spans become evidence, and the added row commits', async () => {
    const f = await seedFixture(prisma, PREFIX);
    const quote = 'The Pilot project starts soon.';
    const charStart = (await prisma.note.findUniqueOrThrow({ where: { id: f.note.id } })).body.indexOf(quote);
    const segQuote = 'Northwind Robotics';
    const segStart = f.segment.text.indexOf(segQuote);

    const added = await services.proposals.addItem(f.caller, f.proposal.id, {
      kind: 'relation',
      payload: { type: 'WORKS_FOR', from: { entityId: f.existing.sarah }, to: { ref: 'e2' }, props: {}, validFrom: null, validTo: null, precision: 'unknown' },
      evidence: [
        { source: 'note', noteVersion: 1, charStart, charEnd: charStart + quote.length, quote: `  ${quote} ` },
        { source: 'segment', segmentId: f.segment.id, segmentRev: 1, charStart: segStart, charEnd: segStart + segQuote.length, quote: segQuote },
      ],
    });
    expect(added.item).toEqual(expect.objectContaining({ origin: 'user', decision: 'accept', groupKey: 'relations' }));
    expect(added.item.effectivePayload.ref).toBe('u1');
    expect(added.item.evidence).toEqual([
      expect.objectContaining({ source: 'note', stale: false }),
      expect.objectContaining({ source: 'segment', transcriptId: f.transcript.id, startMs: 0, endMs: 4000, speakerName: 'Sarah Chen', stale: false }),
    ]);

    // A stale version, a stale rev, a mismatched quote.
    const stale = await services.proposals
      .addItem(f.caller, f.proposal.id, { kind: 'entity', payload: { type: 'Project', label: 'Pilot' }, evidence: [{ source: 'note', noteVersion: 2, charStart, charEnd: charStart + 5, quote: 'The P' }] })
      .then(() => { throw new Error('expected a refusal'); }, (e: ConflictException) => e);
    expect((stale.getResponse() as { details: { reason: string } }).details.reason).toBe('stale_note_version');
    const staleRev = await services.proposals
      .addItem(f.caller, f.proposal.id, { kind: 'entity', payload: { type: 'Project', label: 'Pilot' }, evidence: [{ source: 'segment', segmentId: f.segment.id, segmentRev: 7, charStart: 0, charEnd: 2, quote: 'Hi' }] })
      .then(() => { throw new Error('expected a refusal'); }, (e: ConflictException) => e);
    expect((staleRev.getResponse() as { details: { reason: string } }).details.reason).toBe('stale_segment_rev');
    const mismatch = await services.proposals
      .addItem(f.caller, f.proposal.id, { kind: 'entity', payload: { type: 'Project', label: 'Pilot' }, evidence: [{ source: 'note', noteVersion: 1, charStart, charEnd: charStart + 5, quote: 'Nope!' }] })
      .then(() => { throw new Error('expected a refusal'); }, (e: BadRequestException) => e);
    expect((mismatch.getResponse() as { details: { reason: string } }).details.reason).toBe('span_mismatch');

    const { result } = await services.commits.commit(f.caller, f.proposal.id);
    expect(result.created.relations).toBe(2);
    expect(await orphans(prisma, f.ownerId)).toEqual([]);
  });

  it('a committed proposal accepts no further decision', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await services.commits.commit(f.caller, f.proposal.id);
    const err = await services.proposals
      .decide(f.caller, f.proposal.id, f.itemIds.e3, { decision: 'accept' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });
});
