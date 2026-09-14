// =============================================================================
// NoteSourcesService (issue #51, epic #45)
// =============================================================================
//
// Accepting an uploaded document and getting it onto the queue. Three things
// happen here and the ORDER of the first two is the design:
//
//   1. EVERY REFUSAL HAPPENS AT THE DOOR — before a byte reaches storage and
//      before a row exists. The issue is explicit ("reject anything else at the
//      door with the accepted list in the message, rather than accepting it and
//      failing later in a job") and the reason is concrete: an object created
//      here is `managed_by: 'notes'`, so it is INVISIBLE to
//      `GET /api/storage/objects` and its generic `DELETE` answers 409. A
//      rejected upload that left a row behind would leave the user with a file
//      they can neither see nor delete, and an operator with an orphan nothing
//      sweeps.
//
//   2. BYTES BEFORE ROW, ROW BEFORE JOB. A row written before the upload
//      describes an object that may not exist; a job enqueued before the row
//      exists names a subject the handler cannot resolve. Both failure modes of
//      this order are the harmless direction (bytes with no row; a row with no
//      job, which a re-upload replaces).
//
//   3. THE SIZE CEILING IS A SETTING, READ PER REQUEST. `ai.maxDocumentBytes`
//      (#47's namespace, this issue's field) — see its own comment for why an
//      AI policy rather than a storage one. Read per request rather than
//      cached, because an administrator lowering it should take effect on the
//      next upload rather than at some unspecified later time.
// =============================================================================

import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { JobsService } from '../jobs/jobs.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../storage/storage-job-input';
import {
  acceptedDocumentTypesSentence,
  normalizeDocumentMimeType,
  type NoteDocumentMimeType,
} from './extraction/document-format';
import { NOTE_SOURCE_EXTRACT_JOB_TYPE } from './job-types';
import { NoteObjectsService } from './note-objects.service';
import { documentExtension, sourceDocumentStorageKey } from './source-metadata';

/** What the controller hands over once it has a complete multipart part. */
export interface UploadedDocument {
  filename: string;
  /** The part's declared type, exactly as it arrived. Never trusted as-is. */
  mimeType: string;
  body: Buffer;
}

/** What `POST /api/notes/sources/documents` answers. */
export interface NoteSourceDocument {
  objectId: string;
  filename: string;
  mimeType: NoteDocumentMimeType;
  size: number;
  jobId: string;
  status: 'extracting';
}

/** Longest filename this endpoint will echo back and store as a display name. */
const MAX_FILENAME_LENGTH = 255;

/** C0 and C1 control characters, which never belong in a stored display name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

@Injectable()
export class NoteSourcesService {
  private readonly logger = new Logger(NoteSourcesService.name);

  constructor(
    private readonly objects: NoteObjectsService,
    private readonly jobs: JobsService,
    private readonly settings: SystemSettingsService,
  ) {}

  /** The per-deployment ceiling on one uploaded document, in bytes. */
  async maxDocumentBytes(): Promise<number> {
    const policy = await this.settings.getAiPolicy();

    return policy.maxDocumentBytes;
  }

  /**
   * Store an uploaded document and queue its extraction.
   *
   * ⚠ THE TYPE CHECK USES THE *CANONICAL* TYPE, NOT THE RAW HEADER. A `.md`
   * file arrives as `text/markdown` from one browser and `text/x-markdown` from
   * another, and `text/plain; charset=utf-8` carries a parameter a naive
   * equality check fails on. `normalizeDocumentMimeType` collapses the
   * spellings this application recognises onto the three it stores — and
   * returns `null`, which is a 400 carrying the accepted list, for everything
   * else including `application/octet-stream` ("I have no idea what this is").
   */
  async uploadDocument(
    upload: UploadedDocument,
    userId: string,
  ): Promise<NoteSourceDocument> {
    const mimeType = normalizeDocumentMimeType(upload.mimeType);

    if (!mimeType) {
      throw new BadRequestException(
        `"${upload.filename}" is a ${upload.mimeType || 'file of unknown type'}, which is not ` +
          `a document this application can read. Accepted types are: ` +
          `${acceptedDocumentTypesSentence()}.`,
      );
    }

    const ceiling = await this.maxDocumentBytes();

    // Belt and braces: the controller already capped the multipart read at this
    // number, so reaching here means either the setting changed mid-request or
    // a future caller reached this service another way. Refusing twice costs a
    // comparison; refusing once and being wrong costs a worker's heap.
    if (upload.body.byteLength > ceiling) {
      throw new PayloadTooLargeException(
        `"${upload.filename}" is ${upload.body.byteLength} bytes, over this deployment's ` +
          `${ceiling}-byte limit for a source document.`,
      );
    }

    if (upload.body.byteLength === 0) {
      throw new BadRequestException(`"${upload.filename}" is empty.`);
    }

    const filename = this.safeFilename(upload.filename, mimeType);
    const storageKey = sourceDocumentStorageKey(randomUUID(), documentExtension(mimeType));

    const object = await this.objects.put({
      storageKey,
      name: filename,
      mimeType,
      body: upload.body,
      ownerId: userId,
      metadata: { uploadedFilename: filename },
    });

    const job = await this.jobs.enqueue({
      type: NOTE_SOURCE_EXTRACT_JOB_TYPE,
      reason: 'upload',
      // `storage_object`, so the node data plane can resolve this job's input
      // and mint a presigned GET for it without knowing anything about notes.
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: object.id,
      // IDENTIFIERS ONLY — the job re-reads the row at run time rather than
      // trusting a copy of it made minutes earlier.
      payload: { objectId: object.id },
    });

    this.logger.log(
      `Stored note source document ${object.id} (${upload.body.byteLength} bytes, ${mimeType}) ` +
        `and queued extraction job ${job.id}`,
    );

    return {
      objectId: object.id,
      filename,
      mimeType,
      size: upload.body.byteLength,
      jobId: job.id,
      status: 'extracting',
    };
  }

  /**
   * A display name that is safe to store and echo back.
   *
   * ⚠ IT IS NOT USED TO BUILD THE STORAGE KEY — that is a fresh UUID plus an
   * extension derived from the validated MIME type (see
   * `sourceDocumentStorageKey`). This is only the `name` column and the
   * response, but both are rendered by a browser, so path separators and
   * control characters come out and a bounded length goes in.
   */
  private safeFilename(raw: string, mimeType: NoteDocumentMimeType): string {
    const stripped = (raw ?? '')
      // Path separators, so a name can never read as a path anywhere it is
      // later joined to one.
      .replace(/[\\/]+/g, '_')
      // Controls, including the newline that would break a header.
      .replace(CONTROL_CHARACTERS, '')
      .trim();

    if (stripped.length === 0) {
      return `document${documentExtension(mimeType)}`;
    }

    return stripped.slice(0, MAX_FILENAME_LENGTH);
  }
}
