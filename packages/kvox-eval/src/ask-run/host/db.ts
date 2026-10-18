// =============================================================================
// The in-memory database of the headless Ask evaluation (issue #608)
// =============================================================================
//
// PGlite (PostgreSQL compiled to WebAssembly) in THIS process, with `vector`,
// `pg_trgm` and `uuid-ossp`, served on a loopback socket so the Prisma client's
// `pg` driver adapter can reach it. The data lives in memory and dies with the
// run: nothing an evaluation does ever touches a real database, so there is no
// safe-database guard to pass any more.
//
// THE SCHEMA. Extensions first (the bootstrap superuser's job, never a
// migration's), then every migration file the package ships under
// `host/prisma/migrations/` (the platform history stamped 2024-01-01, then the
// domain's under stable names, so the folder names sort in apply order), each
// executed as one simple-protocol script, exactly what `prisma migrate deploy`
// sends. No Prisma CLI runs at evaluation time; `scripts/prepare-host.mjs`
// composed the schema and generated the client at build time.
//
// ONE SESSION. PGlite serialises every query onto one backend, so the client
// uses a pool of ONE connection: an interactive transaction holds the only
// connection and anything outside it waits. A port implementation must never
// await a query on the pool while holding a transaction open (on PGlite that is
// a deadlock); the fake jobs port of `ports.ts` writes through the caller's tx.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../host/generated/index.js';

/**
 * The package's `host/` folder: `prisma/migrations/` and `generated/` (built by
 * `scripts/prepare-host.mjs`). `dist/ask-run/host/db.js` and `src/ask-run/host/db.ts`
 * are both three levels below the package root.
 *
 * @stability experimental
 */
export const ASK_EVAL_HOST_DIR = join(__dirname, '..', '..', '..', 'host');

/**
 * The Prisma client of the evaluation's database: the platform and domain schema,
 * generated into `host/generated/` at build time.
 *
 * @stability experimental
 */
export type AskEvalPrismaClient = PrismaClient;

/**
 * A started, fully migrated in-memory database and the client on it.
 *
 * @stability experimental
 */
export interface AskEvalDatabase {
  /** The client (one pooled connection). */
  readonly prisma: AskEvalPrismaClient;
  /** How many migration folders were applied. */
  readonly migrations: number;
  /** Disconnects the client, stops the socket and closes PGlite. Safe to call twice. */
  close(): Promise<void>;
}

/** A free loopback port (bound and released). */
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

/** The shipped migration folders, in apply order. */
function migrationFolders(): string[] {
  const dir = join(ASK_EVAL_HOST_DIR, 'prisma', 'migrations');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(
      `The evaluation's database host is missing (${dir}); build the package first (node scripts/prepare-host.mjs).`,
    );
  }
  return names
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => join(dir, name, 'migration.sql'));
}

/**
 * Starts PGlite in memory, applies every shipped migration, serves it on a
 * loopback socket and connects a Prisma client to it.
 *
 * @param log - receives one line per step (never data).
 * @returns the database; call `close()` when done.
 * @stability experimental
 */
export async function startAskEvalDatabase(log: (line: string) => void = () => {}): Promise<AskEvalDatabase> {
  const files = migrationFolders();
  const db = await PGlite.create({ extensions: { vector, pg_trgm, uuid_ossp } });
  let server: PGLiteSocketServer | null = null;
  let prisma: PrismaClient | null = null;

  const close = async (): Promise<void> => {
    const [p, s] = [prisma, server];
    prisma = null;
    server = null;
    await p?.$disconnect().catch(() => undefined);
    await s?.stop().catch(() => undefined);
    if (!db.closed) await db.close().catch(() => undefined);
  };

  try {
    // What the application's bootstrap superuser does before the first migration.
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    log(`database: applying ${files.length} migrations in memory`);
    for (const file of files) await db.exec(readFileSync(file, 'utf8'));

    const port = await freePort();
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
    await server.start();

    const url = `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
    await prisma.$connect();
    log('database: ready');
  } catch (error) {
    await close();
    throw error;
  }

  const client = prisma as PrismaClient;
  let closed = false;
  return {
    prisma: client,
    migrations: files.length,
    async close() {
      if (closed) return;
      closed = true;
      await close();
    },
  };
}
