// =============================================================================
// Unit tests for the history-purge handler (issue #263, epic #254)
// =============================================================================
//
// The TRANSACTION is proved in `test/jobs/job-history-purge.db.spec.ts`: a
// `$transaction` rollback is not meaningfully testable against a mock, since
// a mocked `$transaction` rolls nothing back and a mocked `deleteMany` deletes
// nothing. What is tested here is everything AROUND that guarantee — the
// selection rule (terminal only, at any age), the fold arithmetic, the
// batching loop's exit conditions, and the disabled switch.
// =============================================================================

import { Job, JobStatus } from '@prisma/client';

import { foldDeltas, JobHistoryPurgeHandler, purgeableWhere } from './job-history-purge.handler';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { JobHandler } from '../job-handler.interface';
import type { JobHandlerRegistry } from '../job-handler.registry';

const CUTOFF = new Date('2026-01-01T00:00:00.000Z');

type Candidate = Pick<Job, 'id' | 'type' | 'status' | 'startedAt' | 'finishedAt'>;

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'job-1',
  type: 'example.echo',
  status: 'succeeded' as JobStatus,
  startedAt: new Date('2025-12-01T00:00:00.000Z'),
  finishedAt: new Date('2025-12-01T00:00:02.000Z'),
  ...overrides,
});

function makeHandler(options: {
  findMany?: jest.Mock;
  purgeEnabled?: boolean;
  retentionDays?: number;
}) {
  const findMany = options.findMany ?? jest.fn().mockResolvedValue([]);
  const upsert = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });

  const tx = { jobStatsRollup: { upsert }, job: { deleteMany } };

  const prisma = {
    job: { findMany },
    // Runs the callback against a fake `tx`. It proves the ORDER of the calls
    // and the arguments, not the atomicity — that is the database suite's job.
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;

  const systemSettings = {
    getJobsPolicy: jest.fn().mockResolvedValue({
      history: {
        retentionDays: options.retentionDays ?? 30,
        purgeEnabled: options.purgeEnabled ?? true,
      },
      stuckThresholdMinutes: 30,
    }),
  } as unknown as SystemSettingsService;

  const register = jest.fn();
  const registry = { register } as unknown as JobHandlerRegistry;

  return {
    handler: new JobHistoryPurgeHandler(prisma, systemSettings, registry),
    findMany,
    upsert,
    deleteMany,
    prisma,
    register,
  };
}

const purgeJob = { id: 'purge-1', type: 'job.history.purge' } as Job;

describe('purgeableWhere', () => {
  it('takes terminal rows only — pending and running are never candidates', () => {
    // THE RULE, not an implementation detail: a pending job is work that has
    // not been done, and its age says something about the queue rather than
    // about whether the work is still wanted.
    expect(purgeableWhere(CUTOFF).status).toEqual({ in: ['succeeded', 'failed'] });
  });

  it('ages a terminal row by finishedAt, or by createdAt when it has none', () => {
    // The second arm is not decoration: `NULL < cutoff` is NULL, so a
    // terminal row with no finish time would otherwise be unpurgeable forever
    // and the table would grow without bound.
    expect(purgeableWhere(CUTOFF).OR).toEqual([
      { finishedAt: { lt: CUTOFF } },
      { finishedAt: null, createdAt: { lt: CUTOFF } },
    ]);
  });
});

describe('foldDeltas', () => {
  it('counts successes and failures per type', () => {
    const deltas = foldDeltas([
      candidate({ id: 'a', type: 'x', status: 'succeeded' }),
      candidate({ id: 'b', type: 'x', status: 'failed' }),
      candidate({ id: 'c', type: 'y', status: 'succeeded' }),
    ]);

    expect(deltas.get('x')).toMatchObject({ succeeded: 1, failed: 1 });
    expect(deltas.get('y')).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('samples durations from succeeded rows only', () => {
    // Matching `jobs_succeeded_duration_idx`, the partial index the live half
    // of this statistic is computed over. Folding failures in would make the
    // purged half mean something different from the live half.
    const deltas = foldDeltas([
      candidate({
        id: 'a',
        type: 'x',
        status: 'succeeded',
        startedAt: new Date(1000),
        finishedAt: new Date(3000),
      }),
      candidate({
        id: 'b',
        type: 'x',
        status: 'failed',
        startedAt: new Date(1000),
        finishedAt: new Date(9999),
      }),
    ]);

    expect(deltas.get('x')).toEqual({
      succeeded: 1,
      failed: 1,
      sumDurationMs: 2000,
      durationSamples: 1,
    });
  });

  it('skips a row with no timestamps rather than counting a zero-length sample', () => {
    const deltas = foldDeltas([
      candidate({ id: 'a', type: 'x', startedAt: null, finishedAt: null }),
    ]);

    expect(deltas.get('x')).toEqual({
      succeeded: 1,
      failed: 0,
      sumDurationMs: 0,
      durationSamples: 0,
    });
  });

  it('drops both the sum and the sample when a duration is negative', () => {
    // A clock stepped backwards between the claim and the terminal write.
    // Counting the sample without the duration would drag the average down.
    const deltas = foldDeltas([
      candidate({
        id: 'a',
        type: 'x',
        startedAt: new Date(5000),
        finishedAt: new Date(1000),
      }),
    ]);

    expect(deltas.get('x')).toMatchObject({ sumDurationMs: 0, durationSamples: 0 });
  });
});

describe('JobHistoryPurgeHandler', () => {
  it('self-registers from its own onModuleInit', () => {
    const { handler, register } = makeHandler({});

    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
  });

  it('is server-only, by carrying neither node member', () => {
    // Read through the `JobHandler` view rather than the class, because the
    // class does not declare either member at all — which IS the assertion:
    // `serverOnlyTypes()` derives eligibility from their absence, so there is
    // no flag here that could disagree with the implementation.
    const { handler } = makeHandler({});
    const asHandler: JobHandler = handler;

    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it('does nothing at all when the purge is disabled', async () => {
    // Checked here as well as in the scheduling task: a purge row can also
    // arrive from an admin control or a rerun, and the setting is a statement
    // about deleting history rather than about scheduling it.
    const { handler, findMany, deleteMany } = makeHandler({ purgeEnabled: false });

    await handler.process(purgeJob);

    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('derives the cutoff from the configured retention', async () => {
    const { handler, findMany } = makeHandler({ retentionDays: 7 });

    const before = Date.now();
    await handler.process(purgeJob);
    const after = Date.now();

    const where = findMany.mock.calls[0][0].where as { OR: [{ finishedAt: { lt: Date } }] };
    const cutoff = where.OR[0].finishedAt.lt.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    expect(cutoff).toBeGreaterThanOrEqual(before - sevenDays);
    expect(cutoff).toBeLessThanOrEqual(after - sevenDays);
  });

  it('counts the batch into the rollup and deletes it inside one transaction', async () => {
    const rows = [
      candidate({ id: 'a', type: 'x', status: 'succeeded' }),
      candidate({ id: 'b', type: 'x', status: 'failed' }),
    ];
    const findMany = jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    const { handler, upsert, deleteMany, prisma } = makeHandler({ findMany });

    await handler.process(purgeJob);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { type: 'x' },
      update: { succeededCount: { increment: 1 }, failedCount: { increment: 1 } },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } } });
  });

  it('deletes exactly the ids it counted, never by re-running the where', async () => {
    // Re-running the `where` inside the transaction would delete rows that
    // became terminal between the select and the delete — rows nothing has
    // counted, which is precisely the "deleted uncounted" outcome.
    const rows = [candidate({ id: 'only-this-one' })];
    const findMany = jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    const { handler, deleteMany } = makeHandler({ findMany });

    await handler.process(purgeJob);

    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['only-this-one'] } } });
  });

  it('stops after a short batch without asking again', async () => {
    const findMany = jest.fn().mockResolvedValue([candidate()]);
    const { handler } = makeHandler({ findMany });

    await handler.process(purgeJob);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing old enough', async () => {
    const { handler, deleteMany, prisma } = makeHandler({});

    await handler.process(purgeJob);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('lets a database error propagate, so the queue retries the purge', async () => {
    // Throw to fail: the handler contract's failure mode, and what buys the
    // purge `JOBS_MAX_ATTEMPTS` and backoff for free.
    const findMany = jest.fn().mockRejectedValue(new Error('deadlock detected'));
    const { handler } = makeHandler({ findMany });

    await expect(handler.process(purgeJob)).rejects.toThrow('deadlock detected');
  });
});
