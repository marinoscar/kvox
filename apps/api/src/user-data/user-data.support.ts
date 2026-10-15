// =============================================================================
// Shared plumbing for the user-data hooks (issue #460)
// =============================================================================
//
// Everything the purge steps used to share as private members of
// `UserDataPurgeHandler` — the batch bounds, the audit row, the live-purge
// coverage check — now has to be reachable from hook classes that live in other
// folders. They sit here, in the user-data module, because the dependency runs
// one way: a domain's `*.user-data.ts` imports this file; this file imports no
// domain.
// =============================================================================

import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { UserDataHookInject } from './user-data.registries';

/**
 * Rows per batch, matching `NOTES_HOUSEKEEPING_BATCH`.
 *
 * The number is a compromise between round trips and the size of the `IN` list
 * the job lookup builds; 200 is what the notes sweep already settled on and
 * there is no reason for this file to pick a different one.
 */
export const USER_DATA_PURGE_BATCH = 200;

/**
 * Most batches any one step will run before giving up.
 *
 * A STOP, NOT A BUDGET. Every loop below terminates by its own predicate
 * (a soft-deleted note no longer matches `deletedAt: null`), so reaching this
 * bound means a row is being selected and not changed — a state where looping
 * forever would hold a worker slot and produce nothing. Hitting it throws, so
 * the job fails loudly with the step named instead of running until the
 * timeout.
 */
export const USER_DATA_PURGE_MAX_BATCHES = 5_000;

/** Anything thrown, as a message. JavaScript lets you throw a string. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One audit row per destructive step.
 *
 * `targetType: 'user'` and `targetId` the user's own id, matching both
 * `UserDataService.audit` and the job's own `subject_type`/`subject_id`: the
 * whole trail for one deletion is greppable by the account it happened to,
 * which is the only key that spans six tables.
 */
export async function auditUserData(
  prisma: Pick<PrismaService, 'auditEvent'>,
  userId: string,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorUserId: userId,
      action,
      targetType: 'user',
      targetId: userId,
      meta: meta as Prisma.InputJsonValue,
    },
  });
}

/**
 * Queue a per-item purge for each id a live purge job does not already cover.
 *
 * ⚠ ONE `job.findMany` FOR THE WHOLE BATCH, never one lookup per id — the
 * shape `notes.housekeeping`'s `requeueStalledPurges` established, and for
 * the same reason: a per-row query turns a sweep into an N+1 against the very
 * table the queue is contending on.
 *
 * The check is an optimisation rather than a correctness requirement —
 * `JobsService.enqueue` deduplicates on `(type, subjectType, subjectId)`
 * while a job is `pending`/`running` anyway — but it saves several hundred
 * insert-then-conflict-then-re-read round trips per batch on a re-run.
 */
export async function enqueuePurges(
  prisma: Pick<PrismaService, 'job'>,
  ids: string[],
  jobType: string,
  subjectType: string,
  enqueue: (id: string) => Promise<void>,
): Promise<void> {
  const live = await prisma.job.findMany({
    where: {
      type: jobType,
      subjectType,
      subjectId: { in: ids },
      status: { in: ['pending', 'running'] },
    },
    select: { subjectId: true },
  });

  const covered = new Set(live.map((entry) => entry.subjectId));

  for (const id of ids) {
    if (covered.has(id)) continue;

    await enqueue(id);
  }
}

/**
 * Resolve the provider behind a category hook, or THROW.
 *
 * ⚠ AN UNRESOLVABLE HOOK FAILS THE JOB (or the summary request); it is never
 * skipped. A category whose hook cannot be found is a category this run would
 * silently not delete while reporting success — a deletion the user believes
 * happened. `ModuleRef.get` throws for an unknown provider; a provider that
 * resolves to nothing is treated the same way.
 */
export function resolveUserDataHook(
  moduleRef: Pick<ModuleRef, 'get'>,
  inject: UserDataHookInject,
  categoryId: string,
  role: 'summary' | 'purge',
): unknown {
  const name = typeof inject === 'string' ? inject : (inject as Type<unknown>).name;
  let instance: unknown;

  try {
    instance = moduleRef.get(inject as never, { strict: false });
  } catch (error) {
    throw new Error(
      `User-data ${role} hook "${name}" for category "${categoryId}" could not be resolved: ` +
        `${describe(error)}. Provide it in its domain module.`,
    );
  }

  if (instance === undefined || instance === null) {
    throw new Error(
      `User-data ${role} hook "${name}" for category "${categoryId}" could not be resolved. ` +
        'Provide it in its domain module.',
    );
  }

  return instance;
}
