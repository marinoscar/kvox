// =============================================================================
// Real-Postgres test: `kg.migrate` (#384; docs/specs/ontology.md §11, §17.4)
// =============================================================================
//
// The things only a real database can prove:
//
//   - the candidate predicate (semver as `int[]`, `props -> key`, keyset on id)
//     selects exactly the rows a step touches — and nobody else's;
//   - the batch `UPDATE … FROM (VALUES …)` writes type, props and version, and
//     its optimistic guard skips a row edited since it was read;
//   - a run that dies after committing a batch, retried, finishes without
//     double-applying anything; a second complete run changes nothing.
//
// The migrations are the issue's acceptance fixture (`buildMigrationTestDefinition`):
//   1.1.0 rename_attribute Project.startDate → start
//   2.0.0 retag_entity_type OldType → NewType
// Rows are seeded `unreviewed`, which the no-orphans trigger (#355) ignores —
// evidence is not what this job touches.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import { KgMigrateHandler } from '../../src/graph/migrate/kg-migrate.handler';
import { KgMigrateRepository } from '../../src/graph/migrate/kg-migrate.repository';
import type { KgMigrateDefinition } from '../../src/graph/migrate/kg-migrate.plan';
import { KgMigrateSchedulerTask } from '../../src/graph/migrate/kg-migrate-scheduler.task';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { buildMigrationTestDefinition } from '../ontology/fixtures/migration-fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-migrate.db.spec');

const EMAIL_PREFIX = 'kg-migrate-test';

describeWithDb('kg.migrate (real Postgres)', () => {
  let prisma: PrismaClient;
  let definition: KgMigrateDefinition;
  let repository: KgMigrateRepository;
  let handler: KgMigrateHandler;

  const fakeRegistry = { register: jest.fn() } as unknown as JobHandlerRegistry;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
    const def = buildMigrationTestDefinition();
    definition = { registry: def.registry, migrations: def.migrations, changelog: def.changelog, targetVersion: def.targetVersion };
    repository = new KgMigrateRepository(prisma as unknown as PrismaService);
    handler = new KgMigrateHandler(fakeRegistry, repository, definition);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    await prisma.kgProposalItem.deleteMany({ where: { proposal: owner } });
    await prisma.kgProposal.deleteMany({ where: owner });
    await prisma.kgItem.deleteMany({ where: owner });
    await prisma.kgRelation.deleteMany({ where: owner });
    await prisma.kgEntity.deleteMany({ where: owner });
    await prisma.kgAttributeDef.deleteMany({ where: owner });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  function entity(ownerId: string, type: string, ontologyVersion: string, props: Record<string, unknown>, label = type) {
    return prisma.kgEntity.create({
      data: { ownerId, type, label, props: props as object, ontologyVersion, reviewStatus: 'unreviewed' },
    });
  }

  async function seedOwner(ownerId: string) {
    return {
      // 1.0.0 Project with startDate → renamed, and re-versioned to 2.0.0 (the last applied `to`).
      renamed: await entity(ownerId, 'Project', '1.0.0', { startDate: '2026-01-02', status: 'active' }),
      // OldType at 1.1.0 → retagged to NewType at 2.0.0.
      retagged: await entity(ownerId, 'OldType', '1.1.0', { note: 'keep me' }),
      // OldType whose props fail NewType's validation after the retag → left alone, counted.
      invalid: await entity(ownerId, 'OldType', '1.0.0', { note: 'x'.repeat(2001) }),
      // A 1.0.0 Project with no startDate: no step touches it → never selected.
      noStep: await entity(ownerId, 'Project', '1.0.0', { status: 'planned' }),
      // A 1.1.0 Project with startDate: the rename targets rows below 1.1.0 only.
      alreadyPast: await entity(ownerId, 'Project', '1.1.0', { startDate: '2026-03-04' }),
      // Unrelated type.
      person: await entity(ownerId, 'Person', '1.0.0', {}, 'Sarah'),
    };
  }

  async function read(id: string) {
    const row = await prisma.kgEntity.findUniqueOrThrow({ where: { id } });
    return { type: row.type, props: row.props, ontologyVersion: row.ontologyVersion };
  }

  it('reshapes one owner, re-versions changed rows to the last applied `to`, and leaves the rest untouched', async () => {
    const a = await createUser('a');
    const b = await createUser('b');
    const rowsA = await seedOwner(a.id);
    const rowsB = await seedOwner(b.id);

    const result = await handler.migrate(a.id, '2.0.0');

    expect(result).toMatchObject({ ownerId: a.id, targetVersion: '2.0.0', scanned: 3, changed: 2, needsAttention: 1, droppedValues: 0 });
    expect(await read(rowsA.renamed.id)).toEqual({ type: 'Project', props: { start: '2026-01-02', status: 'active' }, ontologyVersion: '2.0.0' });
    expect(await read(rowsA.retagged.id)).toEqual({ type: 'NewType', props: { note: 'keep me' }, ontologyVersion: '2.0.0' });
    expect(await read(rowsA.invalid.id)).toMatchObject({ type: 'OldType', ontologyVersion: '1.0.0' });
    expect(await read(rowsA.noStep.id)).toEqual({ type: 'Project', props: { status: 'planned' }, ontologyVersion: '1.0.0' });
    expect(await read(rowsA.alreadyPast.id)).toEqual({ type: 'Project', props: { startDate: '2026-03-04' }, ontologyVersion: '1.1.0' });
    expect(await read(rowsA.person.id)).toMatchObject({ type: 'Person', ontologyVersion: '1.0.0' });

    // Owner B is not touched by owner A's job.
    expect(await read(rowsB.renamed.id)).toMatchObject({ props: { startDate: '2026-01-02', status: 'active' }, ontologyVersion: '1.0.0' });
    expect(await read(rowsB.retagged.id)).toMatchObject({ type: 'OldType', ontologyVersion: '1.1.0' });
  });

  it('changes nothing the second time', async () => {
    const a = await createUser('twice');
    const rows = await seedOwner(a.id);

    await handler.migrate(a.id, '2.0.0');
    const snapshot = await Promise.all(Object.values(rows).map((r) => read(r.id)));
    const second = await handler.migrate(a.id, '2.0.0');

    expect(second).toMatchObject({ changed: 0, needsAttention: 1, scanned: 1 });
    expect(await Promise.all(Object.values(rows).map((r) => read(r.id)))).toEqual(snapshot);
  });

  it('migrates only as far as the requested target', async () => {
    const a = await createUser('partial');
    const rows = await seedOwner(a.id);

    const result = await handler.migrate(a.id, '1.1.0');

    expect(result).toMatchObject({ targetVersion: '1.1.0', changed: 1 });
    expect(await read(rows.renamed.id)).toMatchObject({ props: { start: '2026-01-02' }, ontologyVersion: '1.1.0' });
    expect(await read(rows.retagged.id)).toMatchObject({ type: 'OldType', ontologyVersion: '1.1.0' });

    // …and the later full run picks up from there.
    await handler.migrate(a.id, '2.0.0');
    expect(await read(rows.renamed.id)).toMatchObject({ props: { start: '2026-01-02' }, ontologyVersion: '1.1.0' });
    expect(await read(rows.retagged.id)).toMatchObject({ type: 'NewType', ontologyVersion: '2.0.0' });
  });

  it('resumes after a crash that followed a committed batch, without double-applying', async () => {
    const a = await createUser('crash');
    const rows = await seedOwner(a.id);

    class CrashingRepository extends KgMigrateRepository {
      override async writeBatch(...args: Parameters<KgMigrateRepository['writeBatch']>): Promise<string[]> {
        const written = await super.writeBatch(...args);
        throw new Error(`worker killed after committing ${written.length} rows`);
      }
    }
    const crashing = new KgMigrateHandler(fakeRegistry, new CrashingRepository(prisma as unknown as PrismaService), definition);
    await expect(crashing.migrate(a.id, '2.0.0')).rejects.toThrow('worker killed');

    // The batch committed before the crash; the retry finds nothing left to reshape.
    const retry = await handler.migrate(a.id, '2.0.0');
    expect(retry).toMatchObject({ changed: 0, needsAttention: 1 });
    expect(await read(rows.renamed.id)).toEqual({ type: 'Project', props: { start: '2026-01-02', status: 'active' }, ontologyVersion: '2.0.0' });
    expect(await read(rows.retagged.id)).toEqual({ type: 'NewType', props: { note: 'keep me' }, ontologyVersion: '2.0.0' });
  });

  it('skips a row edited between the read and the write (optimistic guard)', async () => {
    const a = await createUser('guard');
    const row = await entity(a.id, 'Project', '1.0.0', { startDate: '2026-01-02' });

    const [candidate] = await repository.selectBatch(
      'entity',
      a.id,
      '2.0.0',
      // The same predicate the handler builds.
      (await import('../../src/graph/migrate/kg-migrate.plan')).candidatePredicate('entity', definition.migrations, definition.registry)!,
      null,
      10,
    );
    // A concurrent manual edit lands first.
    await prisma.kgEntity.update({ where: { id: row.id }, data: { props: { startDate: '2026-05-06' } } });

    const written = await repository.writeBatch('entity', a.id, [
      {
        id: candidate.id,
        before: { type: candidate.type, status: null, props: candidate.props, ontologyVersion: candidate.ontologyVersion },
        after: { type: 'Project', status: null, props: { start: '2026-01-02' }, ontologyVersion: '2.0.0' },
      },
    ]);

    expect(written).toEqual([]);
    expect(await read(row.id)).toEqual({ type: 'Project', props: { startDate: '2026-05-06' }, ontologyVersion: '1.0.0' });
  });

  it('flags every item of a draft that predates the major migration with stale_ontology, once', async () => {
    const a = await createUser('drafts');
    const old = await prisma.kgProposal.create({
      data: { ownerId: a.id, kind: 'resolution', status: 'draft', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const fresh = await prisma.kgProposal.create({
      data: { ownerId: a.id, kind: 'resolution', status: 'draft', createdAt: new Date('2099-01-01T00:00:00Z') },
    });
    const committed = await prisma.kgProposal.create({
      data: { ownerId: a.id, kind: 'resolution', status: 'committed', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    for (const p of [old, fresh, committed]) {
      await prisma.kgProposalItem.createMany({
        data: [
          { proposalId: p.id, kind: 'entity', payload: {}, flags: [] },
          { proposalId: p.id, kind: 'entity', payload: {}, flags: ['overlaps'] },
        ],
      });
    }

    const first = await handler.migrate(a.id, '2.0.0');
    const second = await handler.migrate(a.id, '2.0.0');

    expect(first.staleDraftItems).toBe(2);
    expect(second.staleDraftItems).toBe(0);
    const flags = async (proposalId: string) =>
      (await prisma.kgProposalItem.findMany({ where: { proposalId }, orderBy: { flags: 'asc' } })).map((i) => i.flags);
    expect((await flags(old.id)).sort()).toEqual([['overlaps', 'stale_ontology'], ['stale_ontology']].sort());
    expect(await flags(fresh.id)).toEqual(expect.arrayContaining([[], ['overlaps']]));
    expect(await flags(committed.id)).toEqual(expect.arrayContaining([[], ['overlaps']]));
  });

  it('validates a user attribute value against the owner\'s own attribute defs', async () => {
    const a = await createUser('userattr');
    const def = await prisma.kgAttributeDef.create({
      data: { ownerId: a.id, entityType: 'Project', key: 'u_abcdefghij', label: 'Budget', kind: 'number' },
    });
    const row = await entity(a.id, 'Project', '1.0.0', { startDate: '2026-01-02', [def.key]: 5 });

    const result = await handler.migrate(a.id, '2.0.0');

    expect(result).toMatchObject({ changed: 1, needsAttention: 0 });
    expect(await read(row.id)).toMatchObject({ props: { start: '2026-01-02', u_abcdefghij: 5 } });
  });

  it('re-versions a coerce no-op so it stops being a candidate, and never lets a malformed version fail the run', async () => {
    const a = await createUser('coerce');
    const coerceDefinition: KgMigrateDefinition = {
      ...definition,
      migrations: [
        definition.migrations[0],
        {
          to: '2.0.0',
          description: 'status labels to values',
          steps: [{ op: 'coerce_attribute', typeKey: 'Project', key: 'status', to: 'select', map: { Active: 'active' } }],
        },
      ],
    };
    const coercer = new KgMigrateHandler(fakeRegistry, repository, coerceDefinition);
    const mapped = await entity(a.id, 'Project', '1.1.0', { status: 'Active' });
    const alreadyValue = await entity(a.id, 'Project', '1.1.0', { status: 'active' });
    const nullValue = await entity(a.id, 'Project', '1.1.0', { status: null });
    const malformed = await entity(a.id, 'Project', 'garbage', { status: 'Active' });

    const first = await coercer.migrate(a.id, '2.0.0');
    const second = await coercer.migrate(a.id, '2.0.0');

    expect(first).toMatchObject({ scanned: 2, changed: 2, needsAttention: 0 });
    expect(second).toMatchObject({ scanned: 0, changed: 0 });
    expect(await read(mapped.id)).toEqual({ type: 'Project', props: { status: 'active' }, ontologyVersion: '2.0.0' });
    expect(await read(alreadyValue.id)).toEqual({ type: 'Project', props: { status: 'active' }, ontologyVersion: '2.0.0' });
    expect(await read(nullValue.id)).toMatchObject({ ontologyVersion: '1.1.0' });
    expect(await read(malformed.id)).toMatchObject({ props: { status: 'Active' }, ontologyVersion: 'garbage' });
  });

  it('the scheduler selects exactly the owners with a row a step touches', async () => {
    const a = await createUser('sched-a');
    const b = await createUser('sched-b');
    await entity(a.id, 'OldType', '1.0.0', { note: 'x' });
    await entity(b.id, 'Project', '1.0.0', { status: 'planned' });

    const task = new KgMigrateSchedulerTask(
      { get: () => true } as never,
      prisma as unknown as PrismaService,
      { enqueue: jest.fn() } as never,
      repository,
      definition,
    );
    const owners = await task.ownersToMigrate();

    expect(owners).toContain(a.id);
    expect(owners).not.toContain(b.id);
  });
});
