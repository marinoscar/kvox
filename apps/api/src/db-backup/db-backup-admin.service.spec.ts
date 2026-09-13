import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DatabaseBackupRun } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import {
  BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS,
  DatabaseBackupAdminService,
} from './db-backup-admin.service';
import type { DatabaseBackupRunnerService } from './db-backup-runner.service';
import { ACTIVE_RUN_STATUSES } from './db-backup-runner.service';
import type {
  DatabaseRestoreService,
  RestoreRollbackResult,
  StartRestoreOptions,
  StartRestoreResult,
} from './database-restore.service';
import {
  DatabaseBackupAlreadyRunningError,
  DatabaseBackupStorageProviderError,
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreRunNotFoundError,
} from './db-backup.errors';
import type { JobRolePreflightResult } from './pg-job-role.broker';
import type { PgJobRoleBroker } from './pg-job-role.broker';
import type { RestorePreflightResult } from './restore-preflight.service';
import { ACTIVE_BACKUP_STATUSES, toRunDto } from './dto/db-backup-run.dto';

// =============================================================================
// The admin surface's acceptance criteria (issue #283, epic #254)
// =============================================================================
//
// What this file proves is what the SERVICE DECIDES: which values are refused
// before a settings write, what `nextRunAt` projects to across a DST boundary,
// the order in which a delete removes an archive and a row, and that every path
// returning a run converts its two `BigInt` columns.
//
// What it deliberately does NOT prove is anything that only a request pipeline
// can answer — that a 409's `details.activeRunId` SURVIVES THE EXCEPTION
// FILTER, that the guards enforce the permissions the decorators name, that a
// literal route resolves ahead of a parameterised one. Those live in
// `test/db-backup/db-backup-admin.integration.spec.ts`, and the reason is
// stated there: `exception.getResponse()` returns the payload BEFORE the filter
// rebuilds the body, so an assertion here about a thrown exception's shape
// would pass with the filter deleted.
//
// Everything runs against small hand-written doubles rather than the Nest
// testing module, because none of these criteria needs a container: they are
// statements about which collaborator is called, with what, and in what order.
// =============================================================================

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: 's3',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PRE_RESTORE_ID = '44444444-4444-4444-8444-444444444444';

/**
 * A pre-flight verdict, in whichever of the three shapes a case needs.
 *
 * Hand-built rather than produced by the real service: what these tests are
 * about is what the ADMIN service does with a verdict, and probing a cluster to
 * obtain one would make every case here depend on a live PostgreSQL.
 */
function preflight(outcome: 'ok' | 'guided' | 'blocked'): RestorePreflightResult {
  const base = {
    runId: RUN_ID,
    targetDatabase: 'appdb',
    scratchDatabase: 'appdb_restore_20260907T030000Z',
    oldDatabase: 'appdb_old_20260907T030000Z',
    gates: [],
    rollback: {
      configured: 'retain_database' as const,
      effective: 'retain_database' as const,
      downgraded: false,
      reason: null,
    },
    archiveMigration: '20260907120000_add_database_backup_runs',
    liveMigration: '20260907120000_add_database_backup_runs',
    databaseSizeBytes: '1024',
    freeDiskBytes: null,
  };

  if (outcome === 'guided') {
    return {
      ...base,
      outcome: 'guided',
      guidance: {
        reason: 'The connecting role lacks CREATEDB.',
        commands: 'createdb ...',
        runbook: 'docs/runbooks/database-restore.md',
      },
    };
  }

  if (outcome === 'blocked') {
    return {
      ...base,
      outcome: 'blocked',
      block: {
        gateId: 'schema_compatibility',
        message: 'The archive predates the live schema.',
        overridable: true,
        overrideParameter: 'overrideSchemaCheck',
      },
    };
  }

  return { ...base, outcome: 'ok' };
}

/**
 * A run row with genuinely large `BigInt` values.
 *
 * The sizes are above 2^32 on purpose: they are the reason the columns are
 * `BigInt` at all, and a fixture using small numbers would let a `Number()`
 * conversion pass every assertion in this file.
 */
function run(overrides: Partial<DatabaseBackupRun> = {}): DatabaseBackupRun {
  return {
    id: RUN_ID,
    status: 'completed',
    trigger: 'manual',
    startedAt: new Date('2026-09-07T02:00:00.000Z'),
    finishedAt: new Date('2026-09-07T02:41:00.000Z'),
    lastHeartbeatAt: new Date('2026-09-07T02:41:00.000Z'),
    bytesWritten: 9_007_199_254_740_993n,
    sizeBytes: 9_007_199_254_740_993n,
    storageProvider: 's3',
    storageKey: 'database-backups/app/2026/09/app-20260907T020000Z-run.dump',
    bucket: 'backups',
    format: 'custom',
    checksumSha256: 'abc123',
    dbVersion: '16.4',
    appVersion: '1.0.0',
    migrationName: '20260907120000_add_database_backup_runs',
    verifiedAt: new Date('2026-09-07T02:41:00.000Z'),
    lastError: null,
    createdById: USER_ID,
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    createdAt: new Date('2026-09-07T02:00:00.000Z'),
    updatedAt: new Date('2026-09-07T02:41:00.000Z'),
    ...overrides,
  } as DatabaseBackupRun;
}

interface HarnessOptions {
  policy?: Partial<SystemDatabaseBackupValue>;
  rows?: DatabaseBackupRun[];
  storageDelete?: (key: string) => Promise<void>;
  /**
   * #351: the runner now ENQUEUES rather than claiming. The double returns
   * `{ run, job }` because that is what `queueBackup` returns — the admin
   * service logs the job id and answers with the run.
   */
  queueBackup?: (input: unknown) => Promise<{ run: DatabaseBackupRun; job: { id: string } }>;
  cancel?: () => { outcome: 'signalled' | 'not_running_here'; runId: string };
  /** What the (substituted) restore engine answers. #286's two routes. */
  startRestore?: (
    run: DatabaseBackupRun,
    options: StartRestoreOptions
  ) => Promise<StartRestoreResult>;
  rollback?: (
    run: DatabaseBackupRun,
    actorUserId: string | null
  ) => Promise<RestoreRollbackResult>;
  /** #350: what the PostgreSQL job-role broker's capability probe concludes. */
  jobRolePreflight?: () => Promise<JobRolePreflightResult>;
  /** #350: the `nodes` policy half of the node-credential pre-flight. */
  nodesPolicy?: Record<string, unknown> | null;
}

function harness(options: HarnessOptions = {}) {
  const rows = options.rows ?? [run()];
  const policy: SystemDatabaseBackupValue = { ...POLICY, ...options.policy };

  /** One shared, ordered log. "Object then row" is a statement about interleaving. */
  const calls: string[] = [];

  const stored = { ...policy };
  const patches: unknown[] = [];

  const prisma = {
    databaseBackupRun: {
      findUnique: jest.fn(async ({ where }: any) => {
        return rows.find((row) => row.id === where.id) ?? null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const active: string[] = where?.status?.in ?? [];

        return rows.find((row) => active.includes(row.status)) ?? null;
      }),
      findMany: jest.fn(async ({ where, skip = 0, take = 20 }: any) => {
        return rows
          .filter((row) => (where?.status ? row.status === where.status : true))
          .filter((row) => (where?.trigger ? row.trigger === where.trigger : true))
          .slice(skip, skip + take);
      }),
      count: jest.fn(async ({ where }: any) =>
        rows
          .filter((row) => (where?.status ? row.status === where.status : true))
          .filter((row) => (where?.trigger ? row.trigger === where.trigger : true)).length
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        calls.push(`row:${where.id}`);
        const index = rows.findIndex((row) => row.id === where.id);

        if (index === -1) return { count: 0 };
        rows.splice(index, 1);

        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => ({ ...stored })),
    // #350's pre-flight reads the POLICY half through this narrow accessor —
    // the same one the fleet crons and the claim path use, so this suite
    // exercises the real read path rather than a second one.
    getNodesPolicy: jest.fn(async () =>
      options.nodesPolicy === undefined ? { jobSecretBrokerEnabled: true } : options.nodesPolicy
    ),
    patchSettings: jest.fn(async (dto: any) => {
      patches.push(dto);
      Object.assign(stored, dto.databaseBackup ?? {});

      return undefined;
    }),
  } as unknown as SystemSettingsService;

  const storage = {
    delete: jest.fn(async (key: string) => {
      calls.push(`object:${key}`);
      if (options.storageDelete) await options.storageDelete(key);
    }),
    getSignedDownloadUrl: jest.fn(
      async (key: string) => `https://storage.example/${key}?signed`
    ),
  } as unknown as StorageProvider;

  const runner = {
    // The REAL rule, not a re-implementation: the admin service is supposed to
    // call this rather than compare provider names itself, so the double
    // forwards to the same pure helper the runner does.
    assertStorageProviderUsable: jest.fn((configured: string | null | undefined) => {
      const trimmed = (configured ?? '').trim();

      if (trimmed !== '' && trimmed.toLowerCase() !== 's3') {
        throw new DatabaseBackupStorageProviderError(trimmed, 's3');
      }
    }),
    queueBackup: jest.fn(
      options.queueBackup ??
        // `pending`, not `running`: nothing has started until a worker claims
        // the job, and #351 made the row say so.
        (async () => ({ run: run({ status: 'pending' }), job: { id: 'job-1' } }))
    ),
    cancel: jest.fn(options.cancel ?? (() => ({ outcome: 'signalled', runId: RUN_ID }))),
  } as unknown as DatabaseBackupRunnerService;

  // ⚠ THE RESTORE ENGINE IS SUBSTITUTED, and it has to be: the real one creates
  // databases, spawns `pg_restore` and ends by calling `process.exit`. What is
  // being proven here is what the ADMIN service decides before and after it —
  // the lookup, the `completed`-only rule, the actor, and the exact options it
  // forwards. `database-restore.service.spec.ts` proves the engine itself
  // against its own seam.
  const restore = {
    startRestore: jest.fn(
      options.startRestore ??
        (async (row: DatabaseBackupRun) => ({
          outcome: 'started' as const,
          runId: row.id,
          scratchDatabase: 'appdb_restore_20260907T030000Z',
          oldDatabase: 'appdb_old_20260907T030000Z',
          preflight: preflight('ok'),
        }))
    ),
    rollback: jest.fn(
      options.rollback ??
        (async (row: DatabaseBackupRun) => ({
          outcome: 'renamed' as const,
          runId: row.id,
          promoted: 'appdb_old_20260907T030000Z',
          parked: 'appdb_restore_20260907T040000Z',
        }))
    ),
  } as unknown as DatabaseRestoreService;

  /**
   * The #350 job-role broker, stubbed to the CAPABLE answer.
   *
   * Only `getNodeCredentialPreflight` reads it, and the broker's own suites own
   * what it decides — `pg-job-role.broker.spec.ts` for the verdict and
   * `pg-job-role.broker.db.spec.ts` for whether the grants it hands out are
   * really enough. What this service adds is the POLICY half and the mapping,
   * and that is what the tests here assert.
   */
  const jobRoles = {
    preflight: jest.fn(
      options.jobRolePreflight ??
        (async () => ({
          outcome: 'ok' as const,
          kind: 'postgres.readonly',
          databaseRole: 'appuser',
          targetDatabase: 'appdb',
          detail: 'This deployment may create roles.',
        }))
    ),
  } as unknown as PgJobRoleBroker;

  const service = new DatabaseBackupAdminService(
    prisma,
    settings,
    runner,
    restore,
    storage,
    jobRoles
  );

  return {
    service,
    prisma,
    settings,
    storage,
    runner,
    restore,
    jobRoles,
    calls,
    patches,
    stored,
    rows,
  };
}

describe('DatabaseBackupAdminService', () => {
  // =========================================================================
  // nextRunAt — the field an operator confirms a schedule with
  // =========================================================================

  // =========================================================================
  // The node-credential pre-flight (#350) — a capability and a policy, kept apart
  // =========================================================================

  describe('getNodeCredentialPreflight', () => {
    it('reports `ok` with the broker\'s verdict and the stored policy', async () => {
      const { service } = harness();

      await expect(service.getNodeCredentialPreflight()).resolves.toEqual({
        outcome: 'ok',
        kind: 'postgres.readonly',
        databaseRole: 'appuser',
        targetDatabase: 'appdb',
        brokerEnabled: true,
        detail: 'This deployment may create roles.',
        // `null` rather than absent, so a client renders one shape.
        guidance: null,
      });
    });

    it('carries the guided command block through untouched', async () => {
      const { service } = harness({
        jobRolePreflight: async () => ({
          outcome: 'guided' as const,
          kind: 'postgres.readonly',
          databaseRole: 'appuser',
          targetDatabase: 'appdb',
          detail: 'This deployment\'s database role may not CREATE ROLE.',
          guidance: {
            reason: 'no CREATEROLE',
            commands: 'ALTER ROLE "appuser" CREATEROLE;',
            runbook: 'docs/runbooks/node-job-secrets.md',
          },
        }),
      });

      const result = await service.getNodeCredentialPreflight();

      // ⚠ NOT AN ERROR, AND NOT REPHRASED. The remedy is the part a person
      // pastes into a terminal; summarising it here would be how a fixable
      // refusal becomes an outage nobody can explain.
      expect(result.outcome).toBe('guided');
      expect(result.guidance).toEqual({
        reason: 'no CREATEROLE',
        commands: 'ALTER ROLE "appuser" CREATEROLE;',
        runbook: 'docs/runbooks/node-job-secrets.md',
      });
    });

    it('reports the POLICY separately from the CAPABILITY — all four combinations are real', async () => {
      const capable = await harness({ nodesPolicy: { jobSecretBrokerEnabled: false } })
        .service.getNodeCredentialPreflight();

      // Capable, but switched off: one toggle away, and an operator sent to the
      // GRANT screen instead would be fixing something that is not broken.
      expect(capable).toMatchObject({ outcome: 'ok', brokerEnabled: false });
    });

    it.each([
      ['a missing key', {}],
      ['the string "true"', { jobSecretBrokerEnabled: 'true' }],
      ['a number', { jobSecretBrokerEnabled: 1 }],
      ['nothing stored at all', null],
    ])('fails closed on %s, matching what the claim path actually acts on', async (_label, policy) => {
      const { service } = harness({ nodesPolicy: policy as Record<string, unknown> | null });

      // ⚠ ONLY A LITERAL `true` ENABLES IT — `NodeLifecycleService.getPolicy`'s
      // rule, restated here because this screen must report the same answer the
      // claim acts on rather than a friendlier one.
      await expect(service.getNodeCredentialPreflight()).resolves.toMatchObject({
        brokerEnabled: false,
      });
    });

    it('asks the broker rather than re-deciding whether the cluster can mint', async () => {
      const { service, jobRoles } = harness();

      await service.getNodeCredentialPreflight();

      // A second implementation of "can we CREATE ROLE?" is how a screen starts
      // saying yes while the claim path says no.
      expect(jobRoles.preflight).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConfig computes nextRunAt', () => {
    it('projects the next daily fire in the configured zone', async () => {
      const { service } = harness({ policy: { timeOfDay: '02:00', timezone: 'UTC' } });

      const config = await service.getConfig(new Date('2026-09-07T12:00:00.000Z'));

      expect(config.nextRunAt).toBe('2026-09-08T02:00:00.000Z');
    });

    it('stays on the same LOCAL time across a spring-forward boundary', async () => {
      // America/New_York moves from UTC-5 to UTC-4 on 2026-03-08. A 02:30 local
      // backup is 07:30Z on the 7th and 06:30Z on the 8th — the SAME wall-clock
      // time, a DIFFERENT number of milliseconds later. A projection that added
      // 86_400_000ms would say 07:30Z and be an hour wrong for the rest of the
      // year, which is the whole reason `nextFireAt` walks civil dates.
      //
      // 02:30 also does not exist on the 8th in that zone (the clock jumps
      // 02:00 → 03:00), so this additionally pins the non-existent-time rule:
      // the run lands at the instant the clock jumped to, rather than being
      // silently skipped for the day.
      const { service } = harness({
        policy: { timeOfDay: '02:30', timezone: 'America/New_York' },
      });

      const beforeTransition = await service.getConfig(
        new Date('2026-03-07T12:00:00.000Z')
      );
      expect(beforeTransition.nextRunAt).toBe('2026-03-08T07:30:00.000Z');

      const acrossTransition = await service.getConfig(
        new Date('2026-03-08T12:00:00.000Z')
      );
      // 02:30 EDT on the 9th = 06:30Z. Twenty-three hours after the previous
      // fire, not twenty-four.
      expect(acrossTransition.nextRunAt).toBe('2026-03-09T06:30:00.000Z');

      const gapMs =
        Date.parse(acrossTransition.nextRunAt as string) -
        Date.parse(beforeTransition.nextRunAt as string);
      expect(gapMs).toBe(23 * 60 * 60 * 1000);
    });

    it('stays on the same LOCAL time across a fall-back boundary', async () => {
      // The other direction: 2026-11-01, UTC-4 → UTC-5, with the clock rewound
      // from 02:00 to 01:00 — so 01:30 local happens TWICE that morning.
      //
      // 01:30 on the 1st is the FIRST pass, 05:30Z (still EDT); 01:30 on the
      // 2nd is 06:30Z (EST). Twenty-five hours apart, from a schedule that says
      // "every day at the same time" — which is the whole reason the walk moves
      // over civil dates instead of adding 86_400_000ms.
      //
      // Choosing the earlier of the two ambiguous instants is deliberate (see
      // `zonedCivilToUtc`): a 01:30 backup runs ONCE, on the first pass of the
      // clock, rather than twice or not at all.
      const { service } = harness({
        policy: { timeOfDay: '01:30', timezone: 'America/New_York' },
      });

      const before = await service.getConfig(new Date('2026-10-31T12:00:00.000Z'));
      const after = await service.getConfig(new Date('2026-11-01T12:00:00.000Z'));

      expect(before.nextRunAt).toBe('2026-11-01T05:30:00.000Z');
      expect(after.nextRunAt).toBe('2026-11-02T06:30:00.000Z');
      expect(
        Date.parse(after.nextRunAt as string) - Date.parse(before.nextRunAt as string)
      ).toBe(25 * 60 * 60 * 1000);
    });

    it('is null when backups are disabled', async () => {
      const { service } = harness({ policy: { enabled: false } });

      const config = await service.getConfig(new Date('2026-09-07T12:00:00.000Z'));

      expect(config.nextRunAt).toBeNull();
    });

    it('is null rather than a 500 when the STORED timezone is unknown', async () => {
      // The read path degrades: `GET config` is the screen that repairs this
      // setting, so it must load. The WRITE path is where such a value is
      // refused — see the timezone test below.
      const { service } = harness({ policy: { timezone: 'Mars/Olympus_Mons' } });

      const config = await service.getConfig(new Date('2026-09-07T12:00:00.000Z'));

      expect(config.nextRunAt).toBeNull();
      expect(config.timezone).toBe('Mars/Olympus_Mons');
    });

    it('reports the run holding the active slot', async () => {
      const { service } = harness({ rows: [run({ status: 'running' })] });

      const config = await service.getConfig(new Date('2026-09-07T12:00:00.000Z'));

      expect(config.activeRunId).toBe(RUN_ID);
    });

    it('reports no active run when every row has settled', async () => {
      const { service } = harness({ rows: [run({ status: 'completed' })] });

      expect(
        (await service.getConfig(new Date('2026-09-07T12:00:00.000Z'))).activeRunId
      ).toBeNull();
    });
  });

  // =========================================================================
  // PUT config — one settings writer, two pre-write refusals
  // =========================================================================

  describe('updateConfig', () => {
    it('writes through SystemSettingsService and touches nothing else', async () => {
      const { service, settings, patches } = harness();

      await service.updateConfig({ retentionCount: 14 }, USER_ID);

      expect(settings.patchSettings).toHaveBeenCalledTimes(1);
      expect(patches[0]).toEqual({ databaseBackup: { retentionCount: 14 } });
      // The actor is passed through, so the shared `system_settings:patch`
      // audit row names the person who changed the policy.
      expect((settings.patchSettings as jest.Mock).mock.calls[0][1]).toBe(USER_ID);
    });

    it('applies a partial patch without echoing untouched fields', async () => {
      const { service, stored } = harness();

      await service.updateConfig({ enabled: false }, USER_ID);

      expect(stored.enabled).toBe(false);
      expect(stored.retentionCount).toBe(POLICY.retentionCount);
      expect(stored.timeOfDay).toBe(POLICY.timeOfDay);
    });

    it('returns the config as it now stands, with nextRunAt recomputed', async () => {
      const { service } = harness();

      const config = await service.updateConfig(
        { timeOfDay: '05:15' },
        USER_ID,
        new Date('2026-09-07T12:00:00.000Z')
      );

      expect(config.timeOfDay).toBe('05:15');
      expect(config.nextRunAt).toBe('2026-09-08T05:15:00.000Z');
    });

    it('refuses an unknown timezone with a 400, before writing anything', async () => {
      const { service, settings } = harness();

      await expect(
        service.updateConfig({ timezone: 'Mars/Olympus_Mons' }, USER_ID)
      ).rejects.toBeInstanceOf(BadRequestException);

      // THE POINT of validating first: a refused write leaves the stored policy
      // exactly as it was, rather than half-applied.
      expect(settings.patchSettings).not.toHaveBeenCalled();
    });

    it('names the offending field in `details`, where the filter will keep it', async () => {
      const { service } = harness();

      await expect(
        service.updateConfig({ timezone: 'Mars/Olympus_Mons' }, USER_ID)
      ).rejects.toMatchObject({
        response: {
          details: { field: 'timezone', reason: 'unknown_timezone' },
        },
      });
    });

    it('refuses a storageProvider this deployment does not have, with a 400', async () => {
      const { service, settings, runner } = harness();

      await expect(
        service.updateConfig({ storageProvider: 'gcs' }, USER_ID)
      ).rejects.toBeInstanceOf(BadRequestException);

      // Called through the RUNNER's helper rather than compared here — one
      // rule, shared by the write path and the run path.
      expect(runner.assertStorageProviderUsable).toHaveBeenCalledWith('gcs');
      expect(settings.patchSettings).not.toHaveBeenCalled();
    });

    it('accepts an empty storageProvider, which means "whichever is active"', async () => {
      const { service, settings } = harness({ policy: { storageProvider: '' } });

      await service.updateConfig({ enabled: true }, USER_ID);

      expect(settings.patchSettings).toHaveBeenCalledTimes(1);
    });

    it('refuses an unknown timezone EVEN WHILE BACKUPS ARE DISABLED', async () => {
      // The ordinary order of events: an operator sets the schedule up before
      // switching backups on. A check that deferred to `enabled` would accept
      // the bad zone here and only fail the night after somebody enabled it —
      // a failure separated from its cause by weeks.
      const { service, settings } = harness({ policy: { enabled: false } });

      await expect(
        service.updateConfig({ timezone: 'Mars/Olympus_Mons' }, USER_ID)
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(settings.patchSettings).not.toHaveBeenCalled();
    });

    it('validates the MERGED policy, not the patch alone', async () => {
      // A patch that changes only the frequency still has to produce a schedule
      // the STORED timezone can be projected in — which is why the check runs
      // against `{ ...current, ...patch }`.
      const { service, settings } = harness({ policy: { timezone: 'Mars/Olympus_Mons' } });

      await expect(
        service.updateConfig({ frequency: 'weekly' }, USER_ID)
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(settings.patchSettings).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST runs
  // =========================================================================

  describe('startRun', () => {
    it('claims through the runner and attributes the run to the caller', async () => {
      const { service, runner } = harness();

      const result = await service.startRun(USER_ID);

      expect(runner.queueBackup).toHaveBeenCalledWith({
        trigger: 'manual',
        createdById: USER_ID,
      });
      expect(result.id).toBe(RUN_ID);
    });

    it('turns a claim conflict into a 409 carrying the active id under `details`', async () => {
      const { service } = harness({
        queueBackup: async () => {
          throw new DatabaseBackupAlreadyRunningError('other-run');
        },
      });

      await expect(service.startRun(USER_ID)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.startRun(USER_ID)).rejects.toMatchObject({
        response: {
          details: { activeRunId: 'other-run', reason: 'backup_already_running' },
        },
      });
    });

    it('turns a misconfigured storage provider into a 400, not a 500', async () => {
      const { service } = harness({
        queueBackup: async () => {
          throw new DatabaseBackupStorageProviderError('gcs', 's3');
        },
      });

      await expect(service.startRun(USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets an unrecognised failure propagate untouched', async () => {
      const boom = new Error('the database is on fire');
      const { service } = harness({
        queueBackup: async () => {
          throw boom;
        },
      });

      await expect(service.startRun(USER_ID)).rejects.toBe(boom);
    });
  });

  // =========================================================================
  // BigInt — the failure an object-comparing test cannot see
  // =========================================================================

  describe('BigInt serialisation', () => {
    it('maps both BigInt columns to exact decimal strings', () => {
      const dto = toRunDto(run());

      expect(dto.sizeBytes).toBe('9007199254740993');
      expect(dto.bytesWritten).toBe('9007199254740993');

      // The string round-trips through `BigInt` exactly...
      expect(BigInt(dto.sizeBytes)).toBe(9_007_199_254_740_993n);
      // ...and through `Number` it does NOT. The value is above 2^53, so a
      // JSON number would have arrived as ...992: one byte adrift, silently,
      // on the only backups big enough for anyone to care. Exactness is the
      // whole reason these are published as strings.
      expect(String(Number(dto.sizeBytes))).toBe('9007199254740992');
    });

    it('produces an object `JSON.stringify` accepts', () => {
      // The direct statement of the criterion: a raw row throws here.
      expect(() => JSON.stringify(run())).toThrow(/BigInt/);
      expect(() => JSON.stringify(toRunDto(run()))).not.toThrow();
    });

    it('converts on the single-get path', async () => {
      const { service } = harness();

      const result = await service.getRun(RUN_ID);

      expect(typeof result.sizeBytes).toBe('string');
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it('converts on the LIST path, which is the one most likely to be shortcut', async () => {
      const { service } = harness({ rows: [run(), run({ id: 'second' })] });

      const page = await service.listRuns({ page: 1, pageSize: 20 });

      expect(page.items).toHaveLength(2);
      expect(page.items.every((item) => typeof item.bytesWritten === 'string')).toBe(true);
      expect(() => JSON.stringify(page)).not.toThrow();
    });

    it('converts on the manual-trigger path', async () => {
      const { service } = harness();

      const started = await service.startRun(USER_ID);

      expect(() => JSON.stringify(started)).not.toThrow();
    });

    it('renders every timestamp as an ISO string, so the DTO IS the wire shape', async () => {
      const dto = toRunDto(run());

      expect(dto.createdAt).toBe('2026-09-07T02:00:00.000Z');
      expect(dto.finishedAt).toBe('2026-09-07T02:41:00.000Z');
      expect(toRunDto(run({ finishedAt: null })).finishedAt).toBeNull();
    });
  });

  // =========================================================================
  // List
  // =========================================================================

  describe('listRuns', () => {
    it('pages in the flat shape every list in this API uses', async () => {
      const { service } = harness({
        rows: [run(), run({ id: 'b' }), run({ id: 'c' })],
      });

      const page = await service.listRuns({ page: 2, pageSize: 2 });

      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2, totalPages: 2 });
      expect(page.items).toHaveLength(1);
    });

    it('orders newest first by createdAt', async () => {
      const { service, prisma } = harness();

      await service.listRuns({ page: 1, pageSize: 20 });

      expect(
        (prisma.databaseBackupRun.findMany as jest.Mock).mock.calls[0][0].orderBy
      ).toEqual({ createdAt: 'desc' });
    });

    it('filters by status and trigger when asked', async () => {
      const { service } = harness({
        rows: [run({ status: 'failed' }), run({ id: 'b', status: 'completed' })],
      });

      const failed = await service.listRuns({ page: 1, pageSize: 20, status: 'failed' });

      expect(failed.total).toBe(1);
      expect(failed.items[0].status).toBe('failed');
    });
  });

  // =========================================================================
  // Download
  // =========================================================================

  describe('getDownloadUrl', () => {
    it('signs the run\'s stored key with a bounded expiry', async () => {
      const { service, storage } = harness();

      const result = await service.getDownloadUrl(RUN_ID);

      expect(result.expiresIn).toBe(BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS);
      expect(BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS).toBeLessThanOrEqual(15 * 60);
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
        run().storageKey,
        expect.objectContaining({ expiresIn: BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS })
      );
    });

    it('names the saved file after the archive, without inventing a product name', async () => {
      const { service, storage } = harness();

      await service.getDownloadUrl(RUN_ID);

      const options = (storage.getSignedDownloadUrl as jest.Mock).mock.calls[0][1];
      expect(options.responseContentDisposition).toContain(
        'app-20260907T020000Z-run.dump'
      );
    });

    it.each(['running', 'pending', 'failed', 'stale'] as const)(
      'refuses a %s run with a 400 and signs nothing',
      async (status) => {
        const { service, storage } = harness({ rows: [run({ status })] });

        await expect(service.getDownloadUrl(RUN_ID)).rejects.toBeInstanceOf(
          BadRequestException
        );
        expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      }
    );

    it('404s for a run that does not exist', async () => {
      const { service } = harness({ rows: [] });

      await expect(service.getDownloadUrl(RUN_ID)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });
  });

  // =========================================================================
  // Delete
  // =========================================================================

  describe('deleteRun', () => {
    it('deletes the OBJECT first and the ROW second', async () => {
      const { service, calls } = harness();

      await service.deleteRun(RUN_ID);

      // The reverse order would orphan a multi-gigabyte object nothing points
      // at, because the row is the only index of what is in the bucket.
      expect(calls).toEqual([`object:${run().storageKey}`, `row:${RUN_ID}`]);
    });

    it('reports objectDeleted: false for an object that was already gone', async () => {
      const { service, rows } = harness({
        storageDelete: async () => {
          throw new Error('NoSuchKey');
        },
      });

      const result = await service.deleteRun(RUN_ID);

      expect(result).toEqual({ id: RUN_ID, objectDeleted: false });
      // AND THE ROW IS STILL GONE. A missing object must not make a row
      // undeletable.
      expect(rows).toHaveLength(0);
    });

    it.each(ACTIVE_BACKUP_STATUSES)('refuses a %s run with a 400', async (status) => {
      const { service, storage, calls } = harness({ rows: [run({ status })] });

      await expect(service.deleteRun(RUN_ID)).rejects.toBeInstanceOf(BadRequestException);

      // Nothing was touched: that row holds the active slot and its bytes are
      // still being written.
      expect(storage.delete).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('404s for a run that does not exist', async () => {
      const { service } = harness({ rows: [] });

      await expect(service.deleteRun(RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // =========================================================================
  // Cancel
  // =========================================================================

  describe('cancelRun', () => {
    it('reports `signalled` when this process held the handle', async () => {
      const { service } = harness({
        rows: [run({ status: 'running' })],
        cancel: () => ({ outcome: 'signalled', runId: RUN_ID }),
      });

      const result = await service.cancelRun(RUN_ID);

      expect(result.outcome).toBe('signalled');
      expect(result.runId).toBe(RUN_ID);
    });

    it('reports `not_running_here` HONESTLY rather than pretending it cancelled', async () => {
      const { service } = harness({
        rows: [run({ status: 'running' })],
        cancel: () => ({ outcome: 'not_running_here', runId: RUN_ID }),
      });

      const result = await service.cancelRun(RUN_ID);

      expect(result.outcome).toBe('not_running_here');
      // The detail has to say that nothing stopped — a client rendering only
      // this string must not tell an operator the dump is over.
      expect(result.detail).toMatch(/Nothing was stopped/i);
    });

    it('refuses to cancel a run that has already settled', async () => {
      const { service, runner } = harness({ rows: [run({ status: 'completed' })] });

      await expect(service.cancelRun(RUN_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(runner.cancel).not.toHaveBeenCalled();
    });

    it('404s for a run that does not exist', async () => {
      const { service } = harness({ rows: [] });

      await expect(service.cancelRun(RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });


  // =========================================================================
  // ⚠ Restore (#286) — the one surface where a mis-fire is an outage
  // =========================================================================

  describe('startRestore', () => {
    it('forwards the row, the actor and the override to the restore engine', async () => {
      const { service, restore } = harness();

      const result = await service.startRestore(RUN_ID, {
        overrideSchemaCheck: false,
        actorUserId: USER_ID,
      });

      expect(result).toMatchObject({ outcome: 'started', runId: RUN_ID });

      // The ROW, not the id: #284 and #285 both contract to take a row and
      // answer a question about it. The lookup is this service's job.
      const [row, options] = (restore.startRestore as jest.Mock).mock.calls[0];
      expect(row.id).toBe(RUN_ID);
      expect(options).toEqual({ actorUserId: USER_ID, overrideSchemaMismatch: false });
    });

    it('maps overrideSchemaCheck onto the engine\'s overrideSchemaMismatch option', async () => {
      const { service, restore } = harness();

      await service.startRestore(RUN_ID, { overrideSchemaCheck: true, actorUserId: USER_ID });

      // The names differ because they answer different questions — the request
      // field says what the operator is waiving, the option says what the
      // pre-flight compares — and this is the ONE place that knows both. A
      // rename on either side that skipped this mapping would produce a request
      // that silently did nothing.
      expect((restore.startRestore as jest.Mock).mock.calls[0][1]).toEqual({
        actorUserId: USER_ID,
        overrideSchemaMismatch: true,
      });
    });

    it('returns the refusal whole, so a guided verdict keeps its command block', async () => {
      const { service } = harness({
        startRestore: async () => ({ outcome: 'refused', preflight: preflight('guided') }),
      });

      const result = await service.startRestore(RUN_ID, {
        overrideSchemaCheck: false,
        actorUserId: USER_ID,
      });

      expect(result.outcome).toBe('refused');
      // Not flattened to a message: the command block IS the deliverable on
      // this path, and a service that reduced it to "refused" would make the
      // guided outcome useless.
      expect(result).toMatchObject({
        preflight: { outcome: 'guided', guidance: { commands: 'createdb ...' } },
      });
    });

    it('passes the already_running result through rather than throwing', async () => {
      const { service } = harness({
        startRestore: async () => ({ outcome: 'already_running', runId: RUN_ID }),
      });

      // A RESULT, not an exception — nothing has gone wrong. The controller
      // turns it into a 409 carrying `details.activeRunId`; see
      // `db-backup.errors.ts` for why there is deliberately no error class.
      await expect(
        service.startRestore(RUN_ID, { overrideSchemaCheck: false, actorUserId: USER_ID })
      ).resolves.toEqual({ outcome: 'already_running', runId: RUN_ID });
    });

    it.each(['running', 'failed', 'stale', 'pending'] as const)(
      'refuses a %s run and never reaches the engine',
      async (status) => {
        const { service, restore } = harness({ rows: [run({ status })] });

        await expect(
          service.startRestore(RUN_ID, { overrideSchemaCheck: false, actorUserId: USER_ID })
        ).rejects.toBeInstanceOf(DatabaseRestoreNotAllowedError);

        // The check is worth more than the throw: a run whose object is half
        // written or already deleted would be downloaded without complaint and
        // would restore nothing, after hours and after a safety dump.
        expect(restore.startRestore).not.toHaveBeenCalled();
      }
    );

    it('raises the TYPED not-found error, not a framework exception', async () => {
      const { service, restore } = harness({ rows: [] });

      const error = await service
        .startRestore(RUN_ID, { overrideSchemaCheck: false, actorUserId: USER_ID })
        .catch((e: unknown) => e);

      // ⚠ NOT a `NotFoundException`. The restore path is entered from more than
      // the HTTP layer, so the status code is the controller's decision — see
      // this service's header.
      expect(error).toBeInstanceOf(DatabaseRestoreRunNotFoundError);
      expect(error).not.toBeInstanceOf(NotFoundException);
      expect((error as DatabaseRestoreRunNotFoundError).runId).toBe(RUN_ID);
      expect(restore.startRestore).not.toHaveBeenCalled();
    });

    it('does not re-run the pre-flight itself', async () => {
      const { service, restore } = harness();

      await service.startRestore(RUN_ID, { overrideSchemaCheck: false, actorUserId: USER_ID });

      // The gates run exactly once, inside the engine, deliberately: a service
      // that ran them here as well would be one refactor away from a caller
      // that runs them nowhere.
      expect(restore.startRestore).toHaveBeenCalledTimes(1);
    });
  });

  describe('rollbackRestore', () => {
    /** A run that HAS been restored, which is the precondition for a rollback. */
    const restored = (overrides: Partial<DatabaseBackupRun> = {}) =>
      run({
        restoreStatus: 'completed',
        restoredAt: new Date('2026-09-07T03:30:00.000Z'),
        restoredById: USER_ID,
        restoreOldDb: 'appdb_old_20260907T030000Z',
        swappedAt: new Date('2026-09-07T03:30:00.000Z'),
        ...overrides,
      });

    it('renames in retain mode and reports it as such', async () => {
      const { service, restore } = harness({ rows: [restored()] });

      const result = await service.rollbackRestore(RUN_ID, USER_ID);

      expect(result).toMatchObject({ outcome: 'renamed', promoted: 'appdb_old_20260907T030000Z' });
      expect((restore.rollback as jest.Mock).mock.calls[0][1]).toBe(USER_ID);
    });

    it('reports restore_started when the retained database is gone but a dump is not', async () => {
      const { service } = harness({
        rows: [restored({ restoreOldDb: null, preRestoreBackupId: PRE_RESTORE_ID })],
        rollback: async (row) => ({
          outcome: 'restore_started',
          runId: row.id,
          preRestoreRunId: PRE_RESTORE_ID,
        }),
      });

      // The two routes back are not comparable — seconds versus hours — which
      // is the entire reason this is a discriminated result and not a boolean.
      await expect(service.rollbackRestore(RUN_ID, USER_ID)).resolves.toEqual({
        outcome: 'restore_started',
        runId: RUN_ID,
        preRestoreRunId: PRE_RESTORE_ID,
      });
    });

    it('reports unavailable — not a failure — when the window has closed', async () => {
      const { service } = harness({
        rows: [restored({ restoreOldDb: 'appdb_old_20260907T030000Z' })],
        rollback: async (row) => ({
          outcome: 'unavailable',
          runId: row.id,
          reason: 'The displaced database has been dropped.',
        }),
      });

      const result = await service.rollbackRestore(RUN_ID, USER_ID);

      // Nothing went wrong just now; the retention window simply passed. An
      // operator needs that as a fact rather than as an error to retry.
      expect(result).toMatchObject({ outcome: 'unavailable' });
    });

    it('refuses a run that was never restored, and never reaches the engine', async () => {
      const { service, restore } = harness({ rows: [run({ restoreStatus: null })] });

      const error = await service.rollbackRestore(RUN_ID, USER_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DatabaseRestoreNotAllowedError);
      // `unavailable` would have been the wrong answer: it means the way back
      // expired, which is a fact about a restore that happened.
      expect((error as DatabaseRestoreNotAllowedError).reason).toBe('restore_never_ran');
      expect(restore.rollback).not.toHaveBeenCalled();
    });

    it('raises the TYPED not-found error for a run that does not exist', async () => {
      const { service } = harness({ rows: [] });

      await expect(service.rollbackRestore(RUN_ID, USER_ID)).rejects.toBeInstanceOf(
        DatabaseRestoreRunNotFoundError
      );
    });
  });

  // =========================================================================
  // The two active-status lists must not drift apart
  // =========================================================================

  it('agrees with the runner about which statuses hold the active slot', () => {
    // `ACTIVE_BACKUP_STATUSES` is re-derived in the DTO layer so that a DTO file
    // does not import a service. This assertion is what stops that convenience
    // from becoming two different answers to "is this run active".
    expect([...ACTIVE_BACKUP_STATUSES]).toEqual([...ACTIVE_RUN_STATUSES]);
  });
});
