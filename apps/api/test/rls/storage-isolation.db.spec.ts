// =============================================================================
// Real-Postgres test: tenant isolation holds for the application role
// (issue #471, epic #467)
// =============================================================================
//
// The API connects as an ORDINARY role (`NOSUPERUSER NOBYPASSRLS`) that owns
// every table. A superuser or a BYPASSRLS role skips every policy, FORCE
// included, so this suite builds a deployment the way a fresh volume does
// (`test/helpers/app-role-database.helper.ts`: role, extensions, migrate with
// no superuser) and then talks to it AS THAT ROLE:
//
//   - the role is neither superuser nor BYPASSRLS (the Doctor `db.rls_role`
//     check), and owns every table;
//   - the org tables FORCE row-level security;
//   - with `app.org_id` unset, `storage_objects` shows nothing;
//   - inside the platform's `runInOrg`, an org sees exactly its own rows, and
//     cannot write another org's;
//   - a `KvoxManagedObjects` read (the gateway KVox routes every
//     `storage_objects` access through since #469) returns the default org's
//     rows and their owning modules.
//
// Like every `*.db.spec.ts` it is excluded from `npm test` and runs through
// `npm run test:db`; it skips when no Postgres, or no superuser to bootstrap
// the role with, is reachable. It creates and drops its own database and role.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { runInOrg } from '@marinoscar/platform-api/core';

import { UNUSED_STORAGE, createDbManagedObjects } from '../helpers/db-managed-objects.helper';
import {
  findAdminCredentials,
  provisionAppRoleDatabase,
  type AppRoleDatabase,
} from '../helpers/app-role-database.helper';

const admin = findAdminCredentials();

if (!admin) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[storage-isolation.db.spec] SKIPPED: no superuser reachable at ` +
      `${process.env.POSTGRES_HOST ?? '(POSTGRES_HOST unset)'}:${process.env.POSTGRES_PORT ?? '5432'} to bootstrap the ` +
      `application role with. Start a Postgres (infra/compose/test.compose.yml) and re-run \`npm run test:db\`.\n`,
  );
}

const describeWithDb = admin ? describe : describe.skip;

/** The four tables the platform forces row-level security on (migration 0025). */
const FORCED_TABLES = ['storage_objects', 'storage_object_chunks', 'ai_runs', 'ai_usage_events'];

describeWithDb('tenant isolation as the application role (real Postgres)', () => {
  let deployment: AppRoleDatabase;
  let app: Client;
  let prisma: PrismaClient;

  let defaultOrg: string;
  const otherOrg = randomUUID();
  const defaultObjects = [randomUUID(), randomUUID(), randomUUID()];
  const otherObjects = [randomUUID(), randomUUID()];

  /** One statement batch as the role, with the org scope set transaction-locally. */
  async function asOrg<R>(orgId: string | null, fn: (client: Client) => Promise<R>): Promise<R> {
    await app.query('BEGIN');
    try {
      if (orgId) await app.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const result = await fn(app);
      await app.query('COMMIT');
      return result;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  async function insertObject(client: Client, id: string, orgId: string): Promise<void> {
    await client.query(
      `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id)
       VALUES ($1, $2, 1024, 'audio/mpeg', $3, now(), $4)`,
      [id, `${id}.mp3`, `rls/${id}`, orgId],
    );
  }

  beforeAll(async () => {
    deployment = await provisionAppRoleDatabase(admin!);

    app = deployment.appClient();
    await app.connect();
    prisma = deployment.prismaClient();

    // The migrations create the default organization; add a second one. Both
    // organizations and their rows are written AS THE ROLE, through its scope.
    const bootstrap = deployment.adminClient();
    await bootstrap.connect();
    try {
      defaultOrg = (await bootstrap.query(`SELECT id FROM organizations WHERE is_default`)).rows[0].id;
    } finally {
      await bootstrap.end();
    }
    await app.query(
      `INSERT INTO organizations (id, name, slug, is_default, updated_at) VALUES ($1, 'Other', $2, false, now())`,
      [otherOrg, `rls-other-${otherOrg.slice(0, 8)}`],
    );

    await asOrg(defaultOrg, async (client) => {
      for (const id of defaultObjects) await insertObject(client, id, defaultOrg);
      await client.query(
        `INSERT INTO kvox_object_ownership (object_id, org_id, managed_by) VALUES ($1, $2, 'transcripts')`,
        [defaultObjects[0], defaultOrg],
      );
    });
    await asOrg(otherOrg, async (client) => {
      for (const id of otherObjects) await insertObject(client, id, otherOrg);
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await app?.end().catch(() => undefined);
    await deployment?.drop();
  });

  describe('the role', () => {
    it('is neither a superuser nor BYPASSRLS (the Doctor db.rls_role check)', async () => {
      const { rows } = await app.query(
        `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: true, rolcreaterole: true });
    });

    it('owns the database, schema public and every table the migrations created', async () => {
      const db = await app.query(
        `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`,
      );
      expect(db.rows[0].owner).toBe(deployment.role);

      const schema = await app.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`);
      expect(schema.rows[0].owner).toBe(deployment.role);

      const strangers = await app.query(
        `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tableowner <> $1`,
        [deployment.role],
      );
      expect(strangers.rows).toEqual([]);
    });

    it('left the extensions with the bootstrap superuser', async () => {
      const { rows } = await app.query(
        `SELECT extname, pg_get_userbyid(extowner) AS owner FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname`,
      );
      expect(rows.map((row) => row.extname)).toEqual(['pg_trgm', 'vector']);
      for (const row of rows) expect(row.owner).not.toBe(deployment.role);
    });
  });

  describe('the policies', () => {
    it('FORCE row-level security on the org tables, so they apply to the owner', async () => {
      const { rows } = await app.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
        [FORCED_TABLES],
      );
      expect(rows.map((row) => row.relname)).toEqual([...FORCED_TABLES].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      }
    });
  });

  describe('storage_objects with no organization scope', () => {
    it('shows no rows when app.org_id is unset', async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM storage_objects`);
      expect(rows[0].n).toBe(0);
    });

    it('shows no rows when app.org_id is empty', async () => {
      const n = await asOrg(null, async (client) => {
        await client.query(`SELECT set_config('app.org_id', '', true)`);
        return (await client.query(`SELECT count(*)::int AS n FROM storage_objects`)).rows[0].n;
      });
      expect(n).toBe(0);
    });

    it('shows no rows to an unscoped Prisma client', async () => {
      expect(await prisma.storageObject.count()).toBe(0);
    });

    it('proves the rows exist: the bootstrap superuser sees every one of them', async () => {
      const bootstrap = deployment.adminClient();
      await bootstrap.connect();
      try {
        const { rows } = await bootstrap.query(`SELECT count(*)::int AS n FROM storage_objects`);
        expect(rows[0].n).toBe(defaultObjects.length + otherObjects.length);
      } finally {
        await bootstrap.end();
      }
    });
  });

  describe('storage_objects inside the platform runInOrg', () => {
    it('returns the real count for the default organization', async () => {
      const n = await runInOrg(prisma, { orgId: defaultOrg }, (tx) => tx.storageObject.count());
      expect(n).toBe(defaultObjects.length);
    });

    it('returns only the other organization its own rows', async () => {
      const ids = await runInOrg(prisma, { orgId: otherOrg }, async (tx) =>
        (await tx.storageObject.findMany({ select: { id: true } })).map((row) => row.id).sort(),
      );
      expect(ids).toEqual([...otherObjects].sort());
    });

    it('does not leak the scope into the next, unscoped statement on the pool', async () => {
      await runInOrg(prisma, { orgId: defaultOrg }, (tx) => tx.storageObject.count());
      expect(await prisma.storageObject.count()).toBe(0);
    });

    it('refuses a write that names another organization (WITH CHECK)', async () => {
      await expect(
        asOrg(defaultOrg, (client) => insertObject(client, randomUUID(), otherOrg)),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('a KvoxManagedObjects read', () => {
    it('returns the default organization, scoped by the gateway and not by the caller', async () => {
      const objects = createDbManagedObjects(prisma, UNUSED_STORAGE);

      expect(await objects.count({})).toBe(defaultObjects.length);

      const found = await objects.findMany({ select: { id: true } });
      expect(found.map((row) => row.id).sort()).toEqual([...defaultObjects].sort());

      const summary = await objects.summarize({});
      expect(summary).toEqual({ count: defaultObjects.length, bytes: BigInt(1024 * defaultObjects.length) });
    });

    it('resolves the owning module through the ownership side table', async () => {
      const objects = createDbManagedObjects(prisma, UNUSED_STORAGE);

      const owned = await objects.findMany({
        where: { kvoxOwnership: { is: { managedBy: 'transcripts' } } },
        select: { id: true },
      });
      expect(owned.map((row) => row.id)).toEqual([defaultObjects[0]]);

      const unowned = await objects.count({ kvoxOwnership: null });
      expect(unowned).toBe(defaultObjects.length - 1);
    });

    it('addresses the other organization only when asked to', async () => {
      const objects = createDbManagedObjects(prisma, UNUSED_STORAGE);
      expect(await objects.count({}, { orgId: otherOrg })).toBe(otherObjects.length);
    });
  });
});
