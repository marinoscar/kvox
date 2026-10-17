import { KgExportExpiryTask } from './kg-export-expiry.task.js';
import type { KvoxJobsPort } from '../../ports/index.js';

// =============================================================================
// The graph export expiry cron (#386). The platform `cron-enqueue-only`
// conformance suite (`test/conformance.spec.ts`) already pins that its body only enqueues; this pins WHAT it enqueues — one
// `kg.export` job in sweep mode under its own subject type — and that a render
// in flight never suppresses it.
// =============================================================================

describe('KgExportExpiryTask', () => {
  let task: KgExportExpiryTask;
  let jobs: { enqueue: jest.Mock; findActive: jest.Mock };

  beforeEach(() => {
    jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1', deduplicated: false }),
      findActive: jest.fn().mockResolvedValue([]),
    };
    task = new KgExportExpiryTask(jobs as unknown as KvoxJobsPort);
  });

  it('queues one kg.export sweep job at housekeeping priority', async () => {
    await task.handleCron();
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'kg.export',
      reason: 'backfill',
      priority: 100,
      subjectType: 'kg_export_sweep',
      payload: { mode: 'sweep' },
    });
  });

  it('asks only whether a SWEEP is in flight, so a pending render never suppresses it', async () => {
    jobs.findActive.mockResolvedValue([
      { id: 'render-1', type: 'kg.export', subjectType: 'kg_export', subjectId: 'export-1', payload: {} },
    ]);
    await task.handleCron();
    expect(jobs.findActive).toHaveBeenCalledWith({ types: ['kg.export'] });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips the tick when a sweep is still in flight, and never throws', async () => {
    jobs.findActive.mockResolvedValue([
      { id: 'job-0', type: 'kg.export', subjectType: 'kg_export_sweep', subjectId: null, payload: {} },
    ]);
    await task.handleCron();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    jobs.findActive.mockRejectedValue(new Error('database blip'));
    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
