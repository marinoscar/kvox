// =============================================================================
// `note.retitle` (issue #184, epic #163) — naming the library that already exists
// =============================================================================
//
// #182 names a note the moment its body commits. That fixes every note made
// FROM THEN ON and leaves every note already in the library called after its
// template — four rows called "Meeting notes" and no way to tell them apart
// short of renaming fifty of them by hand. This handler is the retroactive
// half: one job per note, queued by `POST /api/notes/{id}/retitle` (one note,
// the "Suggest a title" button) or `POST /api/notes/retitle` (a capped,
// resumable sweep).
//
// -----------------------------------------------------------------------------
// ⚠ A JOB, AND DELIBERATELY NOT A MIGRATION
// -----------------------------------------------------------------------------
//
// The obvious shape for "fix every existing row" is a data migration, and it is
// the wrong one here. Titling rank 1 spends THE NOTE OWNER'S OWN VENDOR KEY on
// THEIR OWN account (spec §9: this epic is strict bring-your-own-key), and
// `migrate deploy` must never bill a user's account on their behalf — least of
// all as an invisible side effect of an operator deploying a release. Quite
// apart from that, CLAUDE.md's standing rule settles the shape on its own: a
// pass over a whole library outlives the request that asked for it, so it is a
// registered `JobHandler` enqueued through `JobsService` and nothing else.
//
// Being a job is also what makes the sweep OPERABLE: each note's work is one
// row in `GET /api/admin/jobs`, independently retryable, and a sweep is stopped
// by simply not asking for the next page.
//
// -----------------------------------------------------------------------------
// `profile: { maxAttempts: 1 }` — THE SAME ARGUMENT `note.generate` MAKES
// -----------------------------------------------------------------------------
//
// A retry would call the same provider with the same user's own key for an
// answer that is not deterministic, and bill them twice for it. See
// `note-generate.handler.ts`'s header for the argument in full; it is the
// identical one and is not restated here. `POST /api/notes/{id}/retitle` is the
// retry path, the same relationship `POST /api/notes/{id}/regenerate` has with
// `note.generate`.
//
// `maxRuntimeMs` IS TWO MINUTES, AND IT IS NOT A GUESS. `JobExecutionProfile`
// requires both numbers — the lease is DERIVED from `maxRuntimeMs` precisely so
// it cannot contradict a declared timeout — so a type that declares one must
// declare the other. Everything this handler does is bounded already:
// `NoteTitleService` caps its own provider call at the smaller of 30 seconds
// and `ai.requestTimeoutMs`, and the rest is two indexed row reads. Two minutes
// is several times the worst honest case and still far below the ten-minute
// deployment default, which matters in the direction people forget: the lease
// comes from this number, so a worker that dies mid-retitle makes the job
// reclaimable in about two minutes rather than in ten. It is deliberately NOT
// `note.generate`'s ten minutes — this job does not generate a note.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY
// -----------------------------------------------------------------------------
//
// Neither `nodeResultSchema` nor `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` reports `note.retitle` and no node can
// ever claim it. The reason is `note.generate`'s, unchanged: the credential is
// the owner's own long-lived account key, no vendor here offers a job-scoped
// sub-key for a `nodeSecretBroker` to broker, and shipping somebody's personal
// API key to a machine this deployment does not own is not an alternative.
//
// -----------------------------------------------------------------------------
// ⚠ SUCCESS MEANS "CONSIDERED", NOT "RENAMED"
// -----------------------------------------------------------------------------
//
// `NoteTitleService.titleNote` never throws — that is its load-bearing property
// (see its header) — so this `process` essentially cannot fail, and that is
// correct rather than a gap in the error handling. Rank 2 (the note's own first
// heading) and rank 3 (it keeps the name it has) are SUCCESSFUL OUTCOMES of a
// pass that ran: a user with no API key saved, or a deployment with AI switched
// off, gets a heading-derived title or an unchanged one, and neither is a
// failure anybody should be paged about. A `failed` row here would mean
// something genuinely unexpected — a database that could not be read — and
// nothing else.
//
// One implementation of the ranks, not two: this handler resolves nothing about
// providers, models or keys itself. It decides only WHETHER this note should be
// considered, and hands the rest to the same service `NoteGenerationService
// .commit` calls.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NoteTitleService } from '../generation/note-title.service';
import { NOTE_RETITLE_JOB_TYPE } from '../job-types';
import { readNoteId } from './note-purge.handler';

/** Two minutes. Also the lease, indirectly — see the header. */
export const NOTE_RETITLE_MAX_RUNTIME_MS = 2 * 60 * 1000;

@Injectable()
export class NoteRetitleHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteRetitleHandler.name);

  readonly type = NOTE_RETITLE_JOB_TYPE;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: NOTE_RETITLE_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly titles: NoteTitleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);

    // ⚠ NO `registerProviderKey` HERE, for `note.generate`'s reason exactly:
    // the bucket is PER USER (spec §2.3) and a user is not known until a job is
    // running. `NoteTitleService` registers it, for this type, immediately
    // before the provider call — which is why `titleNote` takes a `jobType`.
  }

  async process(job: Job): Promise<void> {
    const noteId = readNoteId(job.payload);

    if (!noteId) {
      this.logger.warn(`Retitle job ${job.id} carries no note id; nothing to do`);

      return;
    }

    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      select: {
        id: true,
        ownerId: true,
        body: true,
        status: true,
        titleSource: true,
        deletedAt: true,
        provider: true,
        model: true,
      },
    });

    // -------------------------------------------------------------------------
    // Four skips, all of them RETURNING NORMALLY with a log line.
    // -------------------------------------------------------------------------
    //
    // A sweep queues a page of notes and the jobs run minutes later; by then a
    // note may have been deleted, renamed, or sent back through a generation.
    // Every one of those is an ordinary thing for a user to do between the
    // request and the run, not an error, and a `failed` row for one would put
    // noise in the admin job list for a library that is behaving correctly.
    if (!note) {
      this.logger.log(`Note ${noteId} is gone; retitle job ${job.id} is a no-op`);

      return;
    }

    if (note.deletedAt !== null || note.status === 'deleting') {
      this.logger.log(`Note ${note.id} is being deleted; it is not retitled`);

      return;
    }

    if (note.status !== 'ready') {
      // `draft`/`generating` — the generation that is about to commit will name
      // it through #182's path, which is the same service with fresher input.
      // `failed` — there is no body to name it from.
      this.logger.log(`Note ${note.id} is ${note.status}, not ready; it is not retitled`);

      return;
    }

    const force = readForce(job.payload);

    if (note.titleSource === 'user' && !force) {
      // ⚠ THE BULK SWEEP'S GUARD, and it is checked HERE as well as inside
      // `titleNote` on purpose: a name a person chose must cost nothing to skip
      // — no provider call, no tokens, no round trip. The service's own check
      // is the one that closes the race; this one is the one that keeps a sweep
      // over a mostly hand-named library free.
      this.logger.log(`Note ${note.id} has a user-chosen title; it is left alone`);

      return;
    }

    // ⚠ `note.provider` AND `note.model` STRAIGHT THROUGH, NULLS INCLUDED. They
    // are nullable — a note whose first generation predates those columns, or
    // one that was never generated — and `titleNote` already answers a null
    // pair by skipping rank 1 and deriving a title from the body instead. A
    // default invented here would be this file guessing which model to bill
    // somebody's account for.
    const title = await this.titles.titleNote({
      noteId: note.id,
      ownerId: note.ownerId,
      body: note.body,
      providerId: note.provider,
      model: note.model,
      force,
      jobType: this.type,
    });

    this.logger.log(`Retitle job ${job.id} considered note ${note.id}; it is now "${title ?? ''}"`);
  }
}

/**
 * Whether this job was asked to rename a note its owner named themselves.
 *
 * TOTAL OVER GARBAGE, exactly like `readNoteId` next door: a payload is JSONB
 * written by an earlier process and possibly an earlier build. ⚠ ANYTHING THAT
 * IS NOT LITERALLY `true` IS `false` — a missing, malformed or unreadable
 * payload must fall on the side that leaves a person's own title alone, because
 * that is the only side of this decision with no undo.
 */
export function readForce(payload: Prisma.JsonValue | null): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return false;
  }

  return (payload as Record<string, unknown>).force === true;
}
