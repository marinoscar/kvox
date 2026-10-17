import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

// =============================================================================
// The embedded PostgreSQL of the bare host (issue #505, epic #498)
// =============================================================================
//
// Two ways to get a PostgreSQL with `vector` and `pg_trgm`, one Prisma client on
// top of both:
//
//   service  a server that already runs (`DATABASE_URL`, a role that may create
//            databases and extensions; CI uses the `pgvector/pgvector:pg16`
//            service container). A throwaway database is created on it, so a
//            second run never meets the first one's rows.
//   pglite   PGlite (PostgreSQL compiled to WebAssembly) in this process,
//            served on a loopback socket so `prisma migrate deploy` and the
//            `kvox-db check --database` command, which are separate processes,
//            can reach it. The data lives in memory and dies with the process.
//
// Either way the sequence is the one a real host follows: extensions first (the
// bootstrap superuser's job, never a migration's), then
// `prisma migrate deploy` of the platform and domain history, then the
// `kvox-db check --database` proof that the extensions and the raw-SQL objects
// the domain needs (partial unique indexes, HNSW, GiST, trigram, deferred
// constraint triggers) exist.
//
// PGlite is ONE session: every query from every connection is serialised onto
// it, and a transaction opened on one connection would see another
// connection's statements. The client therefore uses a pool of one connection
// (`max: 1`), so an interactive transaction holds the only connection and a
// query made outside it waits for it. A port implementation must never await
// a query on the pool while holding a transaction open (see
// `ports/pg-table-jobs.ts`); on a server the same mistake is a slow query, on
// PGlite it is a deadlock.
// =============================================================================

/** Where the bare host's PostgreSQL comes from. */
export type DbLeg = 'service' | 'pglite';

/** A started database. */
export interface BareHostDatabase {
  /** Which leg started it. */
  readonly leg: DbLeg;
  /** The connection URL of the database the application uses. */
  readonly url: string;
  /** Stops PGlite, or drops the throwaway database of the service leg. Safe to call twice. */
  close(): Promise<void>;
}

/** The project directory: `dist/db.js` lives one level below it. */
export const PROJECT_ROOT = join(__dirname, '..');

/** Parses the leg from a value (`--db service`, `BARE_HOST_DB`). */
export function parseLeg(value: string | undefined): DbLeg {
  if (value === undefined || value === '') return 'service';
  if (value === 'service' || value === 'pglite') return value;
  throw new Error(`Unknown database leg "${value}". Use "service" or "pglite".`);
}

/** The `bin` script of an installed package. */
function binOf(pkg: string, name: string): string {
  const manifestPath = require.resolve(`${pkg}/package.json`, { paths: [PROJECT_ROOT] });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> };
  return join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name]);
}

/**
 * Runs a node script with a connection URL and resolves with its output.
 * ASYNC ON PURPOSE: on the PGlite leg the database lives in this process, and a
 * synchronous child-process call would block the event loop that serves it.
 */
function runNode(label: string, script: string, args: string[], databaseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} failed (exit ${code}):\n${output}`));
    });
  });
}

/** `prisma migrate deploy`: the platform history, then the domain history (the folder names sort in that order). */
export function migrateDeploy(databaseUrl: string): Promise<string> {
  return runNode(
    'prisma migrate deploy',
    binOf('prisma', 'prisma'),
    ['migrate', 'deploy', '--config', join(PROJECT_ROOT, 'prisma.config.ts')],
    databaseUrl,
  );
}

/**
 * `kvox-db check --database`: the installed copies are the package's, and the
 * database holds the extensions and the raw-SQL objects the domain needs.
 */
export function kvoxDbCheckDatabase(databaseUrl: string): Promise<string> {
  return runNode(
    'kvox-db check --database',
    binOf('@marinoscar/kvox-db', 'kvox-db'),
    ['check', '--root', PROJECT_ROOT, '--database'],
    databaseUrl,
  );
}

/** A free loopback port (bound and released; good enough for a test process). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The service leg: a throwaway database on the server `DATABASE_URL` names. */
async function startService(): Promise<BareHostDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'The service leg needs DATABASE_URL, for example postgresql://postgres:pg@127.0.0.1:5433/postgres (PostgreSQL 16 with pgvector; the role must be allowed to create databases and extensions).',
    );
  }
  const name = `barehost_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  await withClient(adminUrl, (client) => client.query(`CREATE DATABASE "${name}"`));
  const drop = (): Promise<unknown> =>
    withClient(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));

  try {
    // What the application's bootstrap superuser does before the first migration.
    await withClient(url.toString(), async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    });
  } catch (error) {
    await drop();
    throw error;
  }

  let closed = false;
  return {
    leg: 'service',
    url: url.toString(),
    async close() {
      if (closed) return;
      closed = true;
      await drop();
    },
  };
}

/** The PGlite leg: an in-memory database on a loopback socket. */
async function startPglite(): Promise<BareHostDatabase> {
  // Loaded lazily so the service leg never pays for (or needs) the WebAssembly build.
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

  // `uuid-ossp` is created by the FIRST platform migration, so PGlite must be able to load it.
  const db = await PGlite.create({ extensions: { vector, pg_trgm, uuid_ossp } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();

  let closed = false;
  return {
    leg: 'pglite',
    url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable&connection_limit=1`,
    async close() {
      if (closed) return;
      closed = true;
      await server.stop();
      await db.close();
    },
  };
}

/**
 * Starts the database of a leg and brings it to the state a host runs on:
 * extensions, every platform and domain migration, the `kvox-db` database check.
 *
 * @param leg - `service` or `pglite`.
 * @param log - receives one line per step.
 * @returns the database; call `close()` when done.
 */
export async function startDatabase(leg: DbLeg, log: (line: string) => void = () => {}): Promise<BareHostDatabase> {
  const database = leg === 'pglite' ? await startPglite() : await startService();
  try {
    log(`database (${leg}): migrating`);
    await migrateDeploy(database.url);
    log(`database (${leg}): checking the domain objects`);
    const report = await kvoxDbCheckDatabase(database.url);
    log(report.trim());
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** A Prisma client over the `pg` driver adapter, one connection on PGlite. */
export function createPrismaClient(database: BareHostDatabase): PrismaClient {
  const adapter = new PrismaPg({ connectionString: database.url, max: database.leg === 'pglite' ? 1 : 10 });
  return new PrismaClient({ adapter });
}
