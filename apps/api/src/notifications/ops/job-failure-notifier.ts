import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type { JobFailedEmailData } from '../../email';
import {
  JOB_SETTLED_EVENT,
  type JobSettledEvent,
} from '../../jobs/events/job-settled.event';
import { describeThrown } from '../describe-thrown';
import { NotificationsService } from '../notifications.service';

// =============================================================================
// JobFailureNotifier — `jobs.job_failed` (issue #288, epic #254)
// =============================================================================
//
// ONE LISTENER, and every structural decision in this file is about staying a
// BYSTANDER to the queue rather than becoming part of it.
//
// -----------------------------------------------------------------------------
// 1. WHY A LISTENER AND NOT A `notify()` CALL IN `JobTerminalService`
// -----------------------------------------------------------------------------
//
// The direct call is shorter and was rejected twice over:
//
//   * IT WOULD MAKE `JobsModule` DEPEND ON `NotificationsModule`. `JobsModule`
//     is imported by `NodesModule`, by `BroadcastsModule` and by the app root;
//     `NotificationsModule`'s own graph reaches `EmailModule`, `SettingsModule`
//     and `CredentialsModule`. Wiring the queue to the notifier points a heavy
//     graph at the module every feature enqueues through, and the first module
//     that ever wants to notify FROM a job handler closes the loop into a cycle
//     — which then gets "fixed" with `forwardRef`, making the cycle invisible
//     rather than absent. `job-settled.event.ts` already exists precisely so a
//     listener can be a bystander; this is that listener.
//
//   * `JobTerminalService` IS THE TERMINAL CHOKEPOINT. Every path that settles
//     a job runs through it, and its own `safeTerminalUpdate` swallows database
//     failures on purpose because an exception escaping it can strand a worker
//     slot for the life of the process. Adding an outbound side effect to that
//     file makes the most safety-critical method in the queue also the place a
//     notification bug lands.
//
// -----------------------------------------------------------------------------
// 2. THE IMPORT DIRECTION IS A FILE IMPORT, NOT A MODULE DEPENDENCY
// -----------------------------------------------------------------------------
//
// This file imports `JOB_SETTLED_EVENT` and `JobSettledEvent` from
// `jobs/events/job-settled.event.ts`. THAT FILE IMPORTS ONLY `@prisma/client` —
// no Nest module, no service, no `JobsModule` — so the import pulls a class and
// a string constant into the bundle and adds nothing to the provider graph.
// ⚠ IF THAT FILE EVER GROWS AN IMPORT OF ITS OWN, this argument stops holding
// and the shared contract should move to a type-only module instead.
//
// The wiring is `EventEmitterModule.forRoot()` in `app.module.ts`, which is
// global; this provider is registered in `NotificationsModule`, on the
// notifications side of the seam, where it belongs.
//
// -----------------------------------------------------------------------------
// 3. `EventEmitter2` DISPATCHES SYNCHRONOUSLY — SO THIS HANDLER MUST NOT BLOCK
// -----------------------------------------------------------------------------
//
// `emitSettled` calls `this.events.emit(...)` inline, inside the worker's
// completion path. Whatever this method does happens BEFORE the worker frees
// its slot. So the handler:
//
//   * calls the DETACHED `notifyPermissionHolders`, never the awaited sibling —
//     the audience query and every send happen after this returns; and
//   * wraps its whole body in try/catch, so that even a synchronous throw
//     (a bad payload build, a service that failed to construct) cannot reach
//     `JobTerminalService`. That service already catches — see `emitSettled` —
//     and logs "a listener threw"; this catch exists so it never has to.
//
// It is deliberately NOT registered with `{ async: true }`. That option makes
// the emitter await the handler, which is the opposite of what the queue needs
// here, and would put a promise the worker never sees in the emit path.
//
// -----------------------------------------------------------------------------
// 4. IT FIRES ON THE GIVE-UP ONLY, AND THAT IS `status === 'failed'`
// -----------------------------------------------------------------------------
//
// `JOB_SETTLED_EVENT` is emitted from exactly three places in
// `job-terminal.service.ts`, and only the two that write `status: 'failed'` are
// give-ups:
//
//   * `completeSucceeded`  -> `succeeded`  — not this event.
//   * `failPermanently`    -> `failed`     — the attempt budget is spent, or a
//                                            caller declared the job unrunnable.
//   * the rate-limit give-up in `deferForRateLimit`, past
//     `jobs.rateLimitMaxHits` -> `failed`  — a provider limit that waiting will
//                                            not fix.
//
// AN ORDINARY RETRY AND AN ORDINARY DEFERRAL EMIT NOTHING AT ALL: both write
// `status: 'pending'` and return without calling `emitSettled`. So the filter
// below is one comparison, and "terminal only" is a property of the EMITTER
// rather than something this listener has to reconstruct — which is why it is
// worth stating here that the guarantee lives over there.
// =============================================================================

@Injectable()
export class JobFailureNotifier {
  private readonly logger = new Logger(JobFailureNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A job settled. Raise `jobs.job_failed` if — and only if — it gave up.
   *
   * RETURNS SYNCHRONOUSLY IN EVERY CASE. See section 3 of the header: this runs
   * inside the worker's completion path, so nothing here may be awaited and
   * nothing here may throw.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  handleJobSettled(event: JobSettledEvent): void {
    try {
      // THE ONLY FILTER, and it is sufficient — see section 4. A `succeeded`
      // job is not news; a retry and a deferral never reach this listener at
      // all, because they do not settle and do not emit.
      if (event.status !== 'failed') return;

      const job = event.job;

      const payload: JobFailedEmailData = {
        jobId: job.id,
        jobType: job.type,
        error: job.lastError,
        attempts: job.attempts,
        executor: job.executor,
        // `finishedAt` is written by the same terminal update that set
        // `failed`, so it is present here in practice. The fallback is not
        // defensive noise: the row is typed nullable, and a template that
        // rendered `null` as a blank timestamp would be reporting the one
        // thing an operator correlates against logs as "".
        failedAt: job.finishedAt ?? new Date(),
        appUrl: this.appUrl(),
      };

      // DETACHED, and never awaited. The audience query and every send happen
      // after this method has returned and the worker has moved on.
      //
      // ⚠ `.catch()` DESPITE `notifyPermissionHolders` NEVER REJECTING. That
      // guarantee belongs to the dispatcher, not to this file, and an
      // un-handled rejection raised inside a SYNCHRONOUS emitter dispatch is
      // the one failure this listener's whole design exists to make
      // impossible — it would surface as an `unhandledRejection` with a stack
      // pointing at a worker that did nothing wrong. The `try/catch` around
      // this block cannot see a rejected promise; only this can.
      void this.notifications
        .notifyPermissionHolders(
          'jobs.job_failed',
          PERMISSIONS.JOBS_READ,
          payload,
        )
        .catch((err: unknown) => {
          this.logger.error(
            `Dispatching 'jobs.job_failed' for job ${job.id} rejected, which ` +
              `the dispatcher contracts never to do: ${describeThrown(err)}`,
          );
        });
    } catch (err) {
      // Belt and braces over `emitSettled`'s own catch. A notification must
      // never be able to affect a terminal row or a worker slot.
      this.logger.error(
        `Could not raise 'jobs.job_failed' for job ${event.jobId}; the job's ` +
          `terminal row is unaffected: ${describeThrown(err)}`,
      );
    }
  }

  /**
   * The application root, trailing slashes trimmed, or `undefined`.
   *
   * The same shape as `UsersService.appUrl()` — and `undefined` rather than a
   * guess, because the templates omit their CTA entirely when there is no URL
   * rather than rendering a button that goes nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}
