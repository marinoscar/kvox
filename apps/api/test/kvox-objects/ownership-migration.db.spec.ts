// =============================================================================
// Real-Postgres test: migration `kvox_object_ownership` (issue #469, epic #467)
// =============================================================================
//
// `storage_objects.managed_by` and `storage_objects.part_size` were KVox-only
// columns on a platform table. The migration copies `managed_by` into the side
// table `kvox_object_ownership` and drops both columns. A data move is only
// proven by running it over data, so this suite builds a throwaway database,
// replays every migration BEFORE this one, seeds `managed_by` rows on that
// pre-migration schema, applies the migration, and asserts:
//   - an ownership row exists for exactly the objects that had a `managed_by`,
//     with the same module, org and object ids;
//   - both columns are gone from `storage_objects`;
//   - the composite foreign key (object_id, org_id) holds, and deleting the
//     object cascades to its ownership row.
//
// Like every `*.db.spec.ts`, it is excluded from `npm test` and runs through
// `npm run test:db`; it skips when no Postgres is reachable. It creates and
// drops its own uniquely named database and never touches the shared one.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const MIGRATION_SUFFIX = '_kvox_object_ownership';

function isPostgresReachable(host: string, port: number, timeoutMs = 2000): boolean {
  try {
    const probe = `
      const net = require('net');
      const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
      const done = (ok) => { try { socket.destroy(); } catch (_e) {} process.exit(ok ? 0 : 1); };
      socket.setTimeout(${timeoutMs});
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    `;
    execFileSync(process.execPath, ['-e', probe, host, String(port)], {
      stdio: 'ignore',
      timeout: timeoutMs + 1000,
    });
    return true;
  } catch {
    return false;
  }
}

const postgresHost = process.env.POSTGRES_HOST;
const postgresPort = Number(process.env.POSTGRES_PORT) || 5432;
const dbReachable = Boolean(postgresHost) && isPostgresReachable(postgresHost as string, postgresPort);

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[ownership-migration.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. Start a Postgres ` +
      `(infra/compose/test.compose.yml) and re-run \`npm run test:db\`.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

function connect(database: string): Client {
  return new Client({
    host: process.env.POSTGRES_HOST,
    port: postgresPort,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database,
  });
}

/** Every migration directory, oldest first. */
function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(directory: string): string {
  return readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8');
}

describeWithDb('migration kvox_object_ownership (real Postgres)', () => {
  const database = `kvox_ownership_mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;

  let orgId: string;
  const otherOrgId = randomUUID();
  const transcriptObject = randomUUID();
  const noteObject = randomUUID();
  const graphObject = randomUUID();
  const plainObject = randomUUID();

  async function insertObject(id: string, key: string, managedBy: string | null, org = orgId) {
    await db.query(
      `INSERT INTO storage_objects
         (id, name, size, mime_type, storage_key, updated_at, managed_by, part_size, org_id)
       VALUES ($1, $2, 1024, 'audio/mpeg', $3, now(), $4, $5, $6)`,
      [id, key, `ownership-mig/${key}`, managedBy, managedBy ? 8_388_608 : null, org],
    );
  }

  beforeAll(async () => {
    admin = connect('postgres');
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    db = connect(database);
    await db.connect();

    const directories = migrationDirectories();
    const target = directories.findIndex((name) => name.endsWith(MIGRATION_SUFFIX));
    expect(target).toBeGreaterThan(0);

    // Replay the history that existed before this migration, in order.
    for (const directory of directories.slice(0, target)) {
      await db.query(migrationSql(directory));
    }

    // Pre-migration schema: managed_by and part_size still exist.
    const before = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'storage_objects' AND column_name IN ('managed_by', 'part_size')`,
    );
    expect(before.rows).toHaveLength(2);

    // The platform history already created the default organization; add a second one.
    const defaultOrg = await db.query(`SELECT id FROM organizations WHERE is_default`);
    orgId = defaultOrg.rows[0].id;
    await db.query(
      `INSERT INTO organizations (id, name, slug, is_default, updated_at)
       VALUES ($1, 'Other', 'ownership-mig-other', false, now())`,
      [otherOrgId],
    );
    await insertObject(transcriptObject, 'transcript.mp3', 'transcripts');
    await insertObject(noteObject, 'note.txt', 'notes');
    await insertObject(graphObject, 'graph.ttl', 'graph');
    await insertObject(plainObject, 'plain.mp3', null);

    // The migration under test.
    await db.query(migrationSql(directories[target]));
  }, 120_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it('creates one ownership row per managed object, with the same module and org', async () => {
    const { rows } = await db.query(
      `SELECT object_id, org_id, managed_by FROM kvox_object_ownership ORDER BY managed_by`,
    );
    expect(rows).toEqual([
      { object_id: graphObject, org_id: orgId, managed_by: 'graph' },
      { object_id: noteObject, org_id: orgId, managed_by: 'notes' },
      { object_id: transcriptObject, org_id: orgId, managed_by: 'transcripts' },
    ]);
  });

  it('gives a plain upload no ownership row', async () => {
    const { rows } = await db.query(`SELECT 1 FROM kvox_object_ownership WHERE object_id = $1`, [plainObject]);
    expect(rows).toHaveLength(0);
  });

  it('drops managed_by and part_size from storage_objects', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'storage_objects' AND column_name IN ('managed_by', 'part_size')`,
    );
    expect(rows).toEqual([]);
    // The rest of the table survived the data move.
    const objects = await db.query(`SELECT count(*)::int AS n FROM storage_objects`);
    expect(objects.rows[0].n).toBe(4);
  });

  it('keeps the composite foreign key: an ownership row cannot name the wrong org', async () => {
    await expect(
      db.query(
        `INSERT INTO kvox_object_ownership (object_id, org_id, managed_by) VALUES ($1, $2, 'notes')`,
        [plainObject, otherOrgId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('allows at most one owner per object', async () => {
    await expect(
      db.query(
        `INSERT INTO kvox_object_ownership (object_id, org_id, managed_by) VALUES ($1, $2, 'graph')`,
        [transcriptObject, orgId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cascades: deleting the object deletes its ownership row', async () => {
    await db.query(`DELETE FROM storage_objects WHERE id = $1`, [graphObject]);
    const { rows } = await db.query(`SELECT 1 FROM kvox_object_ownership WHERE object_id = $1`, [graphObject]);
    expect(rows).toHaveLength(0);
    const remaining = await db.query(`SELECT count(*)::int AS n FROM kvox_object_ownership`);
    expect(remaining.rows[0].n).toBe(2);
  });
});
