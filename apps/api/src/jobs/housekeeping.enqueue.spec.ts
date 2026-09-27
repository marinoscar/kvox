import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { HOUSEKEEPING_PRIORITY, enqueueHousekeepingJob } from './housekeeping.enqueue';
import type { JobsService } from './jobs.service';

// =============================================================================
// `enqueueHousekeepingJob` — one signature, three callers' shapes:
//   - global (every maintenance cron since #353): scoped to the type alone;
//   - subject TYPE only (#386 `kg.export` sweep): a global sweep told apart
//     from same-type renders — scoped to (type, subjectType, null id);
//   - subject TYPE + ID (#384 `kg.migrate`): one active job per owner.
// The in-flight lookup and the enqueued job always carry the same scope.
// =============================================================================

function harness(active: { id: string; status: string } | null = null) {
  const prisma = { job: { findFirst: jest.fn().mockResolvedValue(active) } };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  const base = {
    prisma: prisma as unknown as PrismaService,
    jobs: jobs as unknown as JobsService,
    logger,
    type: 'x.sweep',
    what: 'x sweep',
  };
  return { prisma, jobs, base };
}

describe('enqueueHousekeepingJob', () => {
  it('global: scopes the lookup to the type and enqueues with no subject', async () => {
    const { prisma, jobs, base } = harness();

    await enqueueHousekeepingJob(base);

    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { type: 'x.sweep', status: { in: ['pending', 'running'] } },
      select: { id: true, status: true },
    });
    expect(jobs.enqueue).toHaveBeenCalledWith({ type: 'x.sweep', reason: 'backfill', priority: HOUSEKEEPING_PRIORITY });
  });

  it('subject type only: scopes to (type, subjectType, null id) and carries the payload', async () => {
    const { prisma, jobs, base } = harness();

    await enqueueHousekeepingJob({ ...base, subjectType: 'x_sweep', payload: { mode: 'sweep' } });

    expect(prisma.job.findFirst.mock.calls[0][0].where).toEqual({
      type: 'x.sweep',
      status: { in: ['pending', 'running'] },
      subjectType: 'x_sweep',
      subjectId: null,
    });
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'x.sweep',
      reason: 'backfill',
      subjectType: 'x_sweep',
      subjectId: null,
      payload: { mode: 'sweep' },
      priority: HOUSEKEEPING_PRIORITY,
    });
  });

  it('subject type + id: one active job per subject', async () => {
    const { prisma, jobs, base } = harness();

    await enqueueHousekeepingJob({ ...base, subjectType: 'user', subjectId: 'u-1', payload: { ownerId: 'u-1' } });

    expect(prisma.job.findFirst.mock.calls[0][0].where).toMatchObject({ subjectType: 'user', subjectId: 'u-1' });
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectType: 'user', subjectId: 'u-1', payload: { ownerId: 'u-1' } }));
  });

  it('ignores a subject id without a subject type', async () => {
    const { prisma, jobs, base } = harness();

    await enqueueHousekeepingJob({ ...base, subjectId: 'u-1' });

    expect(prisma.job.findFirst.mock.calls[0][0].where).toEqual({ type: 'x.sweep', status: { in: ['pending', 'running'] } });
    expect(jobs.enqueue.mock.calls[0][0]).not.toHaveProperty('subjectId');
  });

  it('skips when one is already in flight, and never throws', async () => {
    const skipped = harness({ id: 'j', status: 'running' });
    await expect(enqueueHousekeepingJob(skipped.base)).resolves.toBeNull();
    expect(skipped.jobs.enqueue).not.toHaveBeenCalled();

    const failing = harness();
    failing.prisma.job.findFirst.mockRejectedValue(new Error('db down'));
    await expect(enqueueHousekeepingJob(failing.base)).resolves.toBeNull();
  });
});
