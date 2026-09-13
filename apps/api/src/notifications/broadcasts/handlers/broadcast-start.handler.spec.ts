// =============================================================================
// Unit tests for the broadcast start handler (issue #323, epic #319)
// =============================================================================
//
// The thing under test is a RACE, so most of what follows is about the shape
// of one statement rather than about arithmetic. The compare-and-swap is what
// makes a fan-out happen exactly once, and its correctness lives entirely in
// the status being in the `WHERE` clause — a fact a mock CAN prove, because
// the assertion is on the query the handler builds, not on what Postgres does
// with it. What a mock cannot prove (that two concurrent swaps really do
// resolve to one winner) is a property of the database's row locking, not of
// this file.
//
// Mocking style follows `jobs/handlers/job-history-purge.handler.spec.ts`:
// hand-built jest mocks cast through `unknown`, no Nest testing module. The
// handler takes three collaborators and touches four query methods; standing
// up DI to reach them would test Nest.
// =============================================================================

import { Job } from '@prisma/client';

import { BroadcastStartHandler, BROADCAST_START_TYPE } from './broadcast-start.handler';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import type { JobsService } from '../../../jobs/jobs.service';
import type { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { PrismaService } from '../../../prisma/prisma.service';
import { BROADCAST_SUBJECT_TYPE } from '../broadcast-audience';
import { BROADCAST_CHUNK_TYPE } from './broadcast-chunk.handler';

const BROADCAST_ID = 'bcast-1';

const startJob = {
  id: 'job-1',
  type: BROADCAST_START_TYPE,
  subjectType: BROADCAST_SUBJECT_TYPE,
  subjectId: BROADCAST_ID,
} as Job;

function makeHandler(options: {
  broadcast?: { id: string; status: string } | null;
  claimedCount?: number;
  userCount?: number;
} = {}) {
  const findUnique = jest.fn().mockResolvedValue(
    options.broadcast === undefined
      ? { id: BROADCAST_ID, status: 'scheduled' }
      : options.broadcast
  );
  const updateMany = jest.fn().mockResolvedValue({ count: options.claimedCount ?? 1 });
  const update = jest.fn().mockResolvedValue({});
  const count = jest.fn().mockResolvedValue(options.userCount ?? 42);

  const prisma = {
    notificationBroadcast: { findUnique, updateMany, update },
    user: { count },
  } as unknown as PrismaService;

  const enqueue = jest.fn().mockResolvedValue({ id: 'job-2' });
  const jobs = { enqueue } as unknown as JobsService;

  const register = jest.fn();
  const registry = { register } as unknown as JobHandlerRegistry;

  return {
    handler: new BroadcastStartHandler(prisma, jobs, registry),
    findUnique,
    updateMany,
    update,
    count,
    enqueue,
    register,
  };
}

describe('BroadcastStartHandler', () => {
  it('self-registers under a permanent, dotted type', () => {
    const { handler, register } = makeHandler();

    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('admin.broadcast.start');
  });

  it('is server-only — it declares neither node-eligibility member', () => {
    // Both members or neither; exactly one collapses to server-only anyway.
    // A worker node has no database access and no mail credentials, so there
    // is nothing here for one to compute. Typed as the interface because the
    // members are optional on it — their absence is what
    // `JobHandlerRegistry.serverOnlyTypes()` reads.
    const handler: JobHandler = makeHandler().handler;

    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
  });

  it('is a no-op when the job carries no subject', async () => {
    const { handler, findUnique } = makeHandler();

    await handler.process({ ...startJob, subjectId: null } as Job);

    expect(findUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the broadcast has been deleted', async () => {
    // Deleting a broadcast does NOT delete its scheduled `jobs` row — that
    // races with a claim. The row runs and finds nothing, which must return
    // normally rather than failing an attempt budget on a state the system
    // deliberately allows.
    const { handler, updateMany, count, enqueue } = makeHandler({ broadcast: null });

    await expect(handler.process(startJob)).resolves.toBeUndefined();

    expect(updateMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('claims with a compare-and-swap that puts the status in the WHERE', async () => {
    // THE CENTRAL ASSERTION OF THIS FILE. `status: 'scheduled'` in the `where`
    // is what makes the claim atomic against a concurrent cancel; a
    // read-then-write would leave a window in which a cancelled announcement
    // goes out to everybody.
    const { handler, updateMany } = makeHandler();

    await handler.process(startJob);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: BROADCAST_ID, status: 'scheduled' },
      data: {
        status: 'sending',
        startedAt: expect.any(Date),
        audienceCutoff: expect.any(Date),
      },
    });
  });

  it('stamps startedAt and audienceCutoff from a single instant', async () => {
    const { handler, updateMany } = makeHandler();

    await handler.process(startJob);

    const { data } = updateMany.mock.calls[0][0];

    expect(data.startedAt.getTime()).toBe(data.audienceCutoff.getTime());
  });

  it('counts the audience against the cutoff it just stamped', async () => {
    // The count and the chunk paging MUST use the same predicate — see
    // `broadcast-audience.ts`. Counting against a different one is what makes
    // a progress bar lie.
    const { handler, updateMany, count, update } = makeHandler({ userCount: 137 });

    await handler.process(startJob);

    const cutoff = updateMany.mock.calls[0][0].data.audienceCutoff;

    expect(count).toHaveBeenCalledWith({
      where: { isActive: true, createdAt: { lte: cutoff } },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: BROADCAST_ID },
      data: { recipientsTargeted: 137 },
    });
  });

  it('enqueues the first chunk with skipDedup, the broadcast subject and backfill', async () => {
    const { handler, enqueue } = makeHandler();

    await handler.process(startJob);

    expect(enqueue).toHaveBeenCalledWith({
      type: BROADCAST_CHUNK_TYPE,
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: BROADCAST_ID,
      skipDedup: true,
    });
  });

  describe('when the compare-and-swap claims nothing', () => {
    // Every status other than `scheduled` lands here: a cancel that won the
    // race, a fan-out already in progress, a broadcast that has finished, and
    // — the case an operator can actually cause — a manual rerun of a
    // succeeded start job from the admin Jobs dashboard.
    it('re-stamps nothing, counts nothing and enqueues nothing', async () => {
      const { handler, count, update, enqueue } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'sending' },
        claimedCount: 0,
      });

      await expect(handler.process(startJob)).resolves.toBeUndefined();

      // The point of the CAS: a replay cannot move `audienceCutoff`, which is
      // the definition of who the broadcast was for, and cannot start a second
      // chunk chain over a population the first chain is already walking.
      expect(count).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('sends nothing for a broadcast an admin cancelled before it fired', async () => {
      const { handler, enqueue } = makeHandler({
        broadcast: { id: BROADCAST_ID, status: 'canceled' },
        claimedCount: 0,
      });

      await handler.process(startJob);

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it('throws to fail rather than swallowing a database error', async () => {
    // The queue turns a rejection into `Job.lastError` plus a retry. A
    // `try/catch` here would report `succeeded` for a broadcast that never
    // started, which is the failure mode that leaves no evidence anywhere.
    const { handler, updateMany } = makeHandler();

    updateMany.mockRejectedValue(new Error('connection terminated'));

    await expect(handler.process(startJob)).rejects.toThrow('connection terminated');
  });

  it('throws when the first chunk cannot be queued', async () => {
    // A claimed broadcast with no chunk chain is a broadcast stuck in
    // `sending` forever. It must be a visible, retryable failure.
    const { handler, enqueue } = makeHandler();

    enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(handler.process(startJob)).rejects.toThrow('queue unavailable');
  });
});
