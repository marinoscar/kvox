import { ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { JobFailureNotifier } from './job-failure-notifier';
import { NotificationsService } from '../notifications.service';
import { emitJobSettled, type Job } from '@marinoscar/platform-api/jobs';

// =============================================================================
// JobFailureNotifier — tests (issue #288, epic #254; re-based by #468)
// =============================================================================
//
// The claim this file proves is: `jobs.job_failed` is raised when a job reaches
// the terminal `failed` status, and on nothing else that settles.
//
// WHAT MOVED. Until #468 this suite drove the queue's own terminal state machine
// to prove that a retry and a rate-limit deferral emit no settled event at all.
// The state machine is the platform's now (`@marinoscar/platform-api/jobs`) and
// its emission rules are tested there. What stays here is the part this app owns:
// the `@OnEvent(JOB_SETTLED_EVENT)` subscription (real `EventEmitterModule`, real
// registration, dispatched through the platform's own `emitJobSettled`), the
// filter, the audience, the payload and the containment of a throwing notifier.
//
// `NotificationsService` is the one stand-in: what it does with the event has its
// own suite (`notify-permission-holders.spec.ts`), and a mock is what lets the
// containment tests below make it throw.
// =============================================================================

const NOW = 1_700_000_000_000;

const CONFIG_VALUES: Record<string, unknown> = {
  appUrl: 'https://app.example.com/',
};

/** A job row at the instant it settles. `attempts: 3` is a spent budget. */
function settledJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'vision.describe',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'failed',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 3,
    lastError: 'handler blew up',
    createdAt: new Date(NOW - 60_000),
    startedAt: new Date(NOW - 1_000),
    finishedAt: new Date(NOW),
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: 'server',
    ...overrides,
  } as Job;
}

describe('JobFailureNotifier, wired to the real settled event', () => {
  let module: TestingModule;
  let emitter: EventEmitter2;
  let notifyPermissionHolders: jest.Mock;
  const logger = new Logger('job-failure-notifier.spec');

  beforeEach(async () => {
    notifyPermissionHolders = jest.fn().mockResolvedValue(undefined);

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
    // this the notifier exists and hears nothing, which is precisely the
    // failure mode this suite is here to catch, so it must be the REAL
    // registration and not a hand-wired `emitter.on(...)`.
    await module.init();
    emitter = module.get(EventEmitter2);
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllMocks();
  });

  /** Settles a row the way the queue does. */
  const settle = (job: Job): void => emitJobSettled(emitter, job, logger);

  /** The event keys the notifier raised, in order. */
  const raised = (): string[] =>
    notifyPermissionHolders.mock.calls.map((call) => call[0] as string);

  it('fires when a job settles as failed', () => {
    settle(settledJob());

    expect(raised()).toEqual(['jobs.job_failed']);
  });

  it('does NOT fire when the job succeeded', () => {
    settle(settledJob({ status: 'succeeded', lastError: null }));

    expect(notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('addresses the audience by the exact permission the job admin controller enforces', () => {
    settle(settledJob());

    expect(notifyPermissionHolders.mock.calls[0][1]).toBe('jobs:read');
  });

  it('carries the job type, id, error, attempts and executor into the payload', () => {
    settle(
      settledJob({
        type: 'admin.broadcast.chunk',
        executor: 'node-7',
        lastError: 'the provider refused the request',
      }),
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
  // CONTAINMENT: the acceptance criterion
  // ---------------------------------------------------------------------------

  it('a THROWING notifier does not escape the emission, so the settle is unaffected', () => {
    notifyPermissionHolders.mockImplementation(() => {
      throw new Error('the notifier exploded');
    });

    // `EventEmitter2` dispatches SYNCHRONOUSLY, so a listener that threw
    // uncontained would surface right here.
    expect(() => settle(settledJob())).not.toThrow();
  });

  it('a notifier that REJECTS is caught rather than left as an unhandled rejection', async () => {
    notifyPermissionHolders.mockRejectedValue(new Error('dispatch blew up'));

    expect(() => settle(settledJob())).not.toThrow();

    // Let the rejected promise settle inside the listener's `.catch`.
    await Promise.resolve();
  });

  it('a notifier that throws does not stop a SUBSEQUENT settle from being heard', () => {
    notifyPermissionHolders.mockImplementationOnce(() => {
      throw new Error('the notifier exploded');
    });

    settle(settledJob({ id: 'job-1' }));
    settle(settledJob({ id: 'job-2' }));

    expect(notifyPermissionHolders).toHaveBeenCalledTimes(2);
  });
});
