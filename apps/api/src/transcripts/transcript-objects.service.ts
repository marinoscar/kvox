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
import { Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { TRANSCRIPTS_MANAGED_BY } from './job-types';

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

    const object = await this.prisma.storageObject.create({
      data: {
        name: input.name,
        size: BigInt(input.body.byteLength),
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

    this.logger.log(
      `Stored managed object ${object.id} (${input.body.byteLength} bytes) at ${input.storageKey}`,
    );

    return object;
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
  ): Promise<{ url: string; expiresAt: Date; object: StorageObject } | null> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!object || object.status !== 'ready') return null;

    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn: expiresInSeconds,
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
