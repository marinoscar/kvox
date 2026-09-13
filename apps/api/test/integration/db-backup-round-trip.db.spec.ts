// =============================================================================
// Real-Postgres test: a genuine `pg_dump` round trip through the streaming
// backup engine (issue #290, epic #254, Phase 8)
// =============================================================================
//
// EVIDENCE FOR EPIC #254'S SUCCESS CRITERION 10: a backup marked `completed`
// is provably an archive `pg_restore` can read, not merely a row that says
// so.
//
// `db-backup-runner.service.spec.ts` proves the ORCHESTRATION — the ordering
// of the heartbeat, the metering transform, the two-way `Promise.all`, the
// failure/verify/prune sequencing — against a `DatabaseBackupEngine` double
// that never spawns a real process. `db-backup-active-index.db.spec.ts`
// proves the single-active-run INDEX against real Postgres, with two real
// connections racing an insert. NEITHER runs a real `pg_dump`. This suite is
// the one that does: `DatabaseBackupRunnerService` is constructed with its
// REAL engine (`systemDatabaseBackupEngine` — actual `pg_dump -Fc`, actual
// `pg_restore --list`) and a storage provider that genuinely streams to
// local disk (`TmpDirStorageProvider`), and it backs up THIS suite's own
// reachable database.
//
// ⚠ IT NOW DRIVES THROUGH THE QUEUE, NOT AROUND IT (issue #351, epic #345).
// The dump is a `db.backup.run` job, so proving "a backup completes" by
// calling the runner directly would prove it about a path production no
// longer takes. Every backup in this file goes enqueue → REAL claim
// (`JobClaimService`, `FOR UPDATE SKIP LOCKED`, `attempts` charged, the lease
// derived from the handler's own six-hour profile) → the REAL handler →
// REAL settle (`JobTerminalService`). The only piece deliberately left out is
// `JobWorker`'s poll timer, which is a loop around exactly the two calls this
// file makes by hand and which `job.worker.spec.ts` already owns.
//
// THE ASSERTION THAT MATTERS IS NOT `status === 'completed'`. Asserting only
// that proves the bookkeeping — see this file's own runner's header, "VERIFY
// WHAT ARRIVED, NOT WHAT WE SENT". This suite additionally, and
// INDEPENDENTLY of the runner's own verification, downloads the stored
// object back out of the tmp-dir provider and runs `pg_restore --list` over
// it itself, and recomputes its sha256 and compares it to what the row
// recorded — so a runner that flipped `completed` without ever truly
// checking would still be caught here even if its own internal check were
// deleted.
//
// A REAL `pg_dump` OF THIS SUITE'S OWN DATABASE IS SAFE: `pg_dump` never
// writes to the database it reads. Nothing in this file creates, drops or
// renames anything at the database level — see
// `database-restore-round-trip.db.spec.ts` for the suite that does, and for
// why THAT one needs a throwaway database instead.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db` (CI's `smoke` job — no new service container; see
// `docs/TESTING.md`). See `../jobs/db-test-support.ts`.
//
// MEASURED WALL CLOCK: ~1.5s for this file alone (a real `pg_dump`/
// `pg_restore --list` pair against this suite's small database). See
// `docs/TESTING.md` for the whole real-Postgres suite's budget.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, PrismaClient } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import {
  BACKUP_JOB_TYPE,
  DatabaseBackupRunnerService,
  type DatabaseBackupEngine,
} from '../../src/db-backup/db-backup-runner.service';
import { DatabaseBackupAlreadyRunningError } from '../../src/db-backup/db-backup.errors';
import { DatabaseBackupRunHandler } from '../../src/db-backup/handlers/db-backup-run.handler';
import { buildClaimLeases } from '../../src/jobs/job-execution-profile';
import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { spawnPgDump } from '../../src/db-backup/pg-dump.util';
import { readTocEntryCount } from '../../src/db-backup/pg-restore.util';
import { PgJobRoleBroker } from '../../src/db-backup/pg-job-role.broker';
import { checkPgClientVersion, readServerVersionNumWithPgClient } from '../../src/db-backup/pg-version.util';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

/**
 * The real engine, but pointed at `POSTGRES_*` with `DATABASE_URL` stripped —
 * the same discipline `db-test-support.ts`'s `createDbClient` documents at
 * length: `test/setup.ts` loads `.env.test`, which hard-codes a
 * `DATABASE_URL` for the port-5433 compose test database, and it would win
 * over the `POSTGRES_*` variables the reachability probe just verified.
 * `systemDatabaseBackupEngine` itself has no `env` seam (production always
 * spawns against `process.env`, deliberately — see its own file), so this
 * suite builds the equivalent engine with the override applied.
 */
function realEngineWithoutDatabaseUrl(): DatabaseBackupEngine {
  const { DATABASE_URL: _ignored, ...env } = process.env;

  return {
    startDump: ({ compressionLevel, timeoutMs }) => spawnPgDump({ compressionLevel, timeoutMs, env }),
    readTocEntryCount: (source) => readTocEntryCount({ source }),
    checkClientVersion: () =>
      checkPgClientVersion({ readServerVersionNum: () => readServerVersionNumWithPgClient({ env }) }),
  };
}

const { describeWithDb } = resolveDbSuite('db-backup-round-trip.db.spec');

describeWithDb('A real pg_dump round trip through the backup engine', () => {
  let prisma: PrismaClient;
  let baseDir: string;
  let storage: TmpDirStorageProvider;
  let runner: DatabaseBackupRunnerService;
  let claimer: JobClaimService;
  let terminal: JobTerminalService;
  let registry: JobHandlerRegistry;
  let config: ConfigService;
  let handler: DatabaseBackupRunHandler;
  let settingsService: SystemSettingsService;

  /** Every backup run this suite creates, so cleanup is exact and exhaustive. */
  const createdRunIds: string[] = [];
  /** Every `db.backup.run` job it queued, likewise. */
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    baseDir = join(tmpdir(), `db-backup-round-trip-${process.pid}-${randomUUID()}`);
    storage = new TmpDirStorageProvider(baseDir);

    const settings = {
      getDatabaseBackupPolicy: async () => DEFAULT_SYSTEM_SETTINGS.databaseBackup,
    } as unknown as SystemSettingsService;
    settingsService = settings;

    // ⚠ RETENTION IS NOT A COLLABORATOR OF THE RUNNER ANY MORE (#353, epic
    // #345). It used to be stubbed here, deliberately: the real service prunes
    // by count across EVERY `completed` row in `database_backup_runs`, which in
    // a database shared with the other `*.db.spec.ts` suites (and, locally, a
    // developer's own data) could delete a backup this suite did not create.
    // The runner now ENQUEUES `db.backup.sweep` instead of pruning, so the
    // hazard is gone with the stub: this suite's real `JobsService` writes a
    // pending row that nothing in this file claims, and the sweep's own rules
    // are covered by `db-backup-sweep.handler.spec.ts` and
    // `db-backup-retention.service.spec.ts`.

    const notifications = {
      notifyPermissionHolders: async () => undefined,
    } as unknown as NotificationsService;

    // The deployment-wide job defaults. Nothing here should govern
    // `db.backup.run` — the handler's own profile does — and the assertions
    // below say so.
    config = {
      get: (key: string) =>
        key === 'jobs.maxAttempts' ? 3 : key === 'jobs.jobTimeoutMs' ? 600_000 : undefined,
    } as unknown as ConfigService;

    // ⚠ THE REAL QUEUE, NOT A DOUBLE. #351 made the dump a `db.backup.run`
    // job, and a suite that kept calling the runner directly would still pass
    // while proving nothing about the path production now takes: the enqueue,
    // the claim, the handler, the settle. All four are real here, against real
    // Postgres, and only the CLOCK of the worker's poll loop is missing —
    // `JobWorker` itself is a timer around exactly the two calls this file
    // makes by hand.
    const jobs = new JobsService(prisma as unknown as PrismaService);

    runner = new DatabaseBackupRunnerService(
      prisma as unknown as PrismaService,
      settings,
      storage,
      notifications,
      config,
      jobs,
      // The REAL engine (real `pg_dump`, real `pg_restore --list`) — see
      // `realEngineWithoutDatabaseUrl`'s own comment for why the `env`
      // override is the only thing that differs from production's.
      realEngineWithoutDatabaseUrl()
      // No timers override: the real (unref'd) heartbeat timer.
    );

    registry = new JobHandlerRegistry();
    // ⚠ THE REAL BROKER, AND IT IS NEVER CALLED ON THIS PATH (#350). A
    // `db.backup.run` claimed by THIS process dumps with the application's own
    // credentials; the broker exists for a REMOTE executor, which reaches it
    // through `POST /api/nodes/:id/jobs/:jobId/secret` and not through
    // `process()`. Passing the real one rather than a double is the cheaper
    // honesty: if `process()` ever grew a call to it, this suite would mint a
    // role against the real cluster instead of quietly satisfying a stub.
    // Its cluster behaviour is `src/db-backup/pg-job-role.broker.db.spec.ts`.
    handler = new DatabaseBackupRunHandler(
      registry,
      runner,
      // #352: the handler reads `databaseBackup.nodeOffloadEnabled` through
      // this to answer `nodeOffloadEnabled()`. The same stub the runner uses,
      // so both halves see one policy.
      settings,
      new PgJobRoleBroker()
    );
    handler.onModuleInit();

    claimer = new JobClaimService(prisma as unknown as PrismaService);
    terminal = new JobTerminalService(
      prisma as unknown as PrismaService,
      config,
      new ProviderThrottleService(config),
      new EventEmitter2(),
      registry
    );
  });

  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await prisma.databaseBackupRun.deleteMany({ where: { id: { in: createdRunIds } } });
      createdRunIds.length = 0;
    }

    // AFTER the runs, always: `job_id` is `onDelete: SetNull`, so deleting a
    // job first would silently unlink a run row this suite still means to
    // assert on.
    if (createdJobIds.length > 0) {
      await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
      createdJobIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await cleanupTmpDir(baseDir);
  });

  /** Polls a run's row until it leaves `pending`/`running`, or times out. */
  async function awaitSettled(runId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const row = await prisma.databaseBackupRun.findUniqueOrThrow({ where: { id: runId } });

      if (row.status !== 'pending' && row.status !== 'running') return row;
      if (Date.now() >= deadline) {
        throw new Error(`Backup run ${runId} did not settle within ${timeoutMs}ms (still ${row.status}).`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * The whole production path for one backup: enqueue, claim, run, settle.
   *
   * ⚠ THE CLAIM IS THE REAL ONE (`FOR UPDATE SKIP LOCKED`, `attempts`
   * incremented, the lease applied from the type's own profile), and the
   * settle is the real `JobTerminalService`. What is NOT here is `JobWorker`'s
   * poll timer, which is the only part of the worker this file would be
   * testing twice — `job.worker.spec.ts` owns it.
   */
  async function takeQueuedBackup(): Promise<{ job: Job; runId: string }> {
    const queued = await runner.queueBackup({ trigger: 'manual', createdById: null });
    createdRunIds.push(queued.run.id);
    createdJobIds.push(queued.job.id);

    // Queued, and nothing has started: the run row does not claim a `pg_dump`
    // exists before one does.
    expect(queued.run.status).toBe('pending');
    expect(queued.run.startedAt).toBeNull();
    expect(queued.job.type).toBe(BACKUP_JOB_TYPE);

    const [claimed] = await claimer.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [BACKUP_JOB_TYPE],
      limit: 1,
      leases: buildClaimLeases(config, registry, [BACKUP_JOB_TYPE]),
    });

    expect(claimed?.id).toBe(queued.job.id);
    // ⚠ THE LEASE IS THE PROFILE'S, NOT THE DEPLOYMENT DEFAULT'S. This is the
    // objection that used to make a backup unsafe as a queue job: a 30-minute
    // reaper deadline over a multi-hour dump. The claim's lease must sit past
    // the six-hour ceiling, not past ten minutes.
    const leaseMs = (claimed.leaseExpiresAt as Date).getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(6 * 60 * 60 * 1000);

    const handler = registry.get(BACKUP_JOB_TYPE);
    expect(handler).toBeDefined();

    await handler!.process(claimed);

    // ⚠ THE ASSERTION #351 EXISTS FOR, AND THE ONE A THIN WRAPPER WOULD FAIL.
    // `process()` has RETURNED, and the run is ALREADY `completed` and already
    // verified — the job's lifetime is the dump's lifetime, so there is no
    // window in which a `succeeded` job describes a dump still streaming.
    const onReturn = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });
    expect(onReturn.status).toBe('completed');
    expect(onReturn.verifiedAt).not.toBeNull();

    await terminal.completeSucceeded(claimed);

    return { job: claimed, runId: queued.run.id };
  }

  it('produces a `completed` run whose stored object is a real, independently-verifiable archive', async () => {
    const { job, runId } = await takeQueuedBackup();

    const settled = await awaitSettled(runId);

    // The two rows, and the link between them. `job_id` is what lets a run
    // found in this table be traced back to who asked for it and which attempt
    // produced it; `succeeded` is what makes the backup visible in
    // `GET /api/admin/jobs` and in insights at all.
    expect(settled.jobId).toBe(job.id);
    const settledJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(settledJob.status).toBe('succeeded');
    // One attempt, charged at claim time, and never a second one.
    expect(settledJob.attempts).toBe(1);

    // --- The bookkeeping half ------------------------------------------------
    expect(settled.status).toBe('completed');
    expect(settled.checksumSha256).not.toBeNull();
    expect(settled.verifiedAt).not.toBeNull();
    expect(settled.sizeBytes).toBeGreaterThan(0n);
    expect(settled.lastError).toBeNull();

    // --- The independent half: read the object back OURSELVES, not through --
    // --- any method the runner itself calls, and prove it is a real archive -
    const downloaded = await storage.download(settled.storageKey);

    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded as AsyncIterable<Buffer>) {
      hash.update(chunk);
      chunks.push(chunk);
    }
    const recomputedSha256 = hash.digest('hex');
    const bytes = Buffer.concat(chunks);

    // The row's checksum is not merely present — it is the ACTUAL sha256 of
    // the bytes that ended up in storage, recomputed here from scratch.
    expect(recomputedSha256).toBe(settled.checksumSha256);
    expect(BigInt(bytes.length)).toBe(settled.sizeBytes);

    // And it is a readable custom-format `pg_dump` archive with a non-empty
    // table of contents — the assertion that actually distinguishes "a real
    // backup" from "a file that happens to exist at the right key". A fresh
    // stream, from a freshly re-downloaded copy: this must not reuse
    // anything the runner itself already computed.
    const redownloaded = await storage.download(settled.storageKey);
    const tocEntries = await readTocEntryCount({ source: redownloaded });
    expect(tocEntries).toBeGreaterThan(0);
  });

  it('never auto-retries a failed dump: one attempt, terminally failed, nothing rescheduled', async () => {
    // ⚠ THE THIRD OBJECTION, PROVEN AGAINST REAL POSTGRES WITH THE REAL
    // PROFILE. `JobTerminalService` reads `maxAttempts` through
    // `resolveMaxAttempts(config, registry.get(type))`, so what decides this
    // is the handler's own `maxAttempts: 1` and not the deployment default of
    // 3 that `config` above deliberately reports. A backup that failed must
    // not be re-run unattended against a database that is probably already
    // unwell; the retry is the next scheduled one.
    const queued = await runner.queueBackup({ trigger: 'manual', createdById: null });
    createdRunIds.push(queued.run.id);
    createdJobIds.push(queued.job.id);

    const [claimed] = await claimer.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [BACKUP_JOB_TYPE],
      limit: 1,
      leases: buildClaimLeases(config, registry, [BACKUP_JOB_TYPE]),
    });

    // The dump is not run at all here: what is under test is what the queue
    // does with a failure, and spawning a real `pg_dump` only to break it
    // would test `pg_dump`.
    await terminal.completeFailed(claimed, new Error('pg_dump exited 1'));

    const settledJob = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(settledJob.status).toBe('failed');
    expect(settledJob.attempts).toBe(1);
    // Not 'pending' with a backoff: `scheduled_for` is what a retry would be
    // written as, and there must not be one.
    expect(settledJob.scheduledFor).toBeNull();
    expect(settledJob.lastError).toContain('pg_dump exited 1');

    // ⚠ THE RUN ROW IS STILL `pending`, AND THAT IS A REAL STATE RATHER THAN
    // AN OVERSIGHT. This job failed before its handler ever touched the row,
    // so nothing wrote a terminal status onto it — and under the tightened
    // `database_backup_runs_active_uniq_idx` that leftover row HOLDS THE
    // SINGLE ACTIVE SLOT across `pending` and `running` combined. Both halves
    // are asserted, because the second is what the stale sweep's new `pending`
    // arm exists to resolve.
    const stranded = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });
    expect(stranded.status).toBe('pending');

    await expect(
      runner.queueBackup({ trigger: 'scheduled', createdById: null })
    ).rejects.toBeInstanceOf(DatabaseBackupAlreadyRunningError);

    // Released the way `releaseStaleRuns` releases it (aged by `createdAt`,
    // since a pending row has neither a start nor a heartbeat) — and the next
    // backup queues normally, with a fresh job under the same dedup key.
    await prisma.databaseBackupRun.update({
      where: { id: queued.run.id },
      data: { status: 'stale' },
    });

    const next = await runner.queueBackup({ trigger: 'scheduled', createdById: null });
    createdRunIds.push(next.run.id);
    createdJobIds.push(next.job.id);
    expect(next.job.id).not.toBe(claimed.id);
  });

  it('records provenance: db version, app version and the migration ledger name', async () => {
    const { runId } = await takeQueuedBackup();

    const settled = await awaitSettled(runId);

    expect(settled.status).toBe('completed');
    expect(settled.dbVersion).not.toBeNull();
    expect(settled.appVersion).not.toBeNull();
    expect(settled.migrationName).not.toBeNull();
    // #352: which `pg_dump` wrote the archive. On this path it is the client
    // in this image; on the node path it is the node's, reported back — and a
    // column populated on one path and empty on the other is a column nobody
    // trusts.
    expect(settled.pgDumpVersion).not.toBeNull();
  });

  // ===========================================================================
  // The NODE path, against the same real binaries (#352, epic #345)
  // ===========================================================================
  //
  // ⚠ WHAT THIS PROVES THAT NO UNIT TEST CAN. `db-backup-runner.service.spec.ts`
  // asserts that both executors reach one `completeRun` against a fake engine
  // and a fake bucket. This asserts the thing that actually matters to an
  // operator: an archive produced the way a NODE produces it — a real
  // `pg_dump`, streamed to the run's own key, reported back over the result
  // contract — is verified by the SERVER with a real `pg_restore --list`, and
  // lands as a row indistinguishable from one this process dumped itself.
  //
  // The "node" here is the last few lines of `apps/cli`'s executor, inlined:
  // ask for the key, stream a dump into it, hash and count as the bytes pass,
  // report. Its own half is unit-tested in `apps/cli`; what could only be
  // wrong across the boundary is whether the two halves agree, which is this.

  /** Streams a real `pg_dump` into `key`, exactly as the CLI executor does. */
  async function dumpToKeyLikeANode(key: string): Promise<{ bytes: bigint; sha256: string }> {
    const dump = realEngineWithoutDatabaseUrl().startDump({
      compressionLevel: DEFAULT_SYSTEM_SETTINGS.databaseBackup.compressionLevel,
      timeoutMs: 120_000,
    });

    const hash = createHash('sha256');
    let bytes = 0n;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += BigInt(chunk.length);
        callback(null, chunk);
      },
    });

    dump.stdout.pipe(meter);

    // Both halves, exactly as the executor awaits them: a dump that died
    // mid-archive ends its stdout, and the upload alone would call that a
    // success.
    await Promise.all([
      storage.upload(key, meter, { mimeType: 'application/octet-stream' }),
      dump.done,
    ]);

    return { bytes, sha256: hash.digest('hex') };
  }

  it('accepts a node-taken backup: real archive, server-side verification, one row shape', async () => {
    const queued = await runner.queueBackup({ trigger: 'manual', createdById: null });
    createdRunIds.push(queued.run.id);
    createdJobIds.push(queued.job.id);

    const [claimed] = await claimer.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [BACKUP_JOB_TYPE],
      limit: 1,
      leases: buildClaimLeases(config, registry, [BACKUP_JOB_TYPE]),
    });

    // 1. The node asks where to write. The server answers with the RUN'S OWN
    //    key — not `node-outputs/…`, which is where the data plane's default
    //    would have put an archive the restore path could never find.
    const key = await handler.deriveOutputKey(claimed);
    expect(key).toBe(queued.run.storageKey);

    // …and asking twice yields the same key rather than a second archive.
    expect(await handler.deriveOutputKey(claimed)).toBe(key);

    // The row moved to `running` on the first ask: that request is the only
    // moment this server learns a remote executor has begun.
    const started = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });
    expect(started.status).toBe('running');
    expect(started.startedAt).not.toBeNull();

    // 2. The node dumps and uploads. Nothing about this touches the run row.
    const produced = await dumpToKeyLikeANode(key);

    // 3. The node posts its result, through the handler's own parse — the same
    //    call `NodesService.submitResult` makes.
    await handler.persistNodeResult(claimed, {
      storageKey: key,
      // ⚠ A DECIMAL STRING, all the way through to a `BigInt` column.
      bytes: produced.bytes.toString(),
      sha256: produced.sha256,
      pgDumpVersion: 'pg_dump (PostgreSQL) 17.2',
      dbVersion: 'PostgreSQL 17.4 (reported by the node)',
      migrationName: 'reported_by_the_node',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    await terminal.completeSucceeded(claimed);

    const settled = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });

    expect(settled.status).toBe('completed');
    // ⚠ SET BY THE SERVER'S OWN READ-BACK. `persistNodeResult` downloaded the
    // object and ran `pg_restore --list` over it; the node's word for it was
    // never sufficient.
    expect(settled.verifiedAt).not.toBeNull();
    // The node's numbers, stored exactly.
    expect(settled.sizeBytes).toBe(produced.bytes);
    expect(settled.bytesWritten).toBe(produced.bytes);
    expect(settled.checksumSha256).toBe(produced.sha256);
    // The node's provenance, and the API's own app version beside it.
    expect(settled.pgDumpVersion).toBe('pg_dump (PostgreSQL) 17.2');
    expect(settled.migrationName).toBe('reported_by_the_node');
    expect(settled.appVersion).not.toBeNull();
    expect(settled.lastError).toBeNull();

    // And the archive really is one: read it back INDEPENDENTLY, not through
    // anything the runner calls.
    const stored = await storage.download(settled.storageKey);
    expect(await readTocEntryCount({ source: stored })).toBeGreaterThan(0);

    const settledJob = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(settledJob.status).toBe('succeeded');
  });

  it('REFUSES a result naming a key the server did not hand out, and fails the run', async () => {
    const queued = await runner.queueBackup({ trigger: 'manual', createdById: null });
    createdRunIds.push(queued.run.id);
    createdJobIds.push(queued.job.id);

    const [claimed] = await claimer.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [BACKUP_JOB_TYPE],
      limit: 1,
      leases: buildClaimLeases(config, registry, [BACKUP_JOB_TYPE]),
    });

    const key = await handler.deriveOutputKey(claimed);
    await dumpToKeyLikeANode(key);

    // A node may only report the key it was given. Anything else is a confused
    // executor or an attempt to point this deployment's restore path at bytes
    // of somebody else's choosing — neither is corrected by trusting it.
    await expect(
      handler.persistNodeResult(claimed, {
        storageKey: 'backups/somebody-elses-archive.dump',
        bytes: '1',
        sha256: 'c'.repeat(64),
        pgDumpVersion: null,
        dbVersion: null,
        migrationName: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/may only report the key the server handed it/);

    const failed = await prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: queued.run.id },
    });

    expect(failed.status).toBe('failed');
    expect(failed.verifiedAt).toBeNull();
    // A `failed` run leaves no object behind, or the bucket accumulates
    // archives nothing points at and retention has no row to prune them by.
    //
    // READ THROUGH THE STREAM, not just `download()`: this provider opens the
    // file lazily, so the promise resolves for a key that is already gone and
    // only the first read reports it. That is exactly how a real provider's
    // 404 arrives too.
    await expect(
      (async () => {
        const stream = await storage.download(key);
        for await (const chunk of stream as AsyncIterable<Buffer>) void chunk;
      })()
    ).rejects.toBeDefined();
  });

  it('offers the type to a node only when this deployment has said so', async () => {
    // `nodeOffloadEnabled()` is what `NodesService.nodeEligibleTypes` asks at
    // claim time. The stubbed policy is `DEFAULT_SYSTEM_SETTINGS`, which ships
    // OFF — so the shipped answer, against the real handler, is "no".
    await expect(handler.nodeOffloadEnabled()).resolves.toBe(false);
    expect(DEFAULT_SYSTEM_SETTINGS.databaseBackup.nodeOffloadEnabled).toBe(false);

    // …and it is READ, not remembered: flipping the policy flips the answer
    // with no restart. Restored afterwards, because this stub is shared with
    // the runner and a leaked override would make a later case depend on the
    // order this file happens to run in.
    const stub = settingsService as unknown as {
      getDatabaseBackupPolicy: () => Promise<unknown>;
    };
    const original = stub.getDatabaseBackupPolicy;
    const policy = { ...DEFAULT_SYSTEM_SETTINGS.databaseBackup, nodeOffloadEnabled: true };

    try {
      stub.getDatabaseBackupPolicy = async () => policy;

      await expect(handler.nodeOffloadEnabled()).resolves.toBe(true);
    } finally {
      stub.getDatabaseBackupPolicy = original;
    }
  });
});
