// =============================================================================
// Real-Postgres test: a `known` relation fills the props it adds (issue #444)
// =============================================================================
//
// The graph holds `Sarah —HAS_ROLE {title: VP}→ OldCo`. A later note says she
// is VP of Consulting there; #365's dedup calls it `known` (a null business
// unit matches anything, #440). The commit appends the citation AND fills
// `businessUnit: 'Consulting'` on the stored edge — never overwriting a value
// it already holds — and the revert removes exactly that key again, unless it
// was changed since (then it is a `relation_fill` revert conflict).
// =============================================================================

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { resolveDbSuite } from '../jobs/db-test-support';
import { buildServices, cleanup, noteCite, orphans, seedFixture, V } from './kg-proposal-db-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-proposal-relation-fill.db.spec');
const PREFIX = 'kg-proposal-relation-fill-test';

describeWithDb('graph proposal commit: known relation fills (real Postgres)', () => {
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

  /** The live `{VP}` role plus a draft proposal restating it as `{VP, Consulting}`. */
  async function seed(storedProps: Record<string, unknown> = { title: 'VP' }) {
    const f = await seedFixture(prisma, PREFIX);
    // One draft per note: set the fixture's own proposal aside.
    await prisma.kgProposal.update({ where: { id: f.proposal.id }, data: { status: 'discarded' } });

    const role = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({
        data: { id: role, ownerId: f.ownerId, type: 'HAS_ROLE', fromId: f.existing.sarah, toId: f.existing.oldco, props: storedProps as never, ontologyVersion: V },
      });
      await tx.kgEvidence.create({ data: { ownerId: f.ownerId, subjectKind: 'relation', subjectId: role, quote: 'Sarah is VP at OldCo' } });
    });

    const proposal = await prisma.kgProposal.create({
      data: { ownerId: f.ownerId, kind: 'extraction', status: 'draft', noteId: f.note.id, noteVersion: 1, model: 'gpt-4o', provider: 'openai', stats: { phase: 'ready' } },
    });
    const item = await prisma.kgProposalItem.create({
      data: {
        proposalId: proposal.id,
        kind: 'relation',
        decision: 'accept',
        sortOrder: 0,
        flags: ['known'],
        payload: {
          ref: 'r1',
          type: 'HAS_ROLE',
          from: { entityId: f.existing.sarah },
          to: { entityId: f.existing.oldco },
          props: { title: 'VP', businessUnit: 'Consulting' },
          validFrom: null,
          validTo: null,
          precision: 'unknown',
          dedup: { verdict: 'known', targetRelationId: role, candidateTo: null },
        },
      },
    });
    await prisma.kgEvidence.create({
      data: { ownerId: f.ownerId, subjectKind: 'proposal_item', subjectId: item.id, ...noteCite(f.note.id, 'Sarah Chen joined Northwind Robotics in March 2026.') },
    });
    return { f, role, proposal, item };
  }

  const propsOf = async (id: string) => (await prisma.kgRelation.findUniqueOrThrow({ where: { id } })).props;

  it('shows the pending fill, commits it onto the stored edge, and the revert clears it', async () => {
    const { f, role, proposal, item } = await seed();

    const detail = await services.proposals.get(f.caller, proposal.id, false);
    const view = detail.items.find((i) => i.id === item.id)!;
    expect(view.fills).toEqual({ businessUnit: 'Consulting' });
    expect(view.display.subtitle).toContain('adds Business unit: Consulting');

    const { result } = await services.commits.commit(f.caller, proposal.id);
    expect(result.created.relations).toBe(0);
    expect(result.propsFilled).toBe(1);
    expect(await propsOf(role)).toEqual({ title: 'VP', businessUnit: 'Consulting' });
    const stored = await prisma.kgRelation.findUniqueOrThrow({ where: { id: role } });
    expect(stored.reviewStatus).toBe('accepted');
    expect(await prisma.kgEvidence.count({ where: { subjectKind: 'relation', subjectId: role } })).toBe(2);
    const log = (await prisma.kgProposal.findUniqueOrThrow({ where: { id: proposal.id } })).commitLog as Record<string, unknown>;
    expect(log.relationFills).toEqual([{ relationId: role, fills: { businessUnit: 'Consulting' } }]);
    expect(await orphans(prisma, f.ownerId)).toEqual([]);

    const reverted = await services.reverts.revert(f.caller, proposal.id, false);
    expect(reverted.result.kept).toEqual([]);
    expect(await propsOf(role)).toEqual({ title: 'VP' });
    expect(await prisma.kgEvidence.count({ where: { subjectKind: 'relation', subjectId: role } })).toBe(1);
  });

  it('never overwrites a value the stored edge already holds', async () => {
    const { f, role, proposal } = await seed({ title: 'VP', businessUnit: 'Advisory' });
    const { result } = await services.commits.commit(f.caller, proposal.id);
    expect(result.propsFilled).toBe(0);
    expect(await propsOf(role)).toEqual({ title: 'VP', businessUnit: 'Advisory' });
  });

  it('a fill changed since is a relation_fill revert conflict; confirming keeps it', async () => {
    const { f, role, proposal } = await seed();
    await services.commits.commit(f.caller, proposal.id);
    await prisma.kgRelation.update({ where: { id: role }, data: { props: { title: 'VP', businessUnit: 'Strategy' } } });

    const err = await services.reverts.revert(f.caller, proposal.id, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const details = ((err as ConflictException).getResponse() as { details: { reason: string; conflicts: Array<Record<string, unknown>> } }).details;
    expect(details.reason).toBe('revert_conflict');
    expect(details.conflicts).toEqual([expect.objectContaining({ kind: 'relation_fill', id: role, why: 'edited_since' })]);
    expect(await propsOf(role)).toEqual({ title: 'VP', businessUnit: 'Strategy' });

    const partial = await services.reverts.revert(f.caller, proposal.id, true);
    expect(partial.result.kept).toEqual([expect.objectContaining({ kind: 'relation_fill', id: role })]);
    expect(await propsOf(role)).toEqual({ title: 'VP', businessUnit: 'Strategy' });
  });
});
