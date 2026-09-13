// =============================================================================
// A fully-migrated THROWAWAY database, for suites that need a real "live"
// deployment to act on rather than the shared test database (issue #290,
// epic #254)
// =============================================================================
//
// `database-restore-round-trip.db.spec.ts` cannot rehearse a restore's swap
// against the database the rest of `test:db` shares — a rename, a
// termination of every session, and (on the success path) a promoted
// replacement are exactly the operations no suite may perform on `appdb`.
// So it builds its own tiny "deployment": a uniquely-named database, migrated
// with the REAL `prisma migrate deploy` (the same command
// `npm run prisma:migrate` runs), reachable through its own connection
// string. Everything here is about getting to and from that state; nothing
// in this file touches the shared test database.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl, type DatabaseEnv } from '../../src/common/database-url';
import { resolvePgConnection, spawnPgDump, type PgConnection } from '../../src/db-backup/pg-dump.util';
import {
  checkPgClientVersion,
  readServerVersionNumWithPgClient,
} from '../../src/db-backup/pg-version.util';
import { readTocEntryCount } from '../../src/db-backup/pg-restore.util';
import type { DatabaseBackupEngine } from '../../src/db-backup/db-backup-runner.service';

/** `apps/api`, resolved from this file's location — `prisma-env.js` lives there. */
const API_ROOT = join(__dirname, '..', '..');

/**
 * `process.env` with `DATABASE_URL` stripped and `POSTGRES_DB` pinned to
 * `database`.
 *
 * The strip is `db-test-support.ts#createDbClient`'s own discipline, restated
 * here because every helper in this file needs it: `test/setup.ts` loads
 * `.env.test`, which hard-codes a `DATABASE_URL` for the compose test
 * database, and it would win over `POSTGRES_DB` otherwise.
 */
export function envFor(database: string): DatabaseEnv {
  const { DATABASE_URL: _ignored, ...rest } = process.env;
  return { ...rest, POSTGRES_DB: database };
}

/** A `PrismaClient` bound to `database`, independent of any other client. */
export function prismaClientFor(database: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envFor(database))) });
}

/** The raw `pg` connection tuple for `database` — for `spawnPgDump`, admin utilities, etc. */
export function pgConnectionFor(database: string): PgConnection {
  return resolvePgConnection(envFor(database));
}

/**
 * Runs `prisma migrate deploy` against `database` for real — the same command
 * `npm run prisma:migrate` runs, via the same `scripts/prisma-env.js` that
 * derives its `DATABASE_URL` from `POSTGRES_*`. SYNCHRONOUS, and that is
 * deliberate: it runs inside a `beforeAll`, before anything else in the
 * owning suite may proceed, and Jest's `beforeAll` already serialises against
 * the rest of the file.
 *
 * `database` must already exist (`CREATE DATABASE`) — this only applies the
 * migration ledger to it.
 */
export function migrateDeploy(database: string): void {
  const { DATABASE_URL: _ignored, ...env } = process.env;

  execFileSync(process.execPath, ['scripts/prisma-env.js', 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...env, POSTGRES_DB: database },
    stdio: 'pipe',
  });
}

/**
 * A `DatabaseBackupEngine` that dumps/verifies EXACTLY `connection`, never
 * `process.env`'s database.
 *
 * `systemDatabaseBackupEngine` (the shipped engine) has no such seam — in
 * production there is only ever one database to back up, so it always dumps
 * whatever `POSTGRES_*`/`DATABASE_URL` resolve to. A suite backing up a
 * THROWAWAY "live" database has to say so explicitly; this is that.
 */
export function engineForConnection(connection: PgConnection): DatabaseBackupEngine {
  return {
    startDump: ({ compressionLevel, timeoutMs }) =>
      spawnPgDump({ connection, compressionLevel, timeoutMs }),
    readTocEntryCount: (source) => readTocEntryCount({ source }),
    checkClientVersion: () =>
      checkPgClientVersion({
        readServerVersionNum: () => readServerVersionNumWithPgClient({ env: envFor(connection.database) }),
      }),
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
