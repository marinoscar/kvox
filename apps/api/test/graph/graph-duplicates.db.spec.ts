// =============================================================================
// Real-Postgres test: GET /api/graph/duplicates (issue #766)
// =============================================================================
//
// The pg_trgm self-join and the distinct-pair anti-join are SQL, so they are
// proven against Postgres. Excluded from `npm test`; run by `npm run test:db`.
//
// What it proves:
//   - trigram pairs (>= 0.6) come back with `similar_name`, same type only;
//   - containment ("Avery" / "Avery Example") and initials ("OAC" / "Org Alpha Consulting");
//   - merged and unreviewed entities never appear; another owner's never do;
//   - a `kg_distinct_pairs` row removes the pair;
//   - an open resolution proposal item maps to a `resolution_proposal` pair;
//   - the `type` filter and the `limit`.
// =============================================================================

import type { PrismaClient } from '@prisma/client';

import { DuplicatesService } from './package-internals';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-duplicates.db.spec');
const EMAIL_PREFIX = 'graph-duplicates-test';

describeWithDb('GET /api/graph/duplicates (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: DuplicatesService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    service = new DuplicatesService(prisma as unknown as PrismaService, {} as never, {} as never);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix: string) {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    return { user, g: new GraphFixture(prisma, user.id) };
  }
  const actor = (id: string) => ({ id, permissions: ['graph:read'] }) as never;
  const labels = (out: { pairs: Array<{ a: { label: string }; b: { label: string } }> }) =>
    out.pairs.map((p) => [p.a.label, p.b.label].sort().join(' | ')).sort();

  it('finds containment, initials and similar spelling, same type only', async () => {
    const { user, g } = await owner('names');
    await g.entity('Person', 'Avery');
    await g.entity('Person', 'Avery Example');
    await g.entity('Organization', 'OAC');
    await g.entity('Organization', 'Org Alpha Consulting');
    await g.entity('Organization', 'Org Kappa Holdings');
    await g.entity('Organization', 'Org Kappa Holding');
    await g.entity('Person', 'Al');
    await g.entity('Person', 'Alan');
    await g.entity('Topic', 'Avery Example');

    const out = await service.list(actor(user.id), { limit: 50 });
    expect(labels(out)).toEqual(['Avery | Avery Example', 'OAC | Org Alpha Consulting', 'Org Kappa Holding | Org Kappa Holdings']);
    const kappa = out.pairs.find((p) => p.a.label.startsWith('Org Kappa'))!;
    expect(kappa.reasons).toContain('similar_name');
    expect(kappa.source).toBe('name_pass');
  });

  it('leaves out merged, unreviewed and other owners, and honours distinct pairs', async () => {
    const { user, g } = await owner('filters');
    const { g: other } = await owner('filters-other');
    const a = await g.entity('Person', 'Sasa Example');
    const b = await g.entity('Person', 'Sasa Example Jr');
    await g.entity('Person', 'Sasa Example Sr', { reviewStatus: 'unreviewed' });
    await g.entity('Person', 'Sasa Examplee', { reviewStatus: 'merged', mergedIntoId: a });
    await other.entity('Person', 'Sasa Example Other');
    expect(labels(await service.list(actor(user.id), { limit: 50 }))).toEqual(['Sasa Example | Sasa Example Jr']);

    const [aId, bId] = a < b ? [a, b] : [b, a];
    await prisma.kgDistinctPair.create({ data: { ownerId: user.id, aId, bId } });
    expect((await service.list(actor(user.id), { limit: 50 })).pairs).toEqual([]);
  });

  it('maps an open resolution proposal item and applies type and limit', async () => {
    const { user, g } = await owner('proposal');
    const a = await g.entity('Person', 'Darcy Stubbs');
    const b = await g.entity('Person', 'Ms Stubbs');
    await g.entity('Organization', 'Org Omega');
    await g.entity('Organization', 'Org Omega Inc');
    const proposal = await prisma.kgProposal.create({ data: { ownerId: user.id, kind: 'resolution', status: 'draft' } });
    const item = await prisma.kgProposalItem.create({
      data: {
        proposalId: proposal.id,
        kind: 'entity',
        payload: { ref: 'x1', type: 'Person', label: 'Darcy Stubbs', aliases: [], props: {}, existingEntityId: a },
        resolution: { ref: b, score: 0.82, source: 'trigram', candidates: [], adjudication: null },
        decision: 'pending',
      },
    });
    const people = await service.list(actor(user.id), { type: 'Person', limit: 50 });
    expect(people.pairs).toHaveLength(1);
    expect(people.pairs[0]).toMatchObject({ source: 'resolution_proposal', proposalItemId: item.id, reasons: ['resolution_proposal'] });
    const all = await service.list(actor(user.id), { limit: 1 });
    expect(all.pairs).toHaveLength(1);
  });
});
