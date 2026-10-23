import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';

import {
  NOTE_IMPORT_FAILURE_REASONS,
  parseNoteMarkdownExport,
  type NoteImportFailure,
} from '@marinoscar/kvox-contract/notes';

import {
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxEventsPort,
  type KvoxJobsPort,
} from '../../ports/index.js';
import { SEARCH_DOC_NOTE, SearchIndexService } from '../../search/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { NOTE_SOURCE_EXTRACT_JOB_TYPE } from '../job-types.js';
import { NoteObjectsService } from '../note-objects.service.js';
import type { NotesActor } from '../notes-actor.js';
import { NOTE_READY_EVENT, type NoteReadyEvent } from '../notes.events.js';
import { sourceDocumentStorageKey } from '../source-metadata.js';

// =============================================================================
// NoteImportService (issue #585; docs/specs/notes.md §8.7)
// =============================================================================
//
// `POST /api/notes/import`: a KVox note Markdown export (or any Markdown or text
// file) becomes a `ready` note with the same title and body, editable and
// extractable to the graph like any other.
//
// SYNCHRONOUS, AND THAT KEEPS THE QUEUE RULE. The work is bounded by
// `maxImportBytes` (the multipart read stops there): one parse, one small object
// put and one transaction inside the request. What outlives it (the source
// extraction, the search index) is enqueued.
//
// THE ORDER, and why (the transcript import's, §8.6 of the transcription spec):
//   1. Parse (pure, `@marinoscar/kvox-contract/notes`). A bad file is a typed 400
//      before anything is written.
//   2. Store the file as the note's source document (`managed_by: notes`, the same
//      key space as an uploaded source). `source_type: document` then names a real
//      object, the note page shows it as the source, and a later "regenerate with a
//      template" reads its extracted text like any document source's. Put BEFORE
//      the transaction (never hold a transaction across storage), deleted again if
//      the transaction fails.
//   3. One transaction: the note row (`ready`, version 1, title `user`-sourced: a
//      person supplied it) and version 1, kind `edit`, authored by the importer,
//      summary `Imported from <file>`. That pair IS the import's origin record;
//      no new version kind (and so no migration) is needed for it.
//   4. After the commit, never able to roll it back: the audit row
//      (`note:import`), the extraction and search-index enqueues, and
//      `kvox.notes.note_ready`, so a host's graph treats the note as it treats a
//      generated one (extraction automatic or on demand, the host's choice).
// =============================================================================

/** The longest file name kept as the source document's display name. */
const MAX_FILENAME_LENGTH = 255;

/** C0 and C1 control characters, which never belong in a stored display name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The `subject_type` of a job about a stored object (as `NoteSourcesService` enqueues it). */
const STORAGE_OBJECT_SUBJECT_TYPE = 'storage_object';

/**
 * The uploaded file, as the route read it.
 *
 * @stability experimental
 */
export interface NoteImportFile {
  /** The filename the client sent (display only; the storage key is random). */
  filename: string;
  /** The bytes. */
  body: Buffer;
}

/**
 * The 400 a refused file answers: `details.reason`, plus the line or the foreign `schema`.
 *
 * @param failure - what `parseNoteMarkdownExport` refused.
 * @returns the exception to throw.
 * @stability experimental
 */
export function noteImportException(failure: Pick<NoteImportFailure, 'reason' | 'message' | 'line' | 'schema'>): BadRequestException {
  return new BadRequestException({
    message: failure.message,
    details: {
      reason: failure.reason,
      ...(failure.line !== undefined ? { line: failure.line } : {}),
      ...(failure.schema !== undefined ? { schema: failure.schema } : {}),
    },
  });
}

/** A display name that is safe to store and echo back (also used by the library upload, #715). */
export function safeFilename(raw: string): string {
  const stripped = (raw ?? '').replace(/[\\/]+/g, '_').replace(CONTROL_CHARACTERS, '').trim();
  return stripped.length > 0 ? stripped.slice(0, MAX_FILENAME_LENGTH) : 'note.md';
}

/**
 * NoteImportService: wiring the slice registers itself; a host configures it through
 * `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteImportService {
  private readonly logger = new Logger(NoteImportService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly objects: NoteObjectsService,
    private readonly searchIndex: SearchIndexService,
  ) {}

  /**
   * Creates a note from a note Markdown export, owned by the caller.
   *
   * @param user - the caller.
   * @param file - the uploaded file.
   * @returns the new note's id.
   * @throws BadRequestException with `details.reason` when the file is refused.
   */
  async importFile(user: NotesActor, file: NoteImportFile): Promise<{ noteId: string }> {
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(file.body);
    } catch {
      throw noteImportException({
        reason: NOTE_IMPORT_FAILURE_REASONS.NOT_TEXT,
        message: 'This file is not UTF-8 text, so it is not a note export.',
      });
    }
    if (content.includes('\u0000')) {
      throw noteImportException({
        reason: NOTE_IMPORT_FAILURE_REASONS.NOT_TEXT,
        message: 'This file is binary, so it is not a note export.',
      });
    }

    const filename = safeFilename(file.filename);
    const parsed = parseNoteMarkdownExport(content, { filename });
    if (!parsed.ok) throw noteImportException(parsed);
    const { note: imported } = parsed;

    const source = await this.objects.put({
      storageKey: sourceDocumentStorageKey(randomUUID(), '.md'),
      name: filename,
      mimeType: 'text/markdown',
      body: file.body,
      ownerId: user.id,
      // Where the note came from, as the export said: provenance only. The ids belong to
      // the deployment that exported it, so nothing here links to them.
      metadata: {
        uploadedFilename: filename,
        kind: 'note-import',
        ...(imported.kvoxExport ? { importedFrom: imported.provenance } : {}),
      },
    });

    let noteId: string;
    try {
      noteId = await this.prisma.$transaction(async (tx) => {
        const note = await tx.note.create({
          data: {
            ownerId: user.id,
            title: imported.title,
            titleSource: 'user',
            body: imported.body,
            bodyFormat: imported.bodyFormat,
            status: 'ready',
            currentVersion: 1,
            sourceType: 'document',
            sourceObjectId: source.id,
          },
        });
        await tx.noteVersion.create({
          data: {
            noteId: note.id,
            version: 1,
            kind: 'edit',
            body: imported.body,
            bodyFormat: imported.bodyFormat,
            summary: `Imported from ${filename}`,
            // A person supplied the text: a real author, never null (null means the AI).
            authorId: user.id,
          },
        });
        return note.id;
      });
    } catch (error) {
      await this.objects.deleteIfPresent(source.id).catch((cleanup: unknown) => {
        this.logger.warn(`Could not delete the source of a failed note import (${source.id}): ${String(cleanup)}`);
      });
      throw error;
    }

    await this.auditPort.record({
      actorUserId: user.id,
      action: 'note:import',
      targetType: 'note',
      targetId: noteId,
      meta: { sourceObjectId: source.id, bytes: file.body.byteLength, kvoxExport: imported.kvoxExport },
    });

    await this.afterCommit(noteId, user.id, source.id);

    this.logger.log(`Imported note ${noteId} for user ${user.id} (${file.body.byteLength} bytes)`);

    return { noteId };
  }

  /** The enqueues and the ready event; none of them can undo the committed note. */
  private async afterCommit(noteId: string, ownerId: string, objectId: string): Promise<void> {
    try {
      await this.jobs.enqueue({
        type: NOTE_SOURCE_EXTRACT_JOB_TYPE,
        reason: 'import',
        subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
        subjectId: objectId,
        payload: { objectId },
      });
    } catch (error) {
      this.logger.warn(`Could not queue the source extraction of imported note ${noteId}: ${String(error)}`);
    }

    try {
      await this.searchIndex.enqueue(SEARCH_DOC_NOTE, noteId);
    } catch (error) {
      this.logger.warn(`Could not queue a search index of imported note ${noteId}: ${String(error)}`);
    }

    try {
      this.events.emit(NOTE_READY_EVENT, { noteId, ownerId, version: 1 } satisfies NoteReadyEvent);
    } catch (error) {
      this.logger.warn(`Could not publish ${NOTE_READY_EVENT} for imported note ${noteId}: ${String(error)}`);
    }
  }
}
