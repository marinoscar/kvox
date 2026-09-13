// =============================================================================
// Unit tests for the broadcast chunk handler (issue #323, epic #319)
// =============================================================================
//
// Three of the properties tested here fail SILENTLY in production, which is
// why each gets its own named test rather than being implied by a happy path:
//
//   1. `skipDedup: true` on the successor enqueue. Without it, `enqueue`
//      returns the still-`running` job that called it, the broadcast stops
//      after one page, and every job row reads `succeeded` with no error
//      anywhere. Nothing else in this suite would notice.
//   2. `notifyNow`, not `notify`. `notify` returns before anything is sent, so
//      a chunk using it reports success for work a restart moments later would
//      lose — again with no error and no record of who was missed.
//   3. Resuming from the PERSISTED cursor. The at-least-once contract makes a
//      re-run ordinary; the test below crashes a chunk and re-runs it to prove
//      the cursor, not a loop variable, is what decides where a retry starts.
//
// The store is faked STATEFULLY rather than with per-call `mockResolvedValue`s
// for exactly test (3): a re-run has to read back what the previous run wrote,
// and a stack of canned responses cannot express that without encoding the
// answer the test is trying to check. Everything else is the mocking style of
// `jobs/handlers/job-history-purge.handler.spec.ts`.
// =============================================================================

import { Job } from '@prisma/client';

import { BroadcastChunkHandler, BROADCAST_CHUNK_TYPE } from './broadcast-chunk.handler';
import type { ConfigService } from '@nestjs/config';
import type { JobHandler } from '../../../jobs/job-handler.interface';
import type { JobsService } from '../../../jobs/jobs.service';
import type { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import type { NotificationsService } from '../../notifications.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { BROADCAST_CHUNK_SIZE, BROADCAST_SUBJECT_TYPE } from '../broadcast-audience';

const BROADCAST_ID = 'bcast-1';
const CUTOFF = new Date('2026-03-01T12:00:00.000Z');

const chunkJob = {
  id: 'job-1',
  type: BROADCAST_CHUNK_TYPE,
  subjectType: BROADCAST_SUBJECT_TYPE,
  subjectId: BROADCAST_ID,
} as Job;

/** Ascending, zero-padded ids, so keyset paging over them is lexicographic. */
function userIds(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, index) => `u-${String(from + index).padStart(4, '0')}`);
}

interface BroadcastState {
  id: string;
  title: string;
  body: string;
  link: string | null;
  ctaLabel: string | null;
  eventKey: string;
  channels: string[];
  status: string;
  audienceCutoff: Date | null;
  cursorUserId: string | null;
  recipientsDispatched: number;
  finishedAt: Date | null;
}

function makeHandler(
  options: {
    broadcast?: Partial<BroadcastState> | null;
    users?: string[];
    appUrl?: string;
    /** Called before each dispatch, so a test can cancel the broadcast mid-page. */
    onNotify?: (state: BroadcastState, callIndex: number) => void;
  } = {}
) {
  const state: BroadcastState = {
    id: BROADCAST_ID,
    title: 'Scheduled maintenance',
    body: 'We will be offline on Sunday.',
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['email', 'browser'],
    status: 'sending',
    audienceCutoff: CUTOFF,
    cursorUserId: null,
    recipientsDispatched: 0,
    finishedAt: null,
    ...(options.broadcast ?? {}),
  };

  const exists = options.broadcast !== null;
  const allUsers = options.users ?? userIds(3);

  const findUnique = jest.fn(async () => (exists ? { ...state } : null));

  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (!exists || (where.status && where.status !== state.status)) {
      return { count: 0 };
    }

    Object.assign(state, data);

    return { count: 1 };
  });

  const update = jest.fn(async ({ data }: any) => {
    for (const [key, value] of Object.entries<any>(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        (state as any)[key] = ((state as any)[key] ?? 0) + value.increment;
      } else {
        (state as any)[key] = value;
      }
    }

    return { ...state };
  });

  const findMany = jest.fn(async ({ where, take }: any) => {
    const after = where.id?.gt;

    return allUsers
      .filter((id) => (after ? id > after : true))
      .slice(0, take)
      .map((id) => ({ id }));
  });

  const prisma = {
    notificationBroadcast: { findUnique, updateMany, update },
    user: { findMany },
  } as unknown as PrismaService;

  let notifyCalls = 0;
  // `...unknown[]` so the recorded calls stay indexable — the assertions below
  // read the event key, the recipient, the payload and the options by position.
  const notifyNow = jest.fn(async (..._args: unknown[]) => {
    options.onNotify?.(state, notifyCalls);
    notifyCalls += 1;
  });
  const notify = jest.fn();
  const notifications = { notifyNow, notify } as unknown as NotificationsService;

  const enqueue = jest.fn().mockResolvedValue({ id: 'job-next' });
  const jobs = { enqueue } as unknown as JobsService;

  const get = jest.fn((key: string) => (key === 'appUrl' ? options.appUrl : undefined));
  const config = { get } as unknown as ConfigService;

  const register = jest.fn();
  const registry = { register } as unknown as JobHandlerRegistry;

  return {
    handler: new BroadcastChunkHandler(prisma, notifications, jobs, config, registry),
    state,
    findUnique,
    updateMany,
    update,
    findMany,
    notifyNow,
    notify,
    enqueue,
    register,
  };
}

/** The user ids `notifyNow` was actually called for, in call order. */
const dispatchedTo = (notifyNow: jest.Mock): string[] =>
  notifyNow.mock.calls.map((call) => call[1] as string);

describe('BroadcastChunkHandler', () => {
  it('self-registers under a permanent, dotted type', () => {
    const { handler, register } = makeHandler();

    handler.onModuleInit();

    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('admin.broadcast.chunk');
  });

  it('is server-only — it declares neither node-eligibility member', () => {
    // Typed as the interface, because the two members are OPTIONAL on it: the
    // absence of both is what `JobHandlerRegistry.serverOnlyTypes()` derives
    // server-only from, so it is a fact about the contract rather than a
    // property this class happens not to have.
    const handler: JobHandler = makeHandler().handler;

    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
  });

  describe('the status guard', () => {
    it('sends nothing when the broadcast has been cancelled', async () => {
      // How cancel is honoured. #324 flips the status and deliberately leaves
      // the queued chunk rows alone — deleting one races with a claim — so
      // every later chunk arrives, finds `canceled`, and no-ops.
      const { handler, findMany, notifyNow } = makeHandler({
        broadcast: { status: 'canceled' },
      });

      await expect(handler.process(chunkJob)).resolves.toBeUndefined();

      expect(findMany).not.toHaveBeenCalled();
      expect(notifyNow).not.toHaveBeenCalled();
    });

    it('sends nothing for a replayed chunk of a finished broadcast', async () => {
      // A lease that expired mid-chunk can hand the same row to another
      // worker after the fan-out has already completed.
      const { handler, notifyNow } = makeHandler({ broadcast: { status: 'sent' } });

      await handler.process(chunkJob);

      expect(notifyNow).not.toHaveBeenCalled();
    });

    it('sends nothing when the broadcast has been deleted', async () => {
      const { handler, notifyNow } = makeHandler({ broadcast: null });

      await expect(handler.process(chunkJob)).resolves.toBeUndefined();

      expect(notifyNow).not.toHaveBeenCalled();
    });

    it('refuses to page an audience with no cutoff', async () => {
      // Structurally impossible (the start handler's CAS writes the cutoff in
      // the same statement that sets `sending`), and a no-op rather than an
      // unfrozen page that would silently widen the audience.
      const { handler, findMany } = makeHandler({ broadcast: { audienceCutoff: null } });

      await handler.process(chunkJob);

      expect(findMany).not.toHaveBeenCalled();
    });

    it('is a no-op when the job carries no subject', async () => {
      const { handler, findUnique } = makeHandler();

      await handler.process({ ...chunkJob, subjectId: null } as Job);

      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('paging', () => {
    it('pages by ascending id, frozen at the cutoff, skipping inactive users', async () => {
      const { handler, findMany } = makeHandler();

      await handler.process(chunkJob);

      expect(findMany).toHaveBeenCalledWith({
        where: { isActive: true, createdAt: { lte: CUTOFF } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BROADCAST_CHUNK_SIZE,
      });
    });

    it('applies the stored cursor as a keyset predicate', async () => {
      // `id > cursor`, never `skip`. An offset shifts when a row ahead of it
      // is deleted, which silently skips a recipient.
      const { handler, findMany } = makeHandler({
        broadcast: { cursorUserId: 'u-0001' },
        users: userIds(5),
      });

      await handler.process(chunkJob);

      expect(findMany.mock.calls[0][0].where).toEqual({
        isActive: true,
        createdAt: { lte: CUTOFF },
        id: { gt: 'u-0001' },
      });
    });
  });

  describe('dispatch', () => {
    it('uses notifyNow — never the detached notify — with the stored channels', async () => {
      const { handler, notifyNow, notify } = makeHandler({ users: userIds(3) });

      await handler.process(chunkJob);

      expect(notify).not.toHaveBeenCalled();
      expect(dispatchedTo(notifyNow)).toEqual(['u-0000', 'u-0001', 'u-0002']);

      for (const call of notifyNow.mock.calls) {
        expect(call[0]).toBe('admin.broadcast');
        // Narrowing only — the option is intersected after the policy and
        // preference filters, so it can only remove channels.
        expect(call[3]).toEqual({ channels: ['email', 'browser'] });
      }
    });

    it('builds the payload the broadcast templates consume', async () => {
      const { handler, notifyNow } = makeHandler({
        broadcast: { link: '/settings', ctaLabel: 'Open settings' },
        appUrl: 'http://localhost:3535/',
        users: userIds(1),
      });

      await handler.process(chunkJob);

      expect(notifyNow.mock.calls[0][2]).toEqual({
        title: 'Scheduled maintenance',
        body: 'We will be offline on Sunday.',
        link: '/settings',
        ctaLabel: 'Open settings',
        // ABSOLUTE, and with the configured trailing slash stripped exactly as
        // `users.service.ts`'s `appUrl()` does — `safeUrl` in the email layout
        // rejects anything relative, and `//settings` is a protocol-relative
        // URL, not a path.
        ctaUrl: 'http://localhost:3535/settings',
        critical: false,
      });
    });

    it('marks a critical broadcast from its event key alone', async () => {
      const { handler, notifyNow } = makeHandler({
        broadcast: { eventKey: 'admin.broadcast_critical' },
        users: userIds(1),
      });

      await handler.process(chunkJob);

      expect(notifyNow.mock.calls[0][0]).toBe('admin.broadcast_critical');
      expect(notifyNow.mock.calls[0][2]).toMatchObject({ critical: true });
    });

    it('omits the CTA url when there is no link or no configured appUrl', async () => {
      const withoutAppUrl = makeHandler({
        broadcast: { link: '/settings' },
        users: userIds(1),
      });

      await withoutAppUrl.handler.process(chunkJob);

      expect(withoutAppUrl.notifyNow.mock.calls[0][2]).not.toHaveProperty('ctaUrl');

      const withoutLink = makeHandler({ appUrl: 'http://localhost:3535', users: userIds(1) });

      await withoutLink.handler.process(chunkJob);

      expect(withoutLink.notifyNow.mock.calls[0][2]).not.toHaveProperty('ctaUrl');
      expect(withoutLink.notifyNow.mock.calls[0][2]).not.toHaveProperty('link');
    });
  });

  describe('progress', () => {
    it('advances the cursor and the counter in one update, after the sends', async () => {
      // ONE write, because a cursor ahead of its counter reports progress that
      // did not happen and a counter ahead of its cursor double-counts. AFTER,
      // because committing first would turn a crash into a silent drop.
      const { handler, update, notifyNow } = makeHandler({ users: userIds(3) });

      await handler.process(chunkJob);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID },
        data: {
          cursorUserId: 'u-0002',
          recipientsDispatched: { increment: 3 },
        },
      });
      expect(notifyNow).toHaveBeenCalledTimes(3);
    });

    it('writes no progress at all for an empty page', async () => {
      const { handler, update, notifyNow, state } = makeHandler({ users: [] });

      await handler.process(chunkJob);

      expect(notifyNow).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(state.status).toBe('sent');
    });
  });

  describe('the chain', () => {
    it('enqueues the next chunk ONLY on a full page, and with skipDedup', async () => {
      // ⚠ `skipDedup: true` IS LOAD-BEARING AND FAILS SILENTLY. Chunk n
      // enqueues chunk n+1 from inside its own `process()` while n is still
      // `running`, so with dedup on `buildDedupKey` matches the in-flight job
      // and `enqueue` hands back chunk n itself: the broadcast stops after one
      // page with every job row `succeeded` and no error anywhere.
      const { handler, enqueue } = makeHandler({ users: userIds(BROADCAST_CHUNK_SIZE) });

      await handler.process(chunkJob);

      expect(enqueue).toHaveBeenCalledWith({
        type: BROADCAST_CHUNK_TYPE,
        reason: 'backfill',
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: BROADCAST_ID,
        skipDedup: true,
      });
    });

    it('marks the broadcast sent on a short page instead of queueing another', async () => {
      const { handler, enqueue, updateMany, state } = makeHandler({ users: userIds(3) });

      await handler.process(chunkJob);

      expect(enqueue).not.toHaveBeenCalled();
      // Conditional on `sending`, so a chunk racing a cancel cannot overwrite
      // `canceled` with `sent`.
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID, status: 'sending' },
        data: { status: 'sent', finishedAt: expect.any(Date) },
      });
      expect(state.status).toBe('sent');
      expect(state.finishedAt).toBeInstanceOf(Date);
    });

    it('leaves the status alone when it changed before the finishing write', async () => {
      const { handler, updateMany, state } = makeHandler({
        users: userIds(3),
        onNotify: (current, index) => {
          // Cancelled after the last send of a short page, so the page
          // completes and the terminal write is the thing that races.
          if (index === 2) {
            current.status = 'canceled';
          }
        },
      });

      await handler.process(chunkJob);

      // The finishing write was attempted and matched nothing, because its
      // `where` still demands `sending`. An unconditional `update` here would
      // have reported a completed send for a broadcast an admin stopped.
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID, status: 'sending' },
        data: { status: 'sent', finishedAt: expect.any(Date) },
      });
      expect(state.status).toBe('canceled');
      expect(state.finishedAt).toBeNull();
    });
  });

  describe('cancellation mid-page', () => {
    it('stops without waiting out the page, commits what it sent, queues nothing', async () => {
      // The re-read runs every 25 recipients, so an admin waits for at most
      // that many sends rather than a whole 200-recipient page.
      const { handler, notifyNow, update, enqueue } = makeHandler({
        users: userIds(BROADCAST_CHUNK_SIZE),
        onNotify: (current, index) => {
          if (index === 24) {
            current.status = 'canceled';
          }
        },
      });

      await handler.process(chunkJob);

      expect(notifyNow).toHaveBeenCalledTimes(25);
      // The counter must still say what actually went out — that is the number
      // an operator reaches for when asking how far it got before they stopped
      // it.
      expect(update).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID },
        data: { cursorUserId: 'u-0024', recipientsDispatched: { increment: 25 } },
      });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('idempotence under at-least-once delivery', () => {
    it('resumes from the persisted cursor after a crash, without replaying earlier pages', async () => {
      // THE PROPERTY THE WHOLE ORDERING ARGUMENT EXISTS FOR. Page 1 commits
      // its cursor; the chunk that would have sent page 2 dies before its own
      // commit; the retry starts from the committed cursor, so page 1 is not
      // re-sent.
      const all = userIds(BROADCAST_CHUNK_SIZE + 50);
      const context = makeHandler({ users: all });

      // --- run 1: a full page, committed, successor queued ---
      await context.handler.process(chunkJob);

      expect(context.state.cursorUserId).toBe(all[BROADCAST_CHUNK_SIZE - 1]);
      expect(context.state.recipientsDispatched).toBe(BROADCAST_CHUNK_SIZE);
      expect(context.enqueue).toHaveBeenCalledTimes(1);

      // --- run 2: the successor crashes on its progress write ---
      context.notifyNow.mockClear();
      context.update.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(context.handler.process(chunkJob)).rejects.toThrow('connection terminated');

      // The cursor did NOT move. This is the deliberate choice of duplicate
      // over drop: the retry re-sends at most one page, rather than silently
      // skipping one.
      expect(context.state.cursorUserId).toBe(all[BROADCAST_CHUNK_SIZE - 1]);

      // --- run 3: the queue's retry, from the persisted cursor ---
      context.notifyNow.mockClear();

      await context.handler.process(chunkJob);

      const resumed = dispatchedTo(context.notifyNow);

      expect(resumed).toEqual(all.slice(BROADCAST_CHUNK_SIZE));
      // Nobody from page 1 is touched again.
      expect(resumed.some((id) => all.indexOf(id) < BROADCAST_CHUNK_SIZE)).toBe(false);
      expect(context.state.recipientsDispatched).toBe(all.length);
      expect(context.state.status).toBe('sent');
    });
  });

  describe('throw to fail', () => {
    it('propagates a failure to read the page', async () => {
      const { handler, findMany } = makeHandler();

      findMany.mockRejectedValue(new Error('read timeout'));

      await expect(handler.process(chunkJob)).rejects.toThrow('read timeout');
    });

    it('propagates a failure to commit progress rather than swallowing it', async () => {
      // A swallowed error here is a `succeeded` job for a broadcast whose
      // cursor never moved — the same silent stall as a missing `skipDedup`,
      // reached a different way.
      const { handler, update } = makeHandler({ users: userIds(3) });

      update.mockRejectedValue(new Error('deadlock detected'));

      await expect(handler.process(chunkJob)).rejects.toThrow('deadlock detected');
    });

    it('propagates a failure to queue the successor', async () => {
      const { handler, enqueue } = makeHandler({ users: userIds(BROADCAST_CHUNK_SIZE) });

      enqueue.mockRejectedValue(new Error('queue unavailable'));

      await expect(handler.process(chunkJob)).rejects.toThrow('queue unavailable');
    });
  });
});
