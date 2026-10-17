// =============================================================================
// KvoxManagedObjects (issue #469)
// =============================================================================
//
// The ONLY app code that reads or writes `storage_objects` and
// `storage_object_chunks`. The platform storage slice owns those tables (org
// tables with forced row-level security); this app's domain modules (transcripts,
// notes, graph) reach them through this class so that:
//
//   * every statement runs under `runInOrg` (or inside the caller's own
//     `JobScope.run` transaction, passed as `opts.tx`), with the scope set by
//     `set_config(..., true)` and never a session `SET`;
//   * the ownership marker (`kvox_object_ownership`) is written in the same
//     transaction as the object row;
//   * a unit tripwire (`test/kvox-objects/storage-boundary.spec.ts`) fails when
//     any other file touches `storageObject` / `storageObjectChunk`.
//
// Organization: an explicit `orgId` wins; otherwise the default organization
// (`resolveOrgId`, single-organization mode). A handler that already holds a job
// transaction passes it as `opts.tx` (see `common/job-org-scope.ts`).
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, StorageObject } from '@prisma/client';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import { ObjectsService, STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import type { InitUploadResponseDto, StorageProvider } from '@marinoscar/platform-api/storage';
import type { Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { KvoxObjectOwnershipStore, type KvoxModule } from './kvox-object-ownership.store';
import { AUDIO_EXTENSIONS, isMimeTypeAllowed, resolveMimeType } from './upload-mime';

export type { KvoxModule } from './kvox-object-ownership.store';

/** One `storage_objects` row, as the generated client reads it. */
export type StorageObjectRow = StorageObject;

/** What `initManagedUpload` returns: the platform's init-upload response. */
export type InitUploadResult = InitUploadResponseDto;

/** The transaction client a caller may hand in to run inside its own org scope. */
export type KvoxObjectsTx = Prisma.TransactionClient;

/** Where a call runs: the caller's own transaction, or a fresh `runInOrg`. */
export interface KvoxObjectsScope {
  /** The caller's transaction (a `JobScope.run` / `runInOrg` client). When set, `orgId` is ignored. */
  tx?: KvoxObjectsTx;
  /** The organization to open; defaults to the deployment's default organization. */
  orgId?: string | null;
}

/** The object row to create (the issue's fields, plus the optional extras every caller needs). */
export interface CreateManagedObjectInput {
  module: KvoxModule;
  key: string;
  mimeType: string;
  size: number;
  uploadedById: string;
  orgId?: string;
  /** Display name; defaults to the last segment of `key`. */
  name?: string;
  /** Free-form JSONB. */
  metadata?: Record<string, unknown>;
  /** Defaults to `ready`: a managed row is created for bytes that already landed. */
  status?: 'ready' | 'processing' | 'failed';
}

export interface SignedDownloadOptions {
  expiresIn: number;
  /** Signed into the URL as `response-content-disposition`. */
  contentDisposition?: string;
}

/** What `initManagedUpload` takes (the issue's fields, plus the module's own content-type list). */
export interface InitManagedUploadInput {
  module: KvoxModule;
  userId: string;
  name: string;
  size: number;
  /** Optional: a browser may report none, and the extension then decides (`resolveMimeType`). */
  mimeType?: string | null;
  orgId?: string;
  /**
   * The module's own content-type allowlist (`audio/*`, `video/*` for a
   * transcript's source). Checked AFTER the extension-aware type resolution and
   * BEFORE the platform's `storage.allowedMimeTypes` check, which still applies.
   */
  allowedMimeTypes?: readonly string[];
}

/** The gateway contract (the issue's "Interfaces and contracts"). */
export interface KvoxManagedObjects {
  create(input: CreateManagedObjectInput): Promise<StorageObjectRow>;
  initManagedUpload(input: InitManagedUploadInput): Promise<InitUploadResult>;
  get(id: string, scope?: KvoxObjectsScope): Promise<StorageObjectRow | null>;
  findByKey(key: string, scope?: KvoxObjectsScope): Promise<StorageObjectRow | null>;
  managedBy(ids: readonly string[], scope?: KvoxObjectsScope): Promise<Map<string, KvoxModule>>;
  deleteManaged(id: string, module: KvoxModule, scope?: KvoxObjectsScope): Promise<void>;
}

@Injectable()
export class KvoxManagedObjectsService implements KvoxManagedObjects {
  private readonly logger = new Logger(KvoxManagedObjectsService.name);

  private defaultOrg: Promise<string> | null = null;

  /** Called after an upload is aborted (see {@link onAborted}). */
  private readonly abortListeners: Array<(event: { objectId: string; module: KvoxModule }) => Promise<void>> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: KvoxObjectOwnershipStore,
    private readonly objects: ObjectsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** The organization a call without a transaction opens. */
  async resolveOrg(orgId?: string | null): Promise<string> {
    if (orgId) return orgId;
    if (!this.defaultOrg) {
      this.defaultOrg = resolveOrgId(this.prisma, null, 'KvoxManagedObjects').catch((error: unknown) => {
        this.defaultOrg = null;
        throw error;
      });
    }
    return this.defaultOrg;
  }

  /**
   * Runs `fn` on the caller's transaction, or opens `runInOrg` for the scope's
   * organization. The escape hatch for a caller that must combine several
   * object statements in one transaction; prefer the named methods.
   */
  async run<R>(scope: KvoxObjectsScope | undefined, fn: (tx: KvoxObjectsTx) => Promise<R>): Promise<R> {
    if (scope?.tx) return fn(scope.tx);
    const orgId = await this.resolveOrg(scope?.orgId);
    return this.prisma.runInOrg({ orgId }, (tx) => fn(tx as unknown as KvoxObjectsTx));
  }

  async create(input: CreateManagedObjectInput & { tx?: KvoxObjectsTx }): Promise<StorageObjectRow> {
    const scope: KvoxObjectsScope = { tx: input.tx, orgId: input.orgId };
    return this.run(scope, async (tx) => {
      const orgId = input.tx ? await this.orgOfTx(input.orgId) : await this.resolveOrg(input.orgId);
      const created = await tx.storageObject.create({
        data: {
          name: input.name ?? input.key.split('/').pop() ?? input.key,
          size: BigInt(input.size),
          mimeType: input.mimeType,
          storageKey: input.key,
          storageProvider: this.storage.kind,
          bucket: this.storage.getBucket(),
          status: input.status ?? 'ready',
          orgId,
          uploadedById: input.uploadedById,
          metadata: (input.metadata ?? undefined) as never,
        },
      });
      await this.ownership.stamp(tx, { objectId: created.id, orgId, module: input.module });
      return created;
    });
  }

  async initManagedUpload(input: InitManagedUploadInput): Promise<InitUploadResult> {
    // A browser that reported `application/octet-stream` or nothing for a
    // `.m4a` is the ORDINARY case, not an attack: the extension decides.
    const mimeType = resolveMimeType(input.name, input.mimeType);

    if (!mimeType || (input.allowedMimeTypes && !isMimeTypeAllowed(mimeType, [...input.allowedMimeTypes]))) {
      const declared = input.mimeType?.trim() ? `"${input.mimeType}"` : 'no content type';
      throw new BadRequestException(
        `Files of type ${declared} are not accepted. Allowed types: ` +
          `${(input.allowedMimeTypes ?? []).join(', ')}. A file with no usable content type is ` +
          `accepted when its extension is one of: ${AUDIO_EXTENSIONS.join(' ')}`,
      );
    }

    const orgId = await this.resolveOrg(input.orgId);
    const init = await this.objects.initUpload(
      { name: input.name, size: input.size, mimeType },
      input.userId,
      orgId,
    );

    try {
      await this.run({ orgId }, (tx) =>
        this.ownership.stamp(tx, { objectId: init.objectId, orgId, module: input.module }),
      );
    } catch (error) {
      // An unmarked object would be listed and deletable by the generic routes:
      // take the upload back rather than leave it half-claimed.
      await this.objects.abortUpload(init.objectId, input.userId, orgId).catch((abortError: unknown) => {
        this.logger.warn(
          `Could not abort upload ${init.objectId} after an ownership failure: ` +
            `${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
      });
      throw error;
    }

    return init;
  }

  get(id: string, scope?: KvoxObjectsScope): Promise<StorageObjectRow | null> {
    return this.run(scope, (tx) => tx.storageObject.findUnique({ where: { id } }));
  }

  findByKey(key: string, scope?: KvoxObjectsScope): Promise<StorageObjectRow | null> {
    return this.run(scope, (tx) => tx.storageObject.findFirst({ where: { storageKey: key } }));
  }

  managedBy(ids: readonly string[], scope?: KvoxObjectsScope): Promise<Map<string, KvoxModule>> {
    return this.run(scope, (tx) => this.ownership.managedBy(tx, ids));
  }

  // ---------------------------------------------------------------------------
  // Typed pass-throughs: the reads and writes the domain modules need that are
  // not worth a named method each. They exist so the SCOPE (`runInOrg`, or the
  // caller's job transaction) is applied in ONE place; the arguments are
  // Prisma's own, so `kvoxOwnership` (the ownership side table) and the
  // domain back-relations (`transcriptsAsSource`, `notesAsSourceObject`, ...)
  // are filterable. `where: { kvoxOwnership: null }` is "no module owns it".
  // ---------------------------------------------------------------------------

  findMany<A extends Prisma.StorageObjectFindManyArgs>(
    args: A,
    scope?: KvoxObjectsScope,
  ): Promise<Prisma.StorageObjectGetPayload<A>[]> {
    return this.run(scope, (tx) => tx.storageObject.findMany(args) as unknown as Promise<Prisma.StorageObjectGetPayload<A>[]>);
  }

  findFirst<A extends Prisma.StorageObjectFindFirstArgs>(
    args: A,
    scope?: KvoxObjectsScope,
  ): Promise<Prisma.StorageObjectGetPayload<A> | null> {
    return this.run(scope, (tx) => tx.storageObject.findFirst(args) as unknown as Promise<Prisma.StorageObjectGetPayload<A> | null>);
  }

  count(where: Prisma.StorageObjectWhereInput, scope?: KvoxObjectsScope): Promise<number> {
    return this.run(scope, (tx) => tx.storageObject.count({ where }));
  }

  /** The total `size` in bytes of every object matching `where` (each row counted once). */
  async sumSize(where: Prisma.StorageObjectWhereInput, scope?: KvoxObjectsScope): Promise<bigint> {
    const { _sum } = await this.run(scope, (tx) => tx.storageObject.aggregate({ where, _sum: { size: true } }));
    return _sum.size ?? BigInt(0);
  }

  /** Count and total bytes of the objects matching `where`, in one statement. */
  async summarize(
    where: Prisma.StorageObjectWhereInput,
    scope?: KvoxObjectsScope,
  ): Promise<{ count: number; bytes: bigint }> {
    const result = await this.run(scope, (tx) =>
      tx.storageObject.aggregate({ where, _count: { _all: true }, _sum: { size: true } }),
    );
    return { count: result._count._all, bytes: result._sum.size ?? BigInt(0) };
  }

  /** Replace an object's JSONB `metadata`. */
  async setMetadata(id: string, metadata: Record<string, unknown>, scope?: KvoxObjectsScope): Promise<void> {
    await this.run(scope, (tx) =>
      tx.storageObject.update({ where: { id }, data: { metadata: metadata as unknown as Prisma.InputJsonValue } }),
    );
  }

  /** Update an object's `size` (a streamed object whose length was only known at the end). */
  async setSize(id: string, size: number, scope?: KvoxObjectsScope): Promise<StorageObjectRow> {
    return this.run(scope, (tx) => tx.storageObject.update({ where: { id }, data: { size: BigInt(size) } }));
  }

  /**
   * A signed GET for one READY object, or null when it is gone or not ready.
   * The signature covers `response-content-disposition`, so an export downloads
   * as a named attachment.
   */
  async signedDownloadUrl(
    id: string,
    options: SignedDownloadOptions,
    scope?: KvoxObjectsScope,
  ): Promise<{ url: string; expiresAt: Date; object: StorageObjectRow } | null> {
    const object = await this.get(id, scope);
    if (!object || object.status !== 'ready') return null;

    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn: options.expiresIn,
      responseContentDisposition: options.contentDisposition,
    });

    return { url, expiresAt: new Date(Date.now() + options.expiresIn * 1000), object };
  }

  /** The object's bytes, or null when the row is gone. */
  async openStream(id: string, scope?: KvoxObjectsScope): Promise<{ stream: Readable; object: StorageObjectRow } | null> {
    const object = await this.get(id, scope);
    if (!object) return null;
    return { stream: await this.storage.download(object.storageKey), object };
  }

  /**
   * Remove one managed object: the provider bytes first, then the row (the
   * ownership row cascades). `module` must be the owner on record; a mismatch
   * is a 409, an absent row a 404. An unfinished multipart upload is aborted
   * before the row goes.
   */
  async deleteManaged(id: string, module: KvoxModule, scope?: KvoxObjectsScope): Promise<void> {
    const { object, owner } = await this.run(scope, async (tx) => {
      const row = await tx.storageObject.findUnique({ where: { id } });
      const owned = row ? await this.ownership.managedBy(tx, [id]) : new Map<string, KvoxModule>();
      return { object: row, owner: owned.get(id) ?? null };
    });

    if (!object) throw new NotFoundException('Object not found');
    if (owner !== module) {
      throw new ConflictException(`Object ${id} is managed by ${owner ?? 'nobody'}, not by ${module}`);
    }

    this.logger.log(`Deleting ${module}-managed object ${id} from storage and database`);

    if ((object.status === 'pending' || object.status === 'uploading') && object.s3UploadId) {
      await this.storage.abortMultipartUpload(object.storageKey, object.s3UploadId).catch((error: unknown) => {
        this.logger.warn(
          `Could not abort multipart upload of ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    await this.storage.delete(object.storageKey);
    await this.run(scope, (tx) => tx.storageObject.deleteMany({ where: { id } }));
  }

  /**
   * Cancel an in-progress upload of a MANAGED object without deleting its row.
   *
   * The platform's abort deletes the `storage_objects` row, which the owning
   * record's `source_object_id` (`onDelete: Restrict`) refuses. So the provider
   * multipart upload is aborted, the row is set to `failed` and kept, and for a
   * `transcripts` owner the referencing transcript still `uploading` is marked
   * `failed / upload_aborted` (housekeeping purges it later). Idempotent: an
   * already-`failed` object is reconciled again and answers normally.
   *
   * @throws NotFoundException when the object is missing, not the caller's, or not managed.
   * @throws BadRequestException when the upload already settled (processing or ready).
   */
  async abortManaged(id: string, userId: string, scope?: KvoxObjectsScope): Promise<void> {
    const { object, owner } = await this.run(scope, async (tx) => {
      const row = await tx.storageObject.findUnique({ where: { id } });
      const owned = row ? await this.ownership.managedBy(tx, [id]) : new Map<string, KvoxModule>();
      return { object: row, owner: owned.get(id) ?? null };
    });

    if (!object || object.uploadedById !== userId || !owner) throw new NotFoundException('Upload not found');

    const active = object.status === 'pending' || object.status === 'uploading';
    if (!active && object.status !== 'failed') {
      throw new BadRequestException(`Upload is no longer in progress (status: ${object.status})`);
    }

    if (active && object.s3UploadId) {
      await this.storage.abortMultipartUpload(object.storageKey, object.s3UploadId).catch((error: unknown) => {
        this.logger.warn(
          `Could not abort multipart upload of ${id}: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
      });
    }

    await this.run(scope, async (tx) => {
      await tx.storageObject.updateMany({
        where: { id, status: { in: ['pending', 'uploading'] } },
        data: { status: 'failed', s3UploadId: null },
      });

      if (owner === 'transcripts') {
        // Conditional on `uploading`, like the housekeeping reconcile (same reason string).
        await tx.transcript.updateMany({
          where: { sourceObjectId: id, deletedAt: null, status: 'uploading' },
          data: { status: 'failed', failureReason: 'upload_aborted' },
        });
      }
    });

    this.logger.log(`Aborted ${owner}-managed upload ${id}`);

    for (const listener of this.abortListeners) {
      try {
        await listener({ objectId: id, module: owner });
      } catch (error) {
        // A listener is a bystander: the abort itself is done.
        this.logger.warn(
          `An abort listener failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Registers a listener that runs after each managed upload is aborted, once the
   * abort has committed. The object-store port's `onAborted` is built on it.
   */
  onAborted(listener: (event: { objectId: string; module: KvoxModule }) => Promise<void>): void {
    this.abortListeners.push(listener);
  }

  /** The organization of a caller-held transaction: the explicit one, else the default. */
  private orgOfTx(orgId?: string | null): Promise<string> {
    return this.resolveOrg(orgId);
  }
}
