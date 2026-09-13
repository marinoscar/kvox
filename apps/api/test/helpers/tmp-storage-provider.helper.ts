// =============================================================================
// A filesystem-backed `StorageProvider` test double (issue #290, epic #254)
// =============================================================================
//
// `StorageProvidersModule` binds exactly one implementation — S3 — and this
// repository has no local/filesystem provider (see that module's own
// comment: "To add alternative providers ... update the useClass"). The
// real-Postgres database-backup suites in `test/integration/` need a
// provider that is genuinely REAL for `upload`/`download`/`delete` — writing
// through Node's actual filesystem streaming primitives, on the actual
// bytes `pg_dump`/`pg_restore` produce and consume — because the property
// under test is exactly "the archive that arrives is the archive that was
// sent", and an in-memory `Buffer` swap would prove that trivially and
// prove nothing about the streaming contract `db-backup-runner.service.ts`'s
// header describes (one pass, no buffer, checksum and byte count from the
// SAME read).
//
// So this is a SMALL, GENUINELY STREAMING provider over a tmp directory: it
// implements `upload`/`download`/`delete`/`exists`/`getBucket` for real
// against local disk, which is enough to exercise the runner and the
// restore service's real code paths end to end. The five methods this
// repository's backup/restore code never calls (multipart, signed URLs)
// throw rather than silently no-op, so a future caller that started needing
// one fails loudly in the suite that added it instead of writing nothing and
// reporting success.
//
// NOT a general-purpose fake — it exists for these suites only, and it is not
// registered anywhere `STORAGE_PROVIDER` is resolved for the application.
// =============================================================================

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import type {
  MultipartUploadInit,
  SignedPutUrlOptions,
  SignedUrlOptions,
  StorageUploadOptions,
  StorageUploadResult,
  UploadPart,
} from '../../src/storage/providers/storage-provider.types';

function notSupported(method: string): never {
  throw new Error(
    `TmpDirStorageProvider.${method}() is not implemented — this test double covers only ` +
      'upload/download/delete/exists/getBucket, which is everything the database-backup and ' +
      'database-restore code paths actually call. A caller that reached this method needs a ' +
      'real seam added here, not a silent no-op.'
  );
}

/**
 * A `StorageProvider` backed by a real directory on local disk.
 *
 * @param baseDir an ABSOLUTE, already-existing (or creatable) directory this
 * provider owns entirely. Callers are responsible for creating and removing
 * it — this class only ever writes inside it.
 */
export class TmpDirStorageProvider implements StorageProvider {
  constructor(
    private readonly baseDir: string,
    private readonly bucket: string = 'test-tmp-bucket'
  ) {}

  private pathFor(key: string): string {
    // Keys are server-generated (`buildBackupStorageKey` et al.) and contain
    // `/` as a path separator by design — `join` reproduces that structure on
    // disk, which is convenient for a developer poking at the tmp dir and
    // exercises the same nested-directory case a real object-store prefix
    // does.
    return join(this.baseDir, key);
  }

  async upload(
    key: string,
    stream: Readable,
    _options: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    // `pipeline`, not `.pipe()`: propagates a source error (a dead `pg_dump`)
    // into a rejected promise and destroys the write stream, rather than
    // leaving a partial file with nobody watching it — the same reason
    // `defaultDatabaseRestoreSeam.writeArchiveToFile` uses it.
    await pipeline(stream, createWriteStream(path));

    return { key, bucket: this.bucket, location: `file://${path}` };
  }

  async download(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  getBucket(): string {
    return this.bucket;
  }

  async getMetadata(_key: string): Promise<Record<string, string> | null> {
    return null;
  }

  async setMetadata(_key: string, _metadata: Record<string, string>): Promise<void> {
    // No-op: nothing under test reads it back.
  }

  initMultipartUpload(_key: string, _options: StorageUploadOptions): Promise<MultipartUploadInit> {
    return notSupported('initMultipartUpload');
  }

  getSignedUploadUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn?: number
  ): Promise<string> {
    return notSupported('getSignedUploadUrl');
  }

  completeMultipartUpload(
    _key: string,
    _uploadId: string,
    _parts: UploadPart[]
  ): Promise<StorageUploadResult> {
    return notSupported('completeMultipartUpload');
  }

  abortMultipartUpload(_key: string, _uploadId: string): Promise<void> {
    return notSupported('abortMultipartUpload');
  }

  getSignedDownloadUrl(_key: string, _options?: SignedUrlOptions): Promise<string> {
    return notSupported('getSignedDownloadUrl');
  }

  getSignedPutUrl(_key: string, _options?: SignedPutUrlOptions): Promise<string> {
    return notSupported('getSignedPutUrl');
  }
}

/** Removes the whole tmp directory a `TmpDirStorageProvider` was given. */
export async function cleanupTmpDir(baseDir: string): Promise<void> {
  await rm(baseDir, { recursive: true, force: true });
}
