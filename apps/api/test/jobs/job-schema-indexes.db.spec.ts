// =============================================================================
// Real-Postgres test: the three hand-written indexes on `jobs` (issue #255,
// epic #254)
// =============================================================================
//
// `jobs_active_dedup_uniq_idx`, `jobs_attempts_gt1_idx` and
// `jobs_succeeded_duration_idx` are partial indexes the Prisma schema
// language cannot express (see the block comment above the `Job` model in
// prisma/schema.prisma, and the hand-written CREATE INDEX statements in
// prisma/migrations/20260906120000_add_jobs/migration.sql). Nothing in
// `schema.prisma` enforces them, so the only way to know they are actually
// applied — and that the active-dedup constraint they implement behaves the
// way the comment says it does — is to run against a real Postgres.
//
// THIS IS A `*.db.spec.ts` FILE, DELIBERATELY EXCLUDED FROM `npm test`/
// `test:unit`/`test:cov`/`test:ci` (see apps/api/package.json's
// testPathIgnorePatterns). It runs only via `npm run test:db`, which CI's
// `smoke` job invokes right after `prisma:migrate` and before `prisma:seed`
// (see .github/workflows/ci.yml) — the migration has to have actually run
// for these indexes to exist. Locally, `npm run test:db` needs a real
// Postgres reachable at POSTGRES_HOST/POSTGRES_PORT with the migrations
// applied; see the reachability check below for what happens without one.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';

const HAND_WRITTEN_INDEX_NAMES = [
  'jobs_active_dedup_uniq_idx',
  'jobs_attempts_gt1_idx',
  'jobs_succeeded_duration_idx',
];

/**
 * Whether something is actually listening on host:port, checked with a real
 * (short-timeout) TCP connect rather than merely asking whether an env var is
 * set.
 *
 * Why not merely check `process.env.POSTGRES_HOST` for undefined, as a first
 * cut of this suite did: `test/.env.test` (loaded by `test/setup.ts` for
 * every jest run, this one included) unconditionally sets `POSTGRES_HOST` /
 * `POSTGRES_PORT` to a local test-database address, so the env var is always
 * "set" whether or not anything is actually listening there. Checking only
 * for presence would make this suite try to connect to a database a
 * developer running `npm run test:db` without `infra/compose/test.compose.yml`
 * up hasn't started, and blow up with the exact "confusing connection error"
 * this reachability check exists to turn into a clear, skipped warning
 * instead.
 *
 * Implemented as a synchronous child process (rather than an async
 * `beforeAll`) because Jest decides which `describe`/`it` blocks exist by
 * running the test file's top-level, synchronous code — by the time an async
 * `beforeAll` could resolve, `describe`/`it` registration has already
 * happened. `execFileSync` blocks until the child's own async TCP attempt
 * settles, giving a synchronous yes/no this file's top level can act on.
 */
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
    `\n[job-schema-indexes.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\` ` +
      `to exercise these real-Postgres assertions.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('Job schema: hand-written raw-SQL indexes (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Deliberately NOT `buildDatabaseUrl()` off bare `process.env`: this
    // file's own `test/setup.ts` (via `setupFilesAfterEnv`) unconditionally
    // loads `.env.test`, which sets a hard-coded `DATABASE_URL` pointing at
    // the local port-5433 test database docs elsewhere describe for
    // `infra/compose/test.compose.yml`. `buildDatabaseUrl()`'s own contract —
    // documented on itself — is that an already-set `DATABASE_URL` always
    // wins over POSTGRES_*, which is correct for the app at large but would
    // silently point THIS suite somewhere other than the POSTGRES_HOST/
    // POSTGRES_PORT the reachability check above just verified (in CI, the
    // Postgres service container's real address). Passing an env view with
    // `DATABASE_URL` stripped keeps this file honest: the database it proves
    // reachable is the one it actually connects Prisma to.
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    // Every test below creates its own jobs with unique dedup keys, so a
    // blanket delete between tests is safe and keeps them independent.
    await prisma.job.deleteMany({});
  });

  it('creates all three hand-written partial indexes on the jobs table', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'jobs' AND indexname = ANY(${HAND_WRITTEN_INDEX_NAMES})
    `;
    const found = rows.map((r) => r.indexname).sort();
    expect(found).toEqual([...HAND_WRITTEN_INDEX_NAMES].sort());
  });

  it('rejects a second active job sharing a dedup_key with an existing active job', async () => {
    const dedupKey = `test:dedup-active:${Date.now()}`;

    await prisma.job.create({
      data: { type: 'test.dedup', reason: 'upload', status: 'pending', dedupKey },
    });

    await expect(
      prisma.job.create({
        data: { type: 'test.dedup', reason: 'upload', status: 'running', dedupKey },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows any number of jobs with a NULL dedup_key', async () => {
    const job1 = await prisma.job.create({
      data: { type: 'test.no-dedup', reason: 'backfill', status: 'pending' },
    });
    const job2 = await prisma.job.create({
      data: { type: 'test.no-dedup', reason: 'backfill', status: 'pending' },
    });

    expect(job1.dedupKey).toBeNull();
    expect(job2.dedupKey).toBeNull();
    expect(job1.id).not.toBe(job2.id);
  });

  it('frees a dedup_key for a new active job once the holder reaches succeeded', async () => {
    const dedupKey = `test:dedup-freed:${Date.now()}`;

    const first = await prisma.job.create({
      data: { type: 'test.dedup-freed', reason: 'rerun', status: 'running', dedupKey },
    });

    // While `first` is active, a second active job with the same key is
    // still rejected (sanity check on the same mechanism as the test above).
    await expect(
      prisma.job.create({
        data: { type: 'test.dedup-freed', reason: 'rerun', status: 'pending', dedupKey },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.job.update({
      where: { id: first.id },
      data: { status: 'succeeded', finishedAt: new Date() },
    });

    // Now that `first` has left the active set, the key is free again.
    const second = await prisma.job.create({
      data: { type: 'test.dedup-freed', reason: 'rerun', status: 'pending', dedupKey },
    });
    expect(second.dedupKey).toBe(dedupKey);
  });
});
