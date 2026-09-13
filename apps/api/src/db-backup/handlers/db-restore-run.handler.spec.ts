// =============================================================================
// `db.restore.run` is server-only, permanently (issue #353, epic #345)
// =============================================================================
//
// ⚠ THIS FILE EXISTS FOR ONE ASSERTION, AND IT IS NOT A FORMALITY. Node
// eligibility in this queue is DERIVED — a handler carrying both
// `nodeResultSchema` and `persistNodeResult` is claimable by a remote worker,
// one carrying neither is not — so making this type claimable does not require
// anybody to decide to; it requires only that somebody add two members to this
// class for a plausible-sounding reason. What they would be handing a remote
// machine is a job that renames the live database, terminates every pooled
// connection, needs `CREATEDB`, runs an admin connection on the `postgres`
// maintenance database, and ends by exiting the process.
//
// So the derivation is asserted from both ends: the members are absent, and
// `serverOnlyTypes()` actually contains the type. The second is what a
// `JOBS_WORKER_MODE=system` API server reads to decide what IT must run, so the
// two together also prove the type is not stranded — no node may take it, and
// the server still will.
// =============================================================================

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { DB_RESTORE_RUN_TYPE, type DatabaseRestoreService } from '../database-restore.service';
import {
  DatabaseRestoreRunHandler,
  RESTORE_JOB_MAX_RUNTIME_MS,
} from './db-restore-run.handler';

function makeHandler() {
  const registry = new JobHandlerRegistry();
  const executeRestoreJob = jest.fn(async () => undefined);
  const restore = { executeRestoreJob } as unknown as DatabaseRestoreService;
  const handler = new DatabaseRestoreRunHandler(registry, restore);

  handler.onModuleInit();

  return { registry, handler, executeRestoreJob };
}

describe('DatabaseRestoreRunHandler', () => {
  it('registers itself under db.restore.run', () => {
    const { registry, handler } = makeHandler();

    expect(handler.type).toBe(DB_RESTORE_RUN_TYPE);
    expect(registry.get(DB_RESTORE_RUN_TYPE)).toBe(handler);
  });

  it('is SERVER-ONLY by derivation: neither node member is present', () => {
    const { handler } = makeHandler();

    // Read through the interface rather than off the class, because the point
    // is what the REGISTRY can see: these two members are the whole mechanism,
    // and TypeScript would refuse the property access on a class that (rightly)
    // does not declare them.
    const asHandler: JobHandler = handler;

    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it('appears in serverOnlyTypes(), which is what the system worker mode reads', () => {
    const { registry } = makeHandler();

    expect(registry.serverOnlyTypes()).toContain(DB_RESTORE_RUN_TYPE);
  });

  it('declares maxAttempts: 1 — a requeued restore would replay a successful one', () => {
    // ⚠ THE MOST IMPORTANT NUMBER IN THE HANDLER. `attempts` is charged at
    // CLAIM time, so a restore whose executor dies has already spent its only
    // attempt: the reaper permanently fails the row instead of requeueing it.
    const { handler } = makeHandler();

    expect(handler.profile).toEqual({
      maxRuntimeMs: RESTORE_JOB_MAX_RUNTIME_MS,
      maxAttempts: 1,
    });
  });

  it('delegates the whole restore to the service', async () => {
    const { handler, executeRestoreJob } = makeHandler();
    const job = { id: 'job-1' } as never;

    await handler.process(job);

    expect(executeRestoreJob).toHaveBeenCalledWith(job);
  });

  it('lets a failed restore throw, so the queue records it', async () => {
    const { handler, executeRestoreJob } = makeHandler();
    executeRestoreJob.mockRejectedValue(new Error('pg_restore exited 1') as never);

    await expect(handler.process({ id: 'job-1' } as never)).rejects.toThrow('pg_restore exited 1');
  });
});
