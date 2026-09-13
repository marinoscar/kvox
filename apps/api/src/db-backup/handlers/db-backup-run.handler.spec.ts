// =============================================================================
// DatabaseBackupRunHandler unit coverage (issue #351, epic #345)
// =============================================================================
//
// THREE PROPERTIES, AND ONLY ONE OF THEM IS ABOUT THE DUMP.
//
//   1. THE PROFILE IS WHAT IT CLAIMS TO BE, MEASURED THROUGH THE RESOLVERS
//      THE QUEUE ACTUALLY READS. Asserting `handler.profile.maxAttempts === 1`
//      would prove a literal equals itself. What matters is what
//      `resolveMaxAttempts` and `resolveJobLeaseMs` answer for THIS handler,
//      because those are the two functions the reaper's give-up phase and the
//      claim's lease are computed from — the exact pair that used to make a
//      backup unsafe as a queue job.
//   2. `process` IS AWAITED THROUGH, not fired and forgotten. The one line
//      that would quietly undo #351 is a missing `await`, and it would leave
//      every other assertion in this repository green.
//   3. IT IS NODE-ELIGIBLE, AND ALL THREE MEMBERS ARE PRESENT (#352). A
//      handler carrying exactly one of `nodeResultSchema`/`persistNodeResult`
//      is a state the interface forbids and the registry silently derives as
//      server-only, so the assertion is on the DERIVATION
//      (`serverOnlyTypes()`), never on the members alone. `deriveOutputKey`
//      belongs to the same set: without it the data plane would sign an upload
//      into `node-outputs/…`, which is a location no part of the backup
//      subsystem can find an archive in.
//   4. ELIGIBLE IS NOT OFFERED. `nodeOffloadEnabled()` reads the setting on
//      EVERY call — a cached copy is how "we turned node offload off" takes
//      effect at some unspecified later time.
//
// The dump itself is not re-tested here — `db-backup-runner.service.spec.ts`
// owns the streaming contract, and this handler deliberately contains no copy
// of it to test.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { Job } from '@prisma/client';
import { z } from 'zod';

import {
  resolveJobProfile,
  resolveMaxAttempts,
} from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { LEASE_GRACE_MS, resolveJobLeaseMs } from '../../jobs/job.worker';
import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { BACKUP_JOB_TYPE } from '../db-backup-runner.service';
import type { DatabaseBackupRunnerService } from '../db-backup-runner.service';
import { PG_JOB_ROLE_KIND, PgJobRoleBroker } from '../pg-job-role.broker';
import { BACKUP_JOB_MAX_RUNTIME_MS, DatabaseBackupRunHandler } from './db-backup-run.handler';

describe('DatabaseBackupRunHandler', () => {
  const job = { id: 'job-1', type: BACKUP_JOB_TYPE } as Job;

  let registry: JobHandlerRegistry;
  let runQueuedBackup: jest.Mock;
  let completeNodeRun: jest.Mock;
  let resolveNodeOutputKey: jest.Mock;
  let getDatabaseBackupPolicy: jest.Mock;
  let broker: PgJobRoleBroker;
  let handler: DatabaseBackupRunHandler;

  /** A complete, valid node result — the shape the contract publishes. */
  const nodeResult = {
    storageKey: 'backups/2026/09/07/run-1.dump',
    // A DECIMAL STRING, and deliberately one above 2^53 in the round-trip
    // test below. See `db-backup-run.contract.ts`.
    bytes: '4294967296',
    sha256: 'a'.repeat(64),
    pgDumpVersion: 'pg_dump (PostgreSQL) 17.2',
    dbVersion: 'PostgreSQL 16.4',
    migrationName: '20260907160000_add_backup_run_pg_dump_version',
    startedAt: '2026-09-07T01:00:00.000Z',
    finishedAt: '2026-09-07T01:20:00.000Z',
  };

  /** The deployment-wide defaults, i.e. what this type must NOT be governed by. */
  const config = {
    get: jest.fn((key: string) =>
      key === 'jobs.maxAttempts' ? 3 : key === 'jobs.jobTimeoutMs' ? 600_000 : undefined
    ),
  } as unknown as ConfigService;

  beforeEach(() => {
    registry = new JobHandlerRegistry();
    runQueuedBackup = jest.fn(async () => undefined);
    broker = {
      kind: PG_JOB_ROLE_KIND,
      usable: jest.fn(async () => ({ ok: true as const })),
      issue: jest.fn(),
      revoke: jest.fn(),
    } as unknown as PgJobRoleBroker;

    completeNodeRun = jest.fn(async () => undefined);
    resolveNodeOutputKey = jest.fn(async () => nodeResult.storageKey);
    getDatabaseBackupPolicy = jest.fn(async () => ({ nodeOffloadEnabled: true }));

    handler = new DatabaseBackupRunHandler(
      registry,
      {
        runQueuedBackup,
        completeNodeRun,
        resolveNodeOutputKey,
      } as unknown as DatabaseBackupRunnerService,
      { getDatabaseBackupPolicy } as unknown as SystemSettingsService,
      broker
    );
  });

  it('registers itself under the type the runner enqueues, and only from onModuleInit', () => {
    // Before the lifecycle hook the registry knows nothing: registration is
    // the ONE line of wiring a handler needs, and it must be that line rather
    // than a constructor side effect the worker could race.
    expect(registry.get(BACKUP_JOB_TYPE)).toBeUndefined();

    handler.onModuleInit();

    expect(registry.get(BACKUP_JOB_TYPE)).toBe(handler);
    // The enqueue side and the execute side agree BY IMPORT, not by two
    // matching string literals that a rename could separate.
    expect(handler.type).toBe(BACKUP_JOB_TYPE);
  });

  it('has a dashboard label, so a 2am reader sees a phrase and not a dotted key', () => {
    expect(JOB_TYPE_LABELS[BACKUP_JOB_TYPE]).toBe('Database backup');
  });

  describe('the profile the queue actually reads', () => {
    it('is never automatically retried: one attempt, not the deployment default of three', () => {
      // ⚠ THE THIRD OF THE THREE OBJECTIONS `schema.prisma` RAISED, answered
      // by configuration. `JobStuckService`'s give-up phase reads exactly this
      // number, so a failed multi-gigabyte dump is permanently failed rather
      // than requeued against a database that is probably already unwell.
      expect(resolveMaxAttempts(config, handler)).toBe(1);
      // The global it is overriding, for contrast.
      expect(resolveMaxAttempts(config, undefined)).toBe(3);
    });

    it('runs for six hours, not the ten-minute global', () => {
      const profile = resolveJobProfile(handler);

      expect(profile?.maxRuntimeMs).toBe(BACKUP_JOB_MAX_RUNTIME_MS);
      expect(BACKUP_JOB_MAX_RUNTIME_MS).toBe(6 * 60 * 60 * 1000);
    });

    it('derives a lease LONGER than the runtime ceiling — the reaper cannot requeue a dump that is still streaming', () => {
      // The first objection, and the one that used to corrupt archives: a
      // lease shorter than the permitted runtime is a job that reaps itself
      // into two concurrent `pg_dump`s writing to one key. Derived, so the
      // disagreement is unrepresentable rather than merely avoided.
      const lease = resolveJobLeaseMs(config, resolveJobProfile(handler));

      expect(lease).toBe(BACKUP_JOB_MAX_RUNTIME_MS + LEASE_GRACE_MS);
      expect(lease).toBeGreaterThan(BACKUP_JOB_MAX_RUNTIME_MS);
    });
  });

  describe('process', () => {
    it('AWAITS the dump — the job does not settle before the archive is verified', async () => {
      let release!: () => void;
      const dumping = new Promise<void>((resolve) => {
        release = resolve;
      });
      runQueuedBackup.mockImplementation(async () => dumping);

      let settled = false;
      const running = handler.process(job).then(() => {
        settled = true;
      });

      // ⚠ THE ASSERTION #351 EXISTS FOR. A handler that returned here would
      // give a dashboard row and nothing else: no lease, no slot accounting,
      // no timeout, no possibility of node execution.
      await Promise.resolve();
      expect(settled).toBe(false);

      release();
      await running;
      expect(settled).toBe(true);
      expect(runQueuedBackup).toHaveBeenCalledWith(job);
    });

    it('lets the failure through, so the worker settles the job as failed', async () => {
      const boom = new Error('pg_dump exited 1');
      runQueuedBackup.mockRejectedValue(boom);

      await expect(handler.process(job)).rejects.toBe(boom);
    });
  });

  describe('the per-job credential (#350)', () => {
    it('declares the injected broker as `nodeSecretBroker` — presence IS the declaration', () => {
      handler.onModuleInit();

      const registered = registry.get(BACKUP_JOB_TYPE) as JobHandler;

      // Read back through the registry, because the registry is what
      // `NodeSecretBrokerService` asks: a broker the handler holds but does not
      // expose is a credential nothing can mint.
      expect(registered.nodeSecretBroker).toBe(broker);
      expect(registered.nodeSecretBroker?.kind).toBe(PG_JOB_ROLE_KIND);
    });

    it('is a fact independent of eligibility — the broker did not make the type claimable, the two members did', () => {
      handler.onModuleInit();

      const registered = registry.get(BACKUP_JOB_TYPE) as JobHandler;

      // ⚠ THE DISTINCTION #350 DREW AND #352 KEEPS. A broker declares that a
      // REMOTE executor of this type needs a credential; it says nothing about
      // whether one may run it. Eligibility is derived from
      // `nodeResultSchema` + `persistNodeResult`, and it is those two — not
      // this — that took the type out of `serverOnlyTypes()`.
      expect(registered.nodeSecretBroker).toBeDefined();
      expect(registered.nodeResultSchema).toBeDefined();
      expect(typeof registered.persistNodeResult).toBe('function');
    });

    it('does not touch the broker at registration time — no probe at boot', () => {
      handler.onModuleInit();

      // `usable()` opens a connection to the cluster. Calling it from a
      // lifecycle hook would make every boot depend on PostgreSQL answering a
      // privilege question nobody has asked yet.
      expect(broker.usable).not.toHaveBeenCalled();
    });
  });

  describe('node eligibility (#352)', () => {
    it('carries ALL THREE node members, so the registry derives the type as claimable', () => {
      handler.onModuleInit();

      // Read through the interface, because what the REGISTRY sees is what
      // decides eligibility — a member the class holds privately is a member
      // the node plane cannot use.
      const registered = registry.get(BACKUP_JOB_TYPE) as JobHandler;

      expect(registered.nodeResultSchema).toBeDefined();
      expect(typeof registered.persistNodeResult).toBe('function');
      expect(typeof registered.deriveOutputKey).toBe('function');

      // ⚠ THE DERIVATION, not a flag — there is deliberately no
      // `nodeEligible` boolean to set inconsistently. `serverOnlyTypes()` is
      // what the `system` worker mode and the node claim endpoint both read,
      // and this type leaving it is the whole of #352's server half.
      expect(registry.serverOnlyTypes()).not.toContain(BACKUP_JOB_TYPE);
    });

    it('publishes a schema that survives conversion to JSON Schema — a node validates before it submits', () => {
      const schema = handler.nodeResultSchema;

      // The same conversion `GET /api/nodes/job-types` performs. A schema that
      // throws here is published as `null` and every client is left guessing.
      const json = z.toJSONSchema(schema, { io: 'input' }) as {
        properties: Record<string, unknown>;
      };

      expect(Object.keys(json.properties).sort()).toEqual([
        'bytes',
        'dbVersion',
        'finishedAt',
        'migrationName',
        'pgDumpVersion',
        'sha256',
        'startedAt',
        'storageKey',
      ]);
    });

    describe('deriveOutputKey', () => {
      it('returns the run\u2019s own key, from the runner, by job — never a node-outputs path', async () => {
        await expect(handler.deriveOutputKey(job)).resolves.toBe(nodeResult.storageKey);
        expect(resolveNodeOutputKey).toHaveBeenCalledWith(job);
      });

      it('is idempotent per job because the runner re-reads the row, not because it remembers', async () => {
        // Two asks — a timed-out transfer, a lost response — must yield ONE
        // key, or a retry writes a second archive nothing points at.
        const first = await handler.deriveOutputKey(job);
        const second = await handler.deriveOutputKey(job);

        expect(second).toBe(first);
      });
    });

    describe('persistNodeResult', () => {
      it('parses the untrusted body AGAIN before touching the runner', async () => {
        await handler.persistNodeResult(job, { ...nodeResult, sha256: 'not-a-digest' })
          .then(
            () => {
              throw new Error('expected a validation failure');
            },
            (error: unknown) => {
              expect(error).toBeDefined();
            }
          );

        // ⚠ NOTHING REACHED THE WRITER. The second parse is a type-system
        // requirement (`result: unknown`) with a safety dividend: a future
        // caller that forgets to validate cannot write an arbitrary object
        // into `database_backup_runs` through this method.
        expect(completeNodeRun).not.toHaveBeenCalled();
      });

      it('round-trips a byte count ABOVE 2^53 exactly — the reason `bytes` is a string', async () => {
        // 2^53 is 9007199254740992; this is one more than that, i.e. the
        // first integer a JSON number cannot represent. An 8 PB dump is not
        // realistic — the point is that the wire type is exact at the width
        // where a number silently is not, so a 3 TB one is exact too.
        const bytes = '9007199254740993';

        await handler.persistNodeResult(job, { ...nodeResult, bytes });

        const [, parsed] = completeNodeRun.mock.calls[0] as [Job, { bytes: string }];

        expect(parsed.bytes).toBe(bytes);
        expect(BigInt(parsed.bytes)).toBe(9007199254740993n);
        // The corruption this contract exists to prevent, spelled out.
        expect(Number(bytes).toString()).not.toBe(bytes);
      });

      it('hands the parsed result to the runner, which owns the one completing write', async () => {
        await handler.persistNodeResult(job, nodeResult);

        expect(completeNodeRun).toHaveBeenCalledWith(job, nodeResult);
      });

      it('lets a persist failure through, so `submitResult` settles the job as failed', async () => {
        const boom = new Error('the node reported a key it was not given');
        completeNodeRun.mockRejectedValue(boom);

        await expect(handler.persistNodeResult(job, nodeResult)).rejects.toBe(boom);
      });
    });

    describe('nodeOffloadEnabled — the deployment\u2019s own switch', () => {
      it('reads `databaseBackup.nodeOffloadEnabled` on EVERY call, never a cached copy', async () => {
        getDatabaseBackupPolicy.mockResolvedValueOnce({ nodeOffloadEnabled: true });
        await expect(handler.nodeOffloadEnabled()).resolves.toBe(true);

        // The administrator switches it off between two claims.
        getDatabaseBackupPolicy.mockResolvedValueOnce({ nodeOffloadEnabled: false });
        await expect(handler.nodeOffloadEnabled()).resolves.toBe(false);

        expect(getDatabaseBackupPolicy).toHaveBeenCalledTimes(2);
      });

      it('FAILS CLOSED when the settings read throws — the in-process worker takes the backup', async () => {
        getDatabaseBackupPolicy.mockRejectedValue(new Error('settings row unreadable'));

        // Not a throw: throwing here would fail the node's whole CLAIM,
        // including unrelated types it is holding. Withholding one type falls
        // back to the behaviour this deployment had before node offload.
        await expect(handler.nodeOffloadEnabled()).resolves.toBe(false);
      });
    });
  });
});
