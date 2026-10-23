import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  detectKvoxImport,
  normalizeLibraryPath,
  type NoteImportItemAction,
} from '@marinoscar/kvox-contract/notes';

import { KVOX_JOBS, KVOX_PRISMA, type KvoxJobsPort } from '../../ports/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { normalizeDocumentMimeType } from '../extraction/document-format.js';
import { safeFilename } from '../import/note-import.service.js';
import { NOTE_LIBRARY_IMPORT_JOB_TYPE } from '../job-types.js';
import { NoteObjectsService } from '../note-objects.service.js';
import type { NotesActor } from '../notes-actor.js';
import { documentExtension, sourceDocumentStorageKey } from '../source-metadata.js';
import { NOTE_IMPORT_BATCH_NOT_FOUND_MESSAGE } from './note-libraries.service.js';

// =============================================================================
// NoteLibraryUploadService (issue #715, epic #708; docs/specs/notes.md §8.8)
// =============================================================================
//
// `POST /api/notes/import-batches/:id/files` and `.../retry`. An upload stores the bytes as
// the note's future source document and ENQUEUES `note.library.import`; the parse and the
// note write are the job's (`NoteLibraryImportHandler`), because a PDF or an Office file
// outlives the request that uploaded it.
//
// THE ORDER: hash, skip when the library already holds the same bytes, put the object
// (never hold a transaction across storage), then ONE transaction: the library file row,
// the batch item and the job (`enqueueWithin`), so a committed item always has its job.
// A failed transaction deletes the object again.
// =============================================================================

/**
 * The `subject_type` of a job about one batch item.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_ITEM_SUBJECT_TYPE = 'note_import_batch_item';

/**
 * What the upload route reads off the multipart body.
 *
 * @stability experimental
 */
export interface NoteLibraryUploadInput {
  /** The client's file name (display only). */
  filename: string;
  /** The bytes. */
  body: Buffer;
  /** The `path` field: the library-relative path. */
  path?: string | undefined;
  /** The `mtime` field, ms since the epoch. */
  mtimeMs?: number | undefined;
}

/**
 * What an upload answers.
 *
 * @stability experimental
 */
export interface NoteLibraryUploadResult {
  /** The batch item, or `null` when the upload was a no-op. */
  itemId: string | null;
  /** `new` or `changed`; `null` when skipped. */
  action: NoteImportItemAction | null;
  /** True when the library already held these exact bytes. */
  skipped: boolean;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The 400 of a file the import cannot read. */
function unsupported(reason: string, message: string): BadRequestException {
  return new BadRequestException({ message, details: { reason } });
}

/**
 * Uploads into import batches.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteLibraryUploadService {
  private readonly logger = new Logger(NoteLibraryUploadService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    private readonly objects: NoteObjectsService,
  ) {}

  /**
   * Accepts one file into a batch.
   *
   * @throws NotFoundException when the batch is not the caller's.
   * @throws ConflictException when the batch was cancelled.
   * @throws BadRequestException (`details.reason`: `invalid_path`, `unsupported_document`).
   */
  async upload(actor: NotesActor, batchId: string, input: NoteLibraryUploadInput): Promise<NoteLibraryUploadResult> {
    const batch = await this.prisma.noteImportBatch.findFirst({ where: { id: batchId, ownerId: actor.id } });
    if (!batch) throw new NotFoundException(NOTE_IMPORT_BATCH_NOT_FOUND_MESSAGE);
    if (batch.status === 'cancelled') {
      throw new ConflictException({ message: 'This import batch was cancelled.', details: { reason: 'batch_cancelled' } });
    }

    const filename = safeFilename(input.filename);
    const rawPath = input.path !== undefined && input.path !== '' ? input.path : filename;
    const path = normalizeLibraryPath(rawPath);
    if (path === null) throw unsupported('invalid_path', 'The file path is not a valid library-relative path.');

    const target = detectKvoxImport({ filename, head: input.body.subarray(0, 4096) });
    const mimeType =
      target.kind === 'note_document' || target.kind === 'note_markdown' ? normalizeDocumentMimeType(target.mimeType) : null;
    if (mimeType === null) {
      const legacy = target.kind === 'note_document';
      throw unsupported(
        legacy ? 'unsupported_office_format' : 'unsupported_document',
        legacy
          ? 'This is a legacy Office file. Save it as .docx or .pptx and import that.'
          : 'This file type cannot be imported as a note.',
      );
    }

    const contentHash = createHash('sha256').update(input.body).digest('hex');
    const libraryId = batch.libraryId;

    if (libraryId) {
      const existing = await this.prisma.noteLibraryFile.findFirst({ where: { libraryId, relativePath: path } });
      if (existing && existing.contentHash === contentHash && existing.status === 'imported') {
        return { itemId: null, action: null, skipped: true };
      }
    }

    const source = await this.objects.put({
      storageKey: sourceDocumentStorageKey(randomUUID(), documentExtension(mimeType)),
      name: filename,
      mimeType,
      body: input.body,
      ownerId: actor.id,
      metadata: { uploadedFilename: filename, kind: 'note-library-import', ...(libraryId ? { libraryId } : {}) },
    });

    const now = new Date();
    const mtime = input.mtimeMs !== undefined && Number.isFinite(input.mtimeMs) && input.mtimeMs > 0 ? new Date(input.mtimeMs) : now;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        let fileId: string | null = null;
        let action: NoteImportItemAction = 'new';

        if (libraryId) {
          const existing = await tx.noteLibraryFile.findFirst({ where: { libraryId, relativePath: path } });
          const data = {
            size: BigInt(input.body.byteLength),
            mtime,
            contentHash,
            status: 'importing' as const,
            failureReason: null,
            lastSeenAt: now,
          };
          if (existing) {
            action = existing.noteId ? 'changed' : 'new';
            await tx.noteLibraryFile.update({ where: { id: existing.id }, data });
            fileId = existing.id;
          } else {
            const created = await tx.noteLibraryFile.create({ data: { libraryId, relativePath: path, ...data } });
            fileId = created.id;
          }
        }

        const item = await tx.noteImportBatchItem.create({
          data: {
            batchId,
            fileId,
            filename: basename(path),
            path,
            action,
            sourceObjectId: source.id,
            status: 'queued',
          },
        });
        const job = await this.jobs.enqueueWithin(tx, {
          type: NOTE_LIBRARY_IMPORT_JOB_TYPE,
          reason: 'import',
          subjectType: NOTE_IMPORT_ITEM_SUBJECT_TYPE,
          subjectId: item.id,
          priority: 0,
          payload: { itemId: item.id },
        });
        await tx.noteImportBatchItem.update({ where: { id: item.id }, data: { jobId: job.id } });

        if (batch.status !== 'running') {
          await tx.noteImportBatch.update({ where: { id: batchId }, data: { status: 'running', finishedAt: null } });
        }

        return { itemId: item.id, action, skipped: false };
      });

      return result;
    } catch (error) {
      await this.objects.deleteIfPresent(source.id).catch((cleanup: unknown) => {
        this.logger.warn(`Could not delete the object of a failed library upload (${source.id}): ${String(cleanup)}`);
      });
      throw error;
    }
  }

  /**
   * Re-queues every failed item whose source object still exists.
   *
   * @returns how many items went back to `queued`.
   * @throws NotFoundException when the batch is not the caller's.
   */
  async retry(actor: NotesActor, batchId: string): Promise<{ requeued: number }> {
    const batch = await this.prisma.noteImportBatch.findFirst({ where: { id: batchId, ownerId: actor.id } });
    if (!batch) throw new NotFoundException(NOTE_IMPORT_BATCH_NOT_FOUND_MESSAGE);

    const failed = await this.prisma.noteImportBatchItem.findMany({
      where: { batchId, status: 'failed', sourceObjectId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const retryable: typeof failed = [];
    for (const item of failed) {
      if (item.sourceObjectId && (await this.objects.describe(item.sourceObjectId))) retryable.push(item);
    }
    if (retryable.length === 0) return { requeued: 0 };

    await this.prisma.$transaction(async (tx) => {
      for (const item of retryable) {
        await tx.noteImportBatchItem.update({ where: { id: item.id }, data: { status: 'queued', failureReason: null } });
        if (item.fileId) {
          await tx.noteLibraryFile.update({ where: { id: item.fileId }, data: { status: 'importing', failureReason: null } });
        }
        const job = await this.jobs.enqueueWithin(tx, {
          type: NOTE_LIBRARY_IMPORT_JOB_TYPE,
          reason: 'retry',
          subjectType: NOTE_IMPORT_ITEM_SUBJECT_TYPE,
          subjectId: item.id,
          priority: 0,
          payload: { itemId: item.id },
        });
        await tx.noteImportBatchItem.update({ where: { id: item.id }, data: { jobId: job.id } });
      }
      await tx.noteImportBatch.update({ where: { id: batchId }, data: { status: 'running', finishedAt: null } });
    });

    return { requeued: retryable.length };
  }
}
