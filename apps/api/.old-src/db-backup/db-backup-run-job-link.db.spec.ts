// =============================================================================
// Real-Postgres test: database_backup_runs.job_id, its UNIQUE index and the
// jobs FK's ON DELETE SET NULL behaviour (issue #351, epic #345)
// =============================================================================
//
// `DatabaseBackupRun.jobId` is declared `@unique`, nullable, with
// `onDelete: SetNull` — see the block comment above `DatabaseBackupRun.jobId`
// in `prisma/schema.prisma` for why each of those three is load-bearing:
//
//   1. `@unique` is what makes a SECOND run row for one job unrepresentable
//      (a re-derived node upload key must find at most one existing run).
//   2. Nullable, because the `pre_restore` path and pre-migration rows have
//      no job at all.
//   3. `onDelete: SetNull`, NOT `Cascade`, because `job.history.purge`'s
//      retention schedule is independent of the archive's own retention —
//      deleting a `jobs` row must release the link, never delete the run.
//
// None of that is provable by a unit test: a unique constraint's actual
// enforcement and a foreign key's ON DELETE behaviour only exist once a
// migration has run against a real database. So, like
// `db-backup-active-index.db.spec.ts` and
// `test/nodes/worker-node-schema.db.spec.ts` (whose `Job.claimedByNode`
// SetNull assertion this file's shape directly mirrors), this is a
// `*.db.spec.ts` file, excluded from `npm test`/`test:unit`/`test:cov`/
// `test:ci` and run only via `npm run test:db`. See
// `../../test/jobs/db-test-support.ts`.
// =============================================================================

import { PrismaClient } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../../test/jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('db-backup-run-job-link.db.spec');

describeWithDb('DatabaseBackupRun.jobId (real Postgres)', () => {
  let prisma: PrismaClient;

  /**
   * Every row this suite creates carries this marker in `bucket` (for runs)
   * or `type` (for jobs), so cleanup deletes only its own — a shared CI
   * database may legitimately hold rows this suite did not write.
   */
  const MARKER = `test.backup-job-link.${process.pid}`;

  // `status: 'completed'` by default, deliberately NOT 'pending'/'running':
  // this file is about the `job_id` link, not the single-active-run guard
  // (that is `db-backup-active-index.db.spec.ts`'s job), and several tests
  // below create multiple run rows side by side. Defaulting to an active
  // status would make those inserts collide with
  // `database_backup_runs_active_uniq_idx` (tightened by this same migration
  // to admit only one active row at all) and fail for the WRONG reason,
  // masking whatever `job_id` behaviour the test actually means to prove.
  const runRow = (key: string, overrides: Record<string, unknown> = {}) => ({
    status: 'completed' as const,
    trigger: 'manual' as const,
    storageProvider: 'test',
    storageKey: `${MARKER}/${key}`,
    bucket: MARKER,
    format: 'custom',
    ...overrides,
  });

  const jobRow = (overrides: Record<string, unknown> = {}) => ({
    type: MARKER,
    reason: 'backfill' as const,
    status: 'pending' as const,
    ...overrides,
  });

  const cleanup = async (): Promise<void> => {
    await prisma?.databaseBackupRun.deleteMany({ where: { bucket: MARKER } });
    await prisma?.job.deleteMany({ where: { type: MARKER } });
  };

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  it('creates the job_id column, its UNIQUE index, and the FK to jobs with ON DELETE SET NULL', async () => {
    const indexRows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'database_backup_runs' AND indexname = 'database_backup_runs_job_id_key'
    `;
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexRows[0].indexdef).toContain('job_id');

    const fkRows = await prisma.$queryRaw<
      Array<{ constraint_name: string; delete_rule: string; update_rule: string }>
    >`
      SELECT rc.constraint_name, rc.delete_rule, rc.update_rule
      FROM information_schema.referential_constraints rc
      WHERE rc.constraint_name = 'database_backup_runs_job_id_fkey'
    `;
    expect(fkRows).toHaveLength(1);
    expect(fkRows[0].delete_rule).toBe('SET NULL');

    const columnRows = await prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'database_backup_runs' AND column_name = 'job_id'
    `;
    expect(columnRows).toHaveLength(1);
    expect(columnRows[0].is_nullable).toBe('YES');
    expect(columnRows[0].column_default).toBeNull();
  });

  it('allows a run with a null job_id (the pre_restore / pre-migration case)', async () => {
    const run = await prisma.databaseBackupRun.create({ data: runRow('no-job') });
    expect(run.jobId).toBeNull();
  });

  it('links a run to a job and reads the relation back both ways', async () => {
    const job = await prisma.job.create({ data: jobRow() });
    const run = await prisma.databaseBackupRun.create({
      data: runRow('linked', { jobId: job.id }),
    });

    expect(run.jobId).toBe(job.id);

    const reloadedRun = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { job: true },
    });
    expect(reloadedRun.job?.id).toBe(job.id);

    const reloadedJob = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
      include: { backupRun: true },
    });
    expect(reloadedJob.backupRun?.id).toBe(run.id);
  });

  it('rejects a second run pointing at the same job (the unique index at work)', async () => {
    const job = await prisma.job.create({ data: jobRow() });
    await prisma.databaseBackupRun.create({ data: runRow('first', { jobId: job.id }) });

    await expect(
      prisma.databaseBackupRun.create({ data: runRow('second', { jobId: job.id }) })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows any number of runs with a NULL job_id (uniqueness does not apply to NULL)', async () => {
    const first = await prisma.databaseBackupRun.create({ data: runRow('null-a') });
    const second = await prisma.databaseBackupRun.create({ data: runRow('null-b') });

    expect(first.jobId).toBeNull();
    expect(second.jobId).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it('sets job_id to NULL on the run when its job is deleted, rather than deleting the run', async () => {
    const job = await prisma.job.create({ data: jobRow() });
    const run = await prisma.databaseBackupRun.create({
      data: runRow('survives-purge', { jobId: job.id, status: 'completed' }),
    });

    // The scenario this test proves: `job.history.purge` deletes a `jobs` row
    // on a schedule wholly independent of the archive's retention. Deleting
    // the job here stands in for that purge.
    await prisma.job.delete({ where: { id: job.id } });

    const reloaded = await prisma.databaseBackupRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(reloaded.jobId).toBeNull();
    // The run row itself — and everything it records about the archive —
    // survives. Losing the link is acceptable; losing the run row is not.
    expect(reloaded.id).toBe(run.id);
    expect(reloaded.status).toBe('completed');
  });
});
