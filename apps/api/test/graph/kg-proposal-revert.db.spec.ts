// =============================================================================
// Real-Postgres test: reverting a committed graph proposal (issue #366)
// =============================================================================
//
// A revert with nothing touched since restores the owner's graph EXACTLY —
// created rows gone, the closed edge re-opened, the changed commitment's due
// date back, learned aliases and mentions removed. A row edited since is a
// 409 `revert_conflict` that writes nothing; confirming the partial revert
// keeps that row (and whatever it needs) and reverts the rest.
// =============================================================================

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { resolveDbSuite } from '../jobs/db-test-support';
import { buildServices, cleanup, orphans, seedFixture, snapshot } from './kg-proposal-db-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-proposal-revert.db.spec');
const PREFIX = 'kg-proposal-revert-test';

describeWithDb('graph proposal revert (real Postgres)', () => {
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

  const committedRef = async (proposalId: string, itemId: string) =>
    (await prisma.kgProposalItem.findUniqueOrThrow({ where: { id: itemId } })).committedRefId!;

  it('a clean revert restores the graph exactly, closing and item change included', async () => {
    const f = await seedFixture(prisma, PREFIX);
    const before = await snapshot(prisma, f.ownerId);

    await services.commits.commit(f.caller, f.proposal.id);
    expect(await snapshot(prisma, f.ownerId)).not.toEqual(before);

    const { proposal, result } = await services.reverts.revert(f.caller, f.proposal.id, false);
    expect(proposal.status).toBe('reverted');
    expect(proposal.revertedAt).not.toBeNull();
    expect(result.kept).toEqual([]);
    expect(result.reverted).toBeGreaterThan(0);

    expect(await snapshot(prisma, f.ownerId)).toEqual(before);
    expect(await orphans(prisma, f.ownerId)).toEqual([]);

    // Proposal rows keep their decisions (a read-only record); reverting twice is a 409.
    const e2 = await prisma.kgProposalItem.findUniqueOrThrow({ where: { id: f.itemIds.e2 } });
    expect(e2.decision).toBe('accept');
    const again = await services.reverts.revert(f.caller, f.proposal.id, false).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConflictException);
    expect(((again as ConflictException).getResponse() as { details: { reason: string } }).details.reason).toBe('proposal_not_committed');
  });

  it('a row edited since is a 409 revert_conflict that writes nothing', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await services.commits.commit(f.caller, f.proposal.id);
    const northwind = await committedRef(f.proposal.id, f.itemIds.e2);
    await prisma.kgEntity.update({
      where: { id: northwind },
      data: { label: 'Northwind Robotics Inc.', reviewStatus: 'edited', updatedAt: new Date(Date.now() + 60_000) },
    });
    const afterCommit = await snapshot(prisma, f.ownerId);

    const err = await services.reverts.revert(f.caller, f.proposal.id, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      details: { reason: string; conflicts: Array<{ kind: string; id: string; label: string; why: string }>; revertible: number };
    };
    expect(body.details.reason).toBe('revert_conflict');
    expect(body.details.conflicts).toEqual([
      { kind: 'entity', id: northwind, label: 'Northwind Robotics Inc.', why: 'edited_since' },
    ]);
    expect(body.details.revertible).toBeGreaterThan(0);
    expect(await snapshot(prisma, f.ownerId)).toEqual(afterCommit);
    expect((await prisma.kgProposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).status).toBe('committed');
  });

  it('confirmPartial keeps the edited row and reverts the rest', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await services.commits.commit(f.caller, f.proposal.id);
    const northwind = await committedRef(f.proposal.id, f.itemIds.e2);
    const edge = await committedRef(f.proposal.id, f.itemIds.r1);
    const deck = await committedRef(f.proposal.id, f.itemIds.i1);
    await prisma.kgEntity.update({ where: { id: northwind }, data: { updatedAt: new Date(Date.now() + 60_000) } });

    const { proposal, result } = await services.reverts.revert(f.caller, f.proposal.id, true);
    expect(proposal.status).toBe('reverted');
    expect(result.kept).toEqual([expect.objectContaining({ kind: 'entity', id: northwind, why: 'edited_since' })]);

    expect(await prisma.kgEntity.count({ where: { id: northwind } })).toBe(1);
    expect(await prisma.kgRelation.count({ where: { id: edge } })).toBe(0);
    expect(await prisma.kgItem.count({ where: { id: deck } })).toBe(0);

    // The closing and the commitment's due date are restored.
    const [old] = await prisma.$queryRaw<Array<{ valid: string; superseded_by_id: string | null }>>`
      SELECT valid::text AS valid, superseded_by_id::text AS superseded_by_id FROM kg_relations WHERE id = ${f.existing.oldEdge}::uuid`;
    expect(old).toEqual({ valid: '["2019-01-01 00:00:00+00",)', superseded_by_id: null });
    const commitment = await prisma.kgItem.findUniqueOrThrow({ where: { id: f.existing.commitment } });
    expect(commitment.dueAt?.toISOString()).toBe('2026-03-06T00:00:00.000Z');
    expect(await orphans(prisma, f.ownerId)).toEqual([]);
  });

  it('keeps an entity a newer row now names (referenced_since)', async () => {
    const f = await seedFixture(prisma, PREFIX);
    await services.commits.commit(f.caller, f.proposal.id);
    const meeting = await committedRef(f.proposal.id, f.itemIds.meeting);
    // A later relation, written after the commit, points at the meeting.
    await prisma.$transaction(async (tx) => {
      const later = await tx.kgRelation.create({
        data: { ownerId: f.ownerId, type: 'ATTENDED', fromId: f.existing.sarah, toId: meeting, ontologyVersion: 'test', createdAt: new Date(Date.now() + 60_000) },
      });
      await tx.kgEvidence.create({ data: { ownerId: f.ownerId, subjectKind: 'relation', subjectId: later.id, quote: 'Sarah attended' } });
    });

    const err = await services.reverts.revert(f.caller, f.proposal.id, false).catch((e: unknown) => e);
    const body = (err as ConflictException).getResponse() as { details: { conflicts: Array<{ id: string; why: string }> } };
    expect(body.details.conflicts).toEqual([expect.objectContaining({ id: meeting, why: 'referenced_since' })]);
  });
});
