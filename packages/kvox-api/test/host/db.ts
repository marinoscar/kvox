import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DynamicModule } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';

import type { KvoxPrismaClientLike } from '../../src/ports/index.js';
import { createKvoxTestingModule, type KvoxFakePorts } from '../../src/testing/index.js';
import { PrismaClient } from './generated/client.js';

// =============================================================================
// The real-database test host (issue #492, epic #491)
// =============================================================================
//
// What the `db` Jest project's specs import. Needs `npm run test:host:prepare -w
// @marinoscar/kvox-api` first (it generates `./generated`) and a PostgreSQL 16
// server with pgvector whose role may create databases and extensions.
//
//   const db = await createTestDb();            // a fresh, fully migrated database
//   const moduleRef = await Test.createTestingModule({
//     imports: [createTestKvoxModule({ db }), MyModule.forRoot()],
//   }).compile();
//   ...
//   await db.dispose();                         // drops the database
//
// A DATABASE PER CALL, NOT A SCHEMA: the domain migrations are written against
// `public`, and a database is the only isolation that also isolates extensions,
// sequences and the deferred constraint triggers. It costs one `CREATE DATABASE`
// and a `migrate deploy` (a few seconds), so create one per spec file.
//
// Connection: `DATABASE_URL` when set, else `POSTGRES_HOST` / `POSTGRES_PORT` /
// `POSTGRES_USER` / `POSTGRES_PASSWORD` (defaults localhost, 5432, postgres,
// postgres). `POSTGRES_DB` names the maintenance database the new one is created
// from (default `postgres`).
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
// =============================================================================

const HOST_DIR = __dirname;

/** The database the new one is created from, as a URL. */
function adminUrl(): URL {
  const fromUrl = process.env.DATABASE_URL;
  if (fromUrl) return new URL(fromUrl);

  const env = process.env;
  const user = encodeURIComponent(env.POSTGRES_USER ?? 'postgres');
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? 'postgres');
  const host = env.POSTGRES_HOST ?? 'localhost';
  const port = env.POSTGRES_PORT ?? '5432';
  const name = env.POSTGRES_DB ?? 'postgres';

  return new URL(`postgresql://${user}:${password}@${host}:${port}/${name}`);
}

/** The same server, another database. */
function withDatabase(base: URL, name: string): URL {
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  return url;
}

async function withClient<T>(url: URL, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The `prisma` CLI of the installed package, run with the host's config. */
function migrateDeploy(databaseUrl: URL): void {
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> };
  const bin = join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.prisma);

  const result = spawnSync(
    process.execPath,
    [bin, 'migrate', 'deploy', '--config', join(HOST_DIR, 'prisma.config.ts')],
    { cwd: HOST_DIR, env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * A migrated throwaway database and a client on it.
 *
 * @stability experimental
 */
export interface TestDb {
  /** The host's Prisma client, connected to the new database. */
  prisma: PrismaClient;
  /** The connection URL of the new database. */
  url: string;
  /** The new database's name. */
  databaseName: string;
  /** Disconnects the client and drops the database. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Creates a fresh database, installs `vector` and `pg_trgm`, applies every
 * platform and domain migration with `prisma migrate deploy`, and connects a
 * client.
 *
 * @returns the database; call `dispose()` in `afterAll`.
 * @stability experimental
 */
export async function createTestDb(): Promise<TestDb> {
  const base = adminUrl();
  const databaseName = `kvox_api_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const url = withDatabase(base, databaseName);

  await withClient(base, (client) => client.query(`CREATE DATABASE "${databaseName}"`));

  const drop = (): Promise<unknown> =>
    withClient(base, (client) => client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`));

  try {
    // What the application's bootstrap superuser does before the first migration.
    await withClient(url, async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    });
    migrateDeploy(url);
  } catch (error) {
    await drop();
    throw error;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(url.toString()) });
  await prisma.$connect();

  let disposed = false;
  return {
    prisma,
    url: url.toString(),
    databaseName,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await prisma.$disconnect();
      await drop();
    },
  };
}

/**
 * Options of {@link createTestKvoxModule}.
 *
 * @stability experimental
 */
export interface TestKvoxModuleOptions {
  /** The database to bind `KVOX_PRISMA` to; without it the port is the fake's stub that refuses every query. */
  db?: TestDb;
  /** Fakes to use instead of the defaults from `@marinoscar/kvox-api/testing`. */
  overrides?: Partial<KvoxFakePorts>;
}

/**
 * The ports module for a real-database spec: every port is a fake from
 * `@marinoscar/kvox-api/testing`, except `KVOX_PRISMA`, which is the host
 * client of `db`.
 *
 * @param options - the database and any fakes to replace.
 * @returns the module to import first.
 * @stability experimental
 */
export function createTestKvoxModule(options: TestKvoxModuleOptions = {}): DynamicModule {
  return createKvoxTestingModule({
    overrides: {
      ...(options.db ? { prisma: options.db.prisma as unknown as KvoxPrismaClientLike } : {}),
      ...options.overrides,
    },
  });
}
