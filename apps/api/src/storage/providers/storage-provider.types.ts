import { Readable } from 'node:stream';

/**
 * Options for uploading a file to storage
 */
export interface StorageUploadOptions {
  mimeType: string;
  metadata?: Record<string, string>;
  contentLength?: number;
}

/**
 * Result of a successful upload operation
 */
export interface StorageUploadResult {
  key: string;
  bucket: string;
  location: string;
  eTag?: string;
}

/**
 * Represents a completed part of a multipart upload
 */
export interface UploadPart {
  partNumber: number;
  eTag: string;
}

/**
 * A part that a provider reports as ALREADY UPLOADED for an in-progress
 * multipart upload (issue #21).
 *
 * Distinct from `UploadPart` above, and deliberately not an extension of it.
 * `UploadPart` is what a CLIENT asserts when finishing an upload — a part
 * number and an ETag, nothing the server has verified. This is what the
 * PROVIDER reports when asked what it is actually holding, which is the only
 * trustworthy answer to "how far did this upload get?" and carries a `size`
 * the client half has no way to state.
 *
 * WHY THIS EXISTS AT ALL: resume. `storage_object_chunks` rows are written
 * only at completion time, so a status built from them reports zero progress
 * for the entire lifetime of an upload and then jumps to 100% once the upload
 * no longer needs resuming. Asking the provider is the only source that is
 * correct while the answer still matters.
 */
export interface UploadedPart {
  /** 1-based part number, as it was signed. */
  partNumber: number;
  /** Byte length the provider is holding for this part. */
  size: number;
  /** Provider ETag, usable verbatim in `completeMultipartUpload`. */
  etag: string;
  /** When the provider recorded the part, when it reports one. */
  lastModified?: Date;
}

/**
 * Options for generating signed URLs
 */
export interface SignedUrlOptions {
  expiresIn?: number; // Seconds, default 3600
  responseContentDisposition?: string;
}

/**
 * Options for generating a single-shot signed PUT URL (issue #269, epic #254).
 *
 * Separate from `SignedUrlOptions` above rather than an extension of it: the
 * two describe opposite directions and share only `expiresIn`. A download URL
 * carries `responseContentDisposition` (how a browser should present bytes it
 * receives) which means nothing on an upload, and an upload URL carries
 * `contentType` (what the caller promises to send) which means nothing on a
 * download. One merged bag would publish two fields that are silently ignored
 * half the time — and a silently ignored option on a SIGNED url is the worst
 * kind, because the signature was computed without it and the resulting 403
 * names nothing.
 */
export interface SignedPutUrlOptions {
  /** Seconds until the URL stops working. Provider default 3600 when omitted. */
  expiresIn?: number;

  /**
   * The `Content-Type` the uploader will send.
   *
   * ⚠ IT IS PART OF THE SIGNATURE. If this is set, the PUT must send exactly
   * this header or the provider rejects the request — so a caller that does
   * not KNOW the content type should omit it rather than guess, and let the
   * uploader send whatever it likes.
   */
  contentType?: string;
}

/**
 * Result of initiating a multipart upload
 */
export interface MultipartUploadInit {
  uploadId: string;
  key: string;
}
