// =============================================================================
// GraphObjectsService (issue #386) — the graph module's managed storage
// =============================================================================
//
// The narrow storage surface `kg.export` needs, cloned from
// `notes/note-objects.service.ts` for the reason that file's header gives:
// the ONE guarantee this class makes is that every `storage_objects` row it
// writes is owned by `graph` (a `kvox_object_ownership` row) — absent from
// `GET /api/kvox/files`, 409 on the generic DELETE — and a shared class
// parameterised on the owner would guarantee that only as long as every call
// site passed the right string.
//
//   putStream       — stream bytes into storage, metering the size, and record
//                     the row once the upload lands (idempotent on the key)
//   putBuffer       — the same, for bytes already in memory (an upload, #387)
//   openStream      — read a managed object back as a stream (`kg.import`, #387)
//   signedUrlFor    — a short-lived signed GET with a signed Content-Disposition
//   deleteIfPresent — bytes and row, through the object-store port, never throwing for
//                     an object already gone (purges re-run)
//   listImports     — the ids of the owner's uploaded import files, for the purge
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassThrough, Transform, type Readable } from 'node:stream';

import { KVOX_OBJECT_STORE, type KvoxObjectStorePort } from '../ports/index.js';
import { GRAPH_MANAGED_BY } from './job-types.js';

/**
 * Everything `putStream` and `putBuffer` need.
 *
 * @stability experimental
 */
export interface PutGraphObjectInput {
  /** The storage key. */
  storageKey: string;
  /** The display name, which is also the download's file name. */
  name: string;
  /** The content type. */
  mimeType: string;
  /** The owning user. */
  ownerId: string;
  /** Free-form data stored with the object. */
  metadata?: Record<string, unknown>;
}

/**
 * A stored object, as the graph pipeline refers to it.
 *
 * @stability experimental
 */
export interface GraphObjectRef {
  /** The object's id. */
  id: string;
  /** The stored size in bytes. */
  size: number;
}

/**
 * GraphObjectsService: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphObjectsService {
  private readonly logger = new Logger(GraphObjectsService.name);

  constructor(@Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort) {}

  /**
   * Stream bytes into object storage; `done` resolves with the recorded object.
   *
   * ⚠ The caller must await BOTH its own writing and `done` — the
   * `db.backup.run` discipline: either alone can report success on a
   * truncated object. The size is metered by the store, never declared.
   */
  putStream(input: PutGraphObjectInput): { body: PassThrough; done: Promise<GraphObjectRef> } {
    const body = new PassThrough();
    // Without a listener, a destroyed stream's `error` would crash the worker
    // instead of failing the job; the real signal is the rejected pipeline.
    body.on('error', (error: Error) => {
      this.logger.warn(`Managed upload to ${input.storageKey} was aborted: ${error.message}`);
    });

    // The store meters what actually lands; this pass-through only keeps the stream flowing.
    const metered = body.pipe(new Transform({ transform: (chunk, _encoding, callback) => callback(null, chunk) }));

    const done = (async (): Promise<GraphObjectRef> => {
      // A retry re-rendered the same (deterministic) bytes over the same key: the store reuses the object.
      const stored = await this.store.put({
        ownerId: input.ownerId,
        key: input.storageKey,
        body: metered,
        contentType: input.mimeType,
        managedBy: GRAPH_MANAGED_BY,
        name: input.name,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
      return { id: stored.objectId, size: stored.size };
    })();

    done.catch((error: unknown) => {
      body.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return { body, done };
  }

  /** Store bytes already in memory (an upload the request bounded). Resolves once both sides land. */
  async putBuffer(input: PutGraphObjectInput & { body: Buffer }): Promise<GraphObjectRef> {
    const { body: bytes, ...rest } = input;
    const stored = await this.store.put({
      ownerId: rest.ownerId,
      key: rest.storageKey,
      body: bytes,
      contentType: rest.mimeType,
      managedBy: GRAPH_MANAGED_BY,
      name: rest.name,
      ...(rest.metadata !== undefined ? { metadata: rest.metadata } : {}),
    });
    return { id: stored.objectId, size: stored.size };
  }

  /** The object's bytes as a stream, or null when the row (or its upload) is gone or not the graph's. */
  async openStream(objectId: string): Promise<{ stream: Readable; object: { ownerId: string | null } } | null> {
    const object = (await this.store.describe([objectId])).get(objectId);
    if (!object || object.state !== 'ready') return null;
    if (object.managedBy !== GRAPH_MANAGED_BY) return null;
    return { stream: (await this.store.openRead(objectId)) as Readable, object: { ownerId: object.ownerId ?? null } };
  }

  /** A short-lived signed GET, or null if the object is gone. The file name is signed in. */
  async signedUrlFor(
    objectId: string,
    expiresInSeconds: number,
    filename?: string,
  ): Promise<{ url: string; expiresAt: Date } | null> {
    const object = (await this.store.describe([objectId])).get(objectId);
    if (!object || object.state !== 'ready') return null;
    const url = await this.store.signedDownloadUrl(objectId, {
      ttlSeconds: expiresInSeconds,
      ...(filename !== undefined ? { filename } : {}),
    });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  /** The ids of up to `limit` uploaded import files of `ownerId` under `keyPrefix`, ascending. */
  async listImports(ownerId: string, keyPrefix: string, limit: number): Promise<string[]> {
    return this.store.listManaged({ ownerId, managedBy: GRAPH_MANAGED_BY, keyPrefix, limit });
  }

  /** Bytes and row. Never throws for an object already gone. */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;
    try {
      const object = (await this.store.describe([objectId])).get(objectId);
      if (!object) return false;
      if (object.managedBy !== GRAPH_MANAGED_BY) {
        this.logger.warn(`Managed object ${objectId} is not owned by ${GRAPH_MANAGED_BY}; it was not deleted`);
        return false;
      }
      await this.store.delete(objectId);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete managed object ${objectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
