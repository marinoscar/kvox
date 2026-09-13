// =============================================================================
// Unit tests for the lease reaper task (issue #263, epic #254)
// =============================================================================
//
// The acceptance criterion this file exists for is a NEGATIVE one: the reaper
// runs under `JOBS_WORKER_MODE=off` and stops only for
// `JOBS_REAPER_ENABLED=false`. It is the easiest thing in the epic to break by
// accident (adding a worker-mode guard here looks like tidying up) and the
// hardest to notice, because the deployment it breaks — an API acting as a
// pure control plane in front of a node fleet — is precisely the one nobody
// runs locally.
// =============================================================================

import { ConfigService } from '@nestjs/config';

import { JobStuckResetTask } from './job-stuck-reset.task';
import type { JobStuckService } from '../job-stuck.service';

function makeTask(config: Record<string, unknown>, resetStuck = jest.fn()) {
  const stuck = { resetStuck } as unknown as JobStuckService;
  const configService = {
    get: jest.fn((key: string) => config[key]),
  } as unknown as ConfigService;

  return { task: new JobStuckResetTask(stuck, configService), resetStuck };
}

describe('JobStuckResetTask', () => {
  it('reaps even when this process claims no jobs at all', async () => {
    // THE CONTROL-PLANE CASE. `JOBS_WORKER_MODE=off` says "this process
    // executes no jobs"; it does not say "nothing in this deployment does".
    // The leases that expire here belong to remote nodes, which have no
    // database access and cannot reap themselves — so if this process
    // declined, nobody would.
    const { task, resetStuck } = makeTask({ 'jobs.workerMode': 'off' });
    resetStuck.mockResolvedValue({ reset: 2, failed: 1 });

    await task.handleCron();

    expect(resetStuck).toHaveBeenCalledTimes(1);
  });

  it('reaps in every worker mode', async () => {
    for (const workerMode of ['all', 'system', 'off', 'nonsense']) {
      const { task, resetStuck } = makeTask({ 'jobs.workerMode': workerMode });
      resetStuck.mockResolvedValue({ reset: 0, failed: 0 });

      await task.handleCron();

      expect(resetStuck).toHaveBeenCalledTimes(1);
    }
  });

  it('stops only for jobs.reaperEnabled === false', async () => {
    const { task, resetStuck } = makeTask({ 'jobs.reaperEnabled': false });

    await task.handleCron();

    expect(resetStuck).not.toHaveBeenCalled();
  });

  it('reaps when the switch is unset, so a missing key fails open', async () => {
    const { task, resetStuck } = makeTask({});
    resetStuck.mockResolvedValue({ reset: 0, failed: 0 });

    await task.handleCron();

    expect(resetStuck).toHaveBeenCalledTimes(1);
  });

  it('sweeps with the configured threshold, passing no override', async () => {
    const { task, resetStuck } = makeTask({ 'jobs.reaperEnabled': true });
    resetStuck.mockResolvedValue({ reset: 0, failed: 0 });

    await task.handleCron();

    expect(resetStuck).toHaveBeenCalledWith();
  });

  it('swallows a failed sweep rather than rejecting out of the cron handler', async () => {
    // A throw out of a `@Cron` method is an unhandled rejection, and the next
    // tick would have run anyway.
    const { task, resetStuck } = makeTask({});
    resetStuck.mockRejectedValue(new Error('connection reset'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
