import { Test } from '@nestjs/testing';

import { HOUSEKEEPING_PRIORITY } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KgExportExpiryTask } from './kg-export-expiry.task';

// =============================================================================
// The graph export expiry cron (#386). `test/jobs/cron-enqueue-only.spec.ts`
// already pins that its body only enqueues; this pins WHAT it enqueues — one
// `kg.export` job in sweep mode under its own subject type — and that a render
// in flight never suppresses it.
// =============================================================================

describe('KgExportExpiryTask', () => {
  let task: KgExportExpiryTask;
  let jobs: { enqueue: jest.Mock };
  let prisma: { job: { findFirst: jest.Mock } };

  beforeEach(async () => {
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    prisma = { job: { findFirst: jest.fn().mockResolvedValue(null) } };
    const module = await Test.createTestingModule({
      providers: [KgExportExpiryTask, { provide: JobsService, useValue: jobs }, { provide: PrismaService, useValue: prisma }],
    }).compile();
    task = module.get(KgExportExpiryTask);
  });

  it('queues one kg.export sweep job at housekeeping priority', async () => {
    await task.handleCron();
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'kg.export',
      reason: 'backfill',
      priority: HOUSEKEEPING_PRIORITY,
      subjectType: 'kg_export_sweep',
      subjectId: null,
      payload: { mode: 'sweep' },
    });
  });

  it('asks only whether a SWEEP is in flight, so a pending render never suppresses it', async () => {
    await task.handleCron();
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'kg.export', status: { in: ['pending', 'running'] }, subjectType: 'kg_export_sweep', subjectId: null },
      }),
    );
  });

  it('skips the tick when a sweep is still in flight, and never throws', async () => {
    prisma.job.findFirst.mockResolvedValue({ id: 'job-0', status: 'running' });
    await task.handleCron();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    prisma.job.findFirst.mockRejectedValue(new Error('database blip'));
    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
