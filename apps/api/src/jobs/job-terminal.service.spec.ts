// =============================================================================
// Unit tests for the terminal state machine (issue #261, epic #254)
// =============================================================================
//
// THE HIGHEST-LEVERAGE CORRECTNESS SURFACE IN THE QUEUE, and deliberately
// tested here rather than against a database.
//
// Everything this file asserts is a DECISION — which branch, which counter,
// which exact `scheduled_for`, whether an event fired — and every one of
// those decisions is made in this process before any SQL is generated. A
// database test would confirm the row it was told to write, which is the one
// thing already guaranteed; what it could not do is make the write fail on
// cue (the `safeTerminalUpdate` swallow), pin the clock so a jittered
// `scheduled_for` is an exact timestamp rather than a range, or drive eleven
// consecutive rate-limit deferrals without eleven real waits. So: a fake
// clock, a pinned RNG, and a mocked `prisma.job.update` whose recorded
// payload IS the assertion.
//
// The one thing genuinely shared with the outside world — the throttle gate —
// is exercised with the REAL `ProviderThrottleService` in the sibling-back-off
// block, because "a node-reported 429 backs off jobs running on this server"
// is a claim about two components agreeing and a mock would only prove the
// mock.
// =============================================================================

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Prisma } from '@prisma/client';

import { JobClock } from './job-clock';
import { JobSettledEvent, JOB_SETTLED_EVENT } from './events/job-settled.event';
import { resetJobProfileWarnings } from './job-execution-profile';
import { JobHandlerRegistry } from './job-handler.registry';
import { JobTerminalService } from './job-terminal.service';
import { ProviderThrottleService } from './provider-throttle.service';
import { RateLimitError } from './rate-limit.error';
import type { PrismaService } from '../prisma/prisma.service';

/** Pinned "now". Every expected timestamp below is derived from it. */
const NOW = 1_700_000_000_000;

/**
 * The shipped defaults, stated here rather than read from
 * `configuration.ts` — a test that reads the same source as the code proves
 * only that they match each other.
 */
const CONFIG_VALUES: Record<string, number> = {
  'jobs.maxAttempts': 3,
  'jobs.retryBaseMs': 2_000,
  'jobs.retryMaxMs': 60_000,
  'jobs.rateLimitMaxHits': 10,
  'jobs.rateLimitBaseMs': 30_000,
  'jobs.rateLimitMaxMs': 900_000,
};

/**
 * RNG pinned at its floor, so every delay is exactly half its exponential
 * term: retry attempt 1 → 1_000ms, rate-limit hit 1 → 15_000ms.
 */
const RAND_FLOOR = () => 0;

function fakeClock(start = NOW) {
  let current = start;
  const slept: number[] = [];

  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
  } satisfies JobClock & { slept: number[] };
}

/** A claimed, currently-running job. `attempts: 1` is the claim's own charge. */
function runningJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'vision.describe',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'running',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(NOW - 60_000),
    startedAt: new Date(NOW - 1_000),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: new Date(NOW + 30_000),
    executor: 'server',
    ...overrides,
  } as Job;
}

describe('JobTerminalService', () => {
  let clock: ReturnType<typeof fakeClock>;
  let update: jest.Mock;
  let emit: jest.Mock;
  let throttle: jest.Mocked<Pick<ProviderThrottleService, 'trip' | 'recordSuccess'>>;
  let registry: JobHandlerRegistry;
  let service: JobTerminalService;

  /** The `data` payload of the Nth `prisma.job.update` call. */
  const written = (call = 0): Prisma.JobUpdateInput => update.mock.calls[call][0].data;

  beforeEach(() => {
    clock = fakeClock();

    // Echo the merge back, so the row the settled event carries is the row
    // that was written.
    update = jest.fn(({ where, data }) =>
      Promise.resolve({ ...runningJob({ id: where.id }), ...data })
    );

    emit = jest.fn();
    throttle = { trip: jest.fn(), recordSuccess: jest.fn() };
    // EMPTY BY DEFAULT, which is the shape every pre-#346 case assumes: no
    // handler registered means no profile, means the deployment-wide
    // `jobs.maxAttempts` — exactly what this service read before profiles
    // existed.
    registry = new JobHandlerRegistry();
    resetJobProfileWarnings();

    service = new JobTerminalService(
      { job: { update } } as unknown as PrismaService,
      { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
      throttle as unknown as ProviderThrottleService,
      { emit } as unknown as EventEmitter2,
      registry,
      clock,
      RAND_FLOOR
    );
  });

  // ===========================================================================
  // Success
  // ===========================================================================
  describe('completeSucceeded', () => {
    it('writes the terminal row and releases the claim and the lease', async () => {
      await expect(service.completeSucceeded(runningJob())).resolves.toBe('succeeded');

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].where).toEqual({ id: 'job-1' });
      expect(written()).toMatchObject({
        status: 'succeeded',
        finishedAt: new Date(NOW),
        scheduledFor: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
      });
    });

    it('does NOT clear `executor` — which side ran it is worth keeping', async () => {
      // Succeeded is terminal, so there is no stale ownership to null out,
      // and the answer to "did this run on a node?" is worth keeping.
      await service.completeSucceeded(runningJob({ executor: 'node' }));

      expect(written()).not.toHaveProperty('executor');
    });

    it('leaves `lastError` alone, so a job that succeeded on retry still explains itself', async () => {
      await service.completeSucceeded(runningJob({ attempts: 3, lastError: 'attempt 2 blew up' }));

      expect(written()).not.toHaveProperty('lastError');
    });

    it('tells the throttle gate BEFORE the write, so waiting siblings are released sooner', async () => {
      const order: string[] = [];

      throttle.recordSuccess.mockImplementation(() => {
        order.push('recordSuccess');
      });
      update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve(runningJob({ status: 'succeeded' }));
      });

      await service.completeSucceeded(runningJob());

      expect(order).toEqual(['recordSuccess', 'update']);
      expect(throttle.recordSuccess).toHaveBeenCalledWith('vision.describe');
    });
  });

  // ===========================================================================
  // Ordinary failure: the attempts budget
  // ===========================================================================
  describe('completeFailed — the ordinary branch', () => {
    it('consumes an attempt and retries while budget remains', async () => {
      // `attempts` is charged at CLAIM time, so a retry simply does not give
      // it back: the row keeps the 1 it was charged, and nothing about
      // `attempts` appears in the write.
      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'))
      ).resolves.toBe('retry-scheduled');

      expect(written()).toMatchObject({
        status: 'pending',
        scheduledFor: new Date(NOW + 1_000), // exp 2_000, rand floor
        lastError: 'kaboom',
        claimedByNodeId: null,
        leaseExpiresAt: null,
        finishedAt: null,
      });
      expect(written()).not.toHaveProperty('attempts');
      expect(written()).not.toHaveProperty('rateLimitHits');
    });

    it('backs off further on each subsequent attempt', async () => {
      await service.completeFailed(runningJob({ attempts: 2 }), new Error('again'));

      // exp = 2_000 * 2^1 = 4_000, floored jitter → 2_000.
      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 2_000) });
    });

    it('marks the row `failed` once the budget is spent', async () => {
      await expect(
        service.completeFailed(runningJob({ attempts: 3 }), new Error('final'))
      ).resolves.toBe('failed');

      expect(written()).toMatchObject({
        status: 'failed',
        finishedAt: new Date(NOW),
        lastError: 'final',
        scheduledFor: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
      });
      expect(written()).not.toHaveProperty('executor');
    });

    it('does not trip the throttle gate — this is a bug, not a provider limit', async () => {
      await service.completeFailed(runningJob(), new Error('kaboom'));

      expect(throttle.trip).not.toHaveBeenCalled();
    });

    it('records a readable message for anything that can be thrown', async () => {
      await service.completeFailed(runningJob({ attempts: 3 }), 'a bare string');
      expect(written()).toMatchObject({ lastError: 'a bare string' });

      update.mockClear();
      await service.completeFailed(runningJob({ attempts: 3 }), { code: 'ODD' });
      expect(written()).toMatchObject({ lastError: '{"code":"ODD"}' });

      update.mockClear();
      await service.completeFailed(runningJob({ attempts: 3 }), new Error(''));
      expect(written()).toMatchObject({ lastError: 'Error' });
    });

    it('truncates a giant provider message rather than storing it whole', async () => {
      await service.completeFailed(runningJob({ attempts: 3 }), new Error('x'.repeat(10_000)));

      expect(String(written().lastError)).toHaveLength(2_001); // 2_000 + the ellipsis
    });
  });

  // ===========================================================================
  // Rate limits: the separate budget, and the un-charge
  // ===========================================================================
  // ===========================================================================
  // A caller-declared permanent failure (issue #262's missing-handler path)
  // ===========================================================================
  describe('completeFailed — { permanent: true }', () => {
    it('fails the job on the FIRST attempt, with budget still unspent', async () => {
      // `attempts: 1` of a budget of 3, so the ordinary branch would have
      // retried. "Unrunnable" is not "failed once".
      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('no handler'), {
          permanent: true,
        })
      ).resolves.toBe('failed');

      expect(written()).toMatchObject({
        status: 'failed',
        finishedAt: new Date(NOW),
        lastError: 'no handler',
        scheduledFor: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
      });
    });

    it('never schedules a retry', async () => {
      await service.completeFailed(runningJob({ attempts: 1 }), new Error('no handler'), {
        permanent: true,
      });

      expect(written()).not.toMatchObject({ status: 'pending' });
      expect(written().scheduledFor).toBeNull();
    });

    it('emits the settled event, because the job is genuinely over', async () => {
      await service.completeFailed(runningJob(), new Error('no handler'), { permanent: true });

      expect(emit).toHaveBeenCalledTimes(1);
      expect((emit.mock.calls[0][1] as JobSettledEvent).job.status).toBe('failed');
      expect(emit.mock.calls[0][0]).toBe(JOB_SETTLED_EVENT);
    });

    it('BEATS the rate-limit classification: an unrunnable job is not deferred', async () => {
      // A 429-shaped error on a job the executor already knows can never run.
      // Deferring it for fifteen minutes before failing it anyway would be
      // fifteen minutes spent learning nothing.
      await expect(
        service.completeFailed(runningJob(), new RateLimitError('slow down', 30_000), {
          permanent: true,
        })
      ).resolves.toBe('failed');

      expect(written()).toMatchObject({ status: 'failed' });
      expect(throttle.trip).not.toHaveBeenCalled();
    });

    it('does not change the ordinary path when the flag is absent or false', async () => {
      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('boom'), {
          permanent: false,
        })
      ).resolves.toBe('retry-scheduled');
    });

    it('still reports write-failed if the row cannot be written', async () => {
      update.mockRejectedValue(new Error('connection terminated'));

      await expect(
        service.completeFailed(runningJob(), new Error('no handler'), { permanent: true })
      ).resolves.toBe('write-failed');

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('completeFailed — the rate-limit branch', () => {
    it('defers WITHOUT consuming an attempt, and increments rateLimitHits', async () => {
      const job = runningJob({ attempts: 1, rateLimitHits: 0 });

      await expect(service.completeFailed(job, new RateLimitError('429'))).resolves.toBe(
        'rate-limit-deferred'
      );

      expect(written()).toMatchObject({
        status: 'pending',
        // NET of the claim-time increment: claimed at 1, un-charged to 0.
        attempts: 0,
        rateLimitHits: 1,
        rateLimitedAt: new Date(NOW),
        scheduledFor: new Date(NOW + 15_000), // exp 30_000, rand floor
        claimedByNodeId: null,
        leaseExpiresAt: null,
        finishedAt: null,
      });
    });

    it('writes `attempts` as an ABSOLUTE value, never as a relative decrement', async () => {
      // ⚠ The load-bearing detail. `safeTerminalUpdate` retries, and a
      // `{ decrement: 1 }` applied twice would silently grant the job an
      // extra attempt it never earned.
      await service.completeFailed(runningJob({ attempts: 2 }), new RateLimitError('429'));

      expect(typeof written().attempts).toBe('number');
      expect(written().attempts).toBe(1);
    });

    it('is idempotent under a retried write: applying it twice still lands on the same value', async () => {
      // The property the absolute value buys, asserted directly: the payload
      // does not depend on the row's state at apply time.
      update.mockRejectedValueOnce(new Error('connection reset'));

      await service.completeFailed(runningJob({ attempts: 1 }), new RateLimitError('429'));

      expect(update).toHaveBeenCalledTimes(2);
      expect(written(0)).toEqual(written(1));
      expect(written(1).attempts).toBe(0);
    });

    it('never drives `attempts` negative', async () => {
      await service.completeFailed(runningJob({ attempts: 0 }), new RateLimitError('429'));

      expect(written().attempts).toBe(0);
    });

    it('escalates the deferral with the rate-limit counter, not the attempt counter', async () => {
      await service.completeFailed(
        runningJob({ attempts: 1, rateLimitHits: 2 }),
        new RateLimitError('429')
      );

      // hit 3 → exp = 30_000 * 2^2 = 120_000, floored jitter → 60_000.
      expect(written()).toMatchObject({
        rateLimitHits: 3,
        scheduledFor: new Date(NOW + 60_000),
      });
    });

    it('gives up only once the SEPARATE rate-limit budget is exceeded', async () => {
      // Ten deferrals are still deferrals...
      await expect(
        service.completeFailed(
          runningJob({ attempts: 1, rateLimitHits: 9 }),
          new RateLimitError('429')
        )
      ).resolves.toBe('rate-limit-deferred');

      update.mockClear();

      // ...the eleventh is the give-up.
      await expect(
        service.completeFailed(
          runningJob({ attempts: 1, rateLimitHits: 10 }),
          new RateLimitError('429')
        )
      ).resolves.toBe('failed');

      expect(written()).toMatchObject({
        status: 'failed',
        finishedAt: new Date(NOW),
        rateLimitHits: 11,
        scheduledFor: null,
        claimedByNodeId: null,
        leaseExpiresAt: null,
      });
    });

    it('does not exhaust the attempt budget across many deferrals', async () => {
      // The regression this whole design exists to prevent: a long backfill
      // against a throttling provider must not fail permanently.
      let job = runningJob({ attempts: 1, rateLimitHits: 0 });

      for (let i = 0; i < 8; i += 1) {
        update.mockClear();
        await service.completeFailed(job, new RateLimitError('429'));

        // The next claim charges the attempt back again.
        job = runningJob({
          attempts: (written().attempts as number) + 1,
          rateLimitHits: written().rateLimitHits as number,
        });
      }

      expect(job.attempts).toBe(1);
      expect(job.rateLimitHits).toBe(8);
    });

    it('trips the throttle gate with the same delay it wrote to the row', async () => {
      await service.completeFailed(runningJob(), new RateLimitError('429'));

      expect(throttle.trip).toHaveBeenCalledWith('vision.describe', 15_000);
    });

    it('trips the gate BEFORE the write — sibling slots are calling the provider right now', async () => {
      const order: string[] = [];

      throttle.trip.mockImplementation(() => {
        order.push('trip');
      });
      update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve(runningJob());
      });

      await service.completeFailed(runningJob(), new RateLimitError('429'));

      expect(order).toEqual(['trip', 'update']);
    });
  });

  // ===========================================================================
  // Classification order, and the node's flags
  // ===========================================================================
  describe('classification', () => {
    /** The write a given failure produced, minus the message. */
    async function payloadFor(error: unknown, opts?: { rateLimited?: boolean; retryAfterMs?: number }) {
      update.mockClear();
      throttle.trip.mockClear();

      const outcome = await service.completeFailed(
        runningJob({ attempts: 1, rateLimitHits: 0 }),
        error,
        opts
      );
      const { lastError: _ignored, ...rest } = written() as Record<string, unknown>;

      return { outcome, payload: rest, trips: throttle.trip.mock.calls };
    }

    it('a node-reported flag takes the IDENTICAL path to a thrown RateLimitError', async () => {
      const thrown = await payloadFor(new RateLimitError('429 from the provider'));
      const reported = await payloadFor(new Error('node says 429'), { rateLimited: true });

      expect(reported.outcome).toBe(thrown.outcome);
      expect(reported.payload).toEqual(thrown.payload);
      // Including the gate: a node's 429 backs off this server's siblings too.
      expect(reported.trips).toEqual(thrown.trips);
    });

    it('an SDK error shape is classified without any flag', async () => {
      const classified = await payloadFor({ status: 429 });
      const thrown = await payloadFor(new RateLimitError('429'));

      expect(classified.outcome).toBe('rate-limit-deferred');
      expect(classified.payload).toEqual(thrown.payload);
    });

    it('an AWS throttle name with a 400 status is a deferral, not a permanent failure', async () => {
      const { outcome } = await payloadFor({ name: 'ThrottlingException', status: 400 });

      expect(outcome).toBe('rate-limit-deferred');
    });

    it('a thrown RateLimitError wins over a contradicting flag', async () => {
      const { outcome } = await payloadFor(new RateLimitError('429'), { rateLimited: false });

      expect(outcome).toBe('rate-limit-deferred');
    });

    it('an ordinary error with no flag stays an ordinary failure', async () => {
      const { outcome, trips } = await payloadFor(new Error('null is not an object'));

      expect(outcome).toBe('retry-scheduled');
      expect(trips).toEqual([]);
    });
  });

  // ===========================================================================
  // Retry-After
  // ===========================================================================
  describe('Retry-After', () => {
    it('honours integer seconds from a provider header', async () => {
      await service.completeFailed(runningJob(), { status: 429, headers: { 'retry-after': '600' } });

      // 600s dwarfs the 15s backoff, so it is the floor that decides.
      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 600_000) });
      expect(throttle.trip).toHaveBeenCalledWith('vision.describe', 600_000);
    });

    it('honours an HTTP-date from a provider header', async () => {
      const at = new Date(NOW + 300_000).toUTCString();

      await service.completeFailed(runningJob(), { status: 503, headers: { 'retry-after': at } });

      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 300_000) });
    });

    it('honours a delay carried on the thrown RateLimitError', async () => {
      await service.completeFailed(runningJob(), new RateLimitError('429', 120_000));

      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 120_000) });
    });

    it('honours a delay a node forwarded as a flag', async () => {
      await service.completeFailed(runningJob(), new Error('node says 429'), {
        rateLimited: true,
        retryAfterMs: 120_000,
      });

      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 120_000) });
    });

    it('falls back to pure backoff when the header is absent', async () => {
      await service.completeFailed(runningJob(), { status: 429 });

      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 15_000) });
    });

    it('falls back to pure backoff when the header is unparseable', async () => {
      await service.completeFailed(runningJob(), {
        status: 429,
        headers: { 'retry-after': 'soon' },
      });

      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 15_000) });
    });

    it('does not let a SHORTER provider request undo an escalated backoff', async () => {
      await service.completeFailed(
        runningJob({ rateLimitHits: 4 }),
        new RateLimitError('429', 1_000)
      );

      // hit 5 → exp = 30_000 * 2^4 = 480_000, floored jitter → 240_000.
      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 240_000) });
    });
  });

  // ===========================================================================
  // The settled event
  // ===========================================================================
  describe('the job.settled event', () => {
    it('fires on success, carrying the written row', async () => {
      await service.completeSucceeded(runningJob());

      expect(emit).toHaveBeenCalledTimes(1);

      const [key, event] = emit.mock.calls[0] as [string, JobSettledEvent];

      expect(key).toBe(JOB_SETTLED_EVENT);
      expect(event).toBeInstanceOf(JobSettledEvent);
      expect(event.jobId).toBe('job-1');
      expect(event.type).toBe('vision.describe');
      expect(event.status).toBe('succeeded');
      expect(event.succeeded).toBe(true);
    });

    it('fires on an ordinary give-up', async () => {
      await service.completeFailed(runningJob({ attempts: 3 }), new Error('final'));

      expect(emit).toHaveBeenCalledTimes(1);
      expect((emit.mock.calls[0][1] as JobSettledEvent).status).toBe('failed');
      expect((emit.mock.calls[0][1] as JobSettledEvent).lastError).toBe('final');
    });

    it('fires on a rate-limit give-up', async () => {
      await service.completeFailed(
        runningJob({ rateLimitHits: 10 }),
        new RateLimitError('429')
      );

      expect(emit).toHaveBeenCalledTimes(1);
      expect((emit.mock.calls[0][1] as JobSettledEvent).status).toBe('failed');
    });

    it('does NOT fire on an intermediate retry', async () => {
      await service.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'));

      expect(emit).not.toHaveBeenCalled();
    });

    it('does NOT fire on a rate-limit deferral', async () => {
      await service.completeFailed(runningJob(), new RateLimitError('429'));

      expect(emit).not.toHaveBeenCalled();
    });

    it('does NOT fire when the terminal write failed — the event would be a lie', async () => {
      update.mockRejectedValue(new Error('database is down'));

      await service.completeSucceeded(runningJob());

      expect(emit).not.toHaveBeenCalled();
    });

    it('fires AFTER the write, never before', async () => {
      const order: string[] = [];

      update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve(runningJob({ status: 'succeeded' }));
      });
      emit.mockImplementation(() => {
        order.push('emit');
        return true;
      });

      await service.completeSucceeded(runningJob());

      expect(order).toEqual(['update', 'emit']);
    });

    it('a THROWING listener does not affect the row or the outcome', async () => {
      // `EventEmitter2` dispatches synchronously, so an unguarded emit would
      // throw out of a method whose row is already correct.
      emit.mockImplementation(() => {
        throw new Error('a listener exploded');
      });

      await expect(service.completeSucceeded(runningJob())).resolves.toBe('succeeded');
      expect(update).toHaveBeenCalledTimes(1);
      expect(written()).toMatchObject({ status: 'succeeded' });
    });

    it('a throwing listener does not affect a give-up either', async () => {
      emit.mockImplementation(() => {
        throw new Error('a listener exploded');
      });

      await expect(
        service.completeFailed(runningJob({ attempts: 3 }), new Error('final'))
      ).resolves.toBe('failed');
      expect(written()).toMatchObject({ status: 'failed' });
    });
  });

  // ===========================================================================
  // safeTerminalUpdate
  // ===========================================================================
  describe('safeTerminalUpdate', () => {
    it('retries once after a short pause and succeeds', async () => {
      update.mockRejectedValueOnce(new Error('connection reset by peer'));

      await expect(service.completeSucceeded(runningJob())).resolves.toBe('succeeded');

      expect(update).toHaveBeenCalledTimes(2);
      expect(clock.slept).toEqual([250]);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('sends an IDENTICAL payload on the retry', async () => {
      update.mockRejectedValueOnce(new Error('connection reset'));

      await service.completeSucceeded(runningJob());

      expect(update.mock.calls[0][0]).toEqual(update.mock.calls[1][0]);
    });

    it('frees the slot and leaves the row alone when both writes fail', async () => {
      // ⚠ THE SWALLOW IS THE FEATURE. A throw here would propagate into the
      // worker's slot accounting; a slot lost this way is lost for the life
      // of the process.
      update.mockRejectedValue(new Error('database is down'));

      const job = runningJob();

      await expect(service.completeSucceeded(job)).resolves.toBe('write-failed');

      expect(update).toHaveBeenCalledTimes(2);
      // Nothing was written, so the row is still `running` with its lease —
      // exactly the state the lease reaper (#263) exists to find.
      expect(job.status).toBe('running');
      expect(job.leaseExpiresAt).not.toBeNull();
      expect(emit).not.toHaveBeenCalled();
    });

    it('swallows on every branch, not just success', async () => {
      update.mockRejectedValue(new Error('database is down'));

      await expect(service.completeFailed(runningJob(), new Error('boom'))).resolves.toBe(
        'write-failed'
      );
      await expect(
        service.completeFailed(runningJob({ attempts: 3 }), new Error('boom'))
      ).resolves.toBe('write-failed');
      await expect(service.completeFailed(runningJob(), new RateLimitError('429'))).resolves.toBe(
        'write-failed'
      );
      await expect(
        service.completeFailed(runningJob({ rateLimitHits: 10 }), new RateLimitError('429'))
      ).resolves.toBe('write-failed');
    });

    it('does not retry more than once — a worker slot is not held through an outage', async () => {
      update.mockRejectedValue(new Error('database is down'));

      await service.completeSucceeded(runningJob());

      expect(update).toHaveBeenCalledTimes(2);
      expect(clock.slept).toEqual([250]);
    });
  });

  // ===========================================================================
  // Per-type attempt budgets (#346)
  // ===========================================================================
  describe('per-type attempt budgets', () => {
    /** Registers a handler for `vision.describe` carrying `maxAttempts`. */
    function profiled(maxAttempts: number): void {
      registry.register({
        type: 'vision.describe',
        profile: { maxRuntimeMs: 30_000, maxAttempts },
        process: async () => undefined,
      });
    }

    it('FAILS a maxAttempts:1 job on its first failure instead of retrying it', async () => {
      // The whole reason the budget is per type. `attempts` is charged at
      // claim time, so a job in its first run already reads `attempts: 1`; a
      // budget of 1 must make that the last one. Judged against the
      // deployment-wide 3 this same row would have been given a backoff and
      // run again — automatic retry for work whose author said there must not
      // be one.
      profiled(1);

      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'))
      ).resolves.toBe('failed');

      // Terminal, and with no backoff scheduled — the two halves of "not
      // retried".
      expect(written()).toMatchObject({ status: 'failed', scheduledFor: null });
      expect(written().finishedAt).toBeInstanceOf(Date);
    });

    it('retries beyond the deployment-wide budget when the type asks for more', async () => {
      // The other direction, and it has to work too, or "per type" would only
      // ever mean "fewer".
      profiled(6);

      await expect(
        service.completeFailed(runningJob({ attempts: 4 }), new Error('kaboom'))
      ).resolves.toBe('retry-scheduled');

      expect(written()).toMatchObject({ status: 'pending' });
    });

    it('quotes the type’s own budget in the retry log, not the deployment’s', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      profiled(6);

      await service.completeFailed(runningJob({ attempts: 4 }), new Error('kaboom'));

      expect(String(log.mock.calls.at(-1)?.[0])).toContain('4/6');
    });

    it('leaves a type with NO profile on the deployment-wide budget', async () => {
      // The regression guard for every deployment that did not ask for this:
      // nothing registered, so `attempts: 1` of 3 still schedules a retry.
      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'))
      ).resolves.toBe('retry-scheduled');
    });

    it('ignores an unusable profile and uses the deployment-wide budget', async () => {
      registry.register({
        type: 'vision.describe',
        profile: { maxRuntimeMs: 30_000, maxAttempts: 0 },
        process: async () => undefined,
      });

      // A budget of 0 describes a job that may never be claimed, which is not
      // a retry policy. It degrades to 3, so attempt 1 still retries.
      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'))
      ).resolves.toBe('retry-scheduled');
    });

    it('does not consult the profile on the rate-limit path', async () => {
      // A 429 is "not now", not an attempt at the work — it defers and
      // un-charges the attempt regardless of any budget, so even a
      // maxAttempts:1 type is deferred rather than failed.
      profiled(1);

      await expect(
        service.completeFailed(runningJob({ attempts: 1 }), new RateLimitError('429'))
      ).resolves.toBe('rate-limit-deferred');
    });
  });

  // ===========================================================================
  // Config fallbacks
  // ===========================================================================
  describe('missing configuration', () => {
    it('falls back to the shipped defaults rather than producing NaN dates', async () => {
      const bare = new JobTerminalService(
        { job: { update } } as unknown as PrismaService,
        { get: () => undefined } as unknown as ConfigService,
        throttle as unknown as ProviderThrottleService,
        { emit } as unknown as EventEmitter2,
        registry,
        clock,
        RAND_FLOOR
      );

      await bare.completeFailed(runningJob({ attempts: 1 }), new Error('kaboom'));
      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 1_000) });

      update.mockClear();
      await bare.completeFailed(runningJob(), new RateLimitError('429'));
      expect(written()).toMatchObject({ scheduledFor: new Date(NOW + 15_000) });
    });
  });

  // ===========================================================================
  // The gate, against the real ProviderThrottleService
  // ===========================================================================
  describe('sibling back-off, with the real throttle gate', () => {
    it('a node-reported 429 delays a sibling job of the same provider, and not an unrelated one', async () => {
      const realThrottle = new ProviderThrottleService(
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        clock
      );

      realThrottle.registerProviderKey('vision.describe', 'acme-vision');
      realThrottle.registerProviderKey('vision.tag', 'acme-vision');
      realThrottle.registerProviderKey('speech.transcribe', 'other-vendor');

      const wired = new JobTerminalService(
        { job: { update } } as unknown as PrismaService,
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        realThrottle,
        { emit } as unknown as EventEmitter2,
        registry,
        clock,
        RAND_FLOOR
      );

      // A remote node reports a 429 for one job type...
      await wired.completeFailed(runningJob({ type: 'vision.describe', executor: 'node' }), null, {
        rateLimited: true,
        retryAfterMs: 60_000,
      });

      // ...and its SIBLING on the same provider now waits on this server.
      expect(realThrottle.isCoolingDown('vision.tag')).toBe(true);
      await expect(realThrottle.acquire('vision.tag')).resolves.toBe(60_000);

      // An unrelated provider is untouched.
      expect(realThrottle.isCoolingDown('speech.transcribe')).toBe(false);
      await expect(realThrottle.acquire('speech.transcribe')).resolves.toBe(0);
    });

    it('a success clears the cooldown for siblings', async () => {
      const realThrottle = new ProviderThrottleService(
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        clock
      );

      realThrottle.registerProviderKey('vision.describe', 'acme-vision');
      realThrottle.registerProviderKey('vision.tag', 'acme-vision');

      const wired = new JobTerminalService(
        { job: { update } } as unknown as PrismaService,
        { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
        realThrottle,
        { emit } as unknown as EventEmitter2,
        registry,
        clock,
        RAND_FLOOR
      );

      await wired.completeFailed(runningJob(), new RateLimitError('429'));
      expect(realThrottle.isCoolingDown('vision.tag')).toBe(true);

      await wired.completeSucceeded(runningJob({ type: 'vision.tag' }));
      expect(realThrottle.isCoolingDown('vision.describe')).toBe(false);
    });
  });
});
