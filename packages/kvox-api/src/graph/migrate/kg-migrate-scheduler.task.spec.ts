import { jobsMock } from '../__fixtures__/jobs-mock.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import type { ResolvedGraphOptions } from '../graph.options.js';
import { buildMigrationTestDefinition } from '../testing/migration-fixtures.js';
import { KG_MIGRATE_JOB_TYPE } from '../job-types.js';
import { KG_MIGRATE_OWNERS_PER_TICK } from './kg-migrate.enqueuer.js';
import { KgMigrateSchedulerTask } from './kg-migrate-scheduler.task.js';
import { DEFAULT_KG_MIGRATE_DEFINITION, type KgMigrateDefinition } from './kg-migrate.plan.js';
import type { KgMigrateRepository } from './kg-migrate.repository.js';
const HOUSEKEEPING_PRIORITY = 100;

// =============================================================================
// The `kg.migrate` scheduler (#384): it only ever enqueues — one job per owner,
// deduplicated per owner — honours KG_MIGRATE_SCHEDULE_ENABLED=false, and does
// nothing at all (no query) while ONTOLOGY_MIGRATIONS is empty.
// =============================================================================

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fixtureDefinition(): KgMigrateDefinition {
  const def = buildMigrationTestDefinition();
  return { registry: def.registry, migrations: def.migrations, changelog: def.changelog, targetVersion: def.targetVersion };
}

function harness(opts: { scheduleEnabled?: unknown; definition?: KgMigrateDefinition; owners?: string[]; active?: string[] } = {}) {
  const scheduleEnabled = jest.fn().mockReturnValue(opts.scheduleEnabled ?? true);
  const config = { migrateScheduleEnabled: scheduleEnabled } as unknown as ResolvedGraphOptions;
  const prisma = {};
  const jobs = jobsMock();
  jobs.findActive.mockImplementation(async () =>
    (opts.active ?? []).map((subjectId) => ({
      id: `job-${subjectId}`,
      type: KG_MIGRATE_JOB_TYPE,
      subjectType: 'user',
      subjectId,
      payload: {},
    })),
  );
  jobs.enqueue.mockImplementation(async (input?: unknown) => ({
    id: `new-${(input as { subjectId: string }).subjectId}`,
    deduplicated: false,
  }));
  const repository = { ownersNeedingMigration: jest.fn().mockResolvedValue(opts.owners ?? []) };
  const task = new KgMigrateSchedulerTask(
    config,
    prisma as unknown as KvoxGraphDb,
    jobs as never,
    repository as unknown as KgMigrateRepository,
    opts.definition ?? fixtureDefinition(),
  );
  return { task, config: { get: scheduleEnabled }, prisma, jobs, repository };
}

describe('KgMigrateSchedulerTask', () => {
  it('does nothing — no query — while ONTOLOGY_MIGRATIONS is empty (the shipped 1.x state)', async () => {
    const { task, repository, jobs } = harness({ definition: DEFAULT_KG_MIGRATE_DEFINITION, owners: [A] });

    await task.handleCron();

    expect(DEFAULT_KG_MIGRATE_DEFINITION.migrations).toHaveLength(0);
    expect(repository.ownersNeedingMigration).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when KG_MIGRATE_SCHEDULE_ENABLED is false', async () => {
    const { task, config, repository, jobs } = harness({ scheduleEnabled: false, owners: [A] });

    await task.handleCron();

    expect(config.get).toHaveBeenCalled();
    expect(repository.ownersNeedingMigration).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one kg.migrate per owner, per-owner subject, at housekeeping priority', async () => {
    const { task, jobs, repository } = harness({ owners: [A, B] });

    await task.handleCron();

    expect(repository.ownersNeedingMigration).toHaveBeenCalledWith(
      expect.objectContaining({ entity: expect.anything() }),
      '2.0.0',
      KG_MIGRATE_OWNERS_PER_TICK,
    );
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_MIGRATE_JOB_TYPE,
      reason: 'backfill',
      subjectType: 'user',
      subjectId: A,
      payload: { ownerId: A, targetVersion: '2.0.0' },
      priority: HOUSEKEEPING_PRIORITY,
    });
  });

  it('skips an owner whose job is already pending or running, without skipping the others', async () => {
    const { task, jobs } = harness({ owners: [A, B], active: [A] });

    await task.handleCron();

    expect(jobs.findActive).toHaveBeenCalledWith({ types: [KG_MIGRATE_JOB_TYPE] });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectId: B }));
  });

  it('never throws out of the cron', async () => {
    const { task, repository } = harness();
    repository.ownersNeedingMigration.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
