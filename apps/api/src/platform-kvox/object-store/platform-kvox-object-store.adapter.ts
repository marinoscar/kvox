import { Readable, Transform } from 'node:stream';

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
import {
  KvoxObjectMissingError,
  type KvoxAbortedEvent,
  type KvoxInitUploadResult,
  type KvoxManagedBy,
  type KvoxObjectHead,
  type KvoxObjectInfo,
  type KvoxObjectState,
  type KvoxObjectStatus,
  type KvoxObjectStorePort,
  type KvoxPutResult,
  type KvoxUploadPart,
  type KvoxUploadedEvent,
  type KvoxUploadedOptions,
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
// own, as the transcripts slice's upload hook does with the event's `managedBy`.
// =============================================================================

/** The processor name recorded in a processed object's metadata. */
export const KVOX_PORT_UPLOAD_PROCESSOR_NAME = `${APP_SLUG}.ports.uploaded`;

/** `platform` object statuses, folded to the port's three. */
function statusOf(status: string): KvoxObjectStatus {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/** The platform object statuses, narrowed to the port's five. */
function stateOf(status: string): KvoxObjectState {
  if (status === 'ready' || status === 'failed' || status === 'processing' || status === 'uploading') return status;
  return 'pending';
}

/** Whether a content type is one a handler asked for (`audio/*` is a family, anything else exact). */
function wants(contentTypes: readonly string[] | undefined, mimeType: string | null | undefined): boolean {
  if (contentTypes === undefined) return true;
  const type = (mimeType ?? '').toLowerCase();

  return contentTypes.some((wanted) => {
    const pattern = wanted.toLowerCase();
    return pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
  });
}

/** A `Content-Disposition` for a download, safe for any file name. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Injectable()
export class PlatformKvoxObjectStoreAdapter implements KvoxObjectStorePort {
  private readonly logger = new Logger(PlatformKvoxObjectStoreAdapter.name);

  private readonly handlers: Array<{ handler: (e: KvoxUploadedEvent) => Promise<void>; contentTypes?: readonly string[] }> = [];

  private processorRegistered = false;

  private readonly abortHandlers: Array<(e: KvoxAbortedEvent) => Promise<void>> = [];

  private abortRegistered = false;

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
    req: {
      name: string;
      mimeType?: string | null;
      size: number;
      managedBy: KvoxManagedBy;
      allowedMimeTypes?: readonly string[];
    },
  ): Promise<KvoxInitUploadResult> {
    const init = await this.managed.initManagedUpload({
      module: req.managedBy,
      userId: ctx.userId,
      name: req.name,
      size: req.size,
      mimeType: req.mimeType,
      ...(req.allowedMimeTypes !== undefined ? { allowedMimeTypes: req.allowedMimeTypes } : {}),
    });

    return {
      objectId: init.objectId,
      uploadId: init.uploadId,
      partSize: init.partSize,
      totalParts: init.totalParts,
      parts: init.presignedUrls,
    };
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
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<KvoxPutResult> {
    // Count the bytes as they pass; a stream is never collected. A Transform, not a `data`
    // listener on a PassThrough: a listener would start the stream flowing before the provider
    // reads it and the early chunks would be lost.
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(null, chunk);
      },
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
      // IDEMPOTENT ON THE KEY: a retry of a job that already stored and recorded these bytes
      // (the key is a pure function of the job) finds its row and reuses it rather than
      // creating a second one for one file.
      const existing = await this.managed.findByKey(req.key);
      if (existing) return { objectId: existing.id, size: Number(existing.size) };

      const row = await this.managed.create({
        module: req.managedBy,
        key: req.key,
        mimeType: req.contentType,
        size,
        uploadedById: req.ownerId,
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.metadata !== undefined ? { metadata: req.metadata } : {}),
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
  async adopt(req: {
    ownerId: string;
    key: string;
    name: string;
    contentType: string;
    size: number;
    managedBy: KvoxManagedBy;
    metadata?: Record<string, unknown>;
  }): Promise<{ objectId: string }> {
    const existing = await this.managed.findByKey(req.key);
    if (existing) return { objectId: existing.id };

    if (!(await this.storage.exists(req.key))) throw new KvoxObjectMissingError(req.key);

    const row = await this.managed.create({
      module: req.managedBy,
      key: req.key,
      name: req.name,
      mimeType: req.contentType,
      size: req.size,
      uploadedById: req.ownerId,
      ...(req.metadata !== undefined ? { metadata: req.metadata } : {}),
    });

    return { objectId: row.id };
  }

  @Trace()
  async describe(objectIds: readonly string[]): Promise<Map<string, KvoxObjectInfo>> {
    const found = new Map<string, KvoxObjectInfo>();
    if (objectIds.length === 0) return found;

    const ids = [...new Set(objectIds)];
    const rows = await this.managed.findMany({ where: { id: { in: ids } } });
    const owners = await this.managed.managedBy(ids);

    for (const row of rows) {
      const metadata = row.metadata;

      found.set(row.id, {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: Number(row.size),
        state: stateOf(row.status),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ownerId: row.uploadedById,
        managedBy: asKvoxModule(owners.get(row.id) ?? null),
        metadata:
          typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : null,
      });
    }

    return found;
  }

  @Trace()
  async setMetadata(objectId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.managed.setMetadata(objectId, metadata);
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

  onAborted(handler: (e: KvoxAbortedEvent) => Promise<void>): void {
    if (!this.abortRegistered) {
      this.abortRegistered = true;
      this.managed.onAborted(async ({ objectId, module }) => {
        for (const registered of this.abortHandlers) {
          try {
            await registered({ objectId, managedBy: asKvoxModule(module) });
          } catch (error) {
            this.logger.error(
              `An abort handler failed for ${objectId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });
    }

    this.abortHandlers.push(handler);
  }

  onUploaded(handler: (e: KvoxUploadedEvent) => Promise<void>, options?: KvoxUploadedOptions): void {
    this.handlers.push({ handler, ...(options?.contentTypes !== undefined ? { contentTypes: options.contentTypes } : {}) });
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
      // The platform queues one `storage.object.process` job per completed upload that ANY
      // processor accepts, so the processor says yes only to a file some handler wants (a
      // transcript's source is audio or video; a handler with no filter wants everything).
      canProcess: (object: StorageObject) => this.handlers.some((entry) => wants(entry.contentTypes, object.mimeType)),
      process: async (object: StorageObject): Promise<ObjectProcessorResult> => {
        const owners = await this.managed.managedBy([object.id]);
        const event: KvoxUploadedEvent = {
          objectId: object.id,
          managedBy: asKvoxModule(owners.get(object.id) ?? null),
        };

        // A handler's failure is recorded and does not fail the object or stop the next handler.
        let failed = 0;
        for (const { handler, contentTypes } of this.handlers) {
          if (!wants(contentTypes, object.mimeType)) continue;

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
