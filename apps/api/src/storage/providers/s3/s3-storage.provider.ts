import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import type { ListPartsCommandOutput } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { StorageProvider } from '../storage-provider.interface';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  SignedPutUrlOptions,
  UploadedPart,
} from '../storage-provider.types';

/**
 * S3-compatible storage provider implementation
 * Supports AWS S3, MinIO, LocalStack, and other S3-compatible storage services
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('storage.s3.region');
    const endpoint = this.configService.get<string>('storage.s3.endpoint');
    const accessKeyId = this.configService.get<string>(
      'storage.s3.accessKeyId',
    );
    const secretAccessKey = this.configService.get<string>(
      'storage.s3.secretAccessKey',
    );

    this.bucket = this.configService.get<string>('storage.s3.bucket') || '';

    if (!this.bucket) {
      this.logger.warn('S3 bucket not configured');
    }

    // Initialize S3 client
    this.s3Client = new S3Client({
      region,
      endpoint,
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
            }
          : undefined,
      // Force path-style URLs for MinIO/LocalStack compatibility
      forcePathStyle: !!endpoint,
    });

    this.logger.log(
      `S3StorageProvider initialized - Bucket: ${this.bucket}, Region: ${region}${endpoint ? `, Endpoint: ${endpoint}` : ''}`,
    );
  }

  /**
   * Simple upload using AWS SDK Upload helper
   * Automatically handles multipart uploads for large files
   */
  async upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    this.logger.debug(`Starting upload for key: ${key}`);

    try {
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: options.mimeType,
          Metadata: options.metadata || {},
          ContentLength: options.contentLength,
        },
        // Use configured part size for automatic multipart uploads
        partSize: this.configService.get<number>('storage.partSize', 10485760), // 10MB default
      });

      const result = await upload.done();

      this.logger.log(`Upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Upload failed for key ${key}: ${message}`, stack);
      throw error;
    }
  }

  /**
   * Initialize multipart upload
   */
  async initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit> {
    this.logger.debug(`Initiating multipart upload for key: ${key}`);

    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.mimeType,
        Metadata: options.metadata || {},
      });

      const result = await this.s3Client.send(command);

      if (!result.UploadId) {
        throw new Error('Failed to initiate multipart upload - no UploadId returned');
      }

      this.logger.log(`Multipart upload initiated for key: ${key}, UploadId: ${result.UploadId}`);

      return {
        uploadId: result.UploadId,
        key,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to initiate multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed URL for uploading a specific part
   */
  async getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600,
  ): Promise<string> {
    this.logger.debug(
      `Generating signed upload URL for key: ${key}, part: ${partNumber}`,
    );

    try {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed upload URL for key ${key}, part ${partNumber}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Complete multipart upload
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult> {
    this.logger.debug(
      `Completing multipart upload for key: ${key}, ${parts.length} parts`,
    );

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      });

      const result = await this.s3Client.send(command);

      this.logger.log(`Multipart upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to complete multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Abort multipart upload
   */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.logger.debug(`Aborting multipart upload for key: ${key}`);

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      });

      await this.s3Client.send(command);

      this.logger.log(`Multipart upload aborted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to abort multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * List every part S3 is currently holding for an in-progress multipart
   * upload (issue #21).
   *
   * ⚠ PAGINATES. `ListParts` returns at most 1000 parts per response and sets
   * `IsTruncated` with a `NextPartNumberMarker` when there are more. A 5 GB
   * upload at the 10 MiB default part size is 500 parts, but the adaptive part
   * size in `ObjectsService.initUpload` allows up to 10,000 — so a single
   * unpaginated call would silently report an upload as 1000/10000 complete
   * forever, and a resume would re-upload 9000 parts it did not need to.
   *
   * Errors propagate, matching every other method in this file: a provider
   * that cannot answer "what have you got?" must not be reported as holding
   * nothing, because the caller's next move on an empty answer is to upload
   * the whole file again.
   */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    this.logger.debug(`Listing parts for key: ${key}, uploadId: ${uploadId}`);

    try {
      const parts: UploadedPart[] = [];
      let partNumberMarker: string | undefined = undefined;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result: ListPartsCommandOutput = await this.s3Client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );

        for (const part of result.Parts ?? []) {
          // A part with no number is not addressable and cannot be completed
          // with; skipping it is the only safe reading of a malformed entry.
          if (part.PartNumber === undefined) {
            continue;
          }

          parts.push({
            partNumber: part.PartNumber,
            size: part.Size ?? 0,
            etag: part.ETag ?? '',
            lastModified: part.LastModified,
          });
        }

        if (!result.IsTruncated) {
          break;
        }

        // A truncated page with no marker would loop forever re-reading page
        // one. Treat it as the end rather than spinning.
        if (!result.NextPartNumberMarker) {
          break;
        }

        partNumberMarker = String(result.NextPartNumberMarker);
      }

      // S3 already returns ascending part numbers, but the interface PROMISES
      // ordering to callers that feed this straight into
      // `completeMultipartUpload`, so it is enforced here rather than assumed.
      parts.sort((a, b) => a.partNumber - b.partNumber);

      return parts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to list parts for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Download file as stream
   */
  async download(key: string): Promise<Readable> {
    this.logger.debug(`Downloading file for key: ${key}`);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      if (!result.Body) {
        throw new Error('No body returned from S3');
      }

      // S3 returns a readable stream
      return result.Body as Readable;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to download file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed download URL
   */
  async getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    this.logger.debug(`Generating signed download URL for key: ${key}`);

    try {
      const expiresIn = options?.expiresIn || 3600;

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options?.responseContentDisposition,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed download URL for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate a signed URL for a single-shot `PUT` of a whole object.
   *
   * `PutObjectCommand`, deliberately — not `UploadPartCommand`. See the block
   * comment on `getSignedPutUrl` in `../storage-provider.interface.ts` for why
   * a one-part multipart upload was rejected for this.
   *
   * ⚠ `ContentType` IS ONLY SET WHEN THE CALLER SUPPLIED ONE. S3 signs the
   * headers it is given: presigning with a `Content-Type` the uploader then
   * does not send exactly produces a `SignatureDoesNotMatch` on a machine
   * nobody is watching, and the error names the signature rather than the
   * header that caused it. Omitting it leaves the uploader free, which is the
   * right default for a caller that is guessing.
   *
   * The URL itself is NEVER logged, here or anywhere else — it is a bearer
   * write capability for `key` until it expires. The debug line below names
   * the key only, matching `getSignedDownloadUrl` beside it.
   */
  async getSignedPutUrl(
    key: string,
    options?: SignedPutUrlOptions,
  ): Promise<string> {
    this.logger.debug(`Generating signed PUT URL for key: ${key}`);

    try {
      const expiresIn = options?.expiresIn || 3600;

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
      });

      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed PUT URL for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Delete file
   */
  async delete(key: string): Promise<void> {
    this.logger.debug(`Deleting file for key: ${key}`);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);

      this.logger.log(`File deleted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to delete file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getMetadata(key: string): Promise<Record<string, string> | null> {
    this.logger.debug(`Getting metadata for key: ${key}`);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      return result.Metadata || {};
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to get metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Set file metadata
   * Uses CopyObject with REPLACE metadata directive
   */
  async setMetadata(
    key: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    this.logger.debug(`Setting metadata for key: ${key}`);

    try {
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: key,
        CopySource: `${this.bucket}/${key}`,
        Metadata: metadata,
        MetadataDirective: 'REPLACE',
      });

      await this.s3Client.send(command);

      this.logger.log(`Metadata updated for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to set metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Error checking existence for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get bucket name
   */
  getBucket(): string {
    return this.bucket;
  }
}
