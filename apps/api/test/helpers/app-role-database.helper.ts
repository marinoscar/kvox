// =============================================================================
// A fully-migrated THROWAWAY database owned by an ORDINARY application role
// (issue #471, epic #467)
// =============================================================================
//
// Row-level security is inert for a superuser, so a suite that proves tenant
// isolation must connect as the role production connects as. This builds that
// deployment from nothing, the way a fresh volume does:
//
//   1. as the bootstrap superuser: create the role `NOSUPERUSER NOBYPASSRLS
//      CREATEDB CREATEROLE` (infra/compose/postgres-init/10-application-role.sh),
//      create the database and the extensions the migrations need
//      (20-kvox-extensions.sh; an ordinary role cannot create `vector`), and make
//      the role the owner of the database and of schema public;
//   2. as the ROLE, with no superuser in its environment: `prisma migrate deploy`
//      (the same command `npm run prisma:migrate` runs). Every table the
//      migrations create is therefore owned by the role, which is what makes
//      FORCE ROW LEVEL SECURITY apply to it.
//
// The database and the role are uniquely named and dropped by `drop()`; nothing
// here touches the shared test database. The bootstrap superuser is the
// `POSTGRES_USER` of the environment when that is a superuser, otherwise
// `postgres` with `POSTGRES_PASSWORD`; when neither is, `findAdminCredentials`
// answers null and the suites skip.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl, type DatabaseEnv } from '../../src/common/database-url';

/** `apps/api`, resolved from this file's location: `scripts/prisma-env.js` lives there. */
const API_ROOT = join(__dirname, '..', '..');

/** Connection facts for the bootstrap superuser. */
export interface AdminCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Extensions the migrations create; the bootstrap superuser installs them first. */
const EXTENSIONS = ['vector', 'pg_trgm', 'uuid-ossp'] as const;

const POSTGRES_PORT = Number(process.env.POSTGRES_PORT) || 5432;

/**
 * Asks, in a child process (the callers decide at module load whether to skip,
 * before Jest has an event loop to await on), whether `user` can connect and is
 * a superuser.
 */
function isSuperuser(host: string, port: number, user: string, password: string, timeoutMs = 4000): boolean {
  const probe = `
    const { Client } = require('pg');
    const [host, port, user, password] = process.argv.slice(1);
    const client = new Client({ host, port: Number(port), user, password, database: 'postgres', connectionTimeoutMillis: ${timeoutMs - 1000} });
    client.connect()
      .then(() => client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user'))
      .then((r) => process.exit(r.rows[0] && r.rows[0].rolsuper ? 0 : 1))
      .catch(() => process.exit(1));
  `;
  try {
    execFileSync(process.execPath, ['-e', probe, host, String(port), user, password], {
      cwd: API_ROOT,
      stdio: 'ignore',
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether `command` can be run (`--version` exits 0). */
export function commandAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The bootstrap superuser for the Postgres the environment points at, or null
 * when none can be found (no `POSTGRES_HOST`, nothing listening, or only an
 * ordinary role to hand). Never throws.
 */
export function findAdminCredentials(): AdminCredentials | null {
  const host = process.env.POSTGRES_HOST;
  if (!host) return null;

  const candidates: Array<[string, string]> = [];
  if (process.env.POSTGRES_USER) candidates.push([process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD ?? '']);
  if (process.env.POSTGRES_USER !== 'postgres') candidates.push(['postgres', process.env.POSTGRES_PASSWORD ?? '']);

  for (const [user, password] of candidates) {
    if (isSuperuser(host, POSTGRES_PORT, user, password)) {
      return { host, port: POSTGRES_PORT, user, password };
    }
  }
  return null;
}

/** A throwaway database owned by an ordinary role, and everything to talk to it. */
export interface AppRoleDatabase {
  database: string;
  role: string;
  password: string;
  /** `POSTGRES_*` for the application role against this database (DATABASE_URL stripped). */
  env: DatabaseEnv;
  /** A new `pg` client logged in as the application role (the caller connects and ends it). */
  appClient(): Client;
  /** A new `pg` client logged in as the bootstrap superuser, on this database. */
  adminClient(): Client;
  /** A new Prisma client logged in as the application role. */
  prismaClient(): PrismaClient;
  /** Drops the database and the role. Safe to call twice. */
  drop(): Promise<void>;
}

/** `process.env` without `DATABASE_URL` (which would win over `POSTGRES_*`), plus `overrides`. */
function envWithout(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const { DATABASE_URL: _ignored, ...rest } = process.env;
  return { ...rest, ...overrides };
}

/**
 * Builds the database and the role, installs the extensions as the bootstrap
 * superuser, and migrates as the role. Takes about ten seconds.
 */
export async function provisionAppRoleDatabase(admin: AdminCredentials): Promise<AppRoleDatabase> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const database = `kvox_rls_${suffix}`;
  const role = `kvox_rls_app_${suffix}`;
  const password = randomBytes(12).toString('hex');

  const connectAdmin = (db: string): Client =>
    new Client({ host: admin.host, port: admin.port, user: admin.user, password: admin.password, database: db });

  const maintenance = connectAdmin('postgres');
  await maintenance.connect();
  try {
    // 10-application-role.sh
    await maintenance.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE`,
    );
    await maintenance.query(`ALTER ROLE "${role}" SET createrole_self_grant = 'inherit, set'`);
    await maintenance.query(`CREATE DATABASE "${database}"`);
  } finally {
    await maintenance.end();
  }

  const bootstrap = connectAdmin(database);
  await bootstrap.connect();
  try {
    // 20-kvox-extensions.sh (before the ownership moves: the superuser owns the extensions)
    for (const extension of EXTENSIONS) {
      await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    }
    await bootstrap.query(`ALTER DATABASE "${database}" OWNER TO "${role}"`);
    await bootstrap.query(`ALTER SCHEMA public OWNER TO "${role}"`);
  } finally {
    await bootstrap.end();
  }

  const env: DatabaseEnv = {
    ...envWithout({
      POSTGRES_HOST: admin.host,
      POSTGRES_PORT: String(admin.port),
      POSTGRES_DB: database,
      POSTGRES_USER: role,
      POSTGRES_PASSWORD: password,
    }),
  };

  const handle: AppRoleDatabase = {
    database,
    role,
    password,
    env,
    appClient: () =>
      new Client({ host: admin.host, port: admin.port, user: role, password, database }),
    adminClient: () => connectAdmin(database),
    prismaClient: () => new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) }),
    drop: async () => {
      const cleanup = connectAdmin('postgres');
      try {
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await cleanup.query(`DROP ROLE IF EXISTS "${role}"`);
      } catch {
        // Best effort: a leftover scratch database is harmless and uniquely named.
      } finally {
        await cleanup.end().catch(() => undefined);
      }
    },
  };

  try {
    // No superuser anywhere in this process's environment for the migration.
    execFileSync(process.execPath, ['scripts/prisma-env.js', 'migrate', 'deploy'], {
      cwd: API_ROOT,
      env: envWithout({
        POSTGRES_HOST: admin.host,
        POSTGRES_PORT: String(admin.port),
        POSTGRES_DB: database,
        POSTGRES_USER: role,
        POSTGRES_PASSWORD: password,
      }),
      stdio: 'pipe',
    });
  } catch (error) {
    await handle.drop();
    throw error;
  }

  return handle;
}
