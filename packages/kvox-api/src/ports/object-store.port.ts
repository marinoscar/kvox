// =============================================================================
// KVOX_OBJECT_STORE: the object-store port (issue 5.4, epic 486)
// =============================================================================
//
// Resumable uploads, streamed puts and reads, signed downloads and the hook that
// fires when an upload completes. The web edition binds it over the platform
// storage slice (S3-compatible) and tags every object with the owning module in a
// side table; Desktop binds it to the local filesystem.
//
// A BYTE STREAM IS NEVER BUFFERED. `put` and `openRead` move streams so a large
// recording costs a bounded amount of memory on either host.
// =============================================================================

/**
 * Injection token of {@link KvoxObjectStorePort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_OBJECT_STORE = Symbol.for('@marinoscar/kvox/KVOX_OBJECT_STORE');

/**
 * The domain module that owns a stored object. Ownership decides who may read,
 * list and delete it through the generic routes.
 *
 * @stability experimental
 */
export type KvoxManagedBy = 'transcripts' | 'notes' | 'graph';

/**
 * Where an object stands.
 *
 * @stability experimental
 */
export type KvoxObjectStatus = 'pending' | 'ready' | 'failed';

/**
 * A presigned part URL of a resumable upload.
 *
 * @stability experimental
 */
export interface KvoxUploadPart {
  /** The 1-based part number. */
  partNumber: number;
  /** Where the client sends that part. */
  url: string;
}

/**
 * Narrows which completed uploads a {@link KvoxObjectStorePort.onUploaded} handler
 * is interested in, so a host can skip the work of reporting the rest.
 *
 * @stability experimental
 */
export interface KvoxUploadedOptions {
  /**
   * The content types the handler cares about: `audio/*` (a family) or an exact
   * type, matched case-insensitively. Absent: every upload. A hint only: the
   * handler still decides from `managedBy` whether the object is its own.
   */
  contentTypes?: readonly string[];
}

/**
 * What a completed upload reports to {@link KvoxObjectStorePort.onUploaded}
 * handlers.
 *
 * @stability experimental
 */
export interface KvoxUploadedEvent {
  /** The completed object. */
  objectId: string;
  /** The owning module, or `null` when no module owns it. */
  managedBy: KvoxManagedBy | null;
}

/**
 * What {@link KvoxObjectStorePort.adopt} answers.
 *
 * @stability experimental
 */
export interface KvoxAdoptResult {
  /** The object that now records the bytes. */
  objectId: string;
}

/**
 * What `initUpload` returns.
 *
 * @stability experimental
 */
export interface KvoxInitUploadResult {
  /** The new object's id. */
  objectId: string;
  /** The host's id of the resumable upload (the multipart upload id; the object id when the host has none). */
  uploadId: string;
  /** The size of every part but the last, in bytes. */
  partSize: number;
  /** How many parts the whole upload has (`parts` may carry only the first batch). */
  totalParts: number;
  /** A presigned URL per part (the first batch when the upload has many parts). */
  parts: KvoxUploadPart[];
}

/**
 * What an object-store port reports about an object's lifecycle, unfolded: the
 * five states the host tracks.
 *
 * @stability experimental
 */
export type KvoxObjectState = 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';

/**
 * What `describe` reports about one object.
 *
 * @stability experimental
 */
export interface KvoxObjectInfo {
  /** The object's id. */
  id: string;
  /** The display name (the uploaded file's name). */
  name: string;
  /** The content type. */
  mimeType: string;
  /** The size in bytes. */
  size: number;
  /** Where the object stands. */
  state: KvoxObjectState;
  /** When the object was created. */
  createdAt: Date;
  /** When it last changed. */
  updatedAt: Date;
  /** The user who uploaded or stored it, when the host records one. */
  ownerId?: string | null;
  /** The owning module, when the host records one (`null` for an object no module owns). */
  managedBy?: KvoxManagedBy | null;
  /** Free-form data stored with the object (`put` and `adopt` accept it; `setMetadata` replaces it). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Thrown by `adopt` when no bytes exist under the key it was asked to record.
 *
 * @stability experimental
 */
export class KvoxObjectMissingError extends Error {
  /** The key that holds nothing. */
  readonly key: string;

  /**
   * @param key - the key that holds nothing.
   */
  constructor(key: string) {
    super(
      `No object exists at "${key}". The executor reported a result for bytes that never landed in storage, so there is nothing to record.`,
    );
    this.name = 'KvoxObjectMissingError';
    this.key = key;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * What an aborted upload reports to {@link KvoxObjectStorePort.onAborted}
 * handlers.
 *
 * @stability experimental
 */
export interface KvoxAbortedEvent {
  /** The cancelled upload. */
  objectId: string;
  /** The owning module, or `null` when no module owns it. */
  managedBy: KvoxManagedBy | null;
}

/**
 * What `head` reports about an object.
 *
 * @stability experimental
 */
export interface KvoxObjectHead {
  /** The size in bytes. */
  size: number;
  /** The content type. */
  mimeType: string;
  /** Where the object stands. */
  status: KvoxObjectStatus;
}

/**
 * What `put` returns.
 *
 * @stability experimental
 */
export interface KvoxPutResult {
  /** The new object's id. */
  objectId: string;
  /** The stored size in bytes. */
  size: number;
}

/**
 * The object-store port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxObjectStorePort {
  /**
   * Starts a resumable upload and returns the part URLs.
   *
   * @param ctx - the uploading user.
   * @param req - the file name, type, size and owning module.
   */
  initUpload(
    ctx: { userId: string },
    req: {
      name: string;
      /** The type the client reported; absent or empty, the host resolves it from the file name's extension. */
      mimeType?: string | null;
      size: number;
      managedBy: KvoxManagedBy;
      /** Content types the owning module accepts (`audio/*`); checked after the host resolves the type from the name. */
      allowedMimeTypes?: readonly string[];
    },
  ): Promise<KvoxInitUploadResult>;

  /**
   * Fresh URLs for some parts of an unfinished upload (the first ones expired).
   *
   * @param objectId - the upload.
   * @param partNumbers - the parts to sign.
   */
  signParts(objectId: string, partNumbers: number[]): Promise<KvoxUploadPart[]>;

  /**
   * Seals an upload. Fires the {@link KvoxObjectStorePort.onUploaded} handlers
   * once.
   *
   * @param objectId - the upload.
   * @param parts - the part ETags, when the host needs them.
   */
  completeUpload(objectId: string, parts?: { partNumber: number; etag: string }[]): Promise<void>;

  /**
   * Cancels an unfinished upload. Idempotent.
   *
   * @param objectId - the upload.
   */
  abortUpload(objectId: string): Promise<void>;

  /**
   * Stores a stream or buffer under a key, without buffering a stream whole.
   *
   * @param req - the owner, key, body, content type and owning module.
   */
  put(req: {
    ownerId: string;
    key: string;
    body: NodeJS.ReadableStream | Buffer;
    contentType: string;
    managedBy: KvoxManagedBy;
    /** A display name; defaults to the last segment of `key`. */
    name?: string;
    /** Free-form data stored with the object (the transcript id, so an orphan is traceable). */
    metadata?: Record<string, unknown>;
  }): Promise<KvoxPutResult>;

  /**
   * Records bytes that are ALREADY stored under `key` (a worker node uploaded
   * them straight to a presigned URL), after checking they are there.
   * Idempotent on the key: a second call returns the object the first recorded.
   *
   * @param req - the owner, key, size the producer reported, and owning module.
   * @throws KvoxObjectMissingError when nothing is stored under the key.
   */
  adopt(req: {
    ownerId: string;
    key: string;
    name: string;
    contentType: string;
    size: number;
    managedBy: KvoxManagedBy;
    metadata?: Record<string, unknown>;
  }): Promise<KvoxAdoptResult>;

  /**
   * The object's bytes as a stream.
   *
   * @param objectId - the object.
   * @throws Error when the object does not exist.
   */
  openRead(objectId: string): Promise<NodeJS.ReadableStream>;

  /**
   * The object's size, type and status, or `null` when it does not exist.
   *
   * @param objectId - the object.
   */
  head(objectId: string): Promise<KvoxObjectHead | null>;

  /**
   * The facts of many objects in one call. An id that does not exist is absent
   * from the map.
   *
   * @param objectIds - the objects.
   */
  describe(objectIds: readonly string[]): Promise<Map<string, KvoxObjectInfo>>;

  /**
   * Replaces the free-form data stored with an object. The caller passes the WHOLE
   * value (read it from `describe`, change it, write it back); keys it leaves out are
   * removed. A missing object is ignored.
   * @param objectId - the object.
   * @param metadata - the new data.
   */
  setMetadata(objectId: string, metadata: Record<string, unknown>): Promise<void>;

  /**
   * The ids of the objects a module manages that one user uploaded, in ascending id order:
   * the way a purge finds every file it owns without a row of its own to point at it.
   *
   * @param query - the uploader, the managing module, an optional storage-key prefix and the page size.
   * @returns up to `limit` object ids.
   */
  listManaged(query: {
    ownerId: string;
    managedBy: KvoxManagedBy;
    keyPrefix?: string;
    limit: number;
  }): Promise<string[]>;

  /**
   * A time-limited download URL.
   *
   * @param objectId - the object.
   * @param opts - the lifetime and a file name for the attachment header.
   */
  signedDownloadUrl(objectId: string, opts: { ttlSeconds: number; filename?: string }): Promise<string>;

  /**
   * Removes the object and its bytes. Idempotent: deleting a missing object
   * succeeds.
   *
   * @param objectId - the object.
   */
  delete(objectId: string): Promise<void>;

  /**
   * Registers a handler that runs once for each completed upload. A handler
   * decides from `managedBy` whether the object is its own.
   *
   * @param handler - called after the upload is sealed.
   * @param options - which uploads the handler wants reported; a host that runs one
   *   processing job per completed upload uses it to queue none for a file no handler wants.
   */
  onUploaded(handler: (e: KvoxUploadedEvent) => Promise<void>, options?: KvoxUploadedOptions): void;

  /**
   * Registers a handler that runs once for each cancelled upload, so a module
   * can fail the record that was waiting for it. Like `onUploaded`, a handler
   * decides from `managedBy` whether the object is its own.
   *
   * @param handler - called after the upload is cancelled.
   */
  onAborted(handler: (e: KvoxAbortedEvent) => Promise<void>): void;
}
