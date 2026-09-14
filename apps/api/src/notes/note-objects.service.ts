// =============================================================================
// NoteObjectsService (issue #51, epic #45)
// =============================================================================
//
// The narrow storage surface the notes module needs and `ObjectsService` does
// not offer, cloned from `transcripts/transcript-objects.service.ts` and
// carrying the same three properties for the same three reasons:
//
//   • EVERY ROW IT CREATES IS `managed_by: 'notes'`, and that is not a default
//     a caller may override. A managed object is invisible to
//     `GET /api/storage/objects` and refuses the generic `DELETE` with a 409
//     naming this module — which is the behaviour issue #21 built and the only
//     thing standing between "a note's source document" and "a file the user
//     can delete out from under a note that still points at it".
//
//   • `deleteIfPresent` goes through `ObjectsService.deleteManagedObject`,
//     which makes this module NAME the owner it believes in before it may
//     remove anything, so "the notes module deleted somebody else's file" is
//     an impossible state rather than a possible bug.
//
//   • bytes go to STORAGE FIRST AND THE ROW SECOND. A row written before the
//     upload describes an object that may not exist; the failure mode of this
//     order is the harmless one (bytes in the bucket with no row, which the
//     bucket's lifecycle policy covers).
//
// -----------------------------------------------------------------------------
// WHY A CLONE RATHER THAN A SHARED SERVICE
// -----------------------------------------------------------------------------
//
// The obvious alternative is to lift `TranscriptObjectsService` into a generic
// `ManagedObjectsService` both modules inject with a `managedBy` constructor
// argument. Rejected for the same reason `ObjectsService.initUpload` keeps
// `managedBy` as a service-level argument unreachable over HTTP: the ONE thing
// this class guarantees is that every row it writes is claimed by THIS module,
// and a shared class parameterised on the owner guarantees that only as long as
// every call site passes the right string. The duplication is roughly sixty
// lines; the guarantee it buys is the whole point of `managed_by` existing.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StorageObject } from '@prisma/client';
import { PassThrough, Readable, Transform } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { NOTES_MANAGED_BY } from './job-types';

/** An object whose bytes are already in storage, about to be recorded. */
export interface RecordUploadedNoteObjectInput {
  storageKey: string;
  name: string;
  mimeType: string;
  /** Byte length of the object in the bucket, as its producer reported it. */
  size: number;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

/** One object this module is about to write and record. */
export interface PutNoteObjectInput extends Omit<RecordUploadedNoteObjectInput, 'size'> {
  body: Buffer;
}

/**
 * A result names a storage key that holds nothing.
 *
 * A PERMANENT failure of that job attempt and a NAMED one: "the node said it
 * uploaded extracted text and the bucket disagrees" is a specific, actionable
 * state, and it must not reach an operator as a foreign-key error three frames
 * from the cause.
 */
export class MissingUploadedNoteObjectError extends Error {
  constructor(readonly storageKey: string) {
    super(
      `No object exists at "${storageKey}". The executor reported a result for bytes that ` +
        'never landed in storage, so there is nothing to record.',
    );
    this.name = 'MissingUploadedNoteObjectError';
  }
}

@Injectable()
export class NoteObjectsService {
  private readonly logger = new Logger(NoteObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Write bytes to object storage and record them as a managed object.
   *
   * IDEMPOTENT ON THE KEY, like `recordUploaded` below and for the same reason:
   * the queue is at-least-once and `deriveOutputKey` makes the extracted-text
   * key a pure function of the job, so a retry after a successful record
   * arrives here with a key that already has a row. A second row for one file
   * would leave an object nothing references and nothing ever deletes.
   */
  async put(input: PutNoteObjectInput): Promise<StorageObject> {
    const existing = await this.findByKey(input.storageKey);

    if (existing) {
      this.logger.log(
        `Managed object ${existing.id} already records ${input.storageKey}; reusing it`,
      );

      return existing;
    }

    await this.storage.upload(input.storageKey, Readable.from(input.body), {
      mimeType: input.mimeType,
    });

    const object = await this.createRow({ ...input, size: input.body.byteLength });

    this.logger.log(
      `Stored managed object ${object.id} (${input.body.byteLength} bytes) at ${input.storageKey}`,
    );

    return object;
  }

  /**
   * Stream bytes into object storage, recording the row once the upload lands.
   *
   * The counterpart to `put` for a producer that does not have a Buffer: a
   * `note.export` renderer writes a PDF or a DOCX into `body` as it goes and
   * the exporter contract (`apps/api/src/export/exporter-registry.ts`) forbids
   * it from returning one. Cloned from `TranscriptObjectsService.putStream`
   * exactly, including the metering `Transform`, for the reason this file's
   * header already gives about `managed_by`.
   *
   * ⚠ THE SIZE IS METERED, NOT DECLARED. A caller cannot know a rendered PDF's
   * byte length before rendering it, and a `storage_objects.size` copied from
   * an estimate is a row that lies about the file it names.
   */
  putStream(input: Omit<RecordUploadedNoteObjectInput, 'size'>): {
    body: PassThrough;
    done: Promise<StorageObject>;
  } {
    const body = new PassThrough();

    // ⚠ AN EXPLICIT `error` LISTENER, AND IT IS NOT DECORATION. The exporter
    // contract says a failed render DESTROYS `out` — and `EventEmitter` turns
    // an `error` event with no listener into an uncaught exception that takes
    // the worker process down, not into a failed job. The real signal is the
    // rejected `render` promise the handler is already awaiting beside `done`;
    // this listener's only job is to keep a renderer's own honest failure from
    // becoming a crash.
    body.on('error', (error: Error) => {
      this.logger.warn(`Managed upload to ${input.storageKey} was aborted: ${error.message}`);
    });

    let size = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(null, chunk);
      },
    });

    const metered = body.pipe(meter);

    const done = (async () => {
      await this.storage.upload(input.storageKey, metered, { mimeType: input.mimeType });

      const existing = await this.findByKey(input.storageKey);
      const object = existing ?? (await this.createRow({ ...input, size }));

      this.logger.log(
        `Streamed managed object ${object.id} (${size} bytes) to ${input.storageKey}`,
      );

      return object;
    })();

    // Nothing may reject unobserved here: the caller awaits `done`, but if the
    // upload fails BEFORE the caller has finished writing, its writes would
    // otherwise pile up against a stream nobody is reading.
    done.catch((error: unknown) => {
      body.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return { body, done };
  }

  /**
   * A short-lived signed GET for one object, or null if it is gone.
   *
   * ⚠ `contentDisposition` IS PART OF THE SIGNATURE. A provider signs
   * `response-content-disposition` into the URL, which is what makes an export
   * download as a named attachment instead of rendering in the tab — and also
   * why it cannot be added by the caller afterwards as a header.
   */
  async signedUrlFor(
    objectId: string,
    expiresInSeconds: number,
    contentDisposition?: string,
  ): Promise<{ url: string; expiresAt: Date; object: StorageObject } | null> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!object || object.status !== 'ready') return null;

    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn: expiresInSeconds,
      responseContentDisposition: contentDisposition,
    });

    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000), object };
  }

  /**
   * Record bytes that are ALREADY in the bucket, after checking that they are.
   *
   * The counterpart to `put` for the one case `put` cannot serve: an artifact
   * this process did not write. A WORKER NODE PUTs the extracted text straight
   * to a presigned URL, so the server never sees a byte of it and there is
   * nothing to hand `put`.
   *
   * ⚠ THE `exists` CHECK IS THE WHOLE POINT, AND IT IS NOT A RE-COMPUTATION.
   * `persistNodeResult` may not redo a node's work, but it may and must
   * establish that the thing it is about to point a metadata key at actually
   * landed. A node whose upload silently failed would otherwise leave
   * `extractedObjectId` aimed at an empty key, and `note.generate` would fail
   * much later with nothing to explain why.
   */
  async recordUploaded(input: RecordUploadedNoteObjectInput): Promise<StorageObject> {
    const existing = await this.findByKey(input.storageKey);

    if (existing) {
      this.logger.log(
        `Managed object ${existing.id} already records ${input.storageKey}; reusing it`,
      );

      return existing;
    }

    const present = await this.storage.exists(input.storageKey);

    if (!present) {
      throw new MissingUploadedNoteObjectError(input.storageKey);
    }

    const object = await this.createRow(input);

    this.logger.log(
      `Recorded managed object ${object.id} (${input.size} bytes) at ${input.storageKey}`,
    );

    return object;
  }

  /** Read an object's bytes back, or `null` if the row is gone. */
  async download(objectId: string): Promise<Readable | null> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!object) return null;

    return this.storage.download(object.storageKey);
  }

  /** Read an object's bytes back as one buffer. */
  async downloadBuffer(objectId: string): Promise<Buffer | null> {
    const stream = await this.download(objectId);

    if (!stream) return null;

    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Remove one managed object, bytes and row.
   *
   * NEVER THROWS for an object that is already gone: a purge is re-entrant by
   * construction, and a second pass finding nothing to delete has succeeded.
   */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;

    try {
      await this.objects.deleteManagedObject(objectId, NOTES_MANAGED_BY);

      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete managed object ${objectId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  private findByKey(storageKey: string): Promise<StorageObject | null> {
    return this.prisma.storageObject.findFirst({ where: { storageKey } });
  }

  /** The one `storage_objects` insert this module makes. Always `managedBy`. */
  private createRow(input: RecordUploadedNoteObjectInput): Promise<StorageObject> {
    return this.prisma.storageObject.create({
      data: {
        name: input.name,
        size: BigInt(input.size),
        mimeType: input.mimeType,
        storageKey: input.storageKey,
        storageProvider: 's3',
        bucket: this.storage.getBucket(),
        status: 'ready',
        managedBy: NOTES_MANAGED_BY,
        uploadedById: input.ownerId,
        metadata: (input.metadata ?? undefined) as never,
      },
    });
  }
}
