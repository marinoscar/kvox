import { Readable } from 'node:stream';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  SignedPutUrlOptions,
} from './storage-provider.types';

/**
 * Dependency injection token for storage provider
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/**
 * Abstract interface for file storage providers
 * Supports both simple uploads and multipart resumable uploads
 */
export interface StorageProvider {
  /**
   * Simple upload for small to medium files
   * Stream is uploaded directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param stream - Readable stream of file content
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload result with location and metadata
   */
  upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult>;

  /**
   * Initialize a multipart upload for large files or resumable uploads
   *
   * @param key - Unique identifier for the file in storage
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload ID and key for subsequent operations
   */
  initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit>;

  /**
   * Generate a signed URL for uploading a specific part
   * Client can use this URL to upload parts directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param partNumber - Part number (1-based index)
   * @param expiresIn - URL expiration time in seconds (default: 3600)
   * @returns Pre-signed URL for part upload
   */
  getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;

  /**
   * Complete a multipart upload after all parts are uploaded
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param parts - Array of uploaded parts with part numbers and ETags
   * @returns Upload result with final location
   */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult>;

  /**
   * Abort a multipart upload and clean up parts
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /**
   * Download a file as a readable stream
   *
   * @param key - Unique identifier for the file in storage
   * @returns Readable stream of file content
   */
  download(key: string): Promise<Readable>;

  /**
   * Generate a signed URL for downloading a file
   * Allows temporary access without authentication
   *
   * @param key - Unique identifier for the file in storage
   * @param options - URL generation options (expiration, content disposition)
   * @returns Pre-signed URL for file download
   */
  getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string>;

  // ===========================================================================
  // Single-shot signed PUT (issue #269, epic #254)
  // ===========================================================================
  //
  // WHY A NEW METHOD EXISTS RATHER THAN A REUSE OF `getSignedUploadUrl`
  // ---------------------------------------------------------------------------
  //
  // The node data plane needs one thing this interface could not express: a
  // URL a machine with NO storage credentials can PUT a complete object to,
  // once. Everything above it is either credential-holding (`upload`) or
  // multipart (`getSignedUploadUrl`, which signs `UploadPart` and is
  // meaningless without an `uploadId` from `initMultipartUpload`).
  //
  // REJECTED: driving a ONE-PART MULTIPART UPLOAD through the existing
  // methods. It is genuinely possible — `initMultipartUpload`, sign part 1,
  // let the node PUT it, then `completeMultipartUpload` — and it is worse in
  // four specific ways, each of which shows up as an operational problem
  // rather than as ugly code:
  //
  //   1. IT NEEDS A SECOND ROUND TRIP FROM THE NODE, and it needs the node to
  //      report the part's ETag back. That ETag is required by
  //      `CompleteMultipartUploadCommand`, so it would have to become a field
  //      in the node result contract — meaning every node-eligible job type
  //      that writes bytes carries a storage-protocol detail in its own
  //      result schema, forever, for no reason a handler author could guess.
  //   2. AN ABANDONED UPLOAD LEAKS BILLABLE STORAGE. A node that dies between
  //      `init` and `complete` leaves an in-progress multipart upload holding
  //      its parts, invisible to `ListObjects` and chargeable until a bucket
  //      lifecycle rule (which this template does not require an operator to
  //      configure) expires it. A signed PUT that is never used leaves
  //      nothing at all — the failure mode is "no object", which is exactly
  //      what a failed job should leave behind.
  //   3. IT MAKES THE SERVER HOLD PER-JOB STATE. The `uploadId` has to
  //      survive from the mint call to the completion call, so it needs a
  //      column, a cache, or a round trip through the node — three ways for a
  //      node's crash to strand a row. The whole node plane is designed so
  //      the server holds only what is already in `jobs`.
  //   4. S3 ENFORCES A 5 MiB MINIMUM ON EVERY PART BUT THE LAST. A one-part
  //      upload happens to be exempt, but the rule is a trap sitting next to
  //      a path somebody will later "optimise" into two parts.
  //
  // The cost of the chosen option is honest and small: one method on this
  // interface, which every implementation must provide. That is the trade —
  // an interface that says what it means, against a protocol dance encoded in
  // application code and leaking into a public result schema.
  //
  // A NOTE FOR A NEW IMPLEMENTATION: this must sign a PLAIN `PUT` of the whole
  // body to `key`. It must not require multipart headers, and it must not
  // embed credentials anywhere but the signature — the URL is handed to a
  // machine this deployment does not own.

  /**
   * Generate a signed URL for uploading a complete object in ONE `PUT`.
   *
   * Used by the worker-node data plane: a node holds no storage credentials,
   * so the server mints a short-lived, single-object write capability and the
   * bytes go straight from the node to the provider — never through the API.
   *
   * ⚠ THE CALLER CHOOSES `key`, AND IT MUST NEVER BE A REMOTE PARTY'S STRING.
   * A signed PUT is an unconditional overwrite of exactly that key: a caller
   * that forwarded a key it received over the wire would be handing out a
   * write primitive over its whole bucket. See
   * `NodeDataPlaneService.createUploadTarget`.
   *
   * @param key - Server-chosen identifier for the file in storage
   * @param options - Expiry, and the `Content-Type` the uploader will send
   * @returns Pre-signed URL accepting a single `PUT` of the whole body
   */
  getSignedPutUrl(key: string, options?: SignedPutUrlOptions): Promise<string>;

  /**
   * Delete a file from storage
   *
   * @param key - Unique identifier for the file in storage
   */
  delete(key: string): Promise<void>;

  /**
   * Get file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @returns Metadata key-value pairs, or null if file doesn't exist
   */
  getMetadata(key: string): Promise<Record<string, string> | null>;

  /**
   * Set or update file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @param metadata - Metadata key-value pairs to set
   */
  setMetadata(key: string, metadata: Record<string, string>): Promise<void>;

  /**
   * Check if a file exists in storage
   *
   * @param key - Unique identifier for the file in storage
   * @returns True if file exists, false otherwise
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get the bucket name being used by this provider
   *
   * @returns Bucket name
   */
  getBucket(): string;
}
