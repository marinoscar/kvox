// =============================================================================
// Real-Postgres test: a backup taken as the application role holds the org rows
// (issue #471, epic #467)
// =============================================================================
//
// The org tables FORCE row-level security and the API connects as an ordinary
// role, so a dump has to carry BOTH halves of the platform's pairing:
//
//   --enable-row-security   without it pg_dump refuses a forced table;
//   PGOPTIONS=-c app.rls_bypass=on   without it the flag alone EXITS 0 AND WRITES
//                                    AN ARCHIVE WITH NO ROWS.
//
// This suite takes a dump the way a backup job does (the platform's
// `systemDatabaseBackupEngine`, the engine `DatabaseBackupRunnerService` is
// built on, pointed at the deployment by the environment exactly as in
// production) against a throwaway database owned by an ordinary role
// (`test/helpers/app-role-database.helper.ts`), and asserts:
//
//   - the archive holds every `storage_objects` row of EVERY organization and
//     every `kvox_object_ownership` row;
//   - the control: the same dump WITHOUT the bypass option is exactly the silent
//     empty archive the pairing exists to prevent;
//   - the archive restores as the same ordinary role (the other half of the
//     pairing), into a database created from a template holding the extensions,
//     with the data intact and row-level security still enforced on the copy.
//
// Like every `*.db.spec.ts` it is excluded from `npm test` and runs through
// `npm run test:db`; it skips when no Postgres, no superuser to bootstrap the
// role with, or no `pg_dump`/`pg_restore` is available. It creates and drops
// its own databases and role.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import {
  PG_DUMP_COMMAND,
  buildPgDumpArgs,
  pgClientEnv,
  resolvePgConnection,
  spawnPgProcess,
  spawnPgRestore,
  systemDatabaseBackupEngine,
} from '@marinoscar/platform-api/db-backup/testing';

import type { DatabaseEnv } from '../../src/common/database-url';
import {
  commandAvailable,
  findAdminCredentials,
  provisionAppRoleDatabase,
  type AppRoleDatabase,
} from '../helpers/app-role-database.helper';

const admin = findAdminCredentials();
const clientTools = commandAvailable('pg_dump') && commandAvailable('pg_restore');

if (!admin || !clientTools) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[kvox-dump-rls.db.spec] SKIPPED: ` +
      (!admin
        ? `no superuser reachable at ${process.env.POSTGRES_HOST ?? '(POSTGRES_HOST unset)'}:${process.env.POSTGRES_PORT ?? '5432'} to bootstrap the application role with`
        : 'pg_dump / pg_restore are not on the PATH') +
      `. Re-run \`npm run test:db\` with a Postgres and the client tools available.\n`,
  );
}

const describeWithDb = admin && clientTools ? describe : describe.skip;

/** The environment variables a `pg_dump` child is configured from. */
const CONNECTION_KEYS = ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'PGOPTIONS'];

/** Runs `fn` with `process.env` pointing at `env` (and no `DATABASE_URL`/`PGOPTIONS`), then restores it. */
async function withProcessEnv<R>(env: DatabaseEnv, fn: () => R | Promise<R>): Promise<R> {
  const saved = new Map(CONNECTION_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of CONNECTION_KEYS) {
      const value = (env as Record<string, string | undefined>)[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The data lines of one table in an archive (`pg_restore --data-only`), without the COPY frame. */
function archiveRows(archive: string, table: string): string[] {
  const output = execFileSync('pg_restore', ['--data-only', `--table=${table}`, '--file=-', archive], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`COPY public.${table} `));
  if (start === -1) return [];
  const end = lines.indexOf('\\.', start);
  return lines.slice(start + 1, end);
}

describeWithDb('a dump taken as the application role (real Postgres)', () => {
  let deployment: AppRoleDatabase;
  let app: Client;
  let workDir: string;
  let archive: string;

  let defaultOrg: string;
  const otherOrg = randomUUID();
  const defaultObjects = [randomUUID(), randomUUID(), randomUUID()];
  const otherObjects = [randomUUID(), randomUUID()];
  const ownedObjects = [defaultObjects[0], otherObjects[0]];

  async function inOrg(orgId: string, fn: (client: Client) => Promise<void>): Promise<void> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      await fn(app);
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  async function seedObject(client: Client, id: string, orgId: string, owner: string | null): Promise<void> {
    await client.query(
      `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id)
       VALUES ($1, $2, 1024, 'audio/mpeg', $3, now(), $4)`,
      [id, `${id}.mp3`, `dump-rls/${id}`, orgId],
    );
    if (owner) {
      await client.query(
        `INSERT INTO kvox_object_ownership (object_id, org_id, managed_by) VALUES ($1, $2, $3)`,
        [id, orgId, owner],
      );
    }
  }

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'kvox-dump-rls-'));
    archive = join(workDir, 'backup.dump');

    deployment = await provisionAppRoleDatabase(admin!);
    app = deployment.appClient();
    await app.connect();

    const bootstrap = deployment.adminClient();
    await bootstrap.connect();
    try {
      defaultOrg = (await bootstrap.query(`SELECT id FROM organizations WHERE is_default`)).rows[0].id;
    } finally {
      await bootstrap.end();
    }
    await app.query(
      `INSERT INTO organizations (id, name, slug, is_default, updated_at) VALUES ($1, 'Other', $2, false, now())`,
      [otherOrg, `dump-rls-other-${otherOrg.slice(0, 8)}`],
    );

    await inOrg(defaultOrg, async (client) => {
      await seedObject(client, defaultObjects[0], defaultOrg, 'transcripts');
      await seedObject(client, defaultObjects[1], defaultOrg, null);
      await seedObject(client, defaultObjects[2], defaultOrg, null);
    });
    await inOrg(otherOrg, async (client) => {
      await seedObject(client, otherObjects[0], otherOrg, 'notes');
      await seedObject(client, otherObjects[1], otherOrg, null);
    });
  }, 180_000);

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    await deployment?.drop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('the client can dump this server (no version skew to explain a failure below)', async () => {
    const check = await withProcessEnv(deployment.env, () => systemDatabaseBackupEngine.checkClientVersion());
    expect(check.status).toBe('ok');
  });

  it('takes a dump through the platform engine as the ordinary role, streamed to disk', async () => {
    const dump = await withProcessEnv(deployment.env, () =>
      systemDatabaseBackupEngine.startDump({ compressionLevel: 6, timeoutMs: 120_000 }),
    );

    // The archive is streamed, never buffered; the exit code is the authority on success.
    await Promise.all([pipeline(dump.stdout, createWriteStream(archive)), dump.done]);

    // The engine's own verification: a table of contents that lists something.
    expect(await systemDatabaseBackupEngine.readTocEntryCount(createReadStream(archive))).toBeGreaterThan(0);
  }, 120_000);

  it('holds every storage_objects row, of every organization', () => {
    const rows = archiveRows(archive, 'storage_objects');
    expect(rows).toHaveLength(defaultObjects.length + otherObjects.length);
    for (const id of [...defaultObjects, ...otherObjects]) {
      expect(rows.some((row) => row.startsWith(`${id}\t`))).toBe(true);
    }
  });

  it('holds every kvox_object_ownership row', () => {
    const rows = archiveRows(archive, 'kvox_object_ownership');
    expect(rows).toHaveLength(ownedObjects.length);
    for (const id of ownedObjects) {
      expect(rows.some((row) => row.startsWith(`${id}\t`))).toBe(true);
    }
  });

  it('control: --enable-row-security WITHOUT the app.rls_bypass option is the silent empty archive', async () => {
    const connection = resolvePgConnection(deployment.env);
    const controlArchive = join(workDir, 'no-bypass.dump');

    const dump = spawnPgProcess({
      command: PG_DUMP_COMMAND,
      args: buildPgDumpArgs({ connection }),
      password: connection.password,
      extraEnv: pgClientEnv(connection),
      baseEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'PGOPTIONS')),
      timeoutMs: 120_000,
    });
    await Promise.all([pipeline(dump.stdout, createWriteStream(controlArchive)), dump.done]);

    // Exit 0, a table of contents, and no rows in the forced table: exactly what the pairing prevents.
    expect(archiveRows(controlArchive, 'storage_objects')).toEqual([]);
    // The side table is not forced, so it is the half-empty archive that nobody would notice.
    expect(archiveRows(controlArchive, 'kvox_object_ownership')).toHaveLength(ownedObjects.length);
  }, 120_000);

  it('restores as the same ordinary role, with the data intact and isolation still enforced', async () => {
    // A restore creates its scratch database from template1 as this role and replays the archive as this role;
    // the stand-in template holds the extensions the way template1 does after 20-kvox-extensions.sh.
    const template = await deployment.createExtensionTemplate();
    const restored = `${deployment.database}_restored`;
    await app.query(`CREATE DATABASE "${restored}" TEMPLATE "${template}"`);
    deployment.extraDatabases.push(restored);

    const connection = { ...resolvePgConnection(deployment.env), database: restored };
    const restore = spawnPgRestore({ connection, file: archive, timeoutMs: 120_000 });
    await restore.done;

    // The bootstrap superuser sees past the policies: the rows came back.
    const inspector = new Client({
      host: admin!.host,
      port: admin!.port,
      user: admin!.user,
      password: admin!.password,
      database: restored,
    });
    await inspector.connect();
    try {
      const objects = await inspector.query(`SELECT count(*)::int AS n FROM storage_objects`);
      const owners = await inspector.query(`SELECT count(*)::int AS n FROM kvox_object_ownership`);
      expect(objects.rows[0].n).toBe(defaultObjects.length + otherObjects.length);
      expect(owners.rows[0].n).toBe(ownedObjects.length);

      const migrations = await inspector.query(`SELECT count(*)::int AS n FROM _prisma_migrations`);
      expect(migrations.rows[0].n).toBeGreaterThan(0);

      // Every table in the copy belongs to the role that restored it.
      const strangers = await inspector.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner <> $1`,
        [deployment.role],
      );
      expect(strangers.rows).toEqual([]);
    } finally {
      await inspector.end();
    }

    // And the copy is no more open than the original: the role, unscoped, sees nothing.
    const asApp = new Client({
      host: admin!.host,
      port: admin!.port,
      user: deployment.role,
      password: deployment.password,
      database: restored,
    });
    await asApp.connect();
    try {
      const { rows } = await asApp.query(`SELECT count(*)::int AS n FROM storage_objects`);
      expect(rows[0].n).toBe(0);
    } finally {
      await asApp.end();
    }
  }, 180_000);
});
