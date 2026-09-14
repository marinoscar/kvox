// =============================================================================
// TranscriptObjectsService (issue #25, epic #19)
// =============================================================================
//
// The narrow storage surface this module needs and `ObjectsService` does not
// offer: create a managed `storage_objects` row from bytes THIS PROCESS
// produced (the gzipped raw provider result today; #27's snapshots and #28's
// exports later), and presign a GET for one.
//
// -----------------------------------------------------------------------------
// WHY NOT `ObjectsService.simpleUpload`
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
// ⚠ EVERY ROW THIS SERVICE CREATES IS `managed_by: 'transcripts'`, and that is
// not a default a caller may override. A managed object is invisible to the
// generic listing and refuses the generic `DELETE`, which is exactly the
// ownership boundary a transcript's files need — and the reason `delete()`
// below goes through `ObjectsService.deleteManagedObject`, which makes this
// module NAME the owner it believes in before it may remove anything.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageObject } from '@prisma/client';
import { PassThrough, Readable, Transform } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { TRANSCRIPTS_MANAGED_BY } from './job-types';

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
 */
export class MissingUploadedObjectError extends Error {
  constructor(readonly storageKey: string) {
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

@Injectable()
export class TranscriptObjectsService {
  private readonly logger = new Logger(TranscriptObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    private readonly config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Write bytes to object storage and record them as a managed object.
   *
   * ⚠ STORAGE FIRST, ROW SECOND, AND THE ORDER MATTERS. A row written before
   * the upload describes an object that may not exist — every later reader
   * (a purge, a download, a restore) then has to treat "the row says so" as a
   * hint rather than a fact. The failure mode of this order is the harmless
   * one: bytes in the bucket with no row, which the transcript's own purge
   * prefix sweep and the bucket's lifecycle policy both already cover.
   */
  async put(input: PutManagedObjectInput): Promise<StorageObject> {
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
   * Stream bytes into object storage, then record them — never buffering them.
   *
   * The counterpart to `put` for an artifact THIS PROCESS PRODUCES but must not
   * hold: issue #28's PDF export, which spec §8.4 requires to stream precisely
   * because a ten-hour recording's document runs to hundreds of pages. `put`
   * takes a `Buffer`, which for that artifact would undo the streaming the
   * exporter went to the trouble of doing.
   *
   * The caller is handed a `Writable` and a promise. It writes the document to
   * the stream and ends it; the promise settles with the recorded row once the
   * upload has finished. ⚠ BOTH MUST BE AWAITED BY THE CALLER, and the reason
   * is the one `docs/specs/database-backup.md` states for `pg_dump`: awaiting
   * only the producer reports success on a truncated object, and awaiting only
   * the upload hides an error the producer raised. A failure on either side
   * destroys the other, so neither can succeed alone.
   *
   * The size is METERED as the bytes pass rather than declared, because nothing
   * knows it in advance — that is the whole point of not buffering.
   */
  putStream(input: Omit<PutManagedObjectInput, 'body'>): {
    body: PassThrough;
    done: Promise<StorageObject>;
  } {
    const body = new PassThrough();

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

      const object = await this.createRow({ ...input, size });

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
   * Record bytes that are ALREADY in the bucket, after checking that they are.
   *
   * The counterpart to `put` for the one case `put` cannot serve: an artifact
   * this process did not write. `media.audio.transcode`'s rendition is
   * uploaded either by the API's own streaming upload or by a WORKER NODE
   * PUTting straight to a presigned URL (issue #26), and in the second case
   * the server never sees a byte of it — there is nothing to hand `put`.
   *
   * ⚠ THE `exists` CHECK IS THE WHOLE POINT, AND IT IS NOT A RE-COMPUTATION.
   * `JobHandler.persistNodeResult` may not redo a node's work — no second
   * ffprobe, no re-hash, no "correcting" a value it dislikes — but it may and
   * must establish that the thing it is about to point a database column at
   * actually landed. A node whose upload silently failed, or which reported a
   * result for a job whose PUT it never made, would otherwise leave
   * `playback_object_id` aimed at an empty key and a transcript whose audio
   * element plays nothing. One HEAD request is what separates "a row that
   * describes a file" from "a row".
   *
   * ⚠ IDEMPOTENT ON THE KEY. The queue is at-least-once and the rendition's
   * key is a pure function of the job, so a retry after a successful record
   * arrives at this method with a key that already has a row. Returning the
   * existing row rather than creating a second is what stops a duplicate
   * `storage_objects` row from being created for one file — of which the
   * transcript would reference one and `transcript.purge` would delete by
   * prefix, leaving an orphan.
   */
  async recordUploaded(input: RecordUploadedObjectInput): Promise<StorageObject> {
    const existing = await this.prisma.storageObject.findFirst({
      where: { storageKey: input.storageKey },
    });

    if (existing) {
      this.logger.log(
        `Managed object ${existing.id} already records ${input.storageKey}; reusing it`,
      );

      return existing;
    }

    const present = await this.storage.exists(input.storageKey);

    if (!present) {
      throw new MissingUploadedObjectError(input.storageKey);
    }

    const object = await this.createRow(input);

    this.logger.log(
      `Recorded managed object ${object.id} (${input.size} bytes) at ${input.storageKey}`,
    );

    return object;
  }

  /** The one `storage_objects` insert this module makes. Always `managedBy`. */
  private createRow(input: RecordUploadedObjectInput): Promise<StorageObject> {
    return this.prisma.storageObject.create({
      data: {
        name: input.name,
        size: BigInt(input.size),
        mimeType: input.mimeType,
        storageKey: input.storageKey,
        storageProvider: 's3',
        bucket: this.storage.getBucket(),
        status: 'ready',
        managedBy: TRANSCRIPTS_MANAGED_BY,
        uploadedById: input.ownerId,
        metadata: (input.metadata ?? undefined) as never,
      },
    });
  }

  /**
   * A signed GET for one object, by id.
   *
   * Returns `null` for an object that has gone — a purge that ran between the
   * caller's read and this call, most plausibly — rather than throwing, so a
   * playback endpoint can answer "no audio" instead of a 500.
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
      // ⚠ PART OF THE SIGNATURE. A provider signs `response-content-disposition`
      // into the URL, which is what makes an export download as a named
      // attachment instead of rendering in the tab — and also why it cannot be
      // added by the caller afterwards as a header.
      responseContentDisposition: contentDisposition,
    });

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      object,
    };
  }

  /** Read an object's bytes back. Used by ingest's provenance re-read and #27. */
  async download(objectId: string): Promise<Readable | null> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!object) return null;

    return this.storage.download(object.storageKey);
  }

  /**
   * Remove one managed object, bytes and row.
   *
   * Delegates to `ObjectsService.deleteManagedObject`, which requires the
   * caller to name the module it believes owns the object and throws on a
   * mismatch — so "the transcripts module deleted somebody else's file" is an
   * impossible state rather than a possible bug.
   *
   * NEVER THROWS for an object that is already gone. Purge is re-entrant by
   * construction (it may be retried after a partial run), and a second pass
   * finding nothing to delete has succeeded, not failed.
   */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;

    try {
      await this.objects.deleteManagedObject(objectId, TRANSCRIPTS_MANAGED_BY);

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
   * SIX HOURS by default, and deliberately longer than `storage.signedUrlExpiry`
   * (one hour): a signed URL handed to an `<audio>` element is used for the
   * whole time somebody is listening, and a three-hour recording outlives an
   * hour-long URL halfway through. The consequence of it expiring is not an
   * error message — it is playback that silently stops seeking.
   */
  playbackUrlTtlSeconds(): number {
    return this.config.get<number>('storage.playbackUrlExpiry', 6 * 60 * 60);
  }
}
