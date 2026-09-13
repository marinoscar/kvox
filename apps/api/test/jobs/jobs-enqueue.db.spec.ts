// =============================================================================
// Real-Postgres test: enqueue and index-backed dedup (issue #260, epic #254)
// =============================================================================
//
// The dedup contract is a claim about what the DATABASE does when two inserts
// collide, so a mock cannot make it. `jobs_active_dedup_uniq_idx` is a
// partial unique index that exists only in raw migration SQL (Prisma's DSL
// cannot express a `WHERE` on an index), and the whole reason `enqueue`
// inserts optimistically instead of running `findFirst` first is that the
// check-then-act version loses exactly the race this suite runs.
//
// So this suite runs the real `JobsService` over two INDEPENDENT
// `PrismaClient` instances and makes them collide on purpose.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { PrismaClient } from '@prisma/client';

import { buildDedupKey } from '../../src/jobs/job-keys';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('jobs-enqueue.db.spec');

function enqueuerFor(client: PrismaClient): JobsService {
  return new JobsService(client as unknown as PrismaService);
}

describeWithDb('JobsService.enqueue (real Postgres)', () => {
  let clientA: PrismaClient;
  let clientB: PrismaClient;
  let jobsA: JobsService;
  let jobsB: JobsService;

  // Same scoping discipline as the claim suite: a per-process type prefix, so
  // cleanup removes exactly this suite's rows from a shared database.
  const TYPE_PREFIX = `test.enqueue.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    clientA = createDbClient();
    clientB = createDbClient();
    await Promise.all([clientA.$connect(), clientB.$connect()]);
    jobsA = enqueuerFor(clientA);
    jobsB = enqueuerFor(clientB);
  });

  afterEach(async () => {
    await clientA.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    await clientA?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]);
  });

  // ===========================================================================
  // The dedup race
  // ===========================================================================

  it('collapses concurrent enqueues of the same dedup key onto one row, and hands it to both callers', async () => {
    const type = nextType();

    // Two clients, two pools, one key, both inserts in flight at once. This
    // is the arrangement `findFirst`-then-`create` fails: both would see "no
    // active duplicate" and both would insert.
    const [first, second] = await Promise.all([
      jobsA.enqueue({ type, reason: 'upload', subjectType: 'doc', subjectId: 'shared' }),
      jobsB.enqueue({ type, reason: 'upload', subjectType: 'doc', subjectId: 'shared' }),
    ]);

    // BOTH callers get a job (neither sees an error)...
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    // ...and it is the SAME job.
    expect(first.id).toBe(second.id);

    // Exactly one row exists, carrying the key `buildDedupKey` defines.
    const rows = await clientA.job.findMany({ where: { type } });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupKey).toBe(buildDedupKey(type, 'doc', 'shared'));
  });

  it('stays at one row under a wider concurrent burst on the same key', async () => {
    const type = nextType();
    const input = {
      type,
      reason: 'upload' as const,
      subjectType: 'doc',
      subjectId: 'burst',
    };

    // Ten simultaneous callers alternating between two connections. Every one
    // of them must come back with the same row — not an error, not a second
    // job.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        (index % 2 === 0 ? jobsA : jobsB).enqueue(input)
      )
    );

    const ids = new Set(results.map((job) => job.id));
    expect(ids.size).toBe(1);
    expect(await clientA.job.count({ where: { type } })).toBe(1);
  });

  it('creates a separate row per caller when skipDedup is set', async () => {
    const type = nextType();
    const input = {
      type,
      reason: 'upload' as const,
      subjectType: 'doc',
      subjectId: 'shared',
      skipDedup: true,
    };

    const [first, second] = await Promise.all([jobsA.enqueue(input), jobsB.enqueue(input)]);

    // Two distinct rows, both with a NULL key — Postgres treats every NULL as
    // distinct, which is what makes the opt-out free rather than a second
    // code path.
    expect(first.id).not.toBe(second.id);
    expect(first.dedupKey).toBeNull();
    expect(second.dedupKey).toBeNull();
    expect(await clientA.job.count({ where: { type } })).toBe(2);
  });

  // ===========================================================================
  // What the key covers, and when it frees up
  // ===========================================================================

  it('dedups on type plus subject, so a different subject is a different job', async () => {
    const type = nextType();

    const one = await jobsA.enqueue({
      type,
      reason: 'rerun',
      subjectType: 'doc',
      subjectId: 'a',
    });
    const two = await jobsA.enqueue({
      type,
      reason: 'rerun',
      subjectType: 'doc',
      subjectId: 'b',
    });

    expect(one.id).not.toBe(two.id);
    expect(one.dedupKey).toBe(buildDedupKey(type, 'doc', 'a'));
    expect(two.dedupKey).toBe(buildDedupKey(type, 'doc', 'b'));
  });

  it('dedups a subject-less (global) job against another of the same type', async () => {
    const type = nextType();

    const one = await jobsA.enqueue({ type, reason: 'backfill' });
    const two = await jobsB.enqueue({ type, reason: 'backfill' });

    expect(one.id).toBe(two.id);
    // Both nulls fold into the key's empty segments — see `buildDedupKey`.
    expect(one.dedupKey).toBe(buildDedupKey(type, null, null));
  });

  it('dedups against a running job, not only a pending one', async () => {
    const type = nextType();

    const first = await jobsA.enqueue({ type, reason: 'upload', subjectId: 'x' });
    await clientA.job.update({
      where: { id: first.id },
      data: { status: 'running', startedAt: new Date() },
    });

    const second = await jobsB.enqueue({ type, reason: 'upload', subjectId: 'x' });

    // The index's predicate is `status IN ('pending','running')`, so work
    // already being executed still collapses a re-request onto it.
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('running');
  });

  it('frees the key once the holding job settles, so the work can be requeued later', async () => {
    const type = nextType();

    const first = await jobsA.enqueue({ type, reason: 'upload', subjectId: 'x' });
    await clientA.job.update({
      where: { id: first.id },
      data: { status: 'succeeded', finishedAt: new Date() },
    });

    const second = await jobsA.enqueue({ type, reason: 'upload', subjectId: 'x' });

    // A settled job drops out of the partial index's predicate, so dedup
    // collapses work that is IN FLIGHT and never permanently blocks a job on
    // its own history.
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
    expect(await clientA.job.count({ where: { type } })).toBe(2);
  });

  // ===========================================================================
  // The rest of the row
  // ===========================================================================

  it('writes the optional fields it was given and defaults the rest', async () => {
    const type = nextType();
    const scheduledFor = new Date(Date.now() + 30 * 60 * 1000);

    const job = await jobsA.enqueue({
      type,
      reason: 'backfill',
      subjectType: 'report',
      subjectId: 'q3',
      payload: { rows: 12, mode: 'full' },
      priority: -5,
      scheduledFor,
    });

    expect(job.subjectType).toBe('report');
    expect(job.subjectId).toBe('q3');
    expect(job.payload).toEqual({ rows: 12, mode: 'full' });
    expect(job.priority).toBe(-5);
    expect(job.scheduledFor?.getTime()).toBe(scheduledFor.getTime());

    // Untouched by enqueue — a job starts life unclaimed and uncharged.
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.startedAt).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.executor).toBeNull();
    expect(job.providerKey).toBeNull();
  });

  it('defaults priority to 0 and leaves scheduledFor null when not given', async () => {
    const type = nextType();
    const job = await jobsA.enqueue({ type, reason: 'rerun' });

    expect(job.priority).toBe(0);
    // NULL is what makes a job eligible immediately.
    expect(job.scheduledFor).toBeNull();
  });

  // ===========================================================================
  // recordProvider
  // ===========================================================================

  it('records the provider audit on a real row, and swallows a miss on a row that is gone', async () => {
    const type = nextType();
    const job = await jobsA.enqueue({ type, reason: 'upload' });

    await jobsA.recordProvider(job.id, 'provider-a', 'v3');

    const updated = await clientA.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.providerKey).toBe('provider-a');
    expect(updated.modelVersion).toBe('v3');

    // The commonest real failure: queue hygiene (#263) purged the row first.
    // An audit write must never become the caller's problem.
    await clientA.job.delete({ where: { id: job.id } });
    await expect(jobsA.recordProvider(job.id, 'provider-a', 'v3')).resolves.toBeUndefined();
  });
});
