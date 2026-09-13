// =============================================================================
// Shared setup for the queue's real-Postgres suites (issue #260, epic #254)
// =============================================================================
//
// EXTRACTED FROM `job-schema-indexes.db.spec.ts` (#255), which is where both
// of these functions were written and where their reasoning is spelled out at
// length. #260 adds two more `*.db.spec.ts` files that need exactly the same
// two things — "is a database actually there?" and "connect to THAT database,
// not to whatever `.env.test` says" — and three hand-copied versions of a
// reachability probe is how they start to disagree.
//
// That file is deliberately left as it is: it predates this helper, it passes,
// and rewriting a green test to route through new code is a change with no
// upside and a real downside. New suites use this; it is not a migration.
//
// NOT A `*.spec.ts` FILE, so Jest's `testRegex` (`.*\.spec\.ts$`) never tries
// to run it as a suite.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';

/**
 * Whether something is actually listening on host:port, checked with a real
 * (short-timeout) TCP connect rather than merely asking whether an env var is
 * set.
 *
 * Presence of `POSTGRES_HOST` proves nothing: `test/setup.ts` loads
 * `.env.test` for every Jest run, and that file unconditionally sets
 * `POSTGRES_HOST`/`POSTGRES_PORT` to a local test-database address whether or
 * not anything is listening there. Checking only for presence would make
 * these suites blow up with a confusing connection error for a developer who
 * ran `npm run test:db` without a database up — which is exactly what this
 * probe turns into a clear, skipped warning.
 *
 * Synchronous (a child process rather than an async `beforeAll`) because Jest
 * decides which `describe`/`it` blocks exist by running the file's top-level
 * synchronous code: by the time an async `beforeAll` could resolve,
 * registration has already happened.
 */
export function isPostgresReachable(host: string, port: number, timeoutMs = 2000): boolean {
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

/**
 * Resolves whether a real Postgres is available for a `*.db.spec.ts` suite,
 * warning once (and only once per suite) when it is not.
 *
 * Returns `describe` when it is and `describe.skip` when it is not, so a
 * suite reads `describeWithDb('…', () => { … })` and skips cleanly rather
 * than failing on a machine with no database.
 */
export function resolveDbSuite(suiteName: string): {
  describeWithDb: jest.Describe;
  dbReachable: boolean;
} {
  const host = process.env.POSTGRES_HOST;
  const port = Number(process.env.POSTGRES_PORT) || 5432;
  const dbReachable = Boolean(host) && isPostgresReachable(host as string, port);

  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[${suiteName}] SKIPPED: no Postgres reachable at ` +
        `${host ?? '(POSTGRES_HOST unset)'}:${port}. ` +
        `Start infra/compose/test.compose.yml (or otherwise point ` +
        `POSTGRES_HOST/POSTGRES_PORT at a migrated database) and re-run ` +
        `\`npm run test:db\` to exercise these real-Postgres assertions.\n`
    );
  }

  return { describeWithDb: dbReachable ? describe : describe.skip, dbReachable };
}

/**
 * A `PrismaClient` pointed at the database `resolveDbSuite` just proved
 * reachable.
 *
 * ⚠ `DATABASE_URL` IS STRIPPED BEFORE BUILDING THE URL, and that is the whole
 * point of this function existing rather than calling `buildDatabaseUrl()`.
 * `test/setup.ts` loads `.env.test`, which sets a hard-coded `DATABASE_URL`
 * pointing at the port-5433 compose test database — and `buildDatabaseUrl`'s
 * documented contract is that an already-set `DATABASE_URL` always wins over
 * the `POSTGRES_*` variables. That is correct for the application and wrong
 * for these suites: it would silently connect them somewhere other than the
 * `POSTGRES_HOST`/`POSTGRES_PORT` the reachability probe just verified (in
 * CI, the Postgres service container's real address). Passing an env view
 * with `DATABASE_URL` removed keeps a suite honest — the database it proved
 * reachable is the database it talks to.
 *
 * Each call returns an INDEPENDENT client with its own connection pool, which
 * is what lets the concurrency suites run two genuinely separate claimers.
 */
export function createDbClient(): PrismaClient {
  const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
  return new PrismaClient({
    adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)),
  });
}
