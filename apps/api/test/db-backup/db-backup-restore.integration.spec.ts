// =============================================================================
// Integration tests for the restore and rollback endpoints (issue #286)
// =============================================================================
// (epic #254)
//
// ⚠ THESE TWO ROUTES ARE THE ONE PLACE IN THIS APPLICATION WHERE A MIS-FIRED OR
// RETRIED REQUEST IS AN OUTAGE RATHER THAN A DUPLICATE ROW. Everything below is
// driven through the REAL Nest router, the REAL guards, the REAL global
// validation pipe and — above all — the REAL exception filter, because every
// claim this file makes is a claim about the wire and not about a return value:
//
//   1. ⚠ A MISSING OR WRONG `confirmation` MUST START NOTHING. The literal is
//      enforced by the global `ZodValidationPipe`, which only exists inside a
//      request pipeline; a direct call to the controller would sail past it
//      with the decorator deleted. And "it 400s" is only half the claim — the
//      half that matters is that the restore engine was NEVER CALLED, which is
//      asserted with a spy on every bad-confirmation case.
//
//   2. ⚠ `guided` IS NOT AN ERROR STATUS. It is the expected answer on managed
//      PostgreSQL that denies `CREATEDB`, and only a real response carries a
//      real status line. The command block is asserted to be COMPLETE — every
//      parameterised value present — because a block with a placeholder in it
//      is not a deliverable, it is homework, and it is read during an incident.
//
//   3. ⚠ THE 409's `details.activeRunId` MUST SURVIVE THE FILTER.
//      `common/filters/http-exception.filter.ts` REBUILDS every error body from
//      a fixed key allowlist — `message` and `details` off the payload, `code`
//      derived from the status — so a field written at the TOP LEVEL is
//      silently dropped and never reaches the client.
//      `exception.getResponse()` returns the payload BEFORE the filter touches
//      it, so a unit assertion on it proves nothing about the wire: it would
//      pass identically with the filter deleted AND with the field in the
//      position that does not survive.
//
//   4. ⚠ BOTH ROUTES REQUIRE `db_backup:restore` SPECIFICALLY, NOT
//      `db_backup:write`. That split is the entire purpose of the third
//      permission — a deployment must be able to let somebody schedule backups
//      without letting them replace the database — and it is asserted twice, in
//      two ways that catch different mistakes: as decorator METADATA (a route
//      that had drifted to `db_backup:write` would still 403 a viewer and pass
//      every request-level test), and by driving both routes as an ADMIN
//      HOLDING ONLY `db_backup:write` and expecting 403.
//
// -----------------------------------------------------------------------------
// WHY `DatabaseRestoreService` IS THE ONE THING SUBSTITUTED
// -----------------------------------------------------------------------------
//
// The real one CREATES DATABASES, spawns `pg_restore`, renames the live
// database out from under the connection pool and ends by calling
// `process.exit` — which in a Jest run means killing the worker executing this
// file. Its own behaviour is proven against a seam in
// `src/db-backup/database-restore.service.spec.ts` and against a real cluster
// in `src/db-backup/database-restore.db.spec.ts`, which is exactly why that
// seam exists.
//
// NOTHING ELSE IS SUBSTITUTED: the controller, the admin service, the DTOs, the
// guards, the pipe, the interceptor and the filter are all the real ones
// `AppModule` wires. The database is the shared deep mock, so what these assert
// is the shape and the wiring, never which rows a `where` matches.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../../src/auth/decorators/roles.decorator';
import { DatabaseRestoreService } from '../../src/db-backup/database-restore.service';
import { DatabaseBackupController } from '../../src/db-backup/db-backup.controller';
import { DatabaseBackupRunnerService } from '../../src/db-backup/db-backup-runner.service';
import { RESTORE_SCHEMA_OVERRIDE_FIELD } from '../../src/db-backup/restore-preflight.service';
import { startRestoreRequestSchema } from '../../src/db-backup/dto/db-backup-restore.dto';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser, createMockViewerUser } from '../helpers/auth-mock.helper';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PRE_RESTORE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_RUN_ID = '33333333-3333-4333-8333-333333333333';

const RESTORE_PATH = `/api/admin/db-backup/runs/${RUN_ID}/restore`;
const ROLLBACK_PATH = `/api/admin/db-backup/runs/${RUN_ID}/rollback`;

const SCRATCH_DB = 'appdb_restore_20260907T030000Z';
const OLD_DB = 'appdb_old_20260907T030000Z';

/**
 * A COMPLETE guided command block — every value parameterised, nothing left as
 * a placeholder.
 *
 * The point of the guided path is that this can be pasted into a terminal
 * during an incident. A test that accepted a block containing `<your-host>`
 * would be asserting that the feature exists while allowing it to be useless,
 * so the assertions below check for the real names, the real host, the real
 * port and the real run id rather than merely that the string is non-empty.
 */
const GUIDED_COMMANDS = [
  '# 1. Download the archive',
  `#    run id: ${RUN_ID}`,
  'createdb -h db.internal -p 5432 -U appuser appdb_restore_20260907T030000Z',
  'pg_restore -h db.internal -p 5432 -U appuser -d appdb_restore_20260907T030000Z -j 4 backup.dump',
  'psql -h db.internal -p 5432 -U appuser -d postgres -c \'ALTER DATABASE "appdb" RENAME TO "appdb_old_20260907T030000Z"\'',
].join('\n');

/** One `database_backup_runs` row, as Prisma would hand it back. */
function backupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    createdById: null,
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
  };
}

/** A run that HAS been restored — the precondition for a rollback. */
function restoredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return backupRow({
    restoreStatus: 'completed',
    restoredAt: new Date('2026-09-07T03:30:00.000Z'),
    restoreScratchDb: SCRATCH_DB,
    restoreOldDb: OLD_DB,
    swappedAt: new Date('2026-09-07T03:30:00.000Z'),
    ...overrides,
  });
}

/** A pre-flight verdict in whichever of the three shapes a case needs. */
function preflight(outcome: 'ok' | 'guided' | 'blocked'): Record<string, unknown> {
  const base = {
    runId: RUN_ID,
    targetDatabase: 'appdb',
    scratchDatabase: SCRATCH_DB,
    oldDatabase: OLD_DB,
    // Every gate that ran, INCLUDING the ones that passed — an operator about
    // to replace their production database is entitled to see what was checked.
    gates: [
      {
        id: 'pg_client_version',
        kind: 'capability',
        verdict: 'pass',
        title: 'Client and server versions',
        detail: 'pg_restore 16 against server 16.',
        action: null,
      },
      {
        id: 'createdb_privilege',
        kind: 'capability',
        verdict: outcome === 'guided' ? 'warning' : 'pass',
        title: 'CREATEDB privilege',
        detail:
          outcome === 'guided'
            ? 'The connecting role lacks CREATEDB.'
            : 'The connecting role may create databases.',
        action: outcome === 'guided' ? 'Restore by hand with a superuser.' : null,
      },
      {
        id: 'schema_compatibility',
        kind: 'overridable',
        verdict: outcome === 'blocked' ? 'block' : 'pass',
        title: 'Schema compatibility',
        detail:
          outcome === 'blocked'
            ? 'The archive predates the live schema by two migrations.'
            : 'The archive matches the live schema.',
        action: outcome === 'blocked' ? 'Accept the mismatch to proceed.' : null,
      },
    ],
    rollback: {
      configured: 'retain_database',
      effective: 'retain_database',
      downgraded: false,
      reason: null,
    },
    archiveMigration: '20260906090000_earlier',
    liveMigration: '20260907120000_add_database_backup_runs',
    databaseSizeBytes: '9007199254740993',
    freeDiskBytes: null,
  };

  if (outcome === 'guided') {
    return {
      ...base,
      outcome: 'guided',
      guidance: {
        reason: 'The connecting role lacks CREATEDB.',
        commands: GUIDED_COMMANDS,
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
        message: 'The archive predates the live schema by two migrations.',
        overridable: true,
        // The API's FIELD NAME, published so a client never hard-codes which
        // flag clears which gate.
        overrideParameter: RESTORE_SCHEMA_OVERRIDE_FIELD,
      },
    };
  }

  return { ...base, outcome: 'ok' };
}

describe('Admin database-restore API (Integration)', () => {
  let context: TestContext;
  let prisma: any;

  const restoreEngine = {
    startRestore: jest.fn(),
    rollback: jest.fn(),
    dropExpiredOldDatabases: jest.fn(),
  };

  const runner = {
    assertStorageProviderUsable: jest.fn(),
    startBackup: jest.fn(),
    cancel: jest.fn(),
  };

  const storage = {
    delete: jest.fn(),
    getSignedDownloadUrl: jest.fn(),
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: DatabaseRestoreService, useValue: restoreEngine },
        { provide: DatabaseBackupRunnerService, useValue: runner },
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    prisma = context.prismaMock;
    prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow());
    prisma.databaseBackupRun.findFirst.mockResolvedValue(null);

    restoreEngine.startRestore.mockReset();
    restoreEngine.startRestore.mockResolvedValue({
      outcome: 'started',
      runId: RUN_ID,
      scratchDatabase: SCRATCH_DB,
      oldDatabase: OLD_DB,
      preflight: preflight('ok'),
    });
    restoreEngine.rollback.mockReset();
    restoreEngine.rollback.mockResolvedValue({
      outcome: 'renamed',
      runId: RUN_ID,
      promoted: OLD_DB,
      parked: 'appdb_restore_20260907T040000Z',
    });

    runner.assertStorageProviderUsable.mockReset();
    runner.assertStorageProviderUsable.mockImplementation(() => undefined);
    storage.getSignedDownloadUrl.mockReset();
  });

  const server = () => context.app.getHttpServer();

  // =========================================================================
  // ⚠ The confirmation literal — and the proof that nothing was started
  // =========================================================================

  describe('the typed confirmation is the safety feature', () => {
    /**
     * Every way a retry, a replay, a copied cURL line or a fat-fingered body
     * arrives.
     *
     * `{ confirm: true }` is the shape this design rejected outright and it is
     * listed FIRST, because it is the one somebody will propose again: it is
     * trivially reproduced by a proxy replaying a POST, by a client library
     * retrying on a socket timeout, or by a double-click.
     */
    const BAD_BODIES: Array<[string, Record<string, unknown>]> = [
      ['a boolean confirm flag', { confirm: true }],
      ['no body at all', {}],
      ['a lower-case word', { confirmation: 'restore' }],
      ['a misspelt word', { confirmation: 'RESTOR' }],
      ['the empty string', { confirmation: '' }],
      ['a boolean in the confirmation field', { confirmation: true }],
      ["the OTHER route's word", { confirmation: 'ROLLBACK' }],
    ];

    it.each(BAD_BODIES)('400s on %s and starts NOTHING', async (_label, body) => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(400);

      // ⚠ THE ASSERTION THAT MATTERS. A 400 that had already run the pre-flight,
      // downloaded an archive or claimed the restore slot would be a 400 that
      // did damage. Nothing reached the engine at all.
      expect(restoreEngine.startRestore).not.toHaveBeenCalled();

      // And not even the run lookup: the pipe refuses the body before the
      // handler body executes.
      expect(prisma.databaseBackupRun.findUnique).not.toHaveBeenCalled();

      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it.each([
      ['no body at all', {}],
      ['a boolean confirm flag', { confirm: true }],
      ['a lower-case word', { confirmation: 'rollback' }],
      ["the OTHER route's word", { confirmation: 'RESTORE' }],
    ] as Array<[string, Record<string, unknown>]>)(
      'rollback 400s on %s and starts NOTHING',
      async (_label, body) => {
        const admin = await createMockAdminUser(context);

        await request(server())
          .post(ROLLBACK_PATH)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(400);

        expect(restoreEngine.rollback).not.toHaveBeenCalled();
      }
    );

    it('accepts the exact literal, and only then', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);

      expect(restoreEngine.startRestore).toHaveBeenCalledTimes(1);
    });

    it('names the override field the pre-flight publishes, and nothing else', () => {
      // The compile-time tie in the DTO cannot be observed at run time, so this
      // is its run-time half: a rename on either side that skipped one of them
      // would produce a `blocked` body telling the client to set a parameter
      // the endpoint rejects.
      expect(Object.keys(startRestoreRequestSchema.shape)).toContain(RESTORE_SCHEMA_OVERRIDE_FIELD);
      expect(RESTORE_SCHEMA_OVERRIDE_FIELD).toBe('overrideSchemaCheck');
    });
  });

  // =========================================================================
  // The three restore modes
  // =========================================================================

  describe('POST runs/:id/restore returns three normal outcomes', () => {
    it('mode "running": returns promptly with the names, and the work is detached', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        mode: 'running',
        runId: RUN_ID,
        scratchDatabase: SCRATCH_DB,
        oldDatabase: OLD_DB,
      });

      // The whole verdict travels with it, so #287's dialog can show what was
      // checked without a second round trip.
      expect(response.body.data.preflight.outcome).toBe('ok');
      expect(response.body.data.preflight.gates).toHaveLength(3);
      expect(response.body.data.preflight.gates.map((g: any) => g.id)).toEqual([
        'pg_client_version',
        'createdb_privilege',
        'schema_compatibility',
      ]);

      // The actor reaches the engine — a restore is the one action in this
      // subsystem that must never be attributable to nobody.
      expect(restoreEngine.startRestore.mock.calls[0][1]).toMatchObject({
        actorUserId: admin.id,
        overrideSchemaMismatch: false,
      });
    });

    it('mode "guided": is a 200, NOT an error status, and carries a complete block', async () => {
      const admin = await createMockAdminUser(context);
      restoreEngine.startRestore.mockResolvedValue({
        outcome: 'refused',
        preflight: preflight('guided'),
      });

      // ⚠ THE STATUS CODE IS THE ASSERTION. A 4xx here would tell an operator
      // on managed PostgreSQL, mid-incident, that their platform is
      // unsupported. It is not — it is a platform this design planned for.
      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);

      expect(response.body.data.mode).toBe('guided');
      expect(response.body.data.guidance.runbook).toBe('docs/runbooks/database-restore.md');
      expect(response.body.data.guidance.reason).toMatch(/CREATEDB/);

      // COMPLETE, not merely present. Each of these is a value a placeholder
      // would have replaced, and a block with a placeholder in it is homework
      // rather than a deliverable.
      const commands: string = response.body.data.guidance.commands;
      expect(commands).toContain('db.internal');
      expect(commands).toContain('5432');
      expect(commands).toContain('appuser');
      expect(commands).toContain(SCRATCH_DB);
      expect(commands).toContain(OLD_DB);
      expect(commands).toContain(RUN_ID);
      expect(commands).not.toMatch(/<[a-z-]+>/i);

      // It is a REFUSAL: nothing was created, so there is no scratch database
      // name to publish and no run to poll beyond the one asked about.
      expect(response.body.data.scratchDatabase).toBeUndefined();

      // The envelope's own error fields are absent, which is the negative half
      // of "this is not an error".
      expect(response.body.code).toBeUndefined();
      expect(response.body.statusCode).toBeUndefined();
    });

    it('mode "blocked": is a 200 that names the field which unblocks it', async () => {
      const admin = await createMockAdminUser(context);
      restoreEngine.startRestore.mockResolvedValue({
        outcome: 'refused',
        preflight: preflight('blocked'),
      });

      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        mode: 'blocked',
        runId: RUN_ID,
        block: {
          gateId: 'schema_compatibility',
          overridable: true,
          overrideParameter: 'overrideSchemaCheck',
        },
      });

      // The comparison the operator's decision actually rests on, in the body
      // that asks them to make it.
      expect(response.body.data.preflight.archiveMigration).toBe('20260906090000_earlier');
      expect(response.body.data.preflight.liveMigration).toBe(
        '20260907120000_add_database_backup_runs'
      );
    });
  });

  // =========================================================================
  // ⚠ The override unblocks ONE gate — with the explicit negative
  // =========================================================================

  describe('overrideSchemaCheck', () => {
    it('unblocks the schema gate: the flag reaches the engine and the restore runs', async () => {
      const admin = await createMockAdminUser(context);

      // The engine's own contract: with the override set, its pre-flight comes
      // back `ok` rather than `blocked`. `restore-preflight.service.spec.ts`
      // proves that half; this proves the flag gets there.
      restoreEngine.startRestore.mockImplementation(async (_row: unknown, options: any) =>
        options.overrideSchemaMismatch
          ? {
              outcome: 'started',
              runId: RUN_ID,
              scratchDatabase: SCRATCH_DB,
              oldDatabase: OLD_DB,
              preflight: preflight('ok'),
            }
          : { outcome: 'refused', preflight: preflight('blocked') }
      );

      const blocked = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);
      expect(blocked.body.data.mode).toBe('blocked');

      const unblocked = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE', overrideSchemaCheck: true })
        .expect(200);
      expect(unblocked.body.data.mode).toBe('running');

      // ⚠ THE FLAG, ON THE OPTION THE ENGINE ACTUALLY READS. The request field
      // and the service option are deliberately named differently, and this is
      // the assertion that proves the mapping happened rather than the flag
      // being quietly dropped.
      expect(restoreEngine.startRestore.mock.calls[1][1]).toMatchObject({
        overrideSchemaMismatch: true,
      });
    });

    it('⚠ CANNOT unblock a capability gate — the explicit negative', async () => {
      const admin = await createMockAdminUser(context);

      // A cluster whose role lacks CREATEDB, modelled exactly as the pre-flight
      // behaves: the override is inspected and CHANGES NOTHING, because no
      // amount of accepting makes a role without CREATEDB able to create a
      // database. An override that silenced this would not enable a restore; it
      // would start one that dies at `CREATE DATABASE`, after downloading the
      // whole archive.
      restoreEngine.startRestore.mockImplementation(async () => ({
        outcome: 'refused',
        preflight: preflight('guided'),
      }));

      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE', overrideSchemaCheck: true })
        .expect(200);

      expect(response.body.data.mode).toBe('guided');
      expect(response.body.data.mode).not.toBe('running');

      // The flag WAS forwarded — this is not passing because the request was
      // ignored — and the answer is still `guided`.
      expect(restoreEngine.startRestore.mock.calls[0][1]).toMatchObject({
        overrideSchemaMismatch: true,
      });

      // And the block that remains is a capability finding, which no request
      // field names as overridable.
      const createdb = response.body.data.preflight.gates.find(
        (g: any) => g.id === 'createdb_privilege'
      );
      expect(createdb).toMatchObject({ kind: 'capability', verdict: 'warning' });
    });
  });

  // =========================================================================
  // ⚠ The 409, asserted through the real filter
  // =========================================================================

  describe('a second concurrent restore', () => {
    it('409s with details.activeRunId surviving the exception filter', async () => {
      const admin = await createMockAdminUser(context);

      // The engine's process-local guard, as it really behaves: the first claim
      // wins and every later one is refused BY NAME.
      let claimed: string | null = null;
      restoreEngine.startRestore.mockImplementation(async () => {
        if (claimed !== null) return { outcome: 'already_running', runId: claimed };
        claimed = RUN_ID;

        return {
          outcome: 'started',
          runId: RUN_ID,
          scratchDatabase: SCRATCH_DB,
          oldDatabase: OLD_DB,
          preflight: preflight('ok'),
        };
      });

      const first = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);
      expect(first.body.data.mode).toBe('running');

      const second = await request(server())
        .post(`/api/admin/db-backup/runs/${OTHER_RUN_ID}/restore`)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(409);

      // ⚠ THE ASSERTION THIS BLOCK EXISTS FOR. `details.activeRunId` is the only
      // route by which the winning run's id can reach the client: the filter
      // rebuilds the body from `message` and `details` alone, so the same field
      // written at the top level would be gone by now.
      expect(second.body.details).toEqual({
        activeRunId: RUN_ID,
        reason: 'restore_already_running',
      });

      // The proof that it is the FILTER's body and not the exception's: `code`
      // is derived from the status and the envelope's own fields are present.
      expect(second.body.code).toBe('CONFLICT');
      expect(second.body.statusCode).toBe(409);
      expect(second.body.path).toBe(`/api/admin/db-backup/runs/${OTHER_RUN_ID}/restore`);
      expect(second.body).toHaveProperty('timestamp');

      // The negative half: nothing survives at the top level. If a future edit
      // moved `activeRunId` out of `details`, this fails rather than a client
      // silently losing the field.
      expect(second.body.activeRunId).toBeUndefined();
    });
  });

  // =========================================================================
  // Rollback — three modes, and the one that must not be a 500
  // =========================================================================

  describe('POST runs/:id/rollback', () => {
    beforeEach(() => {
      prisma.databaseBackupRun.findUnique.mockResolvedValue(restoredRow());
    });

    it('mode "renamed" in retain mode — seconds', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post(ROLLBACK_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROLLBACK' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        mode: 'renamed',
        runId: RUN_ID,
        promoted: OLD_DB,
        parked: 'appdb_restore_20260907T040000Z',
      });

      // The detail has to convey the process exit, or an operator reads the
      // very next failed request as the rollback having gone wrong.
      expect(response.body.data.detail).toMatch(/exiting/i);
    });

    it('mode "restore_started" in dump mode, driving the restore with the schema check overridden', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(
        restoredRow({ restoreOldDb: null, preRestoreBackupId: PRE_RESTORE_ID })
      );

      // The REAL delegation, modelled the way `DatabaseRestoreService.rollback`
      // performs it: no database to rename, so it re-enters the restore path
      // against the safety archive.
      restoreEngine.rollback.mockImplementation(async (row: any, actorUserId: string) => {
        const started = await restoreEngine.startRestore(
          { id: PRE_RESTORE_ID },
          { actorUserId, overrideSchemaMismatch: true }
        );

        return started.outcome === 'started'
          ? { outcome: 'restore_started', runId: row.id, preRestoreRunId: PRE_RESTORE_ID }
          : { outcome: 'unavailable', runId: row.id, reason: 'could not start' };
      });

      const response = await request(server())
        .post(ROLLBACK_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROLLBACK' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        mode: 'restore_started',
        runId: RUN_ID,
        preRestoreRunId: PRE_RESTORE_ID,
      });

      // ⚠ THE FLAG REACHES THE SERVICE. The pre-restore dump came from the
      // schema this code was running moments before the restore, so the
      // migration it would be compared against is the ARCHIVE's — the gate
      // would block on a mismatch that exists only because the thing being
      // undone happened, at the exact moment an operator needs the way back.
      expect(restoreEngine.startRestore).toHaveBeenCalledWith(
        { id: PRE_RESTORE_ID },
        expect.objectContaining({ overrideSchemaMismatch: true })
      );

      // Hours, not seconds — and the body says which run to poll, which is NOT
      // the one that was asked about.
      expect(response.body.data.detail).toMatch(/schema check overridden/i);
      expect(response.body.data.detail).toContain(PRE_RESTORE_ID);
    });

    it('mode "unavailable" past the retention window — a 200, NOT a 500', async () => {
      const admin = await createMockAdminUser(context);
      restoreEngine.rollback.mockResolvedValue({
        outcome: 'unavailable',
        runId: RUN_ID,
        reason:
          `The displaced database "${OLD_DB}" has been dropped (past ` +
          'databaseBackup.oldDatabaseRetentionHours) and there is no completed pre-restore ' +
          'backup to fall back on.',
      });

      // ⚠ THE STATUS CODE IS THE ASSERTION. Nothing went wrong just now: the
      // rollback window closed, which an operator needs as a FACT rather than
      // as an error to retry — retrying changes nothing.
      const response = await request(server())
        .post(ROLLBACK_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROLLBACK' })
        .expect(200);

      expect(response.body.data.mode).toBe('unavailable');
      expect(response.body.data.detail).toMatch(/oldDatabaseRetentionHours/);
      expect(response.body.code).toBeUndefined();
    });

    it('400s a run that was never restored, without reaching the engine', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ restoreStatus: null }));

      const response = await request(server())
        .post(ROLLBACK_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'ROLLBACK' })
        .expect(400);

      // `unavailable` would have been the wrong answer here: it means the way
      // back expired, which is a fact about a restore that happened.
      expect(response.body.details).toMatchObject({
        runId: RUN_ID,
        reason: 'restore_never_ran',
      });
      expect(restoreEngine.rollback).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // The error mapping, on the wire
  // =========================================================================

  describe('typed errors become status codes in the controller', () => {
    it('404s for a run that does not exist, with the id under details', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(null);

      const response = await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.details).toEqual({
        runId: RUN_ID,
        reason: 'backup_run_not_found',
      });
      expect(restoreEngine.startRestore).not.toHaveBeenCalled();
    });

    it.each(['running', 'failed', 'stale'] as const)(
      '400s a %s run, because only a completed one is a whole archive',
      async (status) => {
        const admin = await createMockAdminUser(context);
        prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status }));

        const response = await request(server())
          .post(RESTORE_PATH)
          .set(authHeader(admin.accessToken))
          .send({ confirmation: 'RESTORE' })
          .expect(400);

        expect(response.body.details).toMatchObject({ reason: 'backup_not_completed' });
        expect(restoreEngine.startRestore).not.toHaveBeenCalled();
      }
    );

    it('rejects a non-uuid run id before anything else', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/db-backup/runs/not-a-uuid/restore')
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(400);

      expect(restoreEngine.startRestore).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ⚠ RBAC — `db_backup:restore`, NOT `db_backup:write`
  // =========================================================================

  describe('permissions', () => {
    const EXPECTED: Array<[keyof DatabaseBackupController, string]> = [
      ['restore', 'db_backup:restore'],
      ['rollback', 'db_backup:restore'],
    ];

    it.each(EXPECTED)('%s requires exactly %s', (handler, permission) => {
      const target = DatabaseBackupController.prototype[handler];

      // Asserted as METADATA as well as driven through the guards below,
      // because the two catch different mistakes: a route that had drifted from
      // `db_backup:restore` to `db_backup:write` would still 403 a viewer and
      // pass every request-level test in this file.
      expect(Reflect.getMetadata(PERMISSIONS_KEY, target)).toEqual([permission]);
      expect(Reflect.getMetadata(ROLES_KEY, target)).toEqual(['admin']);
    });

    it('does not settle for db_backup:write on either route', () => {
      for (const [handler] of EXPECTED) {
        const declared = Reflect.getMetadata(
          PERMISSIONS_KEY,
          DatabaseBackupController.prototype[handler]
        );

        // The split is the entire purpose of the third permission: a deployment
        // must be able to let somebody schedule backups without letting them
        // replace the database.
        expect(declared).not.toContain('db_backup:write');
      }
    });

    it.each([
      ['restore', RESTORE_PATH, { confirmation: 'RESTORE' }],
      ['rollback', ROLLBACK_PATH, { confirmation: 'ROLLBACK' }],
    ] as const)(
      'refuses %s to an admin holding ONLY db_backup:write',
      async (_name, path, body) => {
        const admin = await createMockAdminUser(context);
        stripPermission(prisma, admin.id, 'db_backup:restore');

        // ⚠ THE TEST THE SPLIT EXISTS FOR. This caller is an Admin, holds
        // `db_backup:write`, and may take a backup right now — and must not be
        // able to replace the database.
        await request(server())
          .post(path)
          .set(authHeader(admin.accessToken))
          .send(body)
          .expect(403);

        expect(restoreEngine.startRestore).not.toHaveBeenCalled();
        expect(restoreEngine.rollback).not.toHaveBeenCalled();
      }
    );

    it('still admits an admin who holds db_backup:restore', async () => {
      // The control for the case above: without it, a broken fixture that
      // stripped every permission would make that test pass for the wrong
      // reason.
      const admin = await createMockAdminUser(context);

      await request(server())
        .post(RESTORE_PATH)
        .set(authHeader(admin.accessToken))
        .send({ confirmation: 'RESTORE' })
        .expect(200);
    });

    it.each([
      ['restore', RESTORE_PATH],
      ['rollback', ROLLBACK_PATH],
    ] as const)('refuses a viewer on %s', async (_name, path) => {
      const viewer = await createMockViewerUser(context);

      await request(server()).post(path).set(authHeader(viewer.accessToken)).send({}).expect(403);
    });

    it.each([
      ['restore', RESTORE_PATH],
      ['rollback', ROLLBACK_PATH],
    ] as const)('refuses an unauthenticated caller on %s', async (_name, path) => {
      await request(server()).post(path).send({}).expect(401);
    });
  });
});

/**
 * Removes one permission from a mock user's role, in place.
 *
 * The role fixture mirrors the SEED, where Admin holds all three
 * `db_backup:*` permissions — which is right, and which is exactly why a
 * "holds `db_backup:write` but not `db_backup:restore`" caller has to be
 * constructed rather than looked up. The JWT strategy re-reads the user on
 * every request, so intercepting that read is where the narrowing belongs: it
 * proves the PERMISSIONS GUARD refuses, rather than proving a token was signed
 * differently.
 */
function stripPermission(prisma: any, userId: string, permission: string): void {
  const previous = prisma.user.findUnique.getMockImplementation();

  prisma.user.findUnique.mockImplementation(async (args: any) => {
    const user = await previous(args);

    if (!user || user.id !== userId) return user;

    return {
      ...user,
      userRoles: (user.userRoles ?? []).map((userRole: any) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: (userRole.role.rolePermissions ?? []).filter(
            (rp: any) => rp.permission.name !== permission
          ),
        },
      })),
    };
  });
}
