// =============================================================================
// `auth.token.cleanup` — expired refresh tokens and PATs, as a queue job
// (issue #353, epic #345)
// =============================================================================
//
// The work is unchanged: `AuthService.cleanupExpiredTokens` deletes expired and
// revoked `refresh_tokens`, `PatService.cleanupExpiredTokens` deletes expired
// PATs and revoked ones past their thirty-day grace. WHAT CHANGED IS THE
// EXECUTOR. Until #353 both calls happened inline in a `@Cron` at 3am, which
// meant:
//
//   - the only record that they ran was a log line on whichever process held
//     the timer, so "were expired sessions cleaned up last night?" was a grep
//     rather than a row in the admin job list;
//   - a failure got no retry at all — the next answer was "wait 24 hours" —
//     and, because `TokenCleanupTask` did not even catch, a database blip
//     during the delete became an unhandled rejection inside a cron;
//   - the deletes competed with request traffic on the scheduler's thread
//     rather than against a worker slot with a timeout.
//
// As a job it gets the queue's retry budget, its timeout, and a `jobs` row with
// a duration and a `lastError` — the same accounting every other background
// activity in this application now has.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, BY DERIVATION AND BY NATURE
// -----------------------------------------------------------------------------
//
// It carries NEITHER `nodeResultSchema` NOR `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` derives server-only and nothing has to
// enforce it. That is also the only correct answer: this job IS two `deleteMany`
// statements, so there is nothing for a machine with no database access to
// compute. A `JOBS_WORKER_MODE=system` API server keeps running it while the
// fleet takes node-eligible work, which is exactly right for housekeeping.
//
// -----------------------------------------------------------------------------
// NO PROFILE, DELIBERATELY
// -----------------------------------------------------------------------------
//
// Two indexed deletes are ordinary queue work: the deployment-wide
// `JOBS_JOB_TIMEOUT_MS` and `JOBS_MAX_ATTEMPTS` are right for it, and declaring
// a profile that merely restates them is a second place for those numbers to be
// wrong. Retries are safe because both deletes are idempotent — a row deleted
// twice is a row deleted once — which is the property `JobHandler.process`
// asks for and the reason no profile is needed here.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PatService } from '../../pat/pat.service';
import { AuthService } from '../auth.service';

/**
 * The handler key, and therefore the `Job.type` every token-cleanup row
 * carries.
 *
 * Dotted, lowercase, product-neutral and PERMANENT: rows outlive handlers, so
 * renaming this orphans every historical row and every job already queued under
 * the old name. Exported because `TokenCleanupTask` needs the same string to
 * ask "is one already queued?", and two literals is one typo away from a cron
 * that enqueues a duplicate every night forever.
 */
export const AUTH_TOKEN_CLEANUP_TYPE = 'auth.token.cleanup';

@Injectable()
export class TokenCleanupHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TokenCleanupHandler.name);

  readonly type = AUTH_TOKEN_CLEANUP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly auth: AuthService,
    private readonly pat: PatService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Deletes expired refresh tokens and expired personal access tokens.
   *
   * THROWS TO FAIL, like every handler: the two service calls are not caught,
   * so a database error becomes `Job.lastError` plus a retry on the queue's own
   * budget rather than a silently skipped night.
   *
   * ⚠ THE PAT DELETE IS NOT GUARDED BY THE REFRESH-TOKEN DELETE SUCCEEDING, and
   * that ordering is deliberate rather than accidental: they are two
   * independent housekeeping duties that happen to share a schedule, and a
   * retry re-runs both. Running them in one `process` (rather than as two job
   * types) keeps one row per night in the dashboard, which is what an operator
   * asking "did session cleanup run?" is actually looking for.
   */
  async process(job: Job): Promise<void> {
    const refreshCount = await this.auth.cleanupExpiredTokens();
    const patCount = await this.pat.cleanupExpiredTokens();

    this.logger.log(
      `Token cleanup job ${job.id} removed ${refreshCount} refresh token(s) and ` +
        `${patCount} personal access token(s)`
    );
  }
}
