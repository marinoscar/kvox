// =============================================================================
// NoteContextAttachmentsService (issue #810)
// =============================================================================
//
// Files a user attaches to a note's Context. TWO KINDS, ONE DOOR:
//
//   • a DOCUMENT (txt, md, pdf, docx, pptx) goes through `NoteSourcesService.uploadDocument`
//     unchanged: stored `managed_by: notes`, `note.source.extract` queued. Its extracted text is
//     what reaches the prompt, so it works with every provider.
//   • an IMAGE (png, jpeg, webp, gif) is stored and is READY AT ONCE: there is nothing to extract.
//     It reaches the model as vision input by storage object id (the bytes never leave the
//     object store through this slice).
//
// ⚠ OWNER-SCOPED, 404 FOR EVERY "NO". An attachment another user uploaded, an object another
// module owns and a missing id answer the same 404 (no access is a 404, never a 403). The same
// rule `documentStatus` follows.
//
// ⚠ REFUSALS HAPPEN AT THE DOOR. A bad type, an empty file, an over-size file and an image whose
// bytes are not the image it claims to be are all refused before an object exists.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  MAX_CONTEXT_ATTACHMENTS,
  NOTE_CONTEXT_ATTACHMENT_REASONS,
  type NoteContextAttachment,
  type NoteContextAttachmentKind,
  type NoteContextAttachmentStatusResponse,
  type NoteContextAttachmentUploadResponse,
} from '@marinoscar/kvox-contract/notes';
import { randomUUID } from 'node:crypto';

import { KVOX_OBJECT_STORE, KVOX_PRISMA, type KvoxObjectInfo, type KvoxObjectStorePort } from '../ports/index.js';
import type { KvoxNotesDb } from './data/notes-db.js';
import {
  acceptedImageTypesSentence,
  contextImageStorageKey,
  imageExtension,
  normalizeImageMimeType,
  sniffImageType,
} from './context-attachment-image.js';
import { acceptedDocumentTypesSentence, normalizeDocumentMimeType } from './extraction/document-format.js';
import { NOTES_MANAGED_BY } from './job-types.js';
import { NoteObjectsService } from './note-objects.service.js';
import { NoteSourcesService, type UploadedDocument } from './note-sources.service.js';
import { readDocumentExtractionStatus } from './source-metadata.js';

/** An attachment that passed validation: what is persisted on the note and snapshotted. */
export type ResolvedContextAttachment = NoteContextAttachment;

/** The kind an object is, from its stored type. */
function kindOf(object: KvoxObjectInfo): NoteContextAttachmentKind | null {
  if (normalizeImageMimeType(object.mimeType) !== null) return 'image';
  if (normalizeDocumentMimeType(object.mimeType) !== null) return 'document';

  return null;
}

/**
 * NoteContextAttachmentsService: wiring the slice registers itself; a host configures it through `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteContextAttachmentsService {
  private readonly logger = new Logger(NoteContextAttachmentsService.name);

  constructor(
    private readonly objects: NoteObjectsService,
    private readonly sources: NoteSourcesService,
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
  ) {}

  /** The per-deployment ceiling on one uploaded file, in bytes (the document ceiling). */
  maxBytes(): Promise<number> {
    return this.sources.maxDocumentBytes();
  }

  /**
   * Store one uploaded attachment. Documents queue extraction; images are ready at once.
   *
   * @throws 400 (`context_attachment_unsupported_type`) for a type that is neither, or an image
   * whose bytes are not the image it claims to be; 413 over the ceiling.
   */
  async upload(upload: UploadedDocument, userId: string): Promise<NoteContextAttachmentUploadResponse> {
    if (normalizeDocumentMimeType(upload.mimeType) !== null) {
      const document = await this.sources.uploadDocument(upload, userId);

      return {
        objectId: document.objectId,
        kind: 'document',
        filename: document.filename,
        mimeType: document.mimeType,
        size: document.size,
        status: 'extracting',
        jobId: document.jobId,
      };
    }

    const declared = normalizeImageMimeType(upload.mimeType);

    if (declared === null) {
      throw this.unsupported(
        `"${upload.filename}" is a ${upload.mimeType || 'file of unknown type'}, which cannot be ` +
          `attached as context. Accepted documents: ${acceptedDocumentTypesSentence()}. ` +
          `Accepted images: ${acceptedImageTypesSentence()}.`,
      );
    }

    if (upload.body.byteLength === 0) {
      throw new BadRequestException(`"${upload.filename}" is empty.`);
    }

    const ceiling = await this.maxBytes();

    if (upload.body.byteLength > ceiling) {
      throw new PayloadTooLargeException(
        `"${upload.filename}" is ${upload.body.byteLength} bytes, over this deployment's ` +
          `${ceiling}-byte limit for a note context file.`,
      );
    }

    // ⚠ THE BYTES DECIDE, not the header: they must be the image the part claims to be.
    const sniffed = sniffImageType(upload.body);

    if (sniffed === null || sniffed !== declared) {
      throw this.unsupported(
        `"${upload.filename}" is not a valid ${declared} image. Accepted images: ${acceptedImageTypesSentence()}.`,
      );
    }

    const extension = imageExtension(sniffed);
    const filename = this.sources.safeDisplayName(upload.filename, `image${extension}`);

    const object = await this.objects.put({
      storageKey: contextImageStorageKey(randomUUID(), extension),
      name: filename,
      mimeType: sniffed,
      body: upload.body,
      ownerId: userId,
      metadata: { uploadedFilename: filename, noteContextAttachment: { kind: 'image' } },
    });

    this.logger.log(`Stored note context image ${object.id} (${upload.body.byteLength} bytes, ${sniffed})`);

    return {
      objectId: object.id,
      kind: 'image',
      filename,
      mimeType: sniffed,
      size: upload.body.byteLength,
      status: 'ready',
      jobId: null,
    };
  }

  /**
   * The readiness of one of the caller's attachments. 404 for every "no".
   */
  async status(objectId: string, userId: string): Promise<NoteContextAttachmentStatusResponse> {
    const object = await this.ownedObject(objectId, userId);
    const kind = kindOf(object);

    if (kind === null) throw new NotFoundException('Context attachment not found');

    if (kind === 'image') {
      return { objectId, kind, status: 'ready', message: null, characters: null };
    }

    const extraction = readDocumentExtractionStatus(object.metadata ?? null);

    return {
      objectId,
      kind,
      status: extraction.status === 'extracted' ? 'ready' : extraction.status,
      message: extraction.message,
      characters: extraction.characters,
    };
  }

  /**
   * Validate the ids a request names and return them as attachments, in the order given.
   *
   * Every id must be the caller's (404 otherwise), of a supported kind (400), and READY (409
   * `context_attachment_not_ready`: a document still extracting, or one with no readable text).
   * More than {@link MAX_CONTEXT_ATTACHMENTS} is a 400 (`context_attachment_limit`).
   */
  async resolve(ids: readonly string[], userId: string): Promise<ResolvedContextAttachment[]> {
    if (ids.length > MAX_CONTEXT_ATTACHMENTS) {
      throw new BadRequestException({
        message: `A note may carry at most ${MAX_CONTEXT_ATTACHMENTS} context attachments.`,
        details: { reason: NOTE_CONTEXT_ATTACHMENT_REASONS.LIMIT, limit: MAX_CONTEXT_ATTACHMENTS },
      });
    }

    if (ids.length === 0) return [];

    const described = await this.store.describe([...ids]);
    const out: ResolvedContextAttachment[] = [];

    for (const id of ids) {
      const object = described.get(id);

      if (!object || object.managedBy !== NOTES_MANAGED_BY || object.ownerId !== userId) {
        throw new NotFoundException('Context attachment not found');
      }

      const kind = kindOf(object);

      if (kind === null) {
        throw this.unsupported(`"${object.name}" is not a type that can be attached as context.`);
      }

      if (kind === 'document') {
        const extraction = readDocumentExtractionStatus(object.metadata ?? null);

        if (extraction.status !== 'extracted') {
          throw new ConflictException({
            message:
              extraction.status === 'unextractable'
                ? (extraction.message ?? `No text could be read from "${object.name}", so it cannot be used as context.`)
                : `"${object.name}" is still being read. Wait until it is ready and try again.`,
            details: { reason: NOTE_CONTEXT_ATTACHMENT_REASONS.NOT_READY, objectId: id },
          });
        }
      }

      out.push({ objectId: id, kind, filename: object.name, mimeType: object.mimeType });
    }

    return out;
  }

  /** The attachments a note carries, in the order the model sees them. */
  async forNote(noteId: string): Promise<NoteContextAttachment[]> {
    const rows = await this.prisma.noteContextAttachment.findMany({
      where: { noteId },
      orderBy: { ordinal: 'asc' },
    });

    return [...rows]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => ({
        objectId: row.objectId,
        kind: row.kind === 'image' ? 'image' : 'document',
        filename: row.filename,
        mimeType: row.mimeType,
      }));
  }

  private async ownedObject(objectId: string, userId: string): Promise<KvoxObjectInfo> {
    const object = await this.objects.describe(objectId);

    if (!object || object.managedBy !== NOTES_MANAGED_BY || object.ownerId !== userId) {
      throw new NotFoundException('Context attachment not found');
    }

    return object;
  }

  private unsupported(message: string): BadRequestException {
    return new BadRequestException({
      message,
      details: { reason: NOTE_CONTEXT_ATTACHMENT_REASONS.UNSUPPORTED_TYPE },
    });
  }
}
