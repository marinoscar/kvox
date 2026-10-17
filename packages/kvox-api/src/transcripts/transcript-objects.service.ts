// =============================================================================
// TranscriptObjectsService (issue #25, epic #19)
// =============================================================================
//
// The narrow storage surface this module needs and the platform's
// `ObjectsService` does not offer: create a managed `storage_objects` row from bytes THIS PROCESS
// produced (the gzipped raw provider result today; #27's snapshots and #28's
// exports later), and presign a GET for one.
//
// -----------------------------------------------------------------------------
// WHY NOT the platform's `ObjectsService.simpleUpload`
// -----------------------------------------------------------------------------
//
// `simpleUpload` takes a `MultipartFile` off an HTTP request, enforces the
// per-request MIME allowlist, and attributes the object to the uploading user.
// None of that describes a job writing a gzip blob nobody uploaded: there is
// no request, `application/gzip` is not in the browser-facing allowlist, and
// the attribution belongs to the transcript's OWNER rather than to whichever
// account happened to trigger the job. Widening `simpleUpload` with three
// optional parameters to cover this would make the request path carry
// arguments only a job can supply — which is how the `managed_by` hole that
// §9.3 closes would be reopened from the inside.
//
// ⚠ EVERY ROW THIS SERVICE CREATES IS OWNED BY `transcripts` (a
// `kvox_object_ownership` row written in the same transaction), and that is
// not a default a caller may override. A managed object is absent from
// `GET /api/kvox/files` and refuses the generic `DELETE` (409), which is
// exactly the ownership boundary a transcript's files need — and the reason
// `deleteIfPresent()` below goes through `KvoxManagedObjects.deleteManaged`,
// which makes this module NAME the owner it believes in before it may remove
// anything.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';

import { KVOX_OBJECT_STORE, KvoxObjectMissingError, type KvoxObjectStorePort } from '../ports/index.js';
import { TRANSCRIPTS_MANAGED_BY } from './job-types.js';
import { TRANSCRIPTS_MODULE_OPTIONS, type ResolvedTranscriptsOptions } from './transcripts.options.js';

/**
 * A stored object this module made: its id and the bytes it holds.
 *
 * The port answers an id; a caller that needs more (the type, the name) asks
 * `describe`.
 */
export interface ManagedObjectRef {
  id: string;
  size: number;
}

/**
 * An object whose bytes are already in storage, about to be recorded.
 *
 * The same fields as {@link PutManagedObjectInput} except that the size is
 * DECLARED rather than derived from a buffer — because there is no buffer:
 * nothing in this process ever held these bytes.
 */
export interface RecordUploadedObjectInput {
  storageKey: string;
  name: string;
  mimeType: string;
  /** Byte length of the object in the bucket, as its producer reported it. */
  size: number;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

/**
 * A result names a storage key that holds nothing.
 *
 * A PERMANENT failure of that job attempt and a named one: "the node said it
 * uploaded a rendition and the bucket disagrees" is a specific, actionable
 * state, and it must not be reported as a Prisma foreign-key error three
 * frames away from the cause.
  *
  * @stability experimental
 */
export class MissingUploadedObjectError extends Error {
  /** @param storageKey - the key at which no object exists. */
  constructor(
    /** The key at which no object exists. */
    readonly storageKey: string,
  ) {
    super(
      `No object exists at "${storageKey}". The executor reported a result for bytes that ` +
        'never landed in storage, so there is nothing to record.',
    );
    this.name = 'MissingUploadedObjectError';
  }
}

/** One object this module is about to create. */
export interface PutManagedObjectInput {
  /** Storage key. Built by the caller so the prefix states what the file is. */
  storageKey: string;
  /** Display name, shown nowhere generic — managed objects are not listed. */
  name: string;
  mimeType: string;
  body: Buffer;
  /** Who the bytes belong to: the transcript's owner, not the job's trigger. */
  ownerId: string;
  /** Free-form JSONB. Carries the transcript id so an orphan is traceable. */
  metadata?: Record<string, unknown>;
}

/**
 * TranscriptObjectsService: wiring the slice registers itself; a host configures it through `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TranscriptObjectsService {
  private readonly logger = new Logger(TranscriptObjectsService.name);

  constructor(
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
    @Inject(TRANSCRIPTS_MODULE_OPTIONS) private readonly options: ResolvedTranscriptsOptions,
  ) {}

  /**
   * Write bytes to object storage and record them as a managed object.
   *
   * ⚠ STORAGE FIRST, ROW SECOND, AND THE ORDER MATTERS. A row written before
   * the upload describes an object that may not exist — every later reader
   * (a purge, a download, a restore) then has to treat "the row says so" as a
   * hint rather than a fact. The failure mode of this order is the harmless
   * one: bytes in the bucket with no row, which the transcript's own purge
   * prefix sweep and the bucket's lifecycle policy both already cover. The
   * object-store port's `put` keeps that order (bytes, then the record).
   */
  async put(input: PutManagedObjectInput): Promise<ManagedObjectRef> {
    const stored = await this.store.put({
      ownerId: input.ownerId,
      key: input.storageKey,
      body: input.body,
      contentType: input.mimeType,
      managedBy: TRANSCRIPTS_MANAGED_BY,
      name: input.name,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    this.logger.log(
      `Stored managed object ${stored.objectId} (${input.body.byteLength} bytes) at ${input.storageKey}`,
    );

    return { id: stored.objectId, size: stored.size };
  }

  /**
   * Stream bytes into object storage, then record them — never buffering them.
   *
   * The counterpart to `put` for an artifact THIS PROCESS PRODUCES but must not
   * hold: issue #28's PDF export, which spec §8.4 requires to stream precisely
   * because a ten-hour recording's document runs to hundreds of pages. `put`
   * takes a `Buffer`, which for that artifact would undo the streaming the
   * exporter went to the trouble of doing.
   *
   * The caller is handed a `Writable` and a promise. It writes the document to
   * the stream and ends it; the promise settles with the recorded object once the
   * upload has finished. ⚠ BOTH MUST BE AWAITED BY THE CALLER, and the reason
   * is the one `docs/specs/database-backup.md` states for `pg_dump`: awaiting
   * only the producer reports success on a truncated object, and awaiting only
   * the upload hides an error the producer raised. A failure on either side
   * destroys the other, so neither can succeed alone.
   *
   * The size is METERED by the port as the bytes pass rather than declared,
   * because nothing knows it in advance — that is the whole point of not buffering.
   */
  putStream(input: Omit<PutManagedObjectInput, 'body'>): {
    body: PassThrough;
    done: Promise<ManagedObjectRef>;
  } {
    const body = new PassThrough();

    const done = (async (): Promise<ManagedObjectRef> => {
      const stored = await this.store.put({
        ownerId: input.ownerId,
        key: input.storageKey,
        body,
        contentType: input.mimeType,
        managedBy: TRANSCRIPTS_MANAGED_BY,
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

  /**
   * Record bytes that are ALREADY in the bucket, after checking that they are.
   *
   * The counterpart to `put` for the one case `put` cannot serve: an artifact
   * this process did not write. `media.audio.transcode`'s rendition is
   * uploaded either by the API's own streaming upload or by a WORKER NODE
   * PUTting straight to a presigned URL (issue #26), and in the second case
   * the server never sees a byte of it — there is nothing to hand `put`.
   *
   * ⚠ THE EXISTENCE CHECK IS THE WHOLE POINT, AND IT IS NOT A RE-COMPUTATION.
   * `persistNodeResult` may not redo a node's work — no second ffprobe, no
   * re-hash, no "correcting" a value it dislikes — but it may and must establish
   * that the thing it is about to point a database column at actually landed. A
   * node whose upload silently failed would otherwise leave `playback_object_id`
   * aimed at an empty key and a transcript whose audio element plays nothing.
   * The port's `adopt` makes that check and throws `KvoxObjectMissingError`,
   * which this method reports as {@link MissingUploadedObjectError}.
   *
   * ⚠ IDEMPOTENT ON THE KEY. The queue is at-least-once and the rendition's
   * key is a pure function of the job, so a retry after a successful record
   * arrives here with a key that already has a row. `adopt` returns the existing
   * object rather than creating a second, which is what stops a duplicate row
   * from being created for one file — of which the transcript would reference one
   * and `transcript.purge` would delete by prefix, leaving an orphan.
   */
  async recordUploaded(input: RecordUploadedObjectInput): Promise<ManagedObjectRef> {
    try {
      const adopted = await this.store.adopt({
        ownerId: input.ownerId,
        key: input.storageKey,
        name: input.name,
        contentType: input.mimeType,
        size: input.size,
        managedBy: TRANSCRIPTS_MANAGED_BY,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });

      this.logger.log(
        `Recorded managed object ${adopted.objectId} (${input.size} bytes) at ${input.storageKey}`,
      );

      return { id: adopted.objectId, size: input.size };
    } catch (error) {
      if (error instanceof KvoxObjectMissingError) {
        throw new MissingUploadedObjectError(input.storageKey);
      }

      throw error;
    }
  }

  /**
   * A signed GET for one object, by id.
   *
   * Returns `null` for an object that has gone — a purge that ran between the
   * caller's read and this call, most plausibly — or one that is not ready,
   * rather than throwing, so a playback endpoint can answer "no audio" instead
   * of a 500.
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

  /** Read an object's bytes back, or `null` when it has gone. Used by #27's snapshot read. */
  async download(objectId: string): Promise<Readable | null> {
    const object = (await this.store.describe([objectId])).get(objectId);

    if (!object) return null;

    return (await this.store.openRead(objectId)) as Readable;
  }

  /**
   * Remove one managed object, bytes and row.
   *
   * NEVER THROWS for an object that is already gone. Purge is re-entrant by
   * construction (it may be retried after a partial run), and a second pass
   * finding nothing to delete has succeeded, not failed. A failure to delete one
   * is logged and reported as `false`: the object is then the stale-upload
   * sweep's and the bucket lifecycle's to reclaim.
   */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;

    try {
      if (!(await this.store.describe([objectId])).has(objectId)) return false;

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

  /**
   * The signed-URL lifetime this deployment uses for transcript playback.
   *
   * SIX HOURS by default, and deliberately longer than a download link's usual
   * hour: a signed URL handed to an `<audio>` element is used for the whole time
   * somebody is listening, and a three-hour recording outlives an hour-long URL
   * halfway through. The consequence of it expiring is not an error message — it
   * is playback that silently stops seeking. The host can change it with the
   * module's `playbackUrlTtlSeconds` option.
   */
  playbackUrlTtlSeconds(): number {
    return this.options.playbackUrlTtlSeconds;
  }
}
