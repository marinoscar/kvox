// =============================================================================
// Unit tests for JobAdminService (issue #264, epic #254)
// =============================================================================
//
// Everything here is a DECISION the service makes before any SQL exists: which
// `where` a set of filters produces, which precedence rule wins when two of
// them contradict, whether a cached roll-up is still young enough, and which
// exception a status is turned into. A mocked `job.findMany` returns whatever
// the test told it to whatever `where` it was handed, so a database could not
// prove any of those — but it is also the only thing that CAN capture the
// `where` verbatim, which is exactly what a filter test needs to assert.
//
// The one test that would need Postgres — "does that `where` actually match
// the intended rows" — is already covered one level down, by
// `test/jobs/job-stuck-reset.db.spec.ts` for the stuck predicate this service
// borrows rather than reimplements.
//
// The clock is pinned through `JOB_CLOCK` in every case. Two things depend on
// it — the stats cache TTL and the `now` in the `scheduled`/`processedWithin`
// windows — and both would otherwise be range assertions, which pass just as
// happily for an off-by-a-factor bug that lands inside the range.
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { JobAdminService, RETRY_FAILED_BATCH_LIMIT, STATS_CACHE_TTL_MS } from './job-admin.service';
import { JobClock } from './job-clock';
import { ACTIVE_DEDUP_INDEX_NAME } from './jobs.service';
import { stuckRunningWhere } from './job-stuck.service';
import type { JobStuckService } from './job-stuck.service';
import type { PrismaService } from '../prisma/prisma.service';
import { jobListQuerySchema } from './dto/job-list-query.dto';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/**
 * The horizon width the stubbed `JobStuckService` reports (#347).
 *
 * ⚠ IT MUST COME FROM THE STUB, NOT FROM A SECOND COMPUTATION HERE. The point
 * of the assertion below is that this service asks the reaper for the third
 * instant instead of deriving one of its own — a test that derived one would
 * pass against exactly the copy it exists to forbid.
 */
const HORIZON_MS = 720_000;

/** A parsed query, so every test goes through the same defaults the pipe applies. */
function query(raw: Record<string, unknown> = {}) {
  return jobListQuerySchema.parse(raw);
}

interface Harness {
  service: JobAdminService;
  job: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  stuck: {
    getStuckThresholdMinutes: jest.Mock;
    leaseHorizon: jest.Mock;
    resetStuck: jest.Mock;
  };
  /** Moves the pinned clock forward. */
  advance(ms: number): void;
}

function makeService(overrides: Partial<Harness['job']> = {}): Harness {
  let currentMs = NOW.getTime();

  const job = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    ...overrides,
  };

  const stuck = {
    getStuckThresholdMinutes: jest.fn().mockResolvedValue(30),
    // The third instant the predicate needs (#347). Stubbed here rather than
    // computed, because this suite is about what `JobAdminService` DOES with
    // the reaper's answers — that the horizon itself is right is
    // `JobStuckService.leaseHorizon`'s own test.
    leaseHorizon: jest.fn((now: Date) => new Date(now.getTime() + HORIZON_MS)),
    resetStuck: jest.fn().mockResolvedValue({ reset: 0, failed: 0 }),
  };

  const clock: JobClock = {
    now: () => currentMs,
    sleep: async () => undefined,
  };

  return {
    service: new JobAdminService(
      { job } as unknown as PrismaService,
      stuck as unknown as JobStuckService,
      clock
    ),
    job,
    stuck,
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

/** A `jobs` row shaped as `JOB_LIST_SELECT` projects it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'example.echo',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'failed',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    attempts: 3,
    lastError: 'boom',
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    ...overrides,
  };
}

/** The unique violation Postgres raises when a retry re-enters the dedup index. */
function dedupConflict(target: string = ACTIVE_DEDUP_INDEX_NAME) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });
}

/** The `where` a `findMany`/`count` was called with. */
function whereOf(mock: jest.Mock, call = 0): Record<string, unknown> {
  return mock.mock.calls[call][0].where;
}

// ===========================================================================
// stats
// ===========================================================================

describe('JobAdminService.stats', () => {
  function statsHarness() {
    return makeService({
      groupBy: jest
        .fn()
        // 1. by status
        .mockResolvedValueOnce([
          { status: 'pending', _count: { _all: 4 } },
          { status: 'running', _count: { _all: 2 } },
        ])
        // 2. by type + status
        .mockResolvedValueOnce([
          { type: 'example.echo', status: 'pending', _count: { _all: 3 } },
          { type: 'example.echo', status: 'running', _count: { _all: 2 } },
          { type: 'my-fork.thing', status: 'pending', _count: { _all: 1 } },
        ]),
      // scheduled, then stuckRunning
      count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    });
  }

  it('zero-fills every status, so a healthy queue does not render `undefined`', async () => {
    const { service } = statsHarness();

    const stats = await service.stats();

    expect(stats.byStatus).toEqual({ pending: 4, running: 2, succeeded: 0, failed: 0 });
  });

  it('sums `total` from the status breakdown rather than counting separately', async () => {
    const { service, job } = statsHarness();

    const stats = await service.stats();

    // The tile must equal the sum of the tiles beneath it. A fifth `count()`
    // would be taken at a different instant and could not promise that.
    expect(stats.total).toBe(6);
    // Four queries exactly: two groupBy, two count. Not five.
    expect(job.groupBy).toHaveBeenCalledTimes(2);
    expect(job.count).toHaveBeenCalledTimes(2);
  });

  it('runs both groupBy aggregates unfiltered, so the covering index can serve them', async () => {
    const { service, job } = statsHarness();

    await service.stats();

    // A `where` on either would push it off `jobs(status, type, id)` and onto
    // the heap — the cheapest part of the response becoming the most expensive.
    expect(job.groupBy.mock.calls[0][0]).toEqual({ by: ['status'], _count: { _all: true } });
    expect(job.groupBy.mock.calls[1][0]).toEqual({
      by: ['type', 'status'],
      _count: { _all: true },
    });
  });

  it('labels each type and orders busiest first, alphabetical on a tie', async () => {
    const { service } = statsHarness();

    const stats = await service.stats();

    expect(stats.byType).toEqual([
      {
        type: 'example.echo',
        label: 'Example echo',
        total: 5,
        byStatus: { pending: 3, running: 2, succeeded: 0, failed: 0 },
      },
      {
        // Unmapped: renders as itself, never blank. See `job-type-labels.ts`.
        type: 'my-fork.thing',
        label: 'my-fork.thing',
        total: 1,
        byStatus: { pending: 1, running: 0, succeeded: 0, failed: 0 },
      },
    ]);
  });

  it('orders equal totals alphabetically, so two polls do not reshuffle the table', async () => {
    const { service } = makeService({
      groupBy: jest
        .fn()
        .mockResolvedValueOnce([{ status: 'pending', _count: { _all: 2 } }])
        // Deliberately returned in reverse-alphabetical order, as a database
        // is free to do — `Map` iteration would preserve it.
        .mockResolvedValueOnce([
          { type: 'zzz.later', status: 'pending', _count: { _all: 1 } },
          { type: 'aaa.first', status: 'pending', _count: { _all: 1 } },
        ]),
    });

    const stats = await service.stats();

    expect(stats.byType.map((entry) => entry.type)).toEqual(['aaa.first', 'zzz.later']);
  });

  it('counts scheduled jobs as pending rows whose backoff has not elapsed', async () => {
    const { service, job } = statsHarness();

    await service.stats();

    expect(whereOf(job.count, 0)).toEqual({ status: 'pending', scheduledFor: { gt: NOW } });
  });

  it('counts stuckRunning with the reaper\'s own predicate, zombie arm included', async () => {
    const { service, job, stuck } = statsHarness();
    stuck.getStuckThresholdMinutes.mockResolvedValue(15);

    const stats = await service.stats();

    const threshold = new Date(NOW.getTime() - 15 * 60_000);

    // Compared against `stuckRunningWhere` itself rather than a hand-written
    // literal: the assertion has to fail if the reaper's predicate changes, not
    // merely if this service's copy of it does — because there must be no copy.
    expect(whereOf(job.count, 1)).toEqual(
      stuckRunningWhere(threshold, NOW, new Date(NOW.getTime() + HORIZON_MS))
    );
    // The zombie arm (`running` with a NULL `startedAt`) is the one an
    // independent implementation always forgets. Assert it is really in there.
    expect((whereOf(job.count, 1) as { OR: unknown[] }).OR).toContainEqual({
      leaseExpiresAt: null,
      startedAt: null,
      createdAt: { lt: threshold },
    });
    expect(stats.stuckRunning).toBe(2);
  });

  it('publishes the threshold the count was actually taken against', async () => {
    const { service, stuck } = statsHarness();
    stuck.getStuckThresholdMinutes.mockResolvedValue(5);

    const stats = await service.stats();

    // Without this the UI has to hardcode a number, and goes on displaying the
    // old one after an operator moves the setting.
    expect(stats.stuckThresholdMinutes).toBe(5);
  });

  it('serves a second caller from cache within the TTL', async () => {
    const { service, job, advance } = statsHarness();

    const first = await service.stats();
    advance(STATS_CACHE_TTL_MS - 1);
    const second = await service.stats();

    expect(second).toBe(first);
    expect(job.groupBy).toHaveBeenCalledTimes(2); // still only the first call's pair
  });

  it('does NOT serve one caller\'s result past the TTL', async () => {
    const { service, job, advance } = makeService({
      groupBy: jest.fn().mockResolvedValue([{ status: 'pending', _count: { _all: 1 } }]),
      count: jest.fn().mockResolvedValue(0),
    });

    const first = await service.stats();
    advance(STATS_CACHE_TTL_MS);
    const second = await service.stats();

    // Expiry is exclusive at exactly the TTL: `now - at < TTL` is false here.
    expect(second).not.toBe(first);
    expect(job.groupBy).toHaveBeenCalledTimes(4); // two pairs, so it re-queried
    expect(second.generatedAt.getTime()).toBe(NOW.getTime() + STATS_CACHE_TTL_MS);
  });

  it('re-reads the stuck threshold on a miss, so a settings change lands', async () => {
    const { service, stuck, advance } = makeService({
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    });
    stuck.getStuckThresholdMinutes.mockResolvedValue(30);

    await service.stats();
    stuck.getStuckThresholdMinutes.mockResolvedValue(5);
    advance(STATS_CACHE_TTL_MS);

    expect((await service.stats()).stuckThresholdMinutes).toBe(5);
  });

  it('treats a groupBy row with no `_count` as zero rather than NaN', async () => {
    const { service } = makeService({
      groupBy: jest
        .fn()
        .mockResolvedValueOnce([{ status: 'pending' }])
        .mockResolvedValueOnce([]),
    });

    const stats = await service.stats();

    expect(stats.total).toBe(0);
    expect(Number.isNaN(stats.total)).toBe(false);
  });
});

// ===========================================================================
// list
// ===========================================================================

describe('JobAdminService.list', () => {
  it('defaults to no filter at all, newest first', async () => {
    const { service, job } = makeService();

    await service.list(query());

    expect(job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' }, skip: 0, take: 20 })
    );
  });

  it('never selects `payload`', async () => {
    const { service, job } = makeService();

    await service.list(query());

    // An unbounded JSONB column times a hundred rows, on an endpoint a
    // dashboard polls. See `dto/job-response.dto.ts`.
    expect(job.findMany.mock.calls[0][0].select).not.toHaveProperty('payload');
  });

  it('filters by status alone', async () => {
    const { service, job } = makeService();

    await service.list(query({ status: 'failed' }));

    expect(whereOf(job.findMany)).toEqual({ status: 'failed' });
  });

  it('filters by type alone', async () => {
    const { service, job } = makeService();

    await service.list(query({ type: 'example.echo' }));

    expect(whereOf(job.findMany)).toEqual({ type: 'example.echo' });
  });

  it('filters by subjectType alone', async () => {
    const { service, job } = makeService();

    await service.list(query({ subjectType: 'invoice' }));

    expect(whereOf(job.findMany)).toEqual({ subjectType: 'invoice' });
  });

  it('filters by subjectId alone', async () => {
    const { service, job } = makeService();

    await service.list(query({ subjectId: 'inv_42' }));

    expect(whereOf(job.findMany)).toEqual({ subjectId: 'inv_42' });
  });

  it('filters by scheduled alone, as pending plus a future scheduledFor', async () => {
    const { service, job } = makeService();

    await service.list(query({ scheduled: 'true' }));

    expect(whereOf(job.findMany)).toEqual({ status: 'pending', scheduledFor: { gt: NOW } });
  });

  it('treats scheduled=false as no scheduled filter at all', async () => {
    const { service, job } = makeService();

    // The reason the schema does not use `z.coerce.boolean()`: `Boolean('false')`
    // is `true`, which would turn this opt-OUT into the opt-IN.
    await service.list(query({ scheduled: 'false', status: 'failed' }));

    expect(whereOf(job.findMany)).toEqual({ status: 'failed' });
  });

  it('expresses processedWithin as COALESCE(finishedAt, createdAt), disjointly', async () => {
    const { service, job } = makeService();

    await service.list(query({ processedWithin: '4h' }));

    const since = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);

    expect(whereOf(job.findMany)).toEqual({
      OR: [{ finishedAt: { gte: since } }, { finishedAt: null, createdAt: { gte: since } }],
    });
  });

  it.each([
    ['24h', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ])('reaches back exactly one %s window', async (window, ms) => {
    const { service, job } = makeService();

    await service.list(query({ processedWithin: window }));

    const since = new Date(NOW.getTime() - ms);
    expect(whereOf(job.findMany)).toEqual({
      OR: [{ finishedAt: { gte: since } }, { finishedAt: null, createdAt: { gte: since } }],
    });
  });

  it('adds nothing for processedWithin=all, which is the default', async () => {
    const { service, job } = makeService();

    await service.list(query({ processedWithin: 'all' }));

    expect(whereOf(job.findMany)).toEqual({});
  });

  it('combines type, subject and status into one AND-ed where', async () => {
    const { service, job } = makeService();

    await service.list(
      query({ status: 'running', type: 'example.echo', subjectType: 'invoice', subjectId: 'i1' })
    );

    expect(whereOf(job.findMany)).toEqual({
      status: 'running',
      type: 'example.echo',
      subjectType: 'invoice',
      subjectId: 'i1',
    });
  });

  it('combines every filter at once, scheduled included', async () => {
    const { service, job } = makeService();

    await service.list(
      query({
        type: 'example.echo',
        subjectType: 'invoice',
        subjectId: 'i1',
        scheduled: 'true',
        processedWithin: '24h',
      })
    );

    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

    expect(whereOf(job.findMany)).toEqual({
      type: 'example.echo',
      subjectType: 'invoice',
      subjectId: 'i1',
      status: 'pending',
      scheduledFor: { gt: NOW },
      OR: [{ finishedAt: { gte: since } }, { finishedAt: null, createdAt: { gte: since } }],
    });
  });

  it('lets scheduled=true OVERRIDE a conflicting status rather than intersecting', async () => {
    const { service, job } = makeService();

    await service.list(query({ scheduled: 'true', status: 'failed' }));

    // Answering the contradiction with an empty page would tell the operator
    // that no such job exists, when the truth is that none CAN.
    expect(whereOf(job.findMany)).toEqual({ status: 'pending', scheduledFor: { gt: NOW } });
  });

  it('counts against the same where it lists with', async () => {
    const { service, job } = makeService();

    await service.list(query({ status: 'failed' }));

    expect(whereOf(job.count)).toEqual(whereOf(job.findMany));
  });

  it('paginates with the flat shape every list in this API uses', async () => {
    const { service, job } = makeService({
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(42),
    });

    const result = await service.list(query({ page: 3, pageSize: 10 }));

    expect(job.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    expect(result).toMatchObject({ total: 42, page: 3, pageSize: 10, totalPages: 5 });
  });

  it('adds a typeLabel to every row without removing `type`', async () => {
    const { service } = makeService({
      findMany: jest.fn().mockResolvedValue([row(), row({ type: 'my-fork.thing' })]),
    });

    const { items } = await service.list(query());

    expect(items[0]).toMatchObject({ type: 'example.echo', typeLabel: 'Example echo' });
    expect(items[1]).toMatchObject({ type: 'my-fork.thing', typeLabel: 'my-fork.thing' });
  });
});

// ===========================================================================
// retryFailed
// ===========================================================================

describe('JobAdminService.retryFailed', () => {
  it('scopes to failed jobs and resets each one completely', async () => {
    const { service, job } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    });

    const result = await service.retryFailed();

    expect(whereOf(job.findMany)).toEqual({ status: 'failed' });
    expect(job.updateMany).toHaveBeenCalledWith({
      // `status: 'failed'` is re-asserted with the id: between the read and
      // the write another admin may already have moved the row.
      where: { id: 'a', status: 'failed' },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
        rateLimitedAt: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
        executor: null,
      },
    });
    expect(result).toEqual({ retried: 1, skipped: 0, remaining: 0 });
  });

  it('scopes by type when one is given', async () => {
    const { service, job } = makeService();

    await service.retryFailed('example.echo');

    expect(whereOf(job.findMany)).toEqual({ status: 'failed', type: 'example.echo' });
    expect(whereOf(job.count)).toEqual({ status: 'failed', type: 'example.echo' });
  });

  it('is idempotent when nothing is failed', async () => {
    const { service, job } = makeService();

    expect(await service.retryFailed()).toEqual({ retried: 0, skipped: 0, remaining: 0 });
    expect(job.updateMany).not.toHaveBeenCalled();
  });

  it('never leaves `dedupKey` out of the row it resets', async () => {
    const { service, job } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await service.retryFailed();

    // Clearing it would make every retry succeed, at the cost of silently
    // allowing a duplicate of work that is already running.
    expect(job.updateMany.mock.calls[0][0].data).not.toHaveProperty('dedupKey');
  });

  it('skips a dedup collision and keeps going instead of aborting the sweep', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(dedupConflict())
      .mockResolvedValueOnce({ count: 1 });

    const { service } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      updateMany,
      count: jest.fn().mockResolvedValue(1),
    });

    const result = await service.retryFailed();

    // One `updateMany` over all three would have aborted entirely on `b`.
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ retried: 2, skipped: 1, remaining: 1 });
  });

  it('recognises the collision by the column name too, not only the index name', async () => {
    const { service } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      updateMany: jest.fn().mockRejectedValue(dedupConflict('dedup_key')),
    });

    expect(await service.retryFailed()).toMatchObject({ retried: 0, skipped: 1 });
  });

  it('re-throws a unique violation on some OTHER constraint', async () => {
    const { service } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      updateMany: jest.fn().mockRejectedValue(dedupConflict('a_forks_own_index')),
    });

    // Swallowing it would report success for a write that did not happen.
    await expect(service.retryFailed()).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('re-throws anything that is not a P2002', async () => {
    const { service } = makeService({
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      updateMany: jest.fn().mockRejectedValue(new Error('connection reset')),
    });

    await expect(service.retryFailed()).rejects.toThrow('connection reset');
  });

  it('caps the batch and reports what is left, newest first', async () => {
    const { service, job } = makeService({ count: jest.fn().mockResolvedValue(900) });

    const result = await service.retryFailed();

    expect(job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: RETRY_FAILED_BATCH_LIMIT, orderBy: { createdAt: 'desc' } })
    );
    expect(result.remaining).toBe(900);
  });
});

// ===========================================================================
// resetStuck
// ===========================================================================

describe('JobAdminService.resetStuck', () => {
  it('delegates to JobStuckService rather than sweeping itself', async () => {
    const { service, stuck, job } = makeService();
    stuck.resetStuck.mockResolvedValue({ reset: 3, failed: 1 });

    const result = await service.resetStuck(5);

    expect(stuck.resetStuck).toHaveBeenCalledWith(5);
    expect(result).toEqual({ reset: 3, failed: 1, thresholdMinutes: 5 });
    // Not one query of its own: the whole sweep lives one level down.
    expect(job.updateMany).not.toHaveBeenCalled();
  });

  it('defers to the system setting when no override is given', async () => {
    const { service, stuck } = makeService();
    stuck.getStuckThresholdMinutes.mockResolvedValue(45);

    const result = await service.resetStuck(undefined);

    // The DTO deliberately supplies no default, so an empty body lands here as
    // `undefined` and the settings accessor is the only thing that decides.
    expect(stuck.getStuckThresholdMinutes).toHaveBeenCalled();
    expect(stuck.resetStuck).toHaveBeenCalledWith(45);
    expect(result.thresholdMinutes).toBe(45);
  });

  it('honours an explicit 0 instead of treating it as absent', async () => {
    const { service, stuck } = makeService();

    await service.resetStuck(0);

    // `?? ` on a number is how "sweep everything matching a signal now" turns
    // silently back into the 30-minute default.
    expect(stuck.getStuckThresholdMinutes).not.toHaveBeenCalled();
    expect(stuck.resetStuck).toHaveBeenCalledWith(0);
  });
});

// ===========================================================================
// retry / remove
// ===========================================================================

describe('JobAdminService.retry', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('404s a job that does not exist', async () => {
    const { service, job } = makeService();

    await expect(service.retry(id)).rejects.toThrow(NotFoundException);
    expect(job.updateMany).not.toHaveBeenCalled();
  });

  it('400s a running job, without touching it', async () => {
    const { service, job } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'running' }),
    });

    await expect(service.retry(id)).rejects.toThrow(BadRequestException);
    expect(job.updateMany).not.toHaveBeenCalled();
  });

  it('puts the machine-readable half in `details`, where the filter keeps it', async () => {
    const { service } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'running' }),
    });

    await expect(service.retry(id)).rejects.toMatchObject({
      response: { details: { jobId: id, status: 'running', reason: 'job_running' } },
    });
  });

  it.each(['pending', 'succeeded', 'failed'])('resets a %s job completely', async (status) => {
    const { service, job } = makeService({
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({ id, status })
        .mockResolvedValueOnce(row({ id, status: 'pending' })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    const result = await service.retry(id);

    expect(job.updateMany).toHaveBeenCalledWith({
      // Conditional on the id AND on not-running, so a job that starts running
      // between the read and the write is refused by the write itself.
      where: { id, status: { not: 'running' } },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
        rateLimitedAt: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
        executor: null,
      },
    });
    expect(result).toMatchObject({ id, typeLabel: 'Example echo' });
  });

  it('400s when the job starts running between the read and the write', async () => {
    const { service } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'failed' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });

    // Same answer as the up-front guard, so the race is invisible to the caller.
    await expect(service.retry(id)).rejects.toThrow(BadRequestException);
  });

  it('409s a dedup collision instead of letting a P2002 escape as a 500', async () => {
    const { service } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'failed' }),
      updateMany: jest.fn().mockRejectedValue(dedupConflict()),
    });

    await expect(service.retry(id)).rejects.toThrow(ConflictException);
  });

  it('404s if the row is deleted between the write and the read-back', async () => {
    const { service } = makeService({
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({ id, status: 'failed' })
        .mockResolvedValueOnce(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await expect(service.retry(id)).rejects.toThrow(NotFoundException);
  });
});

describe('JobAdminService.remove', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('404s a job that does not exist', async () => {
    const { service, job } = makeService();

    await expect(service.remove(id)).rejects.toThrow(NotFoundException);
    expect(job.deleteMany).not.toHaveBeenCalled();
  });

  it('400s a running job, without deleting it', async () => {
    const { service, job } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'running' }),
    });

    await expect(service.remove(id)).rejects.toThrow(BadRequestException);
    expect(job.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes conditionally, so a job that starts running is refused', async () => {
    const { service, job } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'succeeded' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    });

    await service.remove(id);

    expect(job.deleteMany).toHaveBeenCalledWith({ where: { id, status: { not: 'running' } } });
  });

  it('400s when the delete matched nothing because the job started running', async () => {
    const { service } = makeService({
      findUnique: jest.fn().mockResolvedValue({ id, status: 'pending' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    });

    await expect(service.remove(id)).rejects.toThrow(BadRequestException);
  });
});
