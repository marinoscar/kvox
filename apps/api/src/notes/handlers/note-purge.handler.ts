// =============================================================================
// `note.purge` (issue #53, epic #45, docs/specs/notes.md §8.5)
// =============================================================================
//
// Removes every row and every byte a deleted note owned — and, deliberately,
// nothing else.
//
// -----------------------------------------------------------------------------
// WHAT IT DELETES
// -----------------------------------------------------------------------------
//
//   • every `note_exports` row and the rendered file behind it (#54);
//   • the note row itself, which CASCADES its versions, its generations and
//     its exports away;
//   • the uploaded SOURCE DOCUMENT and the extracted-text object beside it
//     (#51) — **only when this note is the last thing referencing them**.
//
// -----------------------------------------------------------------------------
// ⚠ WHAT IT DELIBERATELY DOES NOT DELETE
// -----------------------------------------------------------------------------
//
//   • THE SOURCE TRANSCRIPT. A note is derived FROM a recording; deleting the
//     derivative must never delete the evidence. `notes.source_transcript_id`
//     is `Restrict` precisely because "important knowledge should remain
//     connected to its evidence" runs in that direction only, and a purge that
//     reached through the pointer would invert it.
//   • A SOURCE NOTE. Same pointer, same direction, same reasoning — and the
//     delete endpoint already refuses while a derived note exists, so the
//     reverse case cannot arrive here at all.
//   • A SOURCE DOCUMENT ANOTHER NOTE STILL POINTS AT. `source_object_id` is
//     `Restrict`, so PostgreSQL would refuse anyway; checking first turns a
//     foreign-key violation into a logged skip.
//   • ANYTHING ON A PROVIDER. Unlike `transcript.purge`, there is no remote
//     copy to clean up: a chat completion leaves nothing behind the way an
//     in-flight transcription job does (spec §9.4). This handler makes no
//     network call at all.
//
// -----------------------------------------------------------------------------
// OBJECTS FIRST, ROWS LAST — AND THE ORDER IS NOT NEGOTIABLE
// -----------------------------------------------------------------------------
//
// The rows are the ONLY index of which storage objects belong to this note.
// Deleting them first and the objects second means a crash in between orphans
// files with nothing left in the database that knows they exist. Deleting the
// objects first means a crash leaves a `deleting` note whose purge job
// retries — which is why every step below tolerates "already gone".
//
// The ONE exception is the source document, which is deleted AFTER the note
// row and has no choice about it: `notes.source_object_id` is `Restrict`, so
// the storage row is unreachable for deletion while the note exists. The
// failure window that opens is the harmless one — an orphaned object that costs
// storage rather than correctness — and the opposite order is not available.
// `transcript.purge` carries the identical trade-off for the identical reason.
//
// -----------------------------------------------------------------------------
// NO PROFILE, SERVER-ONLY
// -----------------------------------------------------------------------------
//
// Deleting a bounded, enumerable set of objects for one note does not resemble
// the multi-hour shape `maxRuntimeMs` exists for, and retrying IS the recovery
// strategy here — which only works because the handler is re-entrant. It
// declares neither `nodeResultSchema` nor `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` reports it and no node can claim it:
// rule 2's "deletes rows across several tables as it goes", the same reasoning
// `transcript.purge` states.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTE_PURGE_JOB_TYPE } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import { readExtractedObjectId } from '../source-metadata';

@Injectable()
export class NotePurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NotePurgeHandler.name);

  readonly type = NOTE_PURGE_JOB_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: NoteObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const noteId = readNoteId(job.payload);

    if (!noteId) {
      this.logger.warn(`Purge job ${job.id} carries no note id; nothing to do`);

      return;
    }

    // ⚠ `findUnique`, NOT a read that filters out soft-deleted rows — a
    // soft-deleted row is EXACTLY what this handler exists to remove.
    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      include: { exports: { select: { id: true, objectId: true } } },
    });

    if (!note) {
      this.logger.log(`Note ${noteId} is already gone; purge job ${job.id} is a no-op`);

      return;
    }

    let removed = 0;

    // ------------------------------------------------------------------------
    // Exports (#54). Reference first, then bytes, then row.
    // ------------------------------------------------------------------------
    //
    // `note_exports.object_id` is `Restrict`, so the storage row cannot go
    // while the export points at it. `updateMany` rather than `update` so a
    // reference a previous partial run already cleared is a no-op.
    for (const entry of note.exports) {
      await this.prisma.noteExport.updateMany({
        where: { id: entry.id, objectId: { not: null } },
        data: { objectId: null },
      });

      if (await this.objects.deleteIfPresent(entry.objectId)) removed += 1;
    }

    // ------------------------------------------------------------------------
    // The rows. `Cascade` takes versions, generations and exports with them.
    // ------------------------------------------------------------------------
    const sourceObjectId = note.sourceObjectId;

    await this.prisma.note.delete({ where: { id: note.id } });

    // ------------------------------------------------------------------------
    // The source document — ONLY if nothing else names it.
    // ------------------------------------------------------------------------
    if (sourceObjectId) {
      removed += await this.purgeSourceDocument(note.id, sourceObjectId);
    }

    // ⚠ THE SOURCE CLAUSE IS ONLY TRUE FOR THE TWO POINTERS THIS HANDLER NEVER
    // FOLLOWS. A source DOCUMENT may legitimately have been deleted just above,
    // so it is not named here — a log line that claimed otherwise would be the
    // one place an operator went looking for the answer and found the wrong one.
    const untouched =
      note.sourceType === 'document'
        ? ''
        : ` The source ${note.sourceType} was not touched.`;

    this.logger.log(
      `Purged note ${note.id}: ${removed} storage object(s) and every row.${untouched}`,
    );
  }

  /**
   * The uploaded document and its extracted text, if this note was the last
   * note referencing them.
   *
   * ⚠ THE CHECK RUNS AFTER THE NOTE ROW IS GONE, deliberately: the question is
   * "does anything STILL reference this object", and asking it while the row
   * being purged is one of the referrers would answer "yes" forever. A note
   * created from the same document by the same user — an ordinary thing to do —
   * keeps the bytes, and its own purge asks the same question later.
   *
   * The extracted-text object is recorded in the SOURCE object's own metadata
   * (`{ extractedObjectId }`, spec §4.7) rather than in a sixth table, so it is
   * read back from there with the same total reader `note.generate` uses.
   */
  private async purgeSourceDocument(noteId: string, sourceObjectId: string): Promise<number> {
    const others = await this.prisma.note.count({
      where: { sourceObjectId, id: { not: noteId } },
    });

    if (others > 0) {
      this.logger.log(
        `Source document ${sourceObjectId} is still referenced by ${others} other note(s); ` +
          'keeping it',
      );

      return 0;
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: sourceObjectId },
      select: { metadata: true },
    });

    const extractedObjectId = readExtractedObjectId(object?.metadata ?? null);

    let removed = 0;

    // The extraction first: it is an artifact OF the document, and an orphaned
    // extraction with its parent already gone has nothing left pointing at it.
    if (await this.objects.deleteIfPresent(extractedObjectId)) removed += 1;
    if (await this.objects.deleteIfPresent(sourceObjectId)) removed += 1;

    return removed;
  }
}

/**
 * The note id inside a job payload, or `null`.
 *
 * TOTAL OVER GARBAGE, exactly like `readGenerationId` and `readTranscriptId`: a
 * payload is JSONB written by an earlier process and possibly an earlier build
 * — it can be null, a string, an array, or an object with the wrong field.
 * Every one of those means "this job is about nothing", which a handler answers
 * by returning successfully rather than by throwing until the queue gives up.
 */
export function readNoteId(payload: Prisma.JsonValue | null): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).noteId;

  return typeof value === 'string' && value.length > 0 ? value : null;
}
