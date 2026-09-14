// =============================================================================
// `note.export` (issue #54, epic #45, docs/specs/notes.md §8.4 / §8.5)
// =============================================================================
//
// Read one version, render it through the exporter its row names, stream the
// result into a managed storage object, and mark the `note_exports` row
// `ready`. There is no other path to a note export — spec §8.4 is explicit that
// there is no size threshold below which a render happens inside the request,
// because a threshold is exactly the trap `docs/specs/job-queue.md`'s rule 1
// warns against: two code paths for the same operation, where the inline one
// breaks the day a note turns out to be forty pages or the DOCX packer turns
// out to be slow, at the one moment nobody is watching for it.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, AND THIS IS NOT ONE OF RULE 2's THREE EXEMPTIONS
// -----------------------------------------------------------------------------
//
// `docs/specs/notes.md` §8.5's table says "No, in v1 — the identical
// 'renderers live in the API' reasoning `docs/specs/transcription.md` §1.5.6
// states for `transcript.export`", and that argument is carried here in full
// rather than cited, because it is the one job type in this epic that does not
// map onto "writes as it goes", "reads several tables mid-computation", or
// "needs a privilege a remote machine must never hold".
//
// Its input is a MATERIALIZED DOCUMENT — pure data a node could be handed with
// no database access at all — and rendering markdown, a PDF or a DOCX is
// precisely the CPU-bound, secret-free work CLAUDE.md rule 2 says should
// default to node-eligible.
//
// It is server-only anyway because **the renderers live in the API**. A second,
// independently-maintained copy in `apps/cli`'s node executors would mean the
// SAME export request producing byte-for-byte different PDFs depending on which
// of two codebases happened to claim the job — and note that this is strictly
// worse for notes than for transcripts, because a note export is
// CONTENT-ADDRESSED: two renders of `(noteId, version, format, optionsHash)`
// are supposed to be the same file, and the reuse lookup hands the second
// caller the first caller's bytes on exactly that promise. Two renderers that
// could disagree would make that promise false rather than merely untidy.
//
// That is a SCOPE LINE, not a structural limit, and the distinction matters for
// whoever reads this next: nothing about spec §8's design would have to change
// to make this node-eligible once the renderers are extracted into a package
// both `apps/api` and `apps/cli` can import. Adding `nodeResultSchema` +
// `persistNodeResult` would then be the whole change. Until then this handler
// carries NEITHER member — never exactly one — which is what
// `JobHandlerRegistry.serverOnlyTypes()` derives eligibility from; there is no
// flag to set inconsistently.
//
// -----------------------------------------------------------------------------
// THE PROFILE, AND WHY `maxAttempts: 2` RATHER THAN 1 OR 3
// -----------------------------------------------------------------------------
//
// `{ maxRuntimeMs: 5 minutes, maxAttempts: 2 }`, exactly as spec §8.5's table
// specifies and identical to `transcript.export`'s. Five minutes is generous
// for a render whose slowest realistic case is a long note's DOCX and short
// enough that a wedged export frees its worker slot inside the window a user is
// still waiting. Two attempts because an export is IDEMPOTENT — re-rendering
// the same version with the same options produces the same bytes and
// overwrites the same storage key — so a retry after a transient storage
// failure is free and correct, while a third attempt on a genuinely broken
// document just delays telling the user so.
//
// ⚠ ATTEMPTS ARE CHARGED AT CLAIM TIME. That is what makes "an export survives
// a worker restart" work at all: a process killed mid-render leaves a row whose
// lease expires, the reaper requeues it, and the second claim renders it again
// from scratch. The handler is written to make that second run safe — see
// `alreadyDone` below.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, NoteExport, Prisma } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NoteExportService } from '../export/note-export.service';
import { NOTE_EXPORT_JOB_TYPE, NOTES_MANAGED_BY } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';

/** Five minutes. See the file header for the two numbers' reasoning. */
export const NOTE_EXPORT_MAX_RUNTIME_MS = 5 * 60 * 1000;

@Injectable()
export class NoteExportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteExportHandler.name);

  readonly type = NOTE_EXPORT_JOB_TYPE;

  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: NOTE_EXPORT_MAX_RUNTIME_MS,
    maxAttempts: 2,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly exports: NoteExportService,
    private readonly objects: NoteObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const exportId = readString(job.payload, 'exportId');

    if (!exportId) {
      this.logger.warn(`Export job ${job.id} names no export row; nothing to do`);

      return;
    }

    const row = await this.prisma.noteExport.findUnique({ where: { id: exportId } });

    if (!row) {
      // The row is gone: the note was deleted and purged, or housekeeping
      // expired it while this job sat in the queue. Neither is a failure of the
      // render — there is simply nothing left to render into.
      this.logger.log(`Export ${exportId} no longer exists; job ${job.id} has nothing to do`);

      return;
    }

    if (alreadyDone(row)) {
      // A retry after a run that succeeded but whose worker died before the
      // queue recorded it. Re-rendering would orphan the object the first run
      // wrote, since only one `object_id` can be referenced.
      this.logger.log(`Export ${exportId} is already ready; job ${job.id} is a no-op`);

      return;
    }

    try {
      await this.render(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // ⚠ THE ROW IS MARKED BEFORE THE THROW, and the throw still happens. The
      // user is polling the export list and must be told; the queue must still
      // see a failed attempt so the retry budget and the admin job list both
      // mean what they say. Recording one without the other is how an export
      // sits `pending` forever next to a `failed` job, or the reverse.
      await this.prisma.noteExport
        .update({ where: { id: row.id }, data: { status: 'failed', error: message.slice(0, 2000) } })
        .catch((updateError: unknown) => {
          this.logger.error(
            `Could not record the failure of export ${row.id}: ` +
              `${updateError instanceof Error ? updateError.message : String(updateError)}`,
          );
        });

      throw error;
    }
  }

  /** Build, render, upload, record. */
  private async render(row: NoteExport): Promise<void> {
    const exporter = this.exports.exporterFor(row.format);

    if (!exporter) {
      // A format this build does not register — a row written by a deployment
      // that had a plugin exporter, or a fork's format on a framework build.
      // A named domain failure, not a mysterious undefined dereference.
      throw new Error(
        `No exporter is registered for format "${row.format}"; this build cannot render ` +
          `export ${row.id}.`,
      );
    }

    const doc = await this.exports.buildDocument(row);
    const options = this.exports.optionsOf(row, exporter);
    const filename = this.exports.filenameFor(row, doc.title);

    const { body, done } = this.objects.putStream({
      // A PURE FUNCTION OF THE EXPORT ROW, so a retry overwrites the bytes the
      // first attempt wrote rather than leaving an orphan at a random key.
      storageKey: `notes/${row.noteId}/exports/${row.id}.${exporter.extension}`,
      name: filename,
      mimeType: exporter.mimeType,
      ownerId: row.requestedById,
      metadata: {
        noteId: row.noteId,
        exportId: row.id,
        version: row.version,
        format: row.format,
        kind: `${NOTES_MANAGED_BY}-export`,
      },
    });

    // ⚠ BOTH ARE AWAITED, AND THE ORDER OF THE SETTLEMENTS DOES NOT MATTER.
    // Awaiting only the render reports success on an upload that failed;
    // awaiting only the upload hides an exception the renderer raised. This is
    // the same rule `docs/specs/database-backup.md` states for `pg_dump`'s
    // stdout, and it is wrong in the same silent way if either half is dropped.
    const [, object] = await Promise.all([exporter.render(doc, options, body), done]);

    await this.prisma.noteExport.update({
      where: { id: row.id },
      data: { status: 'ready', objectId: object.id, error: null },
    });

    this.logger.log(
      `Exported note ${row.noteId} v${row.version} as ${row.format} ` +
        `(${object.size.toString()} bytes, export ${row.id})`,
    );
  }
}

/** A row a second attempt must leave alone. See `process`. */
export function alreadyDone(row: NoteExport): boolean {
  return row.status === 'ready' && row.objectId !== null;
}

/** One string field out of a job payload. */
function readString(payload: Prisma.JsonValue | null, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const value = (payload as Record<string, unknown>)[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
}
