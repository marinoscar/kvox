// =============================================================================
// UserDataService (issue #80) — the read side of the Danger Zone
// =============================================================================
//
// Two things a user needs before they can sensibly ask this application to
// forget them: an honest inventory of what it is holding, and one way to queue
// the deletion of some of it. Everything destructive happens later, in
// `handlers/user-data-purge.handler.ts`; nothing in this file deletes a row.
//
// -----------------------------------------------------------------------------
// ⚠ THE 409 IS THE QUEUE'S PARTIAL UNIQUE INDEX, NOT THE `findFirst` ABOVE IT
// -----------------------------------------------------------------------------
//
// `requestDeletion` does look for an active job first, and that read is worth
// having — it turns the ordinary double-click into a fast, specific refusal
// that names the scope already running. But it is a COURTESY, and treating it
// as the guard is the classic check-then-act bug: two requests a millisecond
// apart both read "nothing running", both insert, and the user's transcripts
// are now being deleted by two workers racing each other through the same rows.
//
// The real enforcement is `jobs_active_dedup_uniq_idx` — the hand-written
// partial unique index over `dedup_key` while a job is `pending`/`running`
// (schema, epic #254). `JobsService.enqueue` catches that conflict and RETURNS
// THE JOB THAT ALREADY HOLDS THE KEY rather than throwing, which is exactly
// right for every other caller in this repository and exactly wrong here: a
// user who asked for `everything` and silently received the id of the
// `transcripts` job queued by their other tab would be told their keys were
// going and keep them.
//
// So the request carries a `requestId` it generated, and compares it to the
// one on the job that comes back. Same id → this insert won, 202. Different id
// → we deduplicated onto somebody else's row, 409, and the response says which
// scope is actually running.
//
// REJECTED: comparing `createdAt` against a timestamp taken before the call.
// It reads as equivalent and is not — `createdAt` is the DATABASE's clock and
// the comparison instant is this process's, so on any deployment where those
// two drift by milliseconds (all of them) the comparison is a coin flip
// precisely in the race it exists to decide. The `requestId` involves no clock
// at all.
//
// REJECTED: `skipDedup: true` plus a hand-rolled advisory lock. That discards
// the one mechanism in this codebase that already closes this race correctly,
// and replaces it with a second one to keep in step with it.
// =============================================================================

import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import {
  confirmationFor,
  USER_DATA_PURGE_JOB_TYPE,
  USER_DATA_SCOPES,
  USER_DATA_SUBJECT_TYPE,
  type UserDataScope,
} from './job-types';
import type {
  CreateUserDataDeletionDto,
  UserDataDeletionResponse,
  UserDataSummary,
} from './dto/user-data.dto';
import { userDataCategories } from './user-data.registries';
import { resolveUserDataHook } from './user-data.support';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import { JobsService } from '@marinoscar/platform-api/jobs';

/** The job statuses that mean "a deletion is in flight for this user". */
const ACTIVE_JOB_STATUSES = ['pending', 'running'] as const;

@Injectable()
export class UserDataService {
  private readonly logger = new Logger(UserDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * `GET /api/user-data/summary` — what this deployment is holding for the
   * caller, per scope.
   *
   * ⚠ EVERY COUNT EXCLUDES SOFT-DELETED ROWS. A transcript or note in
   * `deleting` has already been taken away from the user's view and its bytes
   * are on their way out through its own purge job; counting it would show a
   * number that shrinks on its own after the page loads, which reads as the
   * application losing track rather than as a purge finishing.
   *
   * The reads are issued together rather than in sequence: they are
   * independent, and a summary that costs one round trip instead of nine is the
   * whole reason this endpoint exists rather than the client assembling it from
   * the list endpoints.
   *
   * ⚠ THE RESPONSE IS ASSEMBLED FROM THE CATEGORY REGISTRY (issue #460): each
   * category that declares a `summary` contributes one key, in category order,
   * then `activeDeletion` last — the wire key order the Danger Zone has always
   * had. The count and byte queries moved, verbatim, into the declaring
   * domain's `*.user-data.ts`; a hook that cannot be resolved fails the request
   * rather than reporting a category as absent.
   */
  async summary(userId: string): Promise<UserDataSummary> {
    const categories = userDataCategories().filter((category) => category.summary);

    // Resolved before any query is issued, so a missing hook fails fast.
    const resolved = categories.map((category) => ({
      category,
      instance: resolveUserDataHook(
        this.moduleRef,
        (category.summary as NonNullable<typeof category.summary>).inject,
        category.id,
        'summary',
      ),
    }));

    const [values, activeDeletion] = await Promise.all([
      Promise.all(
        resolved.map(({ category, instance }) =>
          (category.summary as NonNullable<typeof category.summary>).run(instance, userId),
        ),
      ),
      this.findActiveDeletion(userId),
    ]);

    const summary: Record<string, unknown> = {};

    resolved.forEach(({ category }, index) => {
      summary[(category.summary as NonNullable<typeof category.summary>).key] = values[index];
    });

    summary.activeDeletion = activeDeletion;

    return summary as UserDataSummary;
  }

  /**
   * `POST /api/user-data/deletions` — queue one bulk deletion.
   *
   * Returns as soon as the job row exists. Nothing is deleted synchronously:
   * the work fans out across several tables and object storage and comfortably
   * outlives this request, which is CLAUDE.md rule 1 and not a performance
   * choice.
   */
  async requestDeletion(
    userId: string,
    dto: CreateUserDataDeletionDto,
  ): Promise<UserDataDeletionResponse> {
    const scope = dto.scope;

    // ⚠ COMPARED EXACTLY, WITH NO TRIM AND NO CASE FOLDING. The point of a
    // typed confirmation is that the user produced the characters deliberately;
    // accepting ` everything ` or `Everything` accepts a paste and an
    // autocapitalising keyboard, which are the two things it was meant to
    // exclude. The message names the word rather than saying "invalid
    // confirmation", because a user who genuinely means it should not have to
    // guess.
    if (dto.confirmation !== confirmationFor(scope)) {
      throw new BadRequestException(
        `To delete ${scope}, type ${confirmationFor(scope)} exactly into the confirmation field.`,
      );
    }

    const existing = await this.findActiveDeletion(userId);

    if (existing) {
      throw this.alreadyRunning(existing.scope);
    }

    // See the file header: this id, not a clock, is what distinguishes "my
    // insert won" from "I deduplicated onto a job somebody else queued".
    const requestId = randomUUID();

    const job = await this.jobs.enqueue({
      type: USER_DATA_PURGE_JOB_TYPE,
      // The purge deletes the caller's `storage_objects` rows, so it runs in an
      // organization: the default one in single-org mode.
      orgId: await resolveOrgId(this.prisma, null, `${USER_DATA_PURGE_JOB_TYPE} enqueue`),
      reason: 'rerun',
      subjectType: USER_DATA_SUBJECT_TYPE,
      subjectId: userId,
      payload: { userId, scope, requestId },
    });

    const payload = readPurgePayload(job.payload);

    if (payload?.requestId !== requestId) {
      throw this.alreadyRunning(payload?.scope ?? null);
    }

    await this.audit(userId, 'user_data:delete_requested', userId, {
      scope,
      jobId: job.id,
    });

    this.logger.warn(
      `User ${userId} requested bulk deletion of scope "${scope}" (job ${job.id})`,
    );

    return {
      id: job.id,
      scope,
      status: job.status,
      requestedAt: job.createdAt.toISOString(),
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * The `user.data.purge` job already queued or running for this user, if any.
   *
   * ⚠ THE SCOPE IS READ BACK OUT OF THE PAYLOAD rather than stored anywhere
   * else. There is no `user_data_deletions` table and this issue deliberately
   * adds none: the job row already records who, what, when, its status, its
   * error and its attempts, and a parallel table would be a second answer to
   * every one of those questions with nothing keeping the two in step.
   */
  private async findActiveDeletion(userId: string) {
    const job = await this.prisma.job.findFirst({
      where: {
        type: USER_DATA_PURGE_JOB_TYPE,
        subjectType: USER_DATA_SUBJECT_TYPE,
        subjectId: userId,
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) return null;

    const payload = readPurgePayload(job.payload);

    return {
      id: job.id,
      // A job row whose payload somehow lost its scope is still a deletion in
      // flight, and reporting it as one is what matters; `everything` is the
      // safe direction to guess in a field the client only renders.
      scope: payload?.scope ?? ('everything' as UserDataScope),
      status: job.status,
      requestedAt: job.createdAt.toISOString(),
    };
  }

  /** The 409 both collision paths raise, worded identically. */
  private alreadyRunning(scope: UserDataScope | null): ConflictException {
    return new ConflictException(
      scope
        ? `A deletion of your ${scope} is already in progress. Wait for it to finish before ` +
          'starting another.'
        : 'A deletion of your data is already in progress. Wait for it to finish before ' +
          'starting another.',
    );
  }

  /**
   * One audit row, in the shape `NotesService.audit` and
   * `TranscriptsService.audit` already use.
   *
   * `targetType: 'user'` and `targetId` the caller's own id, matching
   * `Job.subject_type`/`subject_id`: the thing being acted on here is the
   * ACCOUNT, not any one transcript or note. That also makes the trail
   * greppable by the only key that spans every step this deletion will take.
   */
  private async audit(
    userId: string,
    action: string,
    targetId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'user',
        targetId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

/** What a `user.data.purge` payload carries. See `USER_DATA_SCOPES`. */
export interface UserDataPurgePayload {
  userId: string;
  scope: UserDataScope;
  /** Present only on a payload written by `requestDeletion`. */
  requestId?: string;
}

/**
 * A `user.data.purge` payload, or `null` for anything that is not one.
 *
 * Exported and total: the handler reads its own job's payload through this same
 * function, so "what a purge payload is" has one definition rather than a
 * permissive cast at each reader. `job.payload` is JSONB — an operator can put
 * anything in it — so every field is checked rather than asserted.
 */
export function readPurgePayload(value: unknown): UserDataPurgePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const userId = record.userId;
  const scope = record.scope;

  if (typeof userId !== 'string' || userId.length === 0) return null;

  // ⚠ CHECKED AGAINST THE LIST, NOT MERELY `typeof === 'string'`. An unknown
  // scope reaching the handler would fall through every `scopeIncludes` branch
  // and delete NOTHING while reporting success — a deletion the user believes
  // happened. A payload naming a scope this build does not have is not a purge
  // payload, and saying so here is what makes the handler's own read total.
  if (typeof scope !== 'string') return null;
  if (!(USER_DATA_SCOPES as readonly string[]).includes(scope)) return null;

  const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;

  return { userId, scope: scope as UserDataScope, requestId };
}
