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
 * What `initUpload` returns.
 *
 * @stability experimental
 */
export interface KvoxInitUploadResult {
  /** The new object's id. */
  objectId: string;
  /** The size of every part but the last, in bytes. */
  partSize: number;
  /** A presigned URL per part. */
  parts: KvoxUploadPart[];
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
    req: { name: string; mimeType: string; size: number; managedBy: KvoxManagedBy },
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
  }): Promise<KvoxPutResult>;

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
   */
  onUploaded(handler: (e: KvoxUploadedEvent) => Promise<void>): void;
}
