// =============================================================================
// Restore pre-flight (issue #284, epic #254)
// =============================================================================
//
// The claims worth holding, in the order they matter:
//
//   1. NOTHING IS CREATED, DROPPED OR RENAMED, on ANY outcome. Asserted twice —
//      with spies on the four mutating helpers, and against the SQL every fake
//      client actually received, which is the assertion a future refactor
//      cannot route around.
//   2. `CREATEDB` DENIED PRODUCES A PASTEABLE COMMAND BLOCK, not an error. It
//      is asserted BY STRING, because the block is the entire deliverable of
//      that path and a placeholder in it is homework handed to somebody whose
//      application is down.
//   3. A SCHEMA MISMATCH BLOCKS IN BOTH DIRECTIONS, and the override unblocks
//      exactly that gate — never a capability gate. There is an explicit
//      negative test, because an override that quietly widened would turn the
//      one deliberate escape hatch in this subsystem into a way to skip all of
//      it.
//   4. A SHORT DISK DOWNGRADES AND SAYS SO; an unreadable data directory warns.
//      Neither refuses: an administrator mid-incident must never be left with
//      no path forward.
//
// Every cluster call goes through the injected seam, so no test here needs a
// PostgreSQL — and the two `pg` clients this subsystem can open are never
// constructed at all.
// =============================================================================

import type { DatabaseBackupRun } from '@prisma/client';

import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import * as adminConnection from './admin-connection.util';
import type { AdminConnection, AdminQueryClient } from './admin-connection.util';
import {
  DatabaseRestorePreflightService,
  RESTORE_GATE_IDS,
  RESTORE_RUNBOOK_PATH,
  type RestoreGateId,
  type RestorePreflightResult,
  type RestorePreflightSeam,
} from './restore-preflight.service';
import type { PgVersionCheck } from './pg-version.util';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-07T12:00:00.000Z');
const SCRATCH = 'appdb_restore_20260907T120000Z';
const OLD = 'appdb_old_20260907T120000Z';

const CONNECTION: AdminConnection = {
  host: '127.0.0.1',
  port: '5432',
  user: 'appuser',
  password: 'super-secret-password',
  database: 'postgres',
  sslMode: null,
  liveDatabase: 'appdb',
};

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: '',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

const RUN = {
  id: '0d1f1c9e-0000-4000-8000-000000000284',
  status: 'completed',
  trigger: 'manual',
  storageKey: 'database-backups/app/2026/09/app-20260907T020000Z-run-284.dump',
  migrationName: '20260907120000_add_database_backup_runs',
} as unknown as DatabaseBackupRun;

const VERSION_OK: PgVersionCheck = {
  status: 'ok',
  clientMajor: 17,
  serverMajor: 17,
  message: 'PostgreSQL client major 17 can dump server major 17.',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  policy?: Partial<SystemDatabaseBackupValue>;
  version?: PgVersionCheck;
  /** Makes the whole admin session fail, as an unreachable cluster does. */
  adminError?: Error;
  canCreateDatabase?: boolean;
  dataDirectory?: string | null;
  databaseSizeBytes?: string;
  distinctClientAddresses?: string;
  /** Extensions installed in the live database, or `null` for "could not read". */
  installedExtensions?: string[] | null;
  /** Extensions the cluster can offer. Anything installed but not here is missing. */
  availableExtensions?: string[];
  liveMigration?: string | null;
  freeDiskBytes?: bigint | null;
}

function harness(options: HarnessOptions = {}) {
  /** Every statement any fake client received. The no-mutation assertion reads this. */
  const sql: string[] = [];

  const client: AdminQueryClient = {
    connect: jest.fn(async () => undefined),
    query: jest.fn(async (text: string, values?: unknown[]) => {
      sql.push(text);

      if (text.includes('rolcreatedb')) {
        return { rows: [{ can_create: options.canCreateDatabase ?? true }] };
      }

      if (text.includes('data_directory')) {
        const dir = options.dataDirectory === undefined ? '/var/lib/pg/data' : options.dataDirectory;
        if (dir === null) throw new Error('must be superuser to examine "data_directory"');

        return { rows: [{ data_directory: dir }] };
      }

      if (text.includes('pg_database_size')) {
        return { rows: [{ size: options.databaseSizeBytes ?? '1000' }] };
      }

      if (text.includes('COUNT(DISTINCT client_addr)')) {
        return { rows: [{ count: options.distinctClientAddresses ?? '1' }] };
      }

      if (text.includes('pg_available_extensions')) {
        const available = options.availableExtensions ?? ['plpgsql', 'pgcrypto', 'uuid-ossp'];

        return { rows: available.includes(String(values?.[0])) ? [{ ok: 1 }] : [] };
      }

      return { rows: [] };
    }),
    end: jest.fn(async () => undefined),
  };

  const seam: RestorePreflightSeam = {
    resolveConnection: jest.fn(() => CONNECTION),
    withAdminConnection: jest.fn(async (_config, fn) => {
      if (options.adminError !== undefined) throw options.adminError;

      return fn(client);
    }),
    checkClientVersion: jest.fn(async () => options.version ?? VERSION_OK),
    readFreeDiskBytes: jest.fn(async () =>
      options.freeDiskBytes === undefined ? 100_000n : options.freeDiskBytes
    ),
  };

  const prisma = {
    // Tagged-template double, matching the runner's suite: both reads this
    // service makes through Prisma are raw catalog queries.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      sql.push(text);

      if (text.includes('pg_extension')) {
        const installed =
          options.installedExtensions === undefined
            ? ['plpgsql', 'pgcrypto']
            : options.installedExtensions;
        if (installed === null) throw new Error('permission denied for pg_extension');

        return installed.map((extname) => ({ extname }));
      }

      if (text.includes('_prisma_migrations')) {
        const live =
          options.liveMigration === undefined ? RUN.migrationName : options.liveMigration;

        return live === null ? [] : [{ migration_name: live }];
      }

      return [];
    }),
  } as unknown as PrismaService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => ({ ...POLICY, ...options.policy })),
  } as unknown as SystemSettingsService;

  const service = new DatabaseRestorePreflightService(prisma, settings, seam);

  return { service, seam, sql, client, prisma, settings };
}

function gate(result: RestorePreflightResult, id: RestoreGateId) {
  const found = result.gates.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no gate "${id}" in the result`);

  return found;
}

/** Every statement a restore must never issue while it is only being considered. */
const MUTATING_SQL = /CREATE DATABASE|DROP DATABASE|ALTER DATABASE|pg_terminate_backend/i;

// ---------------------------------------------------------------------------

describe('DatabaseRestorePreflightService', () => {
  describe('the happy path', () => {
    it('reports ok, and names both derived databases', async () => {
      const { service } = harness();

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(result.targetDatabase).toBe('appdb');
      expect(result.scratchDatabase).toBe(SCRATCH);
      expect(result.oldDatabase).toBe(OLD);
      expect(result.runId).toBe(RUN.id);
    });

    it('reports a verdict for EVERY gate, not only the failures', async () => {
      // #287's dialog renders the whole list: an operator about to replace
      // their production database is entitled to see what was checked.
      const { service } = harness();

      const result = await service.check(RUN, { now: NOW });

      expect(result.gates.map((entry) => entry.id)).toEqual([...RESTORE_GATE_IDS]);
      expect(result.gates.every((entry) => entry.detail.length > 0)).toBe(true);
    });

    it('publishes the byte counts as decimal strings, never as bigint', async () => {
      // `JSON.stringify` refuses a bigint outright — the hazard
      // `db-backup-run.dto.ts` already converts around for sizeBytes.
      const { service } = harness({ databaseSizeBytes: '9007199254740993' });

      const result = await service.check(RUN, { now: NOW });

      expect(result.databaseSizeBytes).toBe('9007199254740993');
      expect(JSON.stringify(result)).toContain('9007199254740993');
    });
  });

  describe('the capability gates', () => {
    it('guides — it does not error — when the role may not CREATE DATABASE', async () => {
      // Managed PostgreSQL routinely denies CREATEDB. A 4xx here would tell an
      // operator their platform is unsupported when it is not.
      const { service } = harness({ canCreateDatabase: false });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('guided');
      expect(gate(result, 'createdb_privilege').verdict).toBe('warning');
    });

    it('guides when the maintenance connection cannot be opened', async () => {
      const { service } = harness({ adminError: new Error('ECONNREFUSED 127.0.0.1:5432') });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('guided');
      expect(gate(result, 'admin_connection').verdict).toBe('warning');
      expect(gate(result, 'admin_connection').detail).toContain('ECONNREFUSED');
    });

    it('does not report CREATEDB a second time for an unreachable cluster', async () => {
      // Two findings for one cause read as two separate problems to fix.
      const { service } = harness({ adminError: new Error('down') });

      const result = await service.check(RUN, { now: NOW });

      expect(gate(result, 'createdb_privilege').verdict).toBe('pass');
      expect(gate(result, 'createdb_privilege').detail).toContain('Not checked');
    });

    it('guides when the server cannot offer an extension the database uses', async () => {
      const { service } = harness({
        installedExtensions: ['plpgsql', 'postgis'],
        availableExtensions: ['plpgsql'],
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('guided');
      expect(gate(result, 'extensions').detail).toContain('postgis');
      expect(gate(result, 'extensions').action).toContain('postgis');
    });

    it('passes the extension gate when every installed extension is available', async () => {
      const { service } = harness({
        installedExtensions: ['plpgsql', 'pgcrypto'],
        availableExtensions: ['plpgsql', 'pgcrypto', 'uuid-ossp'],
      });

      const result = await service.check(RUN, { now: NOW });

      expect(gate(result, 'extensions').verdict).toBe('pass');
      expect(result.outcome).toBe('ok');
    });

    it('does not guide merely because the installed extensions could not be read', async () => {
      // "Could not check" and "nothing to check" are different answers, and
      // only one of them is a reason to send somebody to a manual restore.
      const { service } = harness({ installedExtensions: null });

      const result = await service.check(RUN, { now: NOW });

      expect(gate(result, 'extensions').verdict).toBe('pass');
      expect(result.outcome).toBe('ok');
    });
  });

  describe('the client/server version gate', () => {
    it('BLOCKS, non-overridably, when the client is older than the server', async () => {
      // The one capability failure with no manual answer: the guided block's
      // pg_restore is still a pg_restore. The fix is an image rebuild.
      const { service } = harness({
        version: {
          status: 'blocked',
          clientMajor: 16,
          serverMajor: 18,
          message: 'The PostgreSQL client in this image is major 16, but the server is major 18.',
        },
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.block.gateId).toBe('pg_client_version');
      expect(result.block.overridable).toBe(false);
      expect(result.block.overrideParameter).toBeNull();
    });

    it('still blocks on the version pair when CREATEDB is also denied', async () => {
      // Precedence: nothing else matters if the binaries cannot read the
      // archive, so the version block outranks the guided path.
      const { service } = harness({
        canCreateDatabase: false,
        version: {
          status: 'blocked',
          clientMajor: 16,
          serverMajor: 18,
          message: 'client 16 < server 18',
        },
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('blocked');
    });

    it('proceeds when the version pair is merely unreadable', async () => {
      // An unparseable version banner is not evidence that anything is wrong,
      // and must never be the reason a recovery did not happen.
      const { service } = harness({
        version: {
          status: 'unknown',
          clientMajor: null,
          serverMajor: null,
          message: 'Could not determine the PostgreSQL version pair.',
        },
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'pg_client_version').verdict).toBe('warning');
    });

    it('proceeds when the version check itself throws', async () => {
      const { service, seam } = harness();
      (seam.checkClientVersion as jest.Mock).mockRejectedValue(new Error('spawn ENOENT'));

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'pg_client_version').verdict).toBe('warning');
    });
  });

  describe('the disk gate', () => {
    it('downgrades retain_database to pre_restore_dump, and reports the downgrade', async () => {
      // The recovery guarantee changes from seconds to hours. That is a
      // decision an operator can act on; "not enough disk, refused" is not.
      const { service } = harness({
        policy: { restoreRollbackMode: 'retain_database' },
        databaseSizeBytes: '1000',
        freeDiskBytes: 1500n,
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(result.rollback).toEqual({
        configured: 'retain_database',
        effective: 'pre_restore_dump',
        downgraded: true,
        reason: expect.stringContaining('seconds'),
      });
      expect(gate(result, 'disk_space').verdict).toBe('warning');
      expect(gate(result, 'disk_space').detail).toContain('dropped instead of kept');
    });

    it('keeps retain_database when there is room for both copies', async () => {
      const { service } = harness({
        policy: { restoreRollbackMode: 'retain_database' },
        databaseSizeBytes: '1000',
        freeDiskBytes: 5000n,
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.rollback.effective).toBe('retain_database');
      expect(result.rollback.downgraded).toBe(false);
      expect(gate(result, 'disk_space').verdict).toBe('pass');
    });

    it('warns rather than blocks when the data directory is not readable', async () => {
      // The ordinary case: the database is external to the compose stack, so
      // its data directory belongs to a host this container cannot see. A
      // false block here would refuse a recovery on the strength of a statfs
      // against somebody else's filesystem.
      const { service, seam } = harness({ dataDirectory: null });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'disk_space').verdict).toBe('warning');
      expect(result.freeDiskBytes).toBeNull();
      // Not even attempted: there is no path to stat.
      expect(seam.readFreeDiskBytes).not.toHaveBeenCalled();
    });

    it('warns rather than blocks when the data directory is invisible to this process', async () => {
      const { service } = harness({ dataDirectory: '/var/lib/pg/data', freeDiskBytes: null });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'disk_space').verdict).toBe('warning');
      // The configured guarantee stands: downgrading on a guess would silently
      // remove a rollback the operator asked for.
      expect(result.rollback.downgraded).toBe(false);
      expect(result.rollback.effective).toBe('retain_database');
    });

    it('never blocks on a short disk in drop_database either', async () => {
      const { service } = harness({
        policy: { restoreRollbackMode: 'drop_database' },
        databaseSizeBytes: '1000',
        freeDiskBytes: 10n,
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'disk_space').verdict).toBe('warning');
      expect(result.rollback.effective).toBe('pre_restore_dump');
      expect(result.rollback.downgraded).toBe(false);
    });
  });

  describe('the replica heuristic', () => {
    it('warns on several client addresses, and never blocks', async () => {
      // It counts a bastion host and a psql window too. Refusing a legitimate
      // recovery over that would be indefensible.
      const { service } = harness({ distinctClientAddresses: '4' });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'replicas').verdict).toBe('warning');
      expect(gate(result, 'replicas').detail).toContain('per-process');
    });

    it('passes on a single client address', async () => {
      const { service } = harness({ distinctClientAddresses: '1' });

      const result = await service.check(RUN, { now: NOW });

      expect(gate(result, 'replicas').verdict).toBe('pass');
    });
  });

  describe('the schema gate', () => {
    it('blocks when the archive is OLDER than the live schema', async () => {
      const { service } = harness({ liveMigration: '20260908000000_later_migration' });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.block.gateId).toBe('schema_compatibility');
      expect(result.block.overridable).toBe(true);
      expect(result.block.overrideParameter).toBe('overrideSchemaCheck');
      expect(result.block.message).toContain('rolls the schema back');
    });

    it('blocks when the archive is NEWER than the live schema', async () => {
      // The direction that looks harmless: the migration runner will consider
      // the schema up to date and apply nothing, so nobody is ever told.
      const { service } = harness({ liveMigration: '20260101000000_earlier_migration' });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.block.gateId).toBe('schema_compatibility');
      expect(result.block.message).toContain('ahead of this database');
    });

    it('warns rather than blocks when the archive records no migration', async () => {
      // #281 records it best-effort. Refusing to restore an archive whose
      // audit read failed would make a best-effort field load-bearing.
      const { service } = harness();
      const run = { ...RUN, migrationName: null } as DatabaseBackupRun;

      const result = await service.check(run, { now: NOW });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'schema_compatibility').verdict).toBe('warning');
    });

    it('is unblocked by the override', async () => {
      const { service } = harness({ liveMigration: '20260908000000_later_migration' });

      const result = await service.check(RUN, {
        now: NOW,
        overrideSchemaMismatch: true,
      });

      expect(result.outcome).toBe('ok');
      expect(gate(result, 'schema_compatibility').verdict).toBe('warning');
      expect(gate(result, 'schema_compatibility').detail).toContain('Overridden by the caller');
    });

    it('⚠ the override NEVER unblocks a capability gate', async () => {
      // The explicit negative test. No amount of accepting makes a role
      // without CREATEDB able to create a database, and an override that
      // silenced everything would turn the one deliberate escape hatch in this
      // subsystem into a way to skip all of it.
      const { service } = harness({
        canCreateDatabase: false,
        liveMigration: '20260908000000_later_migration',
      });

      const result = await service.check(RUN, {
        now: NOW,
        overrideSchemaMismatch: true,
      });

      expect(result.outcome).toBe('guided');
    });

    it('⚠ the override NEVER unblocks the version pair', async () => {
      const { service } = harness({
        version: {
          status: 'blocked',
          clientMajor: 16,
          serverMajor: 18,
          message: 'client 16 < server 18',
        },
      });

      const result = await service.check(RUN, { now: NOW, overrideSchemaMismatch: true });

      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') throw new Error('unreachable');
      expect(result.block.gateId).toBe('pg_client_version');
    });

    it('prefers the guided path over the schema block when both fail', async () => {
      // Telling an operator to re-send with an override when the automated
      // path cannot run at all is a loop, not an instruction.
      const { service } = harness({
        canCreateDatabase: false,
        liveMigration: '20260908000000_later_migration',
      });

      const result = await service.check(RUN, { now: NOW });

      expect(result.outcome).toBe('guided');
      // The schema finding is not lost — the dialog renders every verdict.
      expect(gate(result, 'schema_compatibility').verdict).toBe('block');
    });
  });

  describe('the guided command block', () => {
    async function guided(options: HarnessOptions = {}): Promise<string> {
      const { service } = harness({ canCreateDatabase: false, ...options });
      const result = await service.check(RUN, { now: NOW });

      if (result.outcome !== 'guided') throw new Error(`expected guided, got ${result.outcome}`);
      expect(result.guidance.runbook).toBe(RESTORE_RUNBOOK_PATH);

      return result.guidance.commands;
    }

    it('is fully parameterised with this deployment\'s real host, port and user', async () => {
      const commands = await guided();

      expect(commands).toContain(`createdb --host=127.0.0.1 --port=5432 --username=appuser ${SCRATCH}`);
      expect(commands).toContain(
        `pg_restore --host=127.0.0.1 --port=5432 --username=appuser --dbname=${SCRATCH} \\`
      );
      expect(commands).toContain('psql --host=127.0.0.1 --port=5432 --username=appuser --dbname=postgres');
    });

    it('carries --exit-on-error, without which a half-restored database swaps in', async () => {
      const commands = await guided();

      expect(commands).toContain('--no-owner --no-acl --exit-on-error --jobs=4');
    });

    it('names the real archive and the real run', async () => {
      const commands = await guided();

      expect(commands).toContain(RUN.storageKey);
      expect(commands).toContain(`/tmp/app-20260907T020000Z-run-284.dump`);
      expect(commands).toContain(`/api/admin/db-backup/runs/${RUN.id}/download`);
    });

    it('spells out both halves of the swap, and the way back', async () => {
      const commands = await guided();

      expect(commands).toContain(
        `-c 'ALTER DATABASE "appdb" RENAME TO "${OLD}";' \\`
      );
      expect(commands).toContain(`-c 'ALTER DATABASE "${SCRATCH}" RENAME TO "appdb";'`);
      expect(commands).toContain(`ALTER DATABASE "${OLD}" RENAME TO "appdb";`);
      expect(commands).toContain('pg_terminate_backend(pid)');
    });

    it('tells the operator to stop the application before the renames', async () => {
      // A rename fails while any session is connected, and the failure would
      // land after the archive had already been replayed.
      const commands = await guided();

      expect(commands).toContain('STOP THE APPLICATION');
    });

    it('leaves no placeholder the operator has to invent', async () => {
      const commands = await guided();

      expect(commands).not.toMatch(/<host>|<port>|<user>|<database>|<db>|YOUR[_ ]|\{\{/i);
      expect(commands).not.toContain('undefined');
      expect(commands).not.toContain('null');
    });

    it('never prints the database password', async () => {
      // It would land in an HTTP response, a browser's memory, a screenshot
      // and quite possibly a support ticket.
      const commands = await guided();

      expect(commands).not.toContain(CONNECTION.password);
      expect(commands).toContain('export PGPASSWORD=');
    });

    it('adds the migration step only when the schema also mismatches', async () => {
      const matched = await guided();
      expect(matched).not.toContain('prisma:migrate');

      const mismatched = await guided({ liveMigration: '20260908000000_later_migration' });
      expect(mismatched).toContain('prisma:migrate');
    });

    it('says which gate sent the operator here', async () => {
      const { service } = harness({ canCreateDatabase: false });
      const result = await service.check(RUN, { now: NOW });

      if (result.outcome !== 'guided') throw new Error('expected guided');
      expect(result.guidance.reason).toContain('may not create databases');
    });
  });

  describe('⚠ pre-flight changes nothing', () => {
    const mutations = [
      'createDatabase',
      'dropDatabase',
      'renameDatabase',
      'terminateConnections',
    ] as const;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([
      ['ok', {} as HarnessOptions],
      ['guided (no CREATEDB)', { canCreateDatabase: false } as HarnessOptions],
      ['guided (unreachable)', { adminError: new Error('down') } as HarnessOptions],
      [
        'blocked (schema)',
        { liveMigration: '20260908000000_later_migration' } as HarnessOptions,
      ],
      [
        'blocked (version)',
        {
          version: {
            status: 'blocked',
            clientMajor: 16,
            serverMajor: 18,
            message: 'client 16 < server 18',
          },
        } as HarnessOptions,
      ],
      ['short disk', { databaseSizeBytes: '1000', freeDiskBytes: 1n } as HarnessOptions],
    ])('creates, drops and renames nothing on the %s path', async (_label, options) => {
      const spies = mutations.map((name) =>
        jest.spyOn(adminConnection, name).mockImplementation(() => {
          throw new Error(`${name} must never be called from pre-flight`);
        })
      );

      const { service, sql } = harness(options);

      await service.check(RUN, { now: NOW });

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();

      // The stronger assertion, and the one a refactor cannot route around:
      // no statement the cluster received was a mutation.
      expect(sql.filter((text) => MUTATING_SQL.test(text))).toEqual([]);
      expect(sql.length).toBeGreaterThan(0);
    });
  });

  describe('the cluster session', () => {
    it('does all its reads in ONE session', async () => {
      // Each connection is a connection to the server a restore is about to
      // stress, and a leaked one is what makes the later rename fail.
      const { service, seam } = harness();

      await service.check(RUN, { now: NOW });

      expect(seam.withAdminConnection).toHaveBeenCalledTimes(1);
    });

    it('never throws on an unreachable cluster: the answer is a verdict', async () => {
      const { service } = harness({ adminError: new Error('timeout') });

      await expect(service.check(RUN, { now: NOW })).resolves.toMatchObject({
        outcome: 'guided',
      });
    });

    it('does not verify the archive, because that means downloading it', async () => {
      // Deliberately absent: proving an archive readable streams the whole
      // object through pg_restore --list. An HTTP request cannot wait on it;
      // it is the first phase of #285's asynchronous run.
      const { service, sql } = harness();

      await service.check(RUN, { now: NOW });

      expect(sql.some((text) => text.includes(RUN.storageKey))).toBe(false);
    });
  });
});
