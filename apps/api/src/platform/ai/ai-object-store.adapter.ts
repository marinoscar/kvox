import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';

import type { AiObjectStore } from '@marinoscar/platform-api/ai';
import {
  STORAGE_PROVIDER,
  STORAGE_SETTINGS_PATH,
  StorageConfigService,
  StorageNotConfiguredError,
  type StorageProvider,
} from '@marinoscar/platform-api/storage';

// =============================================================================
// AI_OBJECT_STORE over the platform storage slice (issue #473)
// =============================================================================
//
// Image, audio and file-input AI runs read and write storage objects through this
// port. It is a thin view over the active `STORAGE_PROVIDER` (the runtime-configured
// object store) and `StorageConfigService` (the configuration questions). It owns
// no configuration of its own: when storage is not configured the platform's own
// `StorageNotConfiguredError` (503 with its remedy) is what an AI run reports.
// =============================================================================

@Injectable()
export class AiObjectStoreAdapter implements AiObjectStore {
  readonly settingsPath = STORAGE_SETTINGS_PATH;

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly config: StorageConfigService,
  ) {}

  async upload(
    key: string,
    body: Readable,
    opts: { mimeType: string; contentLength: number },
  ): Promise<{ bucket: string }> {
    const result = await this.storage.upload(key, body, {
      mimeType: opts.mimeType,
      contentLength: opts.contentLength,
    });
    return { bucket: result.bucket };
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }

  download(key: string): Promise<Readable> {
    return this.storage.download(key);
  }

  getSignedDownloadUrl(key: string, opts: { expiresIn: number }): Promise<string> {
    return this.storage.getSignedDownloadUrl(key, { expiresIn: opts.expiresIn });
  }

  async assertWritable(): Promise<void> {
    const resolution = await this.config.resolve();
    if (!resolution.configured) {
      throw StorageNotConfiguredError.missing(resolution.provider, resolution.missing);
    }
  }

  activeProvider(): Promise<string> {
    return this.config.activeProvider();
  }

  notConfiguredReason(err: unknown): string | null {
    if (!(err instanceof StorageNotConfiguredError)) return null;
    const body = err.getResponse() as { details?: { reason?: unknown } };
    return typeof body.details?.reason === 'string' ? body.details.reason : 'storage_not_configured';
  }
}
