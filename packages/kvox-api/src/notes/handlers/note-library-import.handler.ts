// =============================================================================
// `note.library.import` (issue #715, epic #708; docs/specs/notes.md §8.8)
// =============================================================================
//
// One job per batch item: the uploaded file becomes a note (a NEW file) or a new version of
// the note an earlier import made (a CHANGED file). The upload route stored the bytes and
// queued this job in the same transaction as the item.
//
// SERVER-ONLY, on purpose. It reads several tables and writes the note, its version, the
// item and the library file together, so it declares neither `nodeResultSchema` nor
// `persistNodeResult` (a worker node would have to hold database access).
//
// A FILE THE PARSER REFUSES IS A DOMAIN OUTCOME, NOT A CRASH: the item is `failed` with the
// reason and the job returns normally (a retry would re-ask a question whose answer cannot
// change). An unexpected throw retries; on the last attempt the item is marked
// `internal_error` so a batch never sits `running` for a job that is gone.
//
// ⚠ AFTER-COMMIT STEPS NEVER RUN INSIDE THE TRANSACTION: audit, search index, `note_ready`
// (`origin: 'library'`, `bulk: true`, only when the library's `autoExtract` is on) and the
// batch status refresh. Each is its own try/catch: none can undo the committed note.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxEventsPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../ports/index.js';
import { SEARCH_DOC_NOTE, SearchIndexService } from '../../search/index.js';
import type { KvoxNotesDb, NoteImportBatchItemRow, NoteRow } from '../data/notes-db.js';
import { normalizeDocumentMimeType } from '../extraction/document-format.js';
import { documentToNoteBody } from '../extraction/index.js';
import { NOTE_LIBRARY_IMPORT_JOB_TYPE } from '../job-types.js';
import { NoteLibrariesService } from '../library/note-libraries.service.js';
import { NoteObjectsService } from '../note-objects.service.js';
import { NoteVersionWriter } from '../note-version-writer.js';
import { NOTE_READY_EVENT, type NoteReadyEvent } from '../notes.events.js';

/** One import may run five minutes: a large PDF or Office file, not a pathological one. */
const LIBRARY_IMPORT_MAX_RUNTIME_MS = 5 * 60 * 1000;

/** Attempts a job gets. */
const LIBRARY_IMPORT_MAX_ATTEMPTS = 3;

/** `failure_reason` is a short code. */
const MAX_REASON_CHARS = 64;

/** Failure reasons that mark the library file `unsupported` rather than `failed`. */
const UNSUPPORTED_REASONS: ReadonlySet<string> = new Set(['unsupported_office_format', 'unsupported_document']);

/** What the job carries. */
interface LibraryImportPayload {
  itemId?: string;
}

/** What the note write left. */
interface Written {
  noteId: string;
  version: number;
}

/**
 * NoteLibraryImportHandler: wiring the slice registers itself; a host configures it through
 * `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteLibraryImportHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteLibraryImportHandler.name);

  readonly type = NOTE_LIBRARY_IMPORT_JOB_TYPE;

  readonly label = 'Note library import';

  readonly profile: KvoxJobProfile = {
    maxRuntimeMs: LIBRARY_IMPORT_MAX_RUNTIME_MS,
    maxAttempts: LIBRARY_IMPORT_MAX_ATTEMPTS,
  };

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_AUDIT) private readonly audit: KvoxAuditPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly objects: NoteObjectsService,
    private readonly versions: NoteVersionWriter,
    private readonly searchIndex: SearchIndexService,
    private readonly libraries: NoteLibrariesService,
  ) {}

  /** Self-registration. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const itemId = (job.payload as LibraryImportPayload | null)?.itemId ?? job.subjectId;
    if (!itemId) return;

    const item = await this.prisma.noteImportBatchItem.findUnique({ where: { id: itemId } });
    if (!item) {
      this.logger.warn(`Import item ${itemId} is gone; job ${job.id} is a no-op`);
      return;
    }
    // At-least-once delivery: a finished item is never imported twice.
    if (item.status === 'imported') return;

    try {
      await this.importItem(item);
    } catch (error) {
      if (job.attempts >= this.profile.maxAttempts) {
        await this.failItem(item, 'internal_error', false).catch((inner: unknown) => {
          this.logger.warn(`Could not mark import item ${item.id} failed: ${String(inner)}`);
        });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------

  private async importItem(item: NoteImportBatchItemRow): Promise<void> {
    const batch = await this.prisma.noteImportBatch.findUnique({ where: { id: item.batchId } });
    if (!batch) {
      this.logger.warn(`Batch ${item.batchId} of import item ${item.id} is gone`);
      return;
    }
    const ownerId = batch.ownerId;
    const library = batch.libraryId ? await this.prisma.noteLibrary.findUnique({ where: { id: batch.libraryId } }) : null;
    const file = item.fileId ? await this.prisma.noteLibraryFile.findUnique({ where: { id: item.fileId } }) : null;

    await this.prisma.noteImportBatchItem.update({ where: { id: item.id }, data: { status: 'importing' } });

    const sourceObjectId = item.sourceObjectId;
    const info = sourceObjectId ? await this.objects.describe(sourceObjectId) : null;
    const bytes = sourceObjectId && info ? await this.objects.downloadBuffer(sourceObjectId) : null;
    const mimeType = normalizeDocumentMimeType(info?.mimeType);
    if (!sourceObjectId || !bytes || !mimeType) {
      await this.failItem(item, 'source_missing', true);
      return;
    }

    const where = item.path ?? item.filename;
    const parsed = await documentToNoteBody(bytes, mimeType, item.filename);
    if (!parsed.ok) {
      await this.failItem(item, parsed.reason, true);
      return;
    }

    const existing = file?.noteId
      ? await this.prisma.note.findFirst({ where: { id: file.noteId, ownerId, deletedAt: null } })
      : null;

    let written: Written;
    let diverged = false;
    let previousObjectId: string | null = null;

    if (file && existing) {
      diverged = file.importedVersion != null && existing.currentVersion !== file.importedVersion;
      previousObjectId = existing.sourceObjectId;
      written = await this.prisma.$transaction(async (tx) => {
        const updated = await this.versions.commit(
          {
            noteId: existing.id,
            baseVersion: existing.currentVersion,
            body: parsed.body,
            bodyFormat: parsed.bodyFormat,
            kind: 'edit',
            authorId: ownerId,
            summary: `Updated from ${where}`,
            sourceObjectId,
            noteStatus: existing.status,
          },
          tx,
        );
        await tx.noteImportBatchItem.update({
          where: { id: item.id },
          data: { status: 'imported', noteId: updated.id, noteVersion: updated.currentVersion, diverged, failureReason: null },
        });
        await tx.noteLibraryFile.update({
          where: { id: file.id },
          data: {
            importedVersion: updated.currentVersion,
            status: diverged ? 'diverged' : 'imported',
            failureReason: null,
          },
        });
        return { noteId: updated.id, version: updated.currentVersion };
      });
    } else {
      written = await this.prisma.$transaction(async (tx) => {
        const note: NoteRow = await tx.note.create({
          data: {
            ownerId,
            title: parsed.title,
            titleSource: 'user',
            body: parsed.body,
            bodyFormat: parsed.bodyFormat,
            status: 'ready',
            currentVersion: 1,
            sourceType: 'document',
            sourceObjectId,
          },
        });
        await tx.noteVersion.create({
          data: {
            noteId: note.id,
            version: 1,
            kind: 'edit',
            body: parsed.body,
            bodyFormat: parsed.bodyFormat,
            summary: `Imported from ${where}`,
            authorId: ownerId,
          },
        });
        await tx.noteImportBatchItem.update({
          where: { id: item.id },
          data: { status: 'imported', noteId: note.id, noteVersion: 1, diverged: false, failureReason: null },
        });
        if (file) {
          await tx.noteLibraryFile.update({
            where: { id: file.id },
            data: { noteId: note.id, importedVersion: 1, status: 'imported', failureReason: null },
          });
        }
        return { noteId: note.id, version: 1 };
      });
    }

    await this.afterCommit({
      item,
      ownerId,
      written,
      diverged,
      sourceObjectId,
      previousObjectId,
      autoExtract: library ? library.autoExtract : true,
      bytes: bytes.byteLength,
    });
  }

  /** Records a permanent (or final) failure of the item and its file, then the batch status. */
  private async failItem(item: NoteImportBatchItemRow, reason: string, permanent: boolean): Promise<void> {
    const failureReason = reason.slice(0, MAX_REASON_CHARS);
    await this.prisma.noteImportBatchItem.update({ where: { id: item.id }, data: { status: 'failed', failureReason } });
    if (item.fileId) {
      await this.prisma.noteLibraryFile.update({
        where: { id: item.fileId },
        data: { status: permanent && UNSUPPORTED_REASONS.has(reason) ? 'unsupported' : 'failed', failureReason },
      });
    }
    await this.libraries.refreshBatchStatus(item.batchId).catch((error: unknown) => {
      this.logger.warn(`Could not refresh batch ${item.batchId}: ${String(error)}`);
    });
  }

  /** Audit, search, ready event, old-object cleanup, batch status: none can undo the commit. */
  private async afterCommit(input: {
    item: NoteImportBatchItemRow;
    ownerId: string;
    written: Written;
    diverged: boolean;
    sourceObjectId: string;
    previousObjectId: string | null;
    autoExtract: boolean;
    bytes: number;
  }): Promise<void> {
    const { item, ownerId, written } = input;

    try {
      await this.audit.record({
        actorUserId: ownerId,
        action: 'note:library_import',
        targetType: 'note',
        targetId: written.noteId,
        meta: {
          batchId: item.batchId,
          itemId: item.id,
          version: written.version,
          diverged: input.diverged,
          bytes: input.bytes,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not audit library import of note ${written.noteId}: ${String(error)}`);
    }

    try {
      await this.searchIndex.enqueue(SEARCH_DOC_NOTE, written.noteId);
    } catch (error) {
      this.logger.warn(`Could not queue a search index of imported note ${written.noteId}: ${String(error)}`);
    }

    if (input.autoExtract) {
      try {
        this.events.emit(NOTE_READY_EVENT, {
          noteId: written.noteId,
          ownerId,
          version: written.version,
          origin: 'library',
          bulk: true,
        } satisfies NoteReadyEvent);
      } catch (error) {
        this.logger.warn(`Could not publish ${NOTE_READY_EVENT} for imported note ${written.noteId}: ${String(error)}`);
      }
    }

    if (input.previousObjectId && input.previousObjectId !== input.sourceObjectId) {
      try {
        const stillUsed = await this.prisma.note.findFirst({
          where: { sourceObjectId: input.previousObjectId, id: { not: written.noteId } },
        });
        if (!stillUsed) await this.objects.deleteIfPresent(input.previousObjectId);
      } catch (error) {
        this.logger.warn(`Could not delete the previous source ${input.previousObjectId}: ${String(error)}`);
      }
    }

    try {
      await this.libraries.refreshBatchStatus(item.batchId);
    } catch (error) {
      this.logger.warn(`Could not refresh batch ${item.batchId}: ${String(error)}`);
    }
  }
}
