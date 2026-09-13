import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';

import { JobHandler } from '../job-handler.interface';
import { JobHandlerRegistry } from '../job-handler.registry';

/**
 * Example handler that demonstrates the job queue's extension point (issue
 * #259, epic #254). It does the smallest observable thing a handler can do:
 * it logs the job's payload and returns.
 *
 * It is the worked example the way
 * `storage/processing/processors/example-metadata.processor.ts` is for the
 * upload pipeline — copy this file, change three things, and you have a new
 * background job type. See `README.md` in this folder for the four-step
 * recipe.
 *
 * THREE THINGS THIS FILE IS DEMONSTRATING
 * -----------------------------------------------------------------------------
 *
 * 1. **Self-registration from its OWN `OnModuleInit`.** The registry is
 *    injected and `register(this)` is called in `onModuleInit()`. Nothing
 *    else in the application knows this class exists — no `switch`, no
 *    central list of types, no import from the worker. That is the whole
 *    mechanism; see `job-handler.registry.ts` for why registration is
 *    explicit rather than discovered, and for why the worker consequently
 *    starts from `onApplicationBootstrap`.
 *
 * 2. **Throw to fail.** `process` returns `Promise<void>` and reports failure
 *    by throwing; the worker records the message in `Job.lastError` and
 *    retries. There is deliberately no `try/catch` below — swallowing an
 *    error here would report success for work that did not happen.
 *
 * 3. **Server-only, by carrying NEITHER optional member.** This handler has
 *    no `nodeResultSchema` and no `persistNodeResult`, so
 *    `JobHandlerRegistry.serverOnlyTypes()` includes its type. That is the
 *    default for every handler, and it is not a setting anyone can get out of
 *    sync — adding BOTH members is what makes a type node-eligible, and
 *    adding only one of the two leaves it server-only. See
 *    `job-handler.interface.ts`.
 *
 * TO ENABLE IT, add it to a module's `providers` (it self-registers from
 * there); `JobsModule` already does, so that the contract has a live
 * implementation exercising it from the moment the queue exists.
 */
@Injectable()
export class ExampleEchoHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(ExampleEchoHandler.name);

  /**
   * A deliberately example-shaped key carrying no product or feature name —
   * anyone reading a `jobs` row, an admin dashboard or a log line can tell at
   * a glance that this is the template's demonstration handler and not
   * something their application depends on. Delete this class and its type
   * disappears from the dashboard with no migration.
   */
  readonly type = 'example.echo';

  constructor(private readonly registry: JobHandlerRegistry) {}

  /**
   * Self-registration. THIS IS THE ONLY WIRING A HANDLER NEEDS: being a
   * provider in some module is what gets `onModuleInit` called, and this line
   * is what makes the worker able to run the type.
   */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Logs the job's payload.
   *
   * Trivially safe on purpose: no writes, no network, no filesystem, no
   * dependency beyond the logger — so the example cannot damage anything in a
   * deployment that never removed it, and it is still observable (the log
   * line proves the claim → dispatch → handler path actually works end to
   * end).
   *
   * Note what is NOT here: no `try/catch`. A real handler that wants to fail
   * simply lets the error propagate.
   */
  async process(job: Job): Promise<void> {
    this.logger.log(
      `Echoing job ${job.id} (type "${job.type}", reason "${job.reason}", ` +
        `attempt ${job.attempts}): ${JSON.stringify(job.payload ?? null)}`,
    );
  }
}
