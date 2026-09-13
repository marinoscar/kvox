// =============================================================================
// Integration tests for the admin database-backup API (issue #283, epic #254)
// =============================================================================
//
// `src/db-backup/db-backup-admin.service.spec.ts` proves what the service
// DECIDES. This suite proves the things only the real Nest router, the real
// guards, the real global pipe and — above all — THE REAL EXCEPTION FILTER can
// answer. Every case here fails for a reason a direct call to the service could
// not produce:
//
//   1. ⚠ THE ERROR BODY ON THE WIRE. `common/filters/http-exception.filter.ts`
//      REBUILDS every error response from a fixed set of keys — it reads
//      `message` and `details` off the thrown payload, DERIVES `code` from the
//      status code (discarding any the exception supplied), and adds
//      `statusCode`, `timestamp` and `path`. A field placed at the TOP LEVEL of
//      a thrown payload is silently dropped and NEVER REACHES THE CLIENT.
//
//      `exception.getResponse()` returns the payload BEFORE the filter has
//      touched it, so a unit test asserting on it proves nothing whatsoever
//      about what a client receives — it would pass identically with the filter
//      deleted, and with the field in the position that does not survive. The
//      409 that names the already-running backup is worth its entire response
//      to the operator who just clicked, so it is asserted HERE, through the
//      real filter, on the real body.
//
//   2. ⚠ BIGINT SERIALISATION. `bytesWritten` and `sizeBytes` are `BigInt`
//      columns and `JSON.stringify` REFUSES a `bigint` outright — it throws
//      rather than degrading. The catch is that this is invisible to an
//      object-comparing unit test: `toEqual` never serialises anything, so a
//      handler returning a raw Prisma row passes every assertion and then
//      throws inside the framework's serializer on the first real request. Only
//      driving a response with genuinely large values through the real
//      serializer can prove it, which is what the fixture below exists for.
//
//   3. ROUTE ORDER. Nest matches in DECLARATION ORDER, not by specificity, so a
//      literal route declared under `:id` becomes unreachable with no boot
//      error and no log line. The only way it is ever caught is a request going
//      through the real router.
//
//   4. RBAC. `@Auth({ roles, permissions })` is guards, and guards only run in
//      a request pipeline. A unit test calling `controller.getConfig()`
//      directly would pass with the decorator deleted.
//
// -----------------------------------------------------------------------------
// WHY THE RUNNER AND THE STORAGE PROVIDER ARE SUBSTITUTED
// -----------------------------------------------------------------------------
//
// `DatabaseBackupRunnerService` SPAWNS `pg_dump` and streams its output into a
// bucket. Its behaviour is proven against a seam in
// `src/db-backup/db-backup-runner.service.spec.ts` with no PostgreSQL binaries
// installed and no bucket, which is the whole reason that seam exists — and a
// suite that needed either on the runner is a suite CI skips. So the two
// collaborators that reach outside this process are the two that are
// substituted, and NOTHING ELSE IS: the controller, the admin service, the
// settings service, the guards, the pipe and the filter are all the real ones
// `AppModule` wires.
//
// The database is the shared deep mock (`useMockDatabase: true`), so what these
// assert about a response body is the shape and the wiring, never which rows a
// `where` matches — that is Postgres's answer and is asked in `*.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../../src/auth/decorators/roles.decorator';
import { DatabaseBackupController } from '../../src/db-backup/db-backup.controller';
import { BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS } from '../../src/db-backup/db-backup-admin.service';
import { DatabaseBackupRunnerService } from '../../src/db-backup/db-backup-runner.service';
import { PgJobRoleBroker } from '../../src/db-backup/pg-job-role.broker';
import { DatabaseBackupAlreadyRunningError } from '../../src/db-backup/db-backup.errors';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
/** #351: the `db.backup.run` job the enqueue creates alongside the run row. */
const JOB_ID = '11111111-1111-4111-8111-1111111111bb';
const OTHER_RUN_ID = '33333333-3333-4333-8333-333333333333';
const STORAGE_KEY = 'database-backups/app/2026/09/app-20260907T020000Z-run.dump';

/**
 * A byte count ABOVE 2^53.
 *
 * Deliberately not a small number: a fixture of `1024n` would let both a
 * `Number()` conversion and a missing conversion look plausible. At this
 * magnitude the string is the only representation that survives a round trip,
 * and a raw `bigint` is the only one that throws.
 */
const HUGE_BYTES = 9_007_199_254_740_993n;

/** One `database_backup_runs` row, as Prisma would hand it back. */
function backupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    status: 'completed',
    trigger: 'manual',
    startedAt: new Date('2026-09-07T02:00:00.000Z'),
    finishedAt: new Date('2026-09-07T02:41:00.000Z'),
    lastHeartbeatAt: new Date('2026-09-07T02:41:00.000Z'),
    bytesWritten: HUGE_BYTES,
    sizeBytes: HUGE_BYTES,
    storageProvider: 's3',
    storageKey: STORAGE_KEY,
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

/** A stored `system_settings` value carrying a `databaseBackup` namespace. */
function settingsRow(databaseBackup: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'settings-id',
    key: 'default',
    value: {
      databaseBackup: {
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
        ...databaseBackup,
      },
    },
    version: 1,
    updatedByUserId: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

describe('Admin database-backup API (Integration)', () => {
  let context: TestContext;
  let prisma: any;

  /** One shared, ordered log — "object then row" is a claim about interleaving. */
  let calls: string[];

  const runner = {
    assertStorageProviderUsable: jest.fn(),
    // #351: the endpoint ENQUEUES now. The double answers with the pair
    // `queueBackup` returns — a `pending` run row and the `db.backup.run` job
    // a worker will claim.
    queueBackup: jest.fn(),
    cancel: jest.fn(),
  };

  const storage = {
    delete: jest.fn(),
    getSignedDownloadUrl: jest.fn(),
  };

  /**
   * The #350 job-role broker, substituted for the same reason the runner and
   * the storage provider are: it opens a real `pg.Client` to a real cluster,
   * and a suite that needed one is a suite CI skips.
   * `src/db-backup/pg-job-role.broker.db.spec.ts` owns the cluster behaviour.
   */
  const jobRoles = {
    preflight: jest.fn(),
    usable: jest.fn(),
    issue: jest.fn(),
    revoke: jest.fn(),
    kind: 'postgres.readonly',
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: DatabaseBackupRunnerService, useValue: runner },
        { provide: STORAGE_PROVIDER, useValue: storage },
        { provide: PgJobRoleBroker, useValue: jobRoles },
      ],
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    calls = [];
    prisma = context.prismaMock;

    prisma.databaseBackupRun.findUnique.mockResolvedValue(null);
    prisma.databaseBackupRun.findFirst.mockResolvedValue(null);
    prisma.databaseBackupRun.findMany.mockResolvedValue([]);
    prisma.databaseBackupRun.count.mockResolvedValue(0);
    prisma.databaseBackupRun.deleteMany.mockImplementation(async () => {
      calls.push('row');

      return { count: 1 };
    });

    runner.assertStorageProviderUsable.mockReset();
    // The REAL rule, reached the way the service is supposed to reach it. The
    // pure helper it forwards to has its own tests in
    // `src/db-backup/db-backup-storage.spec.ts`.
    runner.assertStorageProviderUsable.mockImplementation(() => undefined);
    runner.queueBackup.mockReset();
    runner.queueBackup.mockResolvedValue({
      run: backupRow({ status: 'pending' }),
      job: { id: JOB_ID },
    });
    runner.cancel.mockReset();
    runner.cancel.mockReturnValue({ outcome: 'signalled', runId: RUN_ID });

    storage.delete.mockReset();
    storage.delete.mockImplementation(async () => {
      calls.push('object');
    });
    storage.getSignedDownloadUrl.mockReset();
    storage.getSignedDownloadUrl.mockResolvedValue('https://storage.example/key?signed');

    jobRoles.preflight.mockReset();
    jobRoles.preflight.mockResolvedValue({
      outcome: 'ok',
      kind: 'postgres.readonly',
      databaseRole: 'appuser',
      targetDatabase: 'appdb',
      detail: 'This deployment may create roles.',
    });
  });

  const server = () => context.app.getHttpServer();

  // =========================================================================
  // Route resolution — one of the four reasons this file exists
  // =========================================================================

  describe('literal routes resolve before the parameterised ones', () => {
    it('reads GET /admin/db-backup/config as the config route, not as a run id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // If a `@Get(':id')` were ever declared at the prefix root above this
      // route, `config` would be captured as an id and `ParseUUIDPipe` would
      // answer `400 Validation failed (uuid is expected)`. Asserting that the
      // POLICY came back is what makes this a route-order test rather than a
      // status-code coincidence.
      expect(response.body.data).toMatchObject({
        frequency: 'daily',
        timeOfDay: '02:00',
        retentionCount: 7,
      });
      expect(response.body.data).toHaveProperty('nextRunAt');
      expect(response.body.data).toHaveProperty('activeRunId');
    });

    it('reads POST /admin/db-backup/runs as the trigger, not as a run id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(202);

      expect(runner.queueBackup).toHaveBeenCalledWith({
        trigger: 'manual',
        createdById: admin.id,
      });
      expect(response.body.data.id).toBe(RUN_ID);
    });

    it('reads GET /admin/db-backup/node-credential-preflight as itself, not as a run id (#350)', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/db-backup/node-credential-preflight')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Hyphens and all — if a `@Get(':id')` were ever declared at the prefix
      // root above it, this would be captured as an id and `ParseUUIDPipe`
      // would answer `400 Validation failed (uuid is expected)`.
      expect(response.body.data).toMatchObject({
        outcome: 'ok',
        kind: 'postgres.readonly',
        databaseRole: 'appuser',
        targetDatabase: 'appdb',
        guidance: null,
      });
      expect(response.body.data).toHaveProperty('brokerEnabled');
    });

    it('reads GET /admin/db-backup/runs as the list, not as a run id', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findMany.mockResolvedValue([backupRow()]);
      prisma.databaseBackupRun.count.mockResolvedValue(1);

      const response = await request(server())
        .get('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
    });
  });

  // =========================================================================
  // ⚠ BigInt on the wire
  // =========================================================================

  describe('BigInt columns reach the client as exact decimal strings', () => {
    it('serialises a single run without a raw BigInt escaping', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow());

      const response = await request(server())
        .get(`/api/admin/db-backup/runs/${RUN_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      // A raw `bigint` in the payload would have made the framework's
      // serializer throw before any of this arrived.
      expect(typeof response.body.data.sizeBytes).toBe('string');
      expect(response.body.data.sizeBytes).toBe('9007199254740993');
      expect(response.body.data.bytesWritten).toBe('9007199254740993');

      // Asserted against the RAW RESPONSE TEXT, not the parsed body: this is
      // the only form in which "what actually went over the wire" can be
      // inspected, and it is what rules out a number that `JSON.parse` would
      // have quietly rounded to ...992.
      expect(response.text).toContain('"sizeBytes":"9007199254740993"');
      expect(response.text).not.toContain('9007199254740992');

      // The whole body round-trips, which a `bigint` anywhere in it could not.
      expect(() => JSON.stringify(response.body)).not.toThrow();
    });

    it('serialises the LIST path too, which is the one most likely to be shortcut', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findMany.mockResolvedValue([
        backupRow(),
        backupRow({ id: OTHER_RUN_ID, status: 'failed', sizeBytes: 0n, bytesWritten: 42n }),
      ]);
      prisma.databaseBackupRun.count.mockResolvedValue(2);

      const response = await request(server())
        .get('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(2);
      for (const item of response.body.data.items) {
        expect(typeof item.sizeBytes).toBe('string');
        expect(typeof item.bytesWritten).toBe('string');
      }
      expect(response.body.data.items[1]).toMatchObject({
        sizeBytes: '0',
        bytesWritten: '42',
      });
    });

    it('serialises the manual-trigger path too', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(202);

      expect(typeof response.body.data.bytesWritten).toBe('string');
    });
  });

  // =========================================================================
  // ⚠ The 409, asserted through the real filter
  // =========================================================================

  describe('POST runs', () => {
    it('returns promptly with a real id, then 409s with the active id', async () => {
      const admin = await createMockAdminUser(context);

      // The single-active-run slot, as the partial unique index enforces it:
      // the first claim wins and every later one is refused BY NAME.
      let claimed: string | null = null;
      runner.queueBackup.mockImplementation(async () => {
        if (claimed !== null) throw new DatabaseBackupAlreadyRunningError(claimed);
        claimed = RUN_ID;

        return { run: backupRow({ status: 'pending' }), job: { id: JOB_ID } };
      });

      const first = await request(server())
        .post('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(202);

      // A REAL id, not a job ticket or a boolean: the caller has something to
      // poll the moment the response lands.
      expect(first.body.data.id).toBe(RUN_ID);
      // ⚠ `pending`, NOT `running`, since #351 — and the change is a
      // correction rather than a regression. The row is created at ENQUEUE
      // time and the handler writes `running` when a worker actually claims
      // the job, so the endpoint no longer asserts that a `pg_dump` exists
      // before one does. `pending` was always in the DTO's status enum and in
      // `ACTIVE_BACKUP_STATUSES`, so no client contract moved.
      expect(first.body.data.status).toBe('pending');

      const second = await request(server())
        .post('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(409);

      // ⚠ THE ASSERTION THIS WHOLE FILE EXISTS FOR. `details.activeRunId` is
      // the only route by which the winning run's id can reach the client: the
      // filter rebuilds the body from `message` and `details` alone, so the
      // same field written at the top level of the thrown payload would be
      // gone by now.
      expect(second.body.details).toEqual({
        activeRunId: RUN_ID,
        reason: 'backup_already_running',
      });

      // And the proof that it is the FILTER's body and not the exception's:
      // `code` is derived from the status, and the envelope's own fields are
      // present.
      expect(second.body.code).toBe('CONFLICT');
      expect(second.body.statusCode).toBe(409);
      expect(second.body.path).toBe('/api/admin/db-backup/runs');
      expect(second.body).toHaveProperty('timestamp');

      // The negative half: nothing survives at the top level. If a future edit
      // moved `activeRunId` out of `details`, this is the assertion that fails
      // rather than a client silently losing the field.
      expect(second.body.activeRunId).toBeUndefined();
    });

    it('reports a storage provider this deployment lacks as a 400, not a 500', async () => {
      const admin = await createMockAdminUser(context);
      const { DatabaseBackupStorageProviderError } = await import(
        '../../src/db-backup/db-backup.errors'
      );
      runner.queueBackup.mockRejectedValue(
        new DatabaseBackupStorageProviderError('gcs', 's3')
      );

      const response = await request(server())
        .post('/api/admin/db-backup/runs')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(400);

      expect(response.body.details).toMatchObject({
        field: 'storageProvider',
        reason: 'storage_provider_unavailable',
      });
    });
  });

  // =========================================================================
  // nextRunAt
  // =========================================================================

  describe('GET config computes nextRunAt', () => {
    it('projects the next fire when backups are enabled', async () => {
      const admin = await createMockAdminUser(context);
      prisma.systemSettings.findUnique.mockResolvedValue(
        settingsRow({ enabled: true, timeOfDay: '02:00', timezone: 'UTC' })
      );

      const response = await request(server())
        .get('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const nextRunAt = response.body.data.nextRunAt as string;
      expect(nextRunAt).toMatch(/T02:00:00\.000Z$/);
      // Strictly in the future, and within a day — a daily schedule cannot be
      // further away than that, and a projection that had gone backwards or
      // stood still would pass a bare "is a string" assertion.
      const delta = Date.parse(nextRunAt) - Date.now();
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    it('is null when backups are disabled', async () => {
      const admin = await createMockAdminUser(context);
      prisma.systemSettings.findUnique.mockResolvedValue(settingsRow({ enabled: false }));

      const response = await request(server())
        .get('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.nextRunAt).toBeNull();
    });

    it('reports the run holding the active slot', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findFirst.mockResolvedValue({ id: OTHER_RUN_ID });

      const response = await request(server())
        .get('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.activeRunId).toBe(OTHER_RUN_ID);
    });
  });

  // =========================================================================
  // PUT config — the two refusals, at save time
  // =========================================================================

  describe('PUT config', () => {
    it('accepts a partial body and writes through the settings service', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .put('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .send({ enabled: true })
        .expect(200);

      // ONE settings writer: the row is updated through the system-settings
      // service's own path, which is what bumps `version` and preserves keys
      // this build does not model.
      expect(prisma.systemSettings.update).toHaveBeenCalled();
    });

    it('refuses an unknown timezone with a clean 400 AT SAVE TIME', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .put('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .send({ timezone: 'Mars/Olympus_Mons' })
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.details).toMatchObject({
        field: 'timezone',
        reason: 'unknown_timezone',
      });
      // The whole point of validating first: nothing was written, so the
      // deployment's schedule is exactly what it was.
      expect(prisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('refuses a storageProvider that is not the active one with a clean 400', async () => {
      const admin = await createMockAdminUser(context);
      const { DatabaseBackupStorageProviderError } = await import(
        '../../src/db-backup/db-backup.errors'
      );
      runner.assertStorageProviderUsable.mockImplementation(() => {
        throw new DatabaseBackupStorageProviderError('gcs', 's3');
      });

      const response = await request(server())
        .put('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .send({ storageProvider: 'gcs' })
        .expect(400);

      expect(response.body.details).toMatchObject({
        field: 'storageProvider',
        configured: 'gcs',
        active: 's3',
        reason: 'storage_provider_unavailable',
      });
      expect(prisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('still enforces the settings schema itself through the global pipe', async () => {
      const admin = await createMockAdminUser(context);

      // `compressionLevel` is bounded 0-9 by `systemDatabaseBackupPatchSchema`,
      // which this route reuses rather than re-declaring — so the bound is
      // enforced here without this controller stating it.
      await request(server())
        .put('/api/admin/db-backup/config')
        .set(authHeader(admin.accessToken))
        .send({ compressionLevel: 42 })
        .expect(400);
    });
  });

  // =========================================================================
  // Download
  // =========================================================================

  describe('GET runs/:id/download', () => {
    it('returns a bounded-expiry signed URL for a completed run', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow());

      const response = await request(server())
        .get(`/api/admin/db-backup/runs/${RUN_ID}/download`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        url: 'https://storage.example/key?signed',
        expiresIn: BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS,
      });

      // BOUNDED, and short: the URL is a credential-free capability over a
      // complete copy of the database.
      expect(BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS).toBeGreaterThan(0);
      expect(BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS).toBeLessThanOrEqual(15 * 60);
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.objectContaining({ expiresIn: BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS })
      );
    });

    it.each(['running', 'pending', 'failed', 'stale'])(
      '400s for a %s run and signs nothing',
      async (status) => {
        const admin = await createMockAdminUser(context);
        prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status }));

        const response = await request(server())
          .get(`/api/admin/db-backup/runs/${RUN_ID}/download`)
          .set(authHeader(admin.accessToken))
          .expect(400);

        expect(response.body.details).toMatchObject({
          runId: RUN_ID,
          status,
          reason: 'backup_not_completed',
        });
        expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      }
    );

    it('404s for a run that does not exist', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get(`/api/admin/db-backup/runs/${RUN_ID}/download`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // Delete
  // =========================================================================

  describe('DELETE runs/:id', () => {
    it('deletes the OBJECT first and the ROW second', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow());

      const response = await request(server())
        .delete(`/api/admin/db-backup/runs/${RUN_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({ id: RUN_ID, objectDeleted: true });
      // The reverse order would leave a multi-gigabyte object nothing points
      // at: the row is the only index of what is in the bucket.
      expect(calls).toEqual(['object', 'row']);
      expect(storage.delete).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('reports objectDeleted: false for an object that was already gone, and still deletes the row', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow());
      storage.delete.mockRejectedValue(new Error('NoSuchKey'));

      const response = await request(server())
        .delete(`/api/admin/db-backup/runs/${RUN_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({ id: RUN_ID, objectDeleted: false });
      // A missing object must NOT be able to leave an undeletable row.
      expect(calls).toEqual(['row']);
      expect(prisma.databaseBackupRun.deleteMany).toHaveBeenCalled();
    });

    it.each(['pending', 'running'])('refuses a %s run and touches nothing', async (status) => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status }));

      const response = await request(server())
        .delete(`/api/admin/db-backup/runs/${RUN_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(response.body.details).toMatchObject({ status, reason: 'backup_active' });
      expect(calls).toEqual([]);
    });

    it('404s for a run that does not exist', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .delete(`/api/admin/db-backup/runs/${RUN_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // Cancel
  // =========================================================================

  describe('POST runs/:id/cancel', () => {
    it('reports `signalled` when this process held the handle', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status: 'running' }));

      const response = await request(server())
        .post(`/api/admin/db-backup/runs/${RUN_ID}/cancel`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(response.body.data.outcome).toBe('signalled');
      expect(runner.cancel).toHaveBeenCalledWith(RUN_ID);
    });

    it('reports HONESTLY when no in-process handle exists', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status: 'running' }));
      runner.cancel.mockReturnValue({ outcome: 'not_running_here', runId: RUN_ID });

      const response = await request(server())
        .post(`/api/admin/db-backup/runs/${RUN_ID}/cancel`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      // The status code says the request was understood and acted on — which
      // it was. The BODY is where the truth lives, and it must not read as a
      // successful cancellation to anything that looks past the status line.
      expect(response.body.data.outcome).toBe('not_running_here');
      expect(response.body.data.detail).toMatch(/Nothing was stopped/i);
      expect(response.body.data.runId).toBe(RUN_ID);
    });

    it('400s for a run that has already settled', async () => {
      const admin = await createMockAdminUser(context);
      prisma.databaseBackupRun.findUnique.mockResolvedValue(backupRow({ status: 'completed' }));

      const response = await request(server())
        .post(`/api/admin/db-backup/runs/${RUN_ID}/cancel`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(400);

      expect(response.body.details).toMatchObject({ reason: 'backup_not_active' });
      expect(runner.cancel).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ⚠ `guided` is a 200 (#350)
  // =========================================================================

  describe('the node-credential pre-flight refuses with a verdict, never a status code', () => {
    it('answers 200 with the command block when this deployment cannot CREATE ROLE', async () => {
      const admin = await createMockAdminUser(context);
      jobRoles.preflight.mockResolvedValue({
        outcome: 'guided',
        kind: 'postgres.readonly',
        databaseRole: 'appuser',
        targetDatabase: 'appdb',
        detail: 'This deployment\'s database role ("appuser") may not CREATE ROLE.',
        guidance: {
          reason: 'no CREATEROLE',
          commands: 'ALTER ROLE "appuser" CREATEROLE;',
          runbook: 'docs/runbooks/node-job-secrets.md',
        },
      });

      const response = await request(server())
        .get('/api/admin/db-backup/node-credential-preflight')
        .set(authHeader(admin.accessToken))
        // ⚠ 200. Managed PostgreSQL withholding CREATEROLE is the ORDINARY
        // configuration; a 4xx would tell an administrator their platform is
        // unsupported when it is not, and a 5xx would say something is broken
        // when nothing is. The same argument the restore pair's `guided` mode
        // makes one file over.
        .expect(200);

      expect(response.body.data.outcome).toBe('guided');
      // The remedy survives the response pipeline verbatim — it is the part a
      // person pastes into a terminal.
      expect(response.body.data.guidance.commands).toBe('ALTER ROLE "appuser" CREATEROLE;');
      expect(response.body.data.guidance.runbook).toBe('docs/runbooks/node-job-secrets.md');
    });
  });

  // =========================================================================
  // RBAC — the decorators, and the guards that enforce them
  // =========================================================================

  describe('permissions', () => {
    /**
     * The exact permission each handler declares.
     *
     * Asserted as METADATA as well as driven through the guards below, because
     * the two catch different mistakes: the guard test proves the decorator is
     * doing something, and this table proves it is doing the RIGHT thing —
     * a route that had drifted from `db_backup:read` to `db_backup:write`
     * would still 403 a viewer and pass every request-level test.
     *
     * These strings are also the API half of the contract a settings card's
     * `permission` field must mirror byte for byte (CLAUDE.md, Settings UI
     * Pattern rule 3).
     */
    const EXPECTED: Array<[keyof DatabaseBackupController, string]> = [
      ['getConfig', 'db_backup:read'],
      ['updateConfig', 'db_backup:write'],
      ['startRun', 'db_backup:write'],
      ['listRuns', 'db_backup:read'],
      // A probe that creates nothing sits on the READ side.
      ['getNodeCredentialPreflight', 'db_backup:read'],
      ['download', 'db_backup:read'],
      ['cancel', 'db_backup:write'],
      ['getRun', 'db_backup:read'],
      ['remove', 'db_backup:write'],
    ];

    it.each(EXPECTED)('%s requires exactly %s', (handler, permission) => {
      const target = DatabaseBackupController.prototype[handler];

      expect(Reflect.getMetadata(PERMISSIONS_KEY, target)).toEqual([permission]);
      // The role admits; the permission is what the guard checks. Both are
      // stated on every route, matching `job-admin.controller.ts`.
      expect(Reflect.getMetadata(ROLES_KEY, target)).toEqual(['admin']);
    });

    it('never spends db_backup:restore on a route that only manages backups', () => {
      const declared = EXPECTED.map(([, permission]) => permission);

      // The third permission belongs to `runs/:id/restore` and
      // `runs/:id/rollback` (#286) and to nothing else. Its whole purpose is to
      // be granted separately, so a config read or a manual backup quietly
      // acquiring it would be a real regression — see
      // `db-backup-restore.integration.spec.ts` for the other half of the
      // split, which drives those two routes as a caller holding only
      // `db_backup:write` and expects 403.
      expect(declared).not.toContain('db_backup:restore');
    });

    it.each([
      ['get', '/api/admin/db-backup/config'],
      ['get', '/api/admin/db-backup/runs'],
      ['get', '/api/admin/db-backup/node-credential-preflight'],
      ['get', `/api/admin/db-backup/runs/${RUN_ID}`],
      ['get', `/api/admin/db-backup/runs/${RUN_ID}/download`],
      ['post', '/api/admin/db-backup/runs'],
      ['post', `/api/admin/db-backup/runs/${RUN_ID}/cancel`],
      ['put', '/api/admin/db-backup/config'],
      ['delete', `/api/admin/db-backup/runs/${RUN_ID}`],
    ] as const)('refuses a viewer on %s %s', async (method, path) => {
      const viewer = await createMockViewerUser(context);

      await (request(server()) as any)
        [method](path)
        .set(authHeader(viewer.accessToken))
        .send({})
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(server()).get('/api/admin/db-backup/config').expect(401);
    });
  });
});
