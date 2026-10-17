import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  KvoxObjectMissingError,
  type KvoxAbortedEvent,
  type KvoxManagedBy,
  type KvoxObjectInfo,
  type KvoxObjectStatus,
  type KvoxObjectStorePort,
  type KvoxUploadPart,
  type KvoxUploadedEvent,
} from '../ports/index.js';

/** The part size the fake advertises for resumable uploads: 5 MiB, S3's minimum. */
const PART_SIZE = 5 * 1024 * 1024;

/**
 * One object in the fake store.
 *
 * @stability experimental
 */
export interface InMemoryKvoxObject {
  /** The object id. */
  id: string;
  /** The owner's user id. */
  ownerId: string;
  /** The storage key (`put`) or the upload's file name (`initUpload`). */
  key: string;
  /** The content type. */
  mimeType: string;
  /** The owning module. */
  managedBy: KvoxManagedBy;
  /** Where the object stands. */
  status: KvoxObjectStatus;
  /** The bytes; empty while an upload is pending. */
  bytes: Buffer;
  /** The size declared by `initUpload`, used when no part was uploaded. */
  declaredSize: number;
  /** The display name. */
  name: string;
  /** Data stored with the object by `put` and `adopt`. */
  metadata: Record<string, unknown> | undefined;
  /** When the object was created. */
  createdAt: Date;
  /** When it last changed. */
  updatedAt: Date;
}

/**
 * An in-memory {@link KvoxObjectStorePort} with test helpers.
 *
 * @stability experimental
 */
export interface InMemoryKvoxObjectStore extends KvoxObjectStorePort {
  /** Every object, by id. */
  readonly objects: ReadonlyMap<string, InMemoryKvoxObject>;
  /**
   * Stands in for the client's PUT of one part to a presigned URL.
   *
   * @param objectId - the pending upload.
   * @param partNumber - the 1-based part number.
   * @param bytes - the part's bytes.
   */
  uploadPart(objectId: string, partNumber: number, bytes: Buffer): void;
  /**
   * Stands in for a worker node PUTting bytes straight to a presigned URL: they
   * are in the store under `key` but have no object record until `adopt` records
   * them.
   *
   * @param key - the storage key.
   * @param bytes - the bytes.
   */
  landBytes(key: string, bytes: Buffer): void;
}

async function collect(body: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Builds an in-memory object store: puts, resumable uploads (parts uploaded with
 * {@link InMemoryKvoxObjectStore.uploadPart}), reads, signed URLs and the
 * upload-completed hook.
 *
 * @returns the fake store.
 * @stability experimental
 */
export function createInMemoryKvoxObjectStore(): InMemoryKvoxObjectStore {
  const objects = new Map<string, InMemoryKvoxObject>();
  const parts = new Map<string, Map<number, Buffer>>();
  const handlers: Array<(e: KvoxUploadedEvent) => Promise<void>> = [];
  const abortHandlers: Array<(e: KvoxAbortedEvent) => Promise<void>> = [];
  const landed = new Map<string, Buffer>();

  const urlsFor = (objectId: string, numbers: number[]): KvoxUploadPart[] =>
    numbers.map((partNumber) => ({ partNumber, url: `memory://uploads/${objectId}/${partNumber}` }));

  const store: InMemoryKvoxObjectStore = {
    objects,

    async initUpload(ctx, req) {
      const objectId = randomUUID();
      objects.set(objectId, {
        id: objectId,
        ownerId: ctx.userId,
        key: req.name,
        mimeType: req.mimeType || 'application/octet-stream',
        managedBy: req.managedBy,
        status: 'pending',
        bytes: Buffer.alloc(0),
        declaredSize: req.size,
        name: req.name,
        metadata: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      parts.set(objectId, new Map());
      const total = Math.max(1, Math.ceil(req.size / PART_SIZE));
      return {
        objectId,
        uploadId: objectId,
        partSize: PART_SIZE,
        totalParts: total,
        parts: urlsFor(objectId, Array.from({ length: total }, (_, i) => i + 1)),
      };
    },

    async signParts(objectId, partNumbers) {
      if (!objects.has(objectId)) throw new Error(`Upload ${objectId} does not exist`);
      return urlsFor(objectId, partNumbers);
    },

    uploadPart(objectId, partNumber, bytes) {
      const held = parts.get(objectId);
      if (!held) throw new Error(`Upload ${objectId} does not exist`);
      held.set(partNumber, bytes);
    },

    async completeUpload(objectId) {
      const object = objects.get(objectId);
      if (!object) throw new Error(`Upload ${objectId} does not exist`);
      if (object.status === 'ready') return;
      const held = parts.get(objectId) ?? new Map<number, Buffer>();
      object.bytes = Buffer.concat([...held.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
      object.status = 'ready';
      parts.delete(objectId);
      for (const handler of handlers) await handler({ objectId, managedBy: object.managedBy });
    },

    async abortUpload(objectId) {
      parts.delete(objectId);
      const object = objects.get(objectId);
      if (object && object.status === 'pending') {
        objects.delete(objectId);
        for (const handler of abortHandlers) await handler({ objectId, managedBy: object.managedBy });
      }
    },

    async put(req) {
      const bytes = await collect(req.body);

      // IDEMPOTENT ON THE KEY, as the port promises: a retry reuses the object.
      for (const object of objects.values()) {
        if (object.key === req.key) return { objectId: object.id, size: object.bytes.length };
      }

      const objectId = randomUUID();
      objects.set(objectId, {
        id: objectId,
        ownerId: req.ownerId,
        key: req.key,
        mimeType: req.contentType,
        managedBy: req.managedBy,
        status: 'ready',
        bytes,
        declaredSize: bytes.length,
        name: req.name ?? req.key.split('/').pop() ?? req.key,
        metadata: req.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { objectId, size: bytes.length };
    },

    landBytes(key, bytes) {
      landed.set(key, bytes);
    },

    async adopt(req) {
      for (const object of objects.values()) {
        if (object.key === req.key) return { objectId: object.id };
      }
      const bytes = landed.get(req.key);
      if (bytes === undefined) throw new KvoxObjectMissingError(req.key);
      const objectId = randomUUID();
      objects.set(objectId, {
        id: objectId,
        ownerId: req.ownerId,
        key: req.key,
        mimeType: req.contentType,
        managedBy: req.managedBy,
        status: 'ready',
        bytes,
        declaredSize: req.size,
        name: req.name,
        metadata: req.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { objectId };
    },

    async openRead(objectId) {
      const object = objects.get(objectId);
      if (!object) throw new Error(`Object ${objectId} does not exist`);
      return Readable.from([object.bytes]);
    },

    async head(objectId) {
      const object = objects.get(objectId);
      if (!object) return null;
      const size = object.status === 'ready' ? object.bytes.length : object.declaredSize;
      return { size, mimeType: object.mimeType, status: object.status };
    },

    async describe(objectIds) {
      const found = new Map<string, KvoxObjectInfo>();
      for (const id of objectIds) {
        const object = objects.get(id);
        if (!object) continue;
        found.set(id, {
          id,
          name: object.name,
          mimeType: object.mimeType,
          size: object.status === 'ready' ? object.bytes.length : object.declaredSize,
          state: object.status === 'ready' ? 'ready' : object.status === 'failed' ? 'failed' : 'uploading',
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
          ownerId: object.ownerId,
          managedBy: object.managedBy,
          metadata: object.metadata ?? null,
        });
      }
      return found;
    },

    async setMetadata(objectId, metadata) {
      const object = objects.get(objectId);
      if (!object) return;
      object.metadata = metadata;
      object.updatedAt = new Date();
    },

    async signedDownloadUrl(objectId, opts) {
      if (!objects.has(objectId)) throw new Error(`Object ${objectId} does not exist`);
      const expires = Date.now() + opts.ttlSeconds * 1000;
      const token = createHash('sha256').update(`${objectId}:${expires}`).digest('hex').slice(0, 16);
      const name = opts.filename ? `&filename=${encodeURIComponent(opts.filename)}` : '';
      return `memory://objects/${objectId}?expires=${expires}&sig=${token}${name}`;
    },

    async delete(objectId) {
      objects.delete(objectId);
      parts.delete(objectId);
    },

    onUploaded(handler) {
      handlers.push(handler);
    },

    onAborted(handler) {
      abortHandlers.push(handler);
    },
  };

  return store;
}
