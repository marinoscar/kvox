// =============================================================================
// `notes.housekeeping` (issue #53, epic #45, docs/specs/notes.md §8.5)
// =============================================================================
//
// The notes module's reconciliation sweep. Three things the rest of the module
// structurally cannot do for itself:
//
// 1. HARD-DELETES EXPIRED PREVIEW GENERATIONS (#50, spec §4.4). A
//    `kind: 'preview'` row has no note, no version and nothing referencing it,
//    which is exactly why it is hard-deleted rather than given a
//    `note_exports`-style `expired` status: there is nothing a soft-expiry
//    status would need to be visible TO. `PREVIEW_TTL_MS` is ten minutes and
//    nothing else ever removes these rows.
//
// 2. EXPIRES EXPORTS (#54, spec §8.4). `note_exports` rows past their
//    `expires_at`, and the storage objects behind them. Written now so that #54
//    does not also have to add a sweep — the identical seam
//    `transcripts.housekeeping` left for issue #28 and for the same reason. A
//    build with no exporters simply finds nothing.
//
// 3. RE-QUEUES NOTES STUCK IN `deleting`. `DELETE /api/notes/:id` soft-deletes
//    and enqueues `note.purge`; a note whose purge job was lost — the process
//    died between the two writes, the job exhausted its attempts, an operator
//    deleted the row — is a note the user believes is gone whose bytes are
//    still in the bucket and whose row still blocks `Restrict` deletes of its
//    source. Nothing else notices: the queue's own lease reaper reasons about
//    JOBS, and here there is no job row to reason about.
//
// -----------------------------------------------------------------------------
// IT IS A JOB, AND THE `@Cron` ONLY ENQUEUES IT
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 1, and `test/jobs/cron-enqueue-only.spec.ts` is its executable
// form: a `@Cron` may decide WHETHER work is due and enqueue it, never do it.
// Everything in this file is the work; `tasks/notes-housekeeping.task.ts` is
// six lines that queue it — with NO new exemption, because there is nothing
// about this sweep that recovery or a local disk depends on.
//
// SERVER-ONLY under rule 2's "reads/writes several tables mid-computation"
// exemption: it sweeps `note_generations`, `note_exports`, `notes`, `jobs` and
// `storage_objects` in one pass, deciding as it goes.
//
// ⚠ NO STEP MAY THROW PAST THE OTHERS. Each of the three is wrapped and their
// failures are collected and reported at the end. A sweep that aborted on the
// first bad row would mean one damaged note stops every other note from ever
// being reconciled — the classic failure mode of a housekeeping job that treats
// its own input as trustworthy.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NOTES_HOUSEKEEPING_JOB_TYPE,
  NOTE_PURGE_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
} from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import { NotesService } from '../notes.service';

/**
 * How long a note may sit in `deleting` before the sweep presumes its purge is
 * not coming.
 *
 * Comfortably longer than a purge takes (it deletes a handful of small objects)
 * and longer than the queue's own retry backoff, so a purge that is merely
 * being retried is never mistaken for one that is gone.
 */
export const DELETING_GRACE_MINUTES = 30;

/** Most rows any one sweep will act on, per step. */
export const NOTES_HOUSEKEEPING_BATCH = 200;

@Injectable()
export class NotesHousekeepingHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NotesHousekeepingHandler.name);

  readonly type = NOTES_HOUSEKEEPING_JOB_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: NoteObjectsService,
    private readonly notes: NotesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const now = new Date();
    const failures: string[] = [];

    let previews = 0;
    let exports = 0;
    let requeued = 0;

    try {
      previews = await this.expirePreviews(now);
    } catch (error) {
      failures.push(`expiring preview generations: ${describe(error)}`);
    }

    try {
      exports = await this.expireExports(now);
    } catch (error) {
      failures.push(`expiring exports: ${describe(error)}`);
    }

    try {
      requeued = await this.requeueStalledPurges(now);
    } catch (error) {
      failures.push(`re-queueing stalled purges: ${describe(error)}`);
    }

    this.logger.log(
      `Note housekeeping (job ${job.id}): ${previews} preview generation(s) removed, ` +
        `${exports} export(s) expired, ${requeued} stalled purge(s) re-queued`,
    );

    if (failures.length > 0) {
      // THROWN, so the sweep is retried and shows as failed in the admin job
      // list — after every step has had its turn. A sweep that reported success
      // having skipped a step is a sweep nobody ever finds out about.
      throw new Error(`Note housekeeping had failures: ${failures.join('; ')}`);
    }
  }

  /** Step 1 — see the file header. */
  private async expirePreviews(now: Date): Promise<number> {
    const stale = await this.prisma.noteGeneration.findMany({
      // ⚠ `kind: 'preview'` AS WELL AS THE TIMESTAMP, even though only a
      // preview is ever given an `expiresAt`. A create/regenerate row acquiring
      // one by accident would otherwise be swept away with the note still
      // pointing at it through `currentGenerationId`, and the note's own
      // provenance line would lose the row it names.
      where: { kind: 'preview', expiresAt: { lt: now } },
      select: { id: true },
      take: NOTES_HOUSEKEEPING_BATCH,
    });

    if (stale.length === 0) return 0;

    const removed = await this.prisma.noteGeneration.deleteMany({
      where: { id: { in: stale.map((entry) => entry.id) } },
    });

    return removed.count;
  }

  /** Step 2 — see the file header. */
  private async expireExports(now: Date): Promise<number> {
    const stale = await this.prisma.noteExport.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, objectId: true },
      take: NOTES_HOUSEKEEPING_BATCH,
    });

    let expired = 0;

    for (const entry of stale) {
      // ROW REFERENCE FIRST, THEN BYTES, THEN ROW. `object_id` is `Restrict`,
      // so the storage row cannot go while the export points at it.
      await this.prisma.noteExport.update({
        where: { id: entry.id },
        data: { objectId: null },
      });

      await this.objects.deleteIfPresent(entry.objectId);
      await this.prisma.noteExport.delete({ where: { id: entry.id } });

      expired += 1;
    }

    return expired;
  }

  /** Step 3 — see the file header. */
  private async requeueStalledPurges(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - DELETING_GRACE_MINUTES * 60_000);

    const stuck = await this.prisma.note.findMany({
      where: { status: 'deleting', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: NOTES_HOUSEKEEPING_BATCH,
    });

    if (stuck.length === 0) return 0;

    // ONE QUERY FOR EVERY CANDIDATE'S JOBS, not one per note: a per-row lookup
    // turns a sweep into an N+1 over a table the queue is already contending
    // on.
    const live = await this.prisma.job.findMany({
      where: {
        type: NOTE_PURGE_JOB_TYPE,
        subjectType: NOTE_SUBJECT_TYPE,
        subjectId: { in: stuck.map((entry) => entry.id) },
        status: { in: ['pending', 'running'] },
      },
      select: { subjectId: true },
    });

    const covered = new Set(live.map((entry) => entry.subjectId));
    let requeued = 0;

    for (const entry of stuck) {
      if (covered.has(entry.id)) continue;

      this.logger.warn(
        `Note ${entry.id} has been deleting since before the grace window with no purge job; ` +
          're-queueing it',
      );

      await this.notes.enqueuePurge(entry.id);

      requeued += 1;
    }

    return requeued;
  }
}

/** Anything thrown, as a message. JavaScript lets you throw a string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
