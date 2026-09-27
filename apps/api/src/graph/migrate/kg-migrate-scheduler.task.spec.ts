import type { ConfigService } from '@nestjs/config';

import { HOUSEKEEPING_PRIORITY } from '../../jobs/housekeeping.enqueue';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { buildMigrationTestDefinition } from '../../../test/ontology/fixtures/migration-fixtures';
import { KG_MIGRATE_JOB_TYPE } from '../job-types';
import { KG_MIGRATE_OWNERS_PER_TICK, KgMigrateSchedulerTask } from './kg-migrate-scheduler.task';
import { DEFAULT_KG_MIGRATE_DEFINITION, type KgMigrateDefinition } from './kg-migrate.plan';
import type { KgMigrateRepository } from './kg-migrate.repository';

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
  const config = { get: jest.fn().mockReturnValue(opts.scheduleEnabled ?? true) };
  const prisma = {
    job: {
      findFirst: jest.fn(async ({ where }: { where: { subjectId?: string } }) =>
        (opts.active ?? []).includes(where.subjectId ?? '') ? { id: `job-${where.subjectId}`, status: 'pending' } : null,
      ),
    },
  };
  const jobs = { enqueue: jest.fn(async (input: { subjectId: string }) => ({ id: `new-${input.subjectId}` })) };
  const repository = { ownersNeedingMigration: jest.fn().mockResolvedValue(opts.owners ?? []) };
  const task = new KgMigrateSchedulerTask(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    jobs as unknown as JobsService,
    repository as unknown as KgMigrateRepository,
    opts.definition ?? fixtureDefinition(),
  );
  return { task, config, prisma, jobs, repository };
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

    expect(config.get).toHaveBeenCalledWith('kgMigrate.scheduleEnabled');
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
    const { task, jobs, prisma } = harness({ owners: [A, B], active: [A] });

    await task.handleCron();

    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: KG_MIGRATE_JOB_TYPE, subjectType: 'user', subjectId: A }) }),
    );
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectId: B }));
  });

  it('never throws out of the cron', async () => {
    const { task, repository } = harness();
    repository.ownersNeedingMigration.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
