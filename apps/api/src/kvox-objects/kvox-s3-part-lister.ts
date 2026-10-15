// =============================================================================
// KvoxS3PartLister (issue #469)
// =============================================================================
//
// The platform storage provider has no ListParts: its resumable upload expects
// the client to hand back every part's ETag, and a browser cannot read the
// `ETag` response header of a cross-origin PUT unless the bucket exposes it
// (`apps/web/src/services/resumableUpload.ts` deliberately never reads it). So
// KVox asks S3 itself, and the client passes what this class returns to the
// PLATFORM's `POST :id/upload/complete`.
//
// The S3 client is built the way the platform builds its own: the resolved
// `storage` settings plus the stored secret (`StorageConfigService`, which reads
// the credential store on every call, so a key rotation is picked up at once),
// through `buildS3ClientConfig`. One client is kept per configuration
// fingerprint and destroyed when the configuration changes.
//
// ONLY THE S3 FAMILY (`s3`, `r2`, `s3compatible`) CAN BE LISTED. Any other
// driver answers 501 with `details.reason = 'list_parts_unsupported'`.
//
// NEVER LOGGED: keys, upload ids, URLs and secrets. Provider failures are mapped
// to a 502 whose body carries no provider text.
// =============================================================================

import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import type { ListPartsCommandOutput } from '@aws-sdk/client-s3';
import {
  S3_FLAVOURS,
  StorageConfigService,
  StorageNotConfiguredError,
  buildS3ClientConfig,
  fingerprintStorageConfig,
  resolveS3Config,
} from '@marinoscar/platform-api/storage';
import type { S3FamilySettings } from '@marinoscar/platform-api/storage';

/** The `details.reason` of the 501 a non-S3 driver answers. */
export const LIST_PARTS_UNSUPPORTED = 'list_parts_unsupported';

/** One part S3 holds for an in-progress upload. */
export interface ListedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** `ListParts` returns at most 1,000 parts a page; 10,000 parts is the ceiling, so ten pages. */
const MAX_PAGES = 12;

const EMPTY_S3_SETTINGS: S3FamilySettings = {
  bucket: '',
  region: '',
  endpoint: '',
  accountId: '',
  accessKeyId: '',
  forcePathStyle: null,
};

interface CachedClient {
  fingerprint: string;
  bucket: string;
  client: S3Client;
}

@Injectable()
export class KvoxS3PartLister implements OnModuleDestroy {
  private readonly logger = new Logger(KvoxS3PartLister.name);

  private cached: CachedClient | null = null;

  constructor(private readonly storageConfig: StorageConfigService) {}

  onModuleDestroy(): void {
    this.cached?.client.destroy();
    this.cached = null;
  }

  /**
   * Every part S3 holds for the upload, ascending by part number.
   *
   * @throws NotImplementedException (501, `list_parts_unsupported`) when the active driver is not in the S3 family.
   * @throws StorageNotConfiguredError (503) when storage is not configured yet.
   * @throws NotFoundException (404) when the provider no longer knows the upload.
   * @throws BadGatewayException (502) for any other provider failure.
   */
  async listParts(key: string, uploadId: string): Promise<ListedPart[]> {
    const { client, bucket } = await this.clientFor();
    const parts: ListedPart[] = [];
    let marker: string | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result: ListPartsCommandOutput = await client.send(
          new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
        );

        for (const part of result.Parts ?? []) {
          // A part with no number is not addressable and cannot be completed with.
          if (part.PartNumber === undefined) continue;
          parts.push({ partNumber: part.PartNumber, etag: part.ETag ?? '', size: part.Size ?? 0 });
        }

        // A truncated page without a marker would re-read page one forever.
        if (!result.IsTruncated || !result.NextPartNumberMarker) break;
        marker = String(result.NextPartNumberMarker);
      }
    } catch (error) {
      throw this.mapError(error);
    }

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  /** The cached client for the configuration in force, rebuilt when it changed. */
  private async clientFor(): Promise<CachedClient> {
    const resolution = await this.storageConfig.resolve();

    if (!resolution.configured) {
      if (!(resolution.provider in S3_FLAVOURS)) throw this.unsupported();
      throw StorageNotConfiguredError.missing(resolution.provider, resolution.missing);
    }

    const { config } = resolution;
    const flavour = S3_FLAVOURS[config.provider as keyof typeof S3_FLAVOURS];
    if (!flavour) throw this.unsupported();

    const fingerprint = fingerprintStorageConfig(config);
    if (this.cached?.fingerprint === fingerprint) return this.cached;

    const s3 = resolveS3Config(
      flavour,
      { ...EMPTY_S3_SETTINGS, ...(config.settings as Partial<S3FamilySettings>) },
      config.secrets['secretAccessKey'] ?? null,
    );
    if (!s3.configured) throw StorageNotConfiguredError.missing(s3.provider, s3.missing);

    const built = new S3Client(
      buildS3ClientConfig({
        provider: flavour.id,
        bucket: s3.config.bucket,
        region: s3.config.region,
        ...(s3.config.endpoint ? { endpoint: s3.config.endpoint } : {}),
        accessKeyId: s3.config.accessKeyId,
        secretAccessKey: s3.config.secretAccessKey,
        forcePathStyle: s3.config.forcePathStyle,
      }),
    );

    this.cached?.client.destroy();
    this.cached = { fingerprint, bucket: s3.config.bucket, client: built };
    return this.cached;
  }

  private unsupported(): NotImplementedException {
    return new NotImplementedException({
      message: 'The active storage driver cannot list the parts of an upload.',
      details: { reason: LIST_PARTS_UNSUPPORTED },
    });
  }

  /** A provider failure as an HTTP error that carries no provider text. */
  private mapError(error: unknown): Error {
    if (error instanceof NotImplementedException || error instanceof StorageNotConfiguredError) {
      return error;
    }

    // Only the error NAME is logged: provider messages can echo the bucket, key or request id.
    const name = error instanceof Error ? error.name : 'UnknownError';
    if (name === 'NoSuchUpload') return new NotFoundException('Upload not found');

    this.logger.warn(`ListParts failed: ${name}`);
    return new BadGatewayException('The storage provider could not list the uploaded parts.');
  }
}
