import { PassThrough, Readable } from 'node:stream';

import { APP_SLUG } from '@app/shared';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  ObjectProcessorRegistry,
  ObjectsService,
  STORAGE_PROVIDER,
  type ObjectProcessor,
  type ObjectProcessorResult,
  type StorageObject,
  type StorageProvider,
} from '@marinoscar/platform-api/storage';
import type {
  KvoxInitUploadResult,
  KvoxManagedBy,
  KvoxObjectHead,
  KvoxObjectStatus,
  KvoxObjectStorePort,
  KvoxPutResult,
  KvoxUploadPart,
  KvoxUploadedEvent,
} from '@marinoscar/kvox-api/ports';

import { KvoxManagedObjectsService, type StorageObjectRow } from '../../kvox-objects/kvox-managed-objects.service';
import { asKvoxModule } from '../../kvox-objects/kvox-object-ownership.store';
import { KvoxS3PartLister } from '../../kvox-objects/kvox-s3-part-lister';

// =============================================================================
// PlatformKvoxObjectStoreAdapter: the `KVOX_OBJECT_STORE` port over the platform
// storage slice (issue #490, epic #486)
// =============================================================================
//
// Every statement on `storage_objects` goes through `KvoxManagedObjects` (the only
// app code that reads that table; `test/kvox-objects/storage-boundary.spec.ts`
// guards it), so the organization scope and the `kvox_object_ownership` stamp are
// applied in one place. The platform `ObjectsService` does the multipart protocol
// and `STORAGE_PROVIDER` the bytes.
//
// `onUploaded` is NOT synchronous with `completeUpload`. The platform runs every
// registered `ObjectProcessor` in its server-only `storage.object.process` job once
// an upload completes, so this adapter registers ONE processor and fans the event
// out to the handlers. A handler decides from `managedBy` whether the object is its
// own, exactly as `TranscriptUploadProcessor` does with the ownership table.
// =============================================================================

/** The processor name recorded in a processed object's metadata. */
export const KVOX_PORT_UPLOAD_PROCESSOR_NAME = `${APP_SLUG}.ports.uploaded`;

/** `platform` object statuses, folded to the port's three. */
function statusOf(status: string): KvoxObjectStatus {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/** A `Content-Disposition` for a download, safe for any file name. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Injectable()
export class PlatformKvoxObjectStoreAdapter implements KvoxObjectStorePort {
  private readonly logger = new Logger(PlatformKvoxObjectStoreAdapter.name);

  private readonly handlers: Array<(e: KvoxUploadedEvent) => Promise<void>> = [];

  private processorRegistered = false;

  constructor(
    private readonly managed: KvoxManagedObjectsService,
    private readonly objects: ObjectsService,
    private readonly lister: KvoxS3PartLister,
    private readonly registry: ObjectProcessorRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Trace()
  async initUpload(
    ctx: { userId: string },
    req: { name: string; mimeType: string; size: number; managedBy: KvoxManagedBy },
  ): Promise<KvoxInitUploadResult> {
    const init = await this.managed.initManagedUpload({
      module: req.managedBy,
      userId: ctx.userId,
      name: req.name,
      size: req.size,
      mimeType: req.mimeType,
    });

    return { objectId: init.objectId, partSize: init.partSize, parts: init.presignedUrls };
  }

  @Trace()
  async signParts(objectId: string, partNumbers: number[]): Promise<KvoxUploadPart[]> {
    const object = await this.openUpload(objectId);

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.getSignedUploadUrl(object.storageKey, object.s3UploadId as string, partNumber),
      })),
    );
  }

  @Trace()
  async completeUpload(objectId: string, parts?: { partNumber: number; etag: string }[]): Promise<void> {
    const object = await this.managed.get(objectId);
    if (!object || object.uploadedById === null) throw new NotFoundException('Upload not found');

    // The browser cannot read a cross-origin ETag, so a caller usually has no list: ask the provider.
    const listed =
      parts ??
      (object.s3UploadId
        ? (await this.lister.listParts(object.storageKey, object.s3UploadId)).map(({ partNumber, etag }) => ({
            partNumber,
            etag,
          }))
        : []);

    await this.objects.completeUpload(
      objectId,
      { parts: listed.map(({ partNumber, etag }) => ({ partNumber, eTag: etag })) },
      object.uploadedById,
      object.orgId,
    );
  }

  @Trace()
  async abortUpload(objectId: string): Promise<void> {
    const object = await this.managed.get(objectId);
    // An upload whose uploader is gone has no one to cancel it; housekeeping reconciles it.
    if (!object || object.uploadedById === null) return;

    try {
      await this.managed.abortManaged(objectId, object.uploadedById, { orgId: object.orgId });
    } catch (error) {
      // Idempotent: an upload that already settled (or is gone) has nothing left to cancel.
      if (error instanceof BadRequestException || error instanceof NotFoundException) return;
      throw error;
    }
  }

  @Trace()
  async put(req: {
    ownerId: string;
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    managedBy: KvoxManagedBy;
  }): Promise<KvoxPutResult> {
    // Count the bytes as they pass; a stream is never collected.
    let size = 0;
    const counted = new PassThrough();
    counted.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });

    const source = Buffer.isBuffer(req.body)
      ? Readable.from([req.body])
      : req.body instanceof Readable
        ? req.body
        : Readable.from(req.body as AsyncIterable<Buffer>);
    source.on('error', (error) => counted.destroy(error));
    source.pipe(counted);

    await this.storage.upload(req.key, counted, {
      mimeType: req.contentType,
      ...(Buffer.isBuffer(req.body) ? { contentLength: req.body.length } : {}),
    });

    try {
      const row = await this.managed.create({
        module: req.managedBy,
        key: req.key,
        mimeType: req.contentType,
        size,
        uploadedById: req.ownerId,
      });
      return { objectId: row.id, size };
    } catch (error) {
      // Bytes with no row would be unreachable and never purged: take them back.
      await this.storage.delete(req.key).catch((cleanup: unknown) => {
        this.logger.warn(
          `Could not remove ${req.key} after a failed put: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
        );
      });
      throw error;
    }
  }

  @Trace()
  async openRead(objectId: string): Promise<NodeJS.ReadableStream> {
    const opened = await this.managed.openStream(objectId);
    if (!opened) throw new NotFoundException('Object not found');

    return opened.stream;
  }

  @Trace()
  async head(objectId: string): Promise<KvoxObjectHead | null> {
    const object = await this.managed.get(objectId);
    if (!object) return null;

    return { size: Number(object.size), mimeType: object.mimeType, status: statusOf(object.status) };
  }

  @Trace()
  async signedDownloadUrl(objectId: string, opts: { ttlSeconds: number; filename?: string }): Promise<string> {
    const signed = await this.managed.signedDownloadUrl(objectId, {
      expiresIn: opts.ttlSeconds,
      ...(opts.filename !== undefined ? { contentDisposition: attachment(opts.filename) } : {}),
    });
    if (!signed) throw new NotFoundException('Object not found or not ready');

    return signed.url;
  }

  @Trace()
  async delete(objectId: string): Promise<void> {
    const object = await this.managed.get(objectId);
    if (!object) return;

    const owners = await this.managed.managedBy([objectId]);
    const module = owners.get(objectId);
    if (module) {
      await this.managed.deleteManaged(objectId, module);
      return;
    }

    // Not module-owned (nothing in the domain creates such an object): the platform's own delete,
    // which needs the uploader on record.
    if (object.uploadedById === null) {
      throw new ConflictException(`Object ${objectId} has no owner on record and no managing module`);
    }
    await this.objects.delete(objectId, object.uploadedById, object.orgId, { canDeleteAny: true });
  }

  onUploaded(handler: (e: KvoxUploadedEvent) => Promise<void>): void {
    this.handlers.push(handler);
    if (this.processorRegistered) return;

    this.processorRegistered = true;
    this.registry.register(this.processor());
  }

  /** The one `ObjectProcessor` that turns the platform's per-object run into port events. */
  private processor(): ObjectProcessor {
    return {
      name: KVOX_PORT_UPLOAD_PROCESSOR_NAME,
      // After the module processors, which only enqueue.
      priority: 900,
      canProcess: () => true,
      process: async (object: StorageObject): Promise<ObjectProcessorResult> => {
        const owners = await this.managed.managedBy([object.id]);
        const event: KvoxUploadedEvent = {
          objectId: object.id,
          managedBy: asKvoxModule(owners.get(object.id) ?? null),
        };

        // A handler's failure is recorded and does not fail the object or stop the next handler.
        let failed = 0;
        for (const handler of this.handlers) {
          try {
            await handler(event);
          } catch (error) {
            failed += 1;
            this.logger.error(
              `An upload handler failed for ${object.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        return { success: true, metadata: { handlers: this.handlers.length, failed } };
      },
    };
  }

  /** The object with a multipart upload still open, or 404/400. */
  private async openUpload(objectId: string): Promise<StorageObjectRow> {
    const object = await this.managed.get(objectId);
    if (!object) throw new NotFoundException('Upload not found');
    if (!object.s3UploadId || (object.status !== 'pending' && object.status !== 'uploading')) {
      throw new BadRequestException(`Upload is no longer in progress (status: ${object.status})`);
    }

    return object;
  }
}
