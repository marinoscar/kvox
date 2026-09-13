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
