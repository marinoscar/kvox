import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type {
  KvoxManagedBy,
  KvoxObjectStatus,
  KvoxObjectStorePort,
  KvoxUploadPart,
  KvoxUploadedEvent,
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
        mimeType: req.mimeType,
        managedBy: req.managedBy,
        status: 'pending',
        bytes: Buffer.alloc(0),
        declaredSize: req.size,
      });
      parts.set(objectId, new Map());
      const total = Math.max(1, Math.ceil(req.size / PART_SIZE));
      return {
        objectId,
        partSize: PART_SIZE,
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
      if (object && object.status === 'pending') objects.delete(objectId);
    },

    async put(req) {
      const bytes = await collect(req.body);
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
      });
      return { objectId, size: bytes.length };
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
  };

  return store;
}
