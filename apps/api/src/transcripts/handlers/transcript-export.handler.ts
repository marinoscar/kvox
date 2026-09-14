// =============================================================================
// `transcript.export` (issue #28, epic #19, spec §1.5.6 / §8.5)
// =============================================================================
//
// Materialize one version, render it through the exporter its row names, stream
// the result into a managed storage object, and mark the `transcript_exports`
// row `ready`. There is no other path to an export — spec §8.5 is explicit that
// there is no size threshold below which a render happens inside the request,
// because a threshold is exactly the trap `docs/specs/job-queue.md`'s rule 1
// warns against: two code paths for the same operation, where the inline one
// breaks the day a short recording turns out to have a dense correction history
// or a slow render, at the one moment nobody is watching for it.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY IN v1, AND THIS IS NOT ONE OF RULE 2's THREE EXEMPTIONS
// -----------------------------------------------------------------------------
//
// Stated here in full because it is the one job type in this epic that does not
// map onto "writes as it goes", "reads several tables mid-computation", or
// "needs a privilege a remote machine must never hold". Its input is a
// MATERIALIZED SNAPSHOT — pure data a node could be handed with no database
// access at all — and rendering Markdown or a PDF is precisely the CPU-bound,
// secret-free work CLAUDE.md rule 2 says should default to node-eligible.
//
// It is server-only anyway because **the renderers live in the API**. A second,
// independently-maintained copy in `apps/cli`'s node executors would mean the
// SAME export request producing byte-for-byte different PDFs depending on which
// of two codebases happened to claim the job — the same failure
// `docs/specs/worker-nodes.md` §21 rejects for a checksum handler whose
// `persistNodeResult` recomputes, generalised from "a decorative answer" to "a
// different, independently drifting implementation".
//
// That is a SCOPE LINE, not a structural limit, and the distinction matters for
// whoever reads this next: nothing about spec §8's design would have to change
// to make this node-eligible once the renderers are extracted into a package
// both `apps/api` and `apps/cli` can import. Adding `nodeResultSchema` +
// `persistNodeResult` would then be the whole change. Until then this handler
// carries NEITHER member, which is what `JobHandlerRegistry.serverOnlyTypes()`
// derives eligibility from — there is no flag to set inconsistently.
//
// -----------------------------------------------------------------------------
// THE PROFILE, AND WHY `maxAttempts: 2` RATHER THAN 1 OR 3
// -----------------------------------------------------------------------------
//
// `{ maxRuntimeMs: 5 minutes, maxAttempts: 2 }`, exactly as issue #28 specifies.
// Five minutes is generous for a render whose slowest realistic case is a
// hundreds-of-pages PDF and short enough that a wedged export frees its worker
// slot inside the window a user is still waiting. Two attempts because an
// export is IDEMPOTENT — re-rendering the same version with the same options
// produces the same bytes and overwrites the same storage key — so a retry
// after a transient storage failure is free and correct, while a third attempt
// on a genuinely broken document just delays telling the user so.
//
// ⚠ ATTEMPTS ARE CHARGED AT CLAIM TIME. That is what makes "an export survives
// a worker restart" work at all: a process killed mid-render leaves a row whose
// lease expires, the reaper requeues it, and the second claim renders it again
// from scratch. The handler is written to make that second run safe — see
// `alreadyDone` below.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma, TranscriptExport } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptExportService, exportFilename } from '../export/transcript-export.service';
import { TRANSCRIPT_EXPORT_JOB_TYPE } from '../job-types';
import { TranscriptObjectsService } from '../transcript-objects.service';

/** Five minutes. See the file header for the two numbers' reasoning. */
export const EXPORT_MAX_RUNTIME_MS = 5 * 60 * 1000;

@Injectable()
export class TranscriptExportHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptExportHandler.name);

  readonly type = TRANSCRIPT_EXPORT_JOB_TYPE;

  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: EXPORT_MAX_RUNTIME_MS,
    maxAttempts: 2,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly exports: TranscriptExportService,
    private readonly objects: TranscriptObjectsService,
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

    const row = await this.prisma.transcriptExport.findUnique({ where: { id: exportId } });

    if (!row) {
      // The row is gone: the transcript was deleted and purged, or housekeeping
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
      // user is polling `GET /:id/exports/:exportId` and must be told; the
      // queue must still see a failed attempt so the retry budget and the admin
      // job list both mean what they say. Recording one without the other is
      // how an export sits `pending` forever next to a `failed` job, or the
      // reverse.
      await this.prisma.transcriptExport
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

  /** Materialize, render, upload, record. */
  private async render(row: TranscriptExport): Promise<void> {
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
    const filename = exportFilename(doc.title, doc.version, exporter.extension);

    const { body, done } = this.objects.putStream({
      storageKey: `transcripts/${row.transcriptId}/exports/${row.id}.${exporter.extension}`,
      name: filename,
      mimeType: exporter.mimeType,
      ownerId: row.requestedById,
      metadata: {
        transcriptId: row.transcriptId,
        exportId: row.id,
        version: row.version,
        format: row.format,
        kind: 'transcript-export',
      },
    });

    // ⚠ BOTH ARE AWAITED, AND THE ORDER OF THE SETTLEMENTS DOES NOT MATTER.
    // Awaiting only the render reports success on an upload that failed;
    // awaiting only the upload hides an exception the renderer raised. This is
    // the same rule `docs/specs/database-backup.md` states for `pg_dump`'s
    // stdout, and it is wrong in the same silent way if either half is dropped.
    const [, object] = await Promise.all([exporter.render(doc, options, body), done]);

    await this.prisma.transcriptExport.update({
      where: { id: row.id },
      data: { status: 'ready', objectId: object.id, error: null },
    });

    this.logger.log(
      `Exported transcript ${row.transcriptId} v${row.version} as ${row.format} ` +
        `(${object.size.toString()} bytes, export ${row.id})`,
    );
  }
}

/** A row a second attempt must leave alone. See `process`. */
export function alreadyDone(row: TranscriptExport): boolean {
  return row.status === 'ready' && row.objectId !== null;
}

/** One string field out of a job payload. */
function readString(payload: Prisma.JsonValue | null, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const value = (payload as Record<string, unknown>)[key];

  return typeof value === 'string' && value.length > 0 ? value : null;
}
