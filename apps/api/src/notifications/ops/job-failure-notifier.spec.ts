import { ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { JobFailureNotifier } from './job-failure-notifier';
import { NotificationsService } from '../notifications.service';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobTerminalService } from '../../jobs/job-terminal.service';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import type { JobClock } from '../../jobs/job-clock';
import type { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// JobFailureNotifier — tests (issue #288, epic #254)
// =============================================================================
//
// ⚠ DRIVEN THROUGH THE REAL `JobTerminalService` AND A REAL `EventEmitter2`,
// deliberately, because the claim this file has to prove is not "the listener
// filters on `status === 'failed'`" — that is one comparison and a test of it
// proves nothing. The claim is:
//
//   `jobs.job_failed` is raised on the GIVE-UP AND ON NOTHING ELSE.
//
// "Nothing else" includes an intermediate retry and a rate-limit deferral, and
// whether those raise it is decided by the EMITTER, not by the listener: both
// write `status: 'pending'` and never call `emitSettled` at all. A suite that
// constructed `JobSettledEvent`s by hand would assert the listener's filter
// against events the queue never emits, and would keep passing on the day
// `JobTerminalService` started emitting on a deferral.
//
// So the wiring here is the production wiring: `EventEmitterModule.forRoot()`
// registers the `@OnEvent` subscription (which is itself under test — a
// listener nothing dispatches to is the other way this feature can be silently
// broken), and the real terminal service settles real job rows through it.
//
// `NotificationsService` is the one stand-in: what it does with the event has
// its own suite (`notify-permission-holders.spec.ts`), and a mock is what lets
// the containment tests below make it throw.
// =============================================================================

const NOW = 1_700_000_000_000;

const CONFIG_VALUES: Record<string, unknown> = {
  'jobs.maxAttempts': 3,
  'jobs.retryBaseMs': 2_000,
  'jobs.retryMaxMs': 60_000,
  'jobs.rateLimitMaxHits': 10,
  'jobs.rateLimitBaseMs': 30_000,
  'jobs.rateLimitMaxMs': 900_000,
  appUrl: 'https://app.example.com/',
};

function fakeClock(): JobClock {
  let current = NOW;

  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
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

describe('JobFailureNotifier, wired to the real settled event', () => {
  let module: TestingModule;
  let terminal: JobTerminalService;
  let notifyPermissionHolders: jest.Mock;
  let update: jest.Mock;
  /** The pre-settle row the fake `update` merges over. Tests that care set it. */
  let rowUnderTest: Job;

  beforeEach(async () => {
    notifyPermissionHolders = jest.fn().mockResolvedValue(undefined);
    rowUnderTest = runningJob();

    // Echo the merge back, so the row the settled event carries is the row
    // that was written — the same fixture `job-terminal.service.spec.ts` uses.
    update = jest.fn(({ where, data }) =>
      Promise.resolve({ ...rowUnderTest, id: where.id, ...data }),
    );

    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        JobFailureNotifier,
        {
          provide: NotificationsService,
          useValue: { notifyPermissionHolders },
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => CONFIG_VALUES[key] },
        },
      ],
    }).compile();

    // `EventEmitterModule` attaches `@OnEvent` subscribers on init. Without
    // this the notifier exists and hears nothing — which is precisely the
    // failure mode this suite is here to catch, so it must be the REAL
    // registration and not a hand-wired `emitter.on(...)`.
    await module.init();

    terminal = new JobTerminalService(
      { job: { update } } as unknown as PrismaService,
      { get: (key: string) => CONFIG_VALUES[key] } as unknown as ConfigService,
      {
        trip: jest.fn(),
        recordSuccess: jest.fn(),
      } as unknown as ProviderThrottleService,
      module.get(EventEmitter2),
      new JobHandlerRegistry(),
      fakeClock(),
      () => 0,
    );
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllMocks();
  });

  /** The event keys the notifier raised, in order. */
  const raised = (): string[] =>
    notifyPermissionHolders.mock.calls.map((call) => call[0] as string);

  // ---------------------------------------------------------------------------
  // IT FIRES ON THE GIVE-UP — BOTH GIVE-UP BRANCHES
  // ---------------------------------------------------------------------------

  it('fires when the attempt budget runs out (failPermanently)', async () => {
    // attempts: 3 of a max of 3 — the next settle is terminal.
    await expect(
      terminal.completeFailed(runningJob({ attempts: 3 }), new Error('handler blew up')),
    ).resolves.toBe('failed');

    expect(raised()).toEqual(['jobs.job_failed']);
  });

  it('fires when a caller declares the job permanently unrunnable, on the first attempt', async () => {
    // `permanent` short-circuits the attempt budget: an unrunnable job must not
    // spend three attempts discovering that. It is still a give-up, so it is
    // still this event.
    await expect(
      terminal.completeFailed(runningJob({ attempts: 1 }), new Error('no such handler'), {
        permanent: true,
      }),
    ).resolves.toBe('failed');

    expect(raised()).toEqual(['jobs.job_failed']);
  });

  it('fires on the RATE-LIMIT give-up, past jobs.rateLimitMaxHits', async () => {
    // 10 hits already recorded; the 11th is past the ceiling of 10 and is a
    // give-up rather than another deferral.
    await expect(
      terminal.completeFailed(
        runningJob({ rateLimitHits: 10 }),
        new RateLimitError('429 Too Many Requests'),
      ),
    ).resolves.toBe('failed');

    expect(raised()).toEqual(['jobs.job_failed']);
  });

  // ---------------------------------------------------------------------------
  // AND ON NOTHING ELSE
  // ---------------------------------------------------------------------------

  it('does NOT fire on an intermediate retry — the job is going to run again', async () => {
    // attempts: 1 of 3. The job goes back to `pending` with a backoff, and no
    // settled event is emitted at all.
    await expect(
      terminal.completeFailed(runningJob({ attempts: 1 }), new Error('transient')),
    ).resolves.toBe('retry-scheduled');

    expect(notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('does NOT fire on a rate-limit DEFERRAL — waiting is expected to fix it', async () => {
    await expect(
      terminal.completeFailed(
        runningJob({ rateLimitHits: 1 }),
        new RateLimitError('429 Too Many Requests'),
      ),
    ).resolves.toBe('rate-limit-deferred');

    expect(notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('does NOT fire when the job succeeded', async () => {
    await expect(terminal.completeSucceeded(runningJob())).resolves.toBe('succeeded');

    expect(notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('does NOT fire when the terminal write itself failed, because nothing settled', async () => {
    update.mockRejectedValue(new Error('database is down'));

    await expect(
      terminal.completeFailed(runningJob({ attempts: 3 }), new Error('handler blew up')),
    ).resolves.toBe('write-failed');

    expect(notifyPermissionHolders).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // THE AUDIENCE AND THE PAYLOAD
  // ---------------------------------------------------------------------------

  it('addresses the audience by the exact permission the job admin controller enforces', async () => {
    await terminal.completeFailed(runningJob({ attempts: 3 }), new Error('boom'));

    expect(notifyPermissionHolders.mock.calls[0][1]).toBe('jobs:read');
  });

  it('carries the job type, id, error, attempts and executor into the payload', async () => {
    rowUnderTest = runningJob({
      attempts: 3,
      type: 'admin.broadcast.chunk',
      executor: 'node-7',
    });

    await terminal.completeFailed(
      rowUnderTest,
      new Error('the provider refused the request'),
    );

    const payload = notifyPermissionHolders.mock.calls[0][2];

    expect(payload).toMatchObject({
      jobId: 'job-1',
      jobType: 'admin.broadcast.chunk',
      error: 'the provider refused the request',
      attempts: 3,
      executor: 'node-7',
      // Trailing slash trimmed, exactly as `UsersService.appUrl()` does it.
      appUrl: 'https://app.example.com',
    });
    expect(payload.failedAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------------------
  // CONTAINMENT — the acceptance criterion
  // ---------------------------------------------------------------------------

  it('a THROWING notifier does not fail the job, and the terminal row is unaffected', async () => {
    notifyPermissionHolders.mockImplementation(() => {
      throw new Error('the notifier exploded');
    });

    // 1. The settle still reports `failed` rather than `write-failed` or a
    //    rejection — `EventEmitter2` dispatches SYNCHRONOUSLY, so a listener
    //    that threw uncontained would surface right here.
    await expect(
      terminal.completeFailed(runningJob({ attempts: 3 }), new Error('boom')),
    ).resolves.toBe('failed');

    // 2. The row was written exactly once, with the terminal status.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'failed' });
  });

  it('a notifier that REJECTS is caught rather than left as an unhandled rejection', async () => {
    notifyPermissionHolders.mockRejectedValue(new Error('dispatch blew up'));

    await expect(
      terminal.completeFailed(runningJob({ attempts: 3 }), new Error('boom')),
    ).resolves.toBe('failed');

    // Let the rejected promise settle inside the listener's `.catch`.
    await Promise.resolve();
  });

  it('a notifier that throws does not stop a SUBSEQUENT job from settling normally', async () => {
    notifyPermissionHolders.mockImplementationOnce(() => {
      throw new Error('the notifier exploded');
    });

    await terminal.completeFailed(runningJob({ attempts: 3 }), new Error('first'));
    await expect(terminal.completeSucceeded(runningJob({ id: 'job-2' }))).resolves.toBe(
      'succeeded',
    );
  });
});
