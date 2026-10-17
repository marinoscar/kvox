// =============================================================================
// NoteObjectsService (issue #51, epic #45)
// =============================================================================
//
// The narrow storage surface the notes module needs and the platform's
// `ObjectsService` does not offer, cloned from `transcripts/transcript-objects.service.ts` and
// carrying the same three properties for the same three reasons:
//
//   • EVERY ROW IT CREATES IS OWNED BY `notes` (a `kvox_object_ownership` row
//     written in the same transaction), and that is not a default a caller may
//     override. A managed object is absent from `GET /api/kvox/files` and
//     refuses the generic `DELETE` with a 409 naming this module — which is the
//     only thing standing between "a note's source document" and "a file the
//     user can delete out from under a note that still points at it".
//
//   • `deleteIfPresent` goes through `KvoxManagedObjects.deleteManaged`,
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
// argument. Rejected for the same reason `initManagedUpload` keeps the module
// as a service-level argument unreachable over HTTP: the ONE thing
// this class guarantees is that every row it writes is claimed by THIS module,
// and a shared class parameterised on the owner guarantees that only as long as
// every call site passes the right string. The duplication is roughly sixty
// lines; the guarantee it buys is the whole point of the ownership marker.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';

import {
  KVOX_OBJECT_STORE,
  KvoxObjectMissingError,
  type KvoxObjectInfo,
  type KvoxObjectStorePort,
} from '../ports/index.js';
import { NOTES_MANAGED_BY } from './job-types.js';

/** A stored object, as the notes pipeline refers to it. @stability experimental */
export interface ManagedObjectRef {
  /** The object's id. */
  id: string;
  /** The stored size in bytes. */
  size: number;
}

/** Everything `recordUploaded` needs to adopt bytes a node already uploaded. @stability experimental */
export interface RecordUploadedNoteObjectInput {
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

/** Everything `put` needs. @stability experimental */
export interface PutNoteObjectInput extends Omit<RecordUploadedNoteObjectInput, 'size'> {
  body: Buffer;
}

/**
 * The executor said it uploaded bytes that are not in storage.
 *
 * @stability experimental
 */
export class MissingUploadedNoteObjectError extends Error {
  /** @param storageKey - the key the executor said it uploaded to. */
  constructor(
    /** The key the executor said it uploaded to. */
    readonly storageKey: string,
  ) {
    super(
      `No object exists at "${storageKey}". The executor reported a result for bytes that ` +
        'never landed in storage, so there is nothing to record.',
    );
    this.name = 'MissingUploadedNoteObjectError';
  }
}

/**
 * NoteObjectsService: wiring the slice registers itself; a host configures it through `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteObjectsService {
  private readonly logger = new Logger(NoteObjectsService.name);

  constructor(@Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort) {}

  /** Stores bytes under a key, once: a retry of the same key reuses the object. */
  async put(input: PutNoteObjectInput): Promise<ManagedObjectRef> {
    const stored = await this.store.put({
      ownerId: input.ownerId,
      key: input.storageKey,
      body: input.body,
      contentType: input.mimeType,
      managedBy: NOTES_MANAGED_BY,
      name: input.name,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    this.logger.log(
      `Stored managed object ${stored.objectId} (${input.body.byteLength} bytes) at ${input.storageKey}`,
    );

    return { id: stored.objectId, size: stored.size };
  }

  /**
   * Opens a destination the caller streams into; `done` settles when the object is stored.
   *
   * ⚠ A STREAM THAT ERRORS MUST DESTROY `body`, which is what the `done` handler does: an
   * exporter that fails mid-render must not leave the upload waiting for an `end` that
   * never comes.
   */
  putStream(input: Omit<PutNoteObjectInput, 'body'>): {
    body: PassThrough;
    done: Promise<ManagedObjectRef>;
  } {
    const body = new PassThrough();

    body.on('error', (error: Error) => {
      this.logger.warn(`Managed upload to ${input.storageKey} was aborted: ${error.message}`);
    });

    const done = (async (): Promise<ManagedObjectRef> => {
      const stored = await this.store.put({
        ownerId: input.ownerId,
        key: input.storageKey,
        body,
        contentType: input.mimeType,
        managedBy: NOTES_MANAGED_BY,
        name: input.name,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });

      this.logger.log(
        `Streamed managed object ${stored.objectId} (${stored.size} bytes) to ${input.storageKey}`,
      );

      return { id: stored.objectId, size: stored.size };
    })();

    done.catch((error: unknown) => {
      body.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return { body, done };
  }

  /** Records bytes a worker node already uploaded to `storageKey`. Idempotent on the key. */
  async recordUploaded(input: RecordUploadedNoteObjectInput): Promise<ManagedObjectRef> {
    try {
      const adopted = await this.store.adopt({
        ownerId: input.ownerId,
        key: input.storageKey,
        name: input.name,
        contentType: input.mimeType,
        size: input.size,
        managedBy: NOTES_MANAGED_BY,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });

      this.logger.log(
        `Recorded managed object ${adopted.objectId} (${input.size} bytes) at ${input.storageKey}`,
      );

      return { id: adopted.objectId, size: input.size };
    } catch (error) {
      if (error instanceof KvoxObjectMissingError) {
        throw new MissingUploadedNoteObjectError(input.storageKey);
      }

      throw error;
    }
  }

  /**
   * A signed download URL for a READY object, or `null` when it is gone or not ready.
   *
   * @param objectId - the object.
   * @param expiresInSeconds - the URL's lifetime.
   * @param filename - the file name the download is saved as.
   */
  async signedUrlFor(
    objectId: string,
    expiresInSeconds: number,
    filename?: string,
  ): Promise<{ url: string; expiresAt: Date; object: { mimeType: string; size: number } } | null> {
    const object = (await this.store.describe([objectId])).get(objectId);

    if (!object || object.state !== 'ready') return null;

    const url = await this.store.signedDownloadUrl(objectId, {
      ttlSeconds: expiresInSeconds,
      ...(filename !== undefined ? { filename } : {}),
    });

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      object: { mimeType: object.mimeType, size: object.size },
    };
  }

  /**
   * What the store records about one object, or `null` when it does not exist.
   *
   * ⚠ NO OWNERSHIP CHECK — the caller decides what `managedBy` and `ownerId`
   * must be (see `NoteSourcesService.documentStatus`).
   */
  async describe(objectId: string): Promise<KvoxObjectInfo | null> {
    return (await this.store.describe([objectId])).get(objectId) ?? null;
  }

  /** The object's bytes as a stream, or `null` when it does not exist. */
  async download(objectId: string): Promise<Readable | null> {
    const object = (await this.store.describe([objectId])).get(objectId);

    if (!object) return null;

    return (await this.store.openRead(objectId)) as Readable;
  }

  /** The object's bytes, whole, or `null` when it does not exist. */
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
   * Removes a note-owned object. Never throws: a missing object, an object another
   * module owns and a failing store are all "not deleted".
   *
   * ⚠ THIS MODULE MUST NAME THE OWNER IT BELIEVES IN before it removes anything: an object
   * whose owning module is not `notes` is left alone.
   */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;

    try {
      const object = (await this.store.describe([objectId])).get(objectId);

      if (!object) return false;

      if (object.managedBy !== NOTES_MANAGED_BY) {
        this.logger.warn(`Managed object ${objectId} is not owned by ${NOTES_MANAGED_BY}; it was not deleted`);

        return false;
      }

      await this.store.delete(objectId);

      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete managed object ${objectId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }
}
