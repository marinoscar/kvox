// =============================================================================
// Real-Postgres test: the personal synonym dictionary (issue #767)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db`.
//
// What it proves:
//   - create / list / update / delete on `kg_synonyms`, owner-scoped (404 for
//     another user's group), `normalized` stored through `normalizeAlias`;
//   - the 2..20 cardinality CHECK holds at the table;
//   - candidate generation finds "Ernst & Young" for the mention "EY" through
//     a synonym group (and does not without one, nor for another owner's group);
//   - the possible-duplicates pass lists the pair with reason `synonym`;
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { GraphOntologyService, GraphPreferencesService, SynonymsService } from '@marinoscar/kvox-api/graph';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { createDbSettings } from '../helpers/graph-ports.helper';
import { CandidateService, DuplicatesService } from './package-internals';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from './graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('graph-synonyms.db.spec');
const EMAIL_PREFIX = 'graph-synonyms-test';

describeWithDb('Personal synonym dictionary (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: SynonymsService;
  let candidates: CandidateService;
  let duplicates: DuplicatesService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const db = prisma as unknown as PrismaService;
    const ontology = new GraphOntologyService(db, new GraphPreferencesService(createDbSettings(prisma)));
    service = new SynonymsService(db, ontology);
    candidates = new CandidateService(db as never);
    duplicates = new DuplicatesService(db, {} as never, {} as never);
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
    return { user, g: new GraphFixture(prisma, user.id), actor: { id: user.id, permissions: ['graph:read', 'graph:write'] } as never };
  }

  it('creates, lists, updates and deletes a group, owner-scoped', async () => {
    const a = await owner('crud-a');
    const b = await owner('crud-b');
    const created = await service.create({ terms: ['EY', 'Ernst & Young', 'ey'], entityType: 'Organization' }, a.actor);
    expect(created.terms).toEqual(['EY', 'Ernst & Young']);
    const row = await prisma.kgSynonym.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.normalized).toEqual(['ey', 'ernst & young']);

    expect((await service.list(a.actor)).groups.map((g) => g.id)).toEqual([created.id]);
    expect((await service.list(b.actor)).groups).toEqual([]);

    await expect(service.update(created.id, { terms: ['x1', 'y1'] }, b.actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(created.id, b.actor)).rejects.toBeInstanceOf(NotFoundException);

    const updated = await service.update(created.id, { terms: ['Acme', 'Roadrunner Supplies'], entityType: null }, a.actor);
    expect(updated).toMatchObject({ terms: ['Acme', 'Roadrunner Supplies'], entityType: null });

    await service.remove(created.id, a.actor);
    expect(await prisma.kgSynonym.count({ where: { ownerId: a.user.id } })).toBe(0);
  });

  it('the table refuses a group of fewer than two terms', async () => {
    const { user } = await owner('check');
    await expect(prisma.kgSynonym.create({ data: { ownerId: user.id, terms: ['solo'], normalized: ['solo'] } })).rejects.toBeDefined();
  });

  it('candidate generation matches EY to Ernst & Young through a group, for the owner and type only', async () => {
    const a = await owner('cand-a');
    const b = await owner('cand-b');
    const ey = await a.g.entity('Organization', 'Ernst & Young');
    const mention = { type: 'Organization', label: 'EY', aliases: [] as string[] };

    expect((await candidates.forMention(a.user.id, mention)).map((c) => c.entityId)).not.toContain(ey);

    await service.create({ terms: ['EY', 'Ernst & Young'] }, b.actor);
    expect((await candidates.forMention(a.user.id, mention)).map((c) => c.entityId)).not.toContain(ey);

    await service.create({ terms: ['EY', 'Ernst & Young'], entityType: 'Person' }, a.actor);
    expect((await candidates.forMention(a.user.id, mention)).filter((c) => c.aliasExact)).toEqual([]);

    await service.create({ terms: ['EY', 'Ernst & Young'], entityType: 'Organization' }, a.actor);
    const found = (await candidates.forMention(a.user.id, mention)).find((c) => c.entityId === ey);
    expect(found).toMatchObject({ aliasExact: true, label: 'Ernst & Young' });
  });

  it('the duplicates pass lists two entities sharing a group as `synonym` (0.9)', async () => {
    const a = await owner('dup');
    await a.g.entity('Organization', 'Acme');
    await a.g.entity('Organization', 'Roadrunner Supplies');
    await service.create({ terms: ['Acme', 'Roadrunner Supplies'] }, a.actor);
    const { pairs } = await duplicates.list(a.actor, { limit: 50 });
    const pair = pairs.find((p) => p.reasons.includes('synonym'));
    expect(pair).toMatchObject({ score: 0.9, source: 'name_pass' });
    expect([pair?.a.label, pair?.b.label].sort()).toEqual(['Acme', 'Roadrunner Supplies']);
  });
});
