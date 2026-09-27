// =============================================================================
// GraphObjectsService (issue #386) — the graph module's managed storage
// =============================================================================
//
// The narrow storage surface `kg.export` needs, cloned from
// `notes/note-objects.service.ts` for the reason that file's header gives:
// the ONE guarantee this class makes is that every `storage_objects` row it
// writes is `managed_by: 'graph'` — hidden from `GET /api/storage/objects`,
// 409 on the generic DELETE — and a shared class parameterised on the owner
// would guarantee that only as long as every call site passed the right string.
//
//   putStream       — stream bytes into storage, metering the size, and record
//                     the row once the upload lands (idempotent on the key)
//   putBuffer       — the same, for bytes already in memory (an upload, #387)
//   openStream      — read a managed object back as a stream (`kg.import`, #387)
//   signedUrlFor    — a short-lived signed GET with a signed Content-Disposition
//   deleteIfPresent — bytes and row, through `deleteManagedObject`, never
//                     throwing for an object already gone (purges re-run)
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StorageObject } from '@prisma/client';
import { PassThrough, Transform, type Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/providers/storage-provider.interface';
import { GRAPH_MANAGED_BY } from './job-types';

export interface PutGraphObjectInput {
  storageKey: string;
  name: string;
  mimeType: string;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class GraphObjectsService {
  private readonly logger = new Logger(GraphObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Stream bytes into object storage; `done` resolves with the recorded row.
   *
   * ⚠ The caller must await BOTH its own writing and `done` — the
   * `db.backup.run` discipline: either alone can report success on a
   * truncated object. The size is metered, never declared.
   */
  putStream(input: PutGraphObjectInput): { body: PassThrough; done: Promise<StorageObject> } {
    const body = new PassThrough();
    // Without a listener, a destroyed stream's `error` would crash the worker
    // instead of failing the job; the real signal is the rejected pipeline.
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
      const existing = await this.prisma.storageObject.findFirst({ where: { storageKey: input.storageKey } });
      if (existing) {
        // A retry re-rendered the same (deterministic) bytes over the same key.
        if (existing.size !== BigInt(size)) {
          return this.prisma.storageObject.update({ where: { id: existing.id }, data: { size: BigInt(size) } });
        }
        return existing;
      }
      return this.prisma.storageObject.create({
        data: {
          name: input.name,
          size: BigInt(size),
          mimeType: input.mimeType,
          storageKey: input.storageKey,
          storageProvider: 's3',
          bucket: this.storage.getBucket(),
          status: 'ready',
          managedBy: GRAPH_MANAGED_BY,
          uploadedById: input.ownerId,
          metadata: (input.metadata ?? undefined) as never,
        },
      });
    })();

    done.catch((error: unknown) => {
      body.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return { body, done };
  }

  /** Store bytes already in memory (an upload the request bounded). Resolves once both sides land. */
  async putBuffer(input: PutGraphObjectInput & { body: Buffer }): Promise<StorageObject> {
    const { body: bytes, ...rest } = input;
    const { body, done } = this.putStream(rest);
    body.end(bytes);
    return done;
  }

  /** The object's bytes as a stream, or null when the row (or its upload) is gone. */
  async openStream(objectId: string): Promise<{ stream: Readable; object: StorageObject } | null> {
    const object = await this.prisma.storageObject.findUnique({ where: { id: objectId } });
    if (!object || object.status !== 'ready' || object.managedBy !== GRAPH_MANAGED_BY) return null;
    return { stream: await this.storage.download(object.storageKey), object };
  }

  /** A short-lived signed GET, or null if the object is gone. The disposition is signed in. */
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

  /** Bytes and row. Never throws for an object already gone. */
  async deleteIfPresent(objectId: string | null | undefined): Promise<boolean> {
    if (!objectId) return false;
    try {
      await this.objects.deleteManagedObject(objectId, GRAPH_MANAGED_BY);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete managed object ${objectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
