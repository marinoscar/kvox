// =============================================================================
// The multipart part size, as the platform storage slice derives it (issue #469)
// =============================================================================
//
// Until #469 the app sized every upload adaptively (`upload-constraints.ts`) and
// PERSISTED the choice in `storage_objects.part_size`, so a resumed upload never
// renumbered its parts. The platform has neither: its `ObjectsService.initUpload`
// reads ONE deployment-wide number, the `StorageModule.forRoot({ partSizeBytes })`
// option or else the config key `storage.partSize` (`STORAGE_PART_SIZE`), and
// derives `totalParts = ceil(size / partSize)` from it every time.
//
// THE CONSEQUENCE, and the operator rule that follows from it:
//
//   NEVER CHANGE THE PART SIZE WHILE UPLOADS ARE IN FLIGHT. A part already on
//   the provider keeps the size it was uploaded with; the client, on resume,
//   would lay the remaining parts out at the NEW size and complete with a part
//   list whose offsets no longer line up. Drain or abort the in-flight uploads
//   first (the stale-upload sweep reclaims abandoned ones).
//
// THE CEILING. S3 allows at most 10,000 parts per upload, so a part size caps
// the largest object it can carry: `partSize * 10,000`. At the platform default
// of 10 MiB that is 97.6 GiB. The largest limit the app enforces is far below it:
//
//   * a transcription provider's `maxInputBytes` (AssemblyAI: 5 GiB, the
//     largest of the registered providers), and
//   * the deployment's `storage.maxFileSize` (`MAX_FILE_SIZE`, default 10 GiB).
//
// 10 GiB at 10 MiB parts is 1,024 parts, so the default stays. An operator who
// raises `MAX_FILE_SIZE` above `maxObjectBytes(partSize)` must raise the part
// size with it (before any upload starts); `initUpload` answers 400 once a file
// exceeds the ceiling, and `part-size.spec.ts` pins the arithmetic.
// =============================================================================

import type { ConfigService } from '@nestjs/config';
import { DEFAULT_STORAGE_PART_SIZE_BYTES } from '@marinoscar/platform-api/storage';
import type { ResolvedStorageModuleOptions } from '@marinoscar/platform-api/storage';

/** S3's ceiling on the number of parts in one multipart upload. */
export const S3_MAX_PARTS = 10_000;

/** S3's floor for every part but the last. */
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * The part size the platform's `initUpload` is using right now: the
 * `StorageModule.forRoot` option when set, else the config key
 * `storage.partSize`, else the platform default (10 MiB). The same expression the
 * platform evaluates, so the part numbers signed here agree with the layout the
 * init response gave the client.
 */
export function resolvePartSize(
  config: Pick<ConfigService, 'get'>,
  options?: Pick<ResolvedStorageModuleOptions, 'partSizeBytes'> | null,
): number {
  return options?.partSizeBytes ?? config.get<number>('storage.partSize', DEFAULT_STORAGE_PART_SIZE_BYTES);
}

/** How many parts an object of `size` bytes has at `partSize`. */
export function totalPartsFor(size: bigint | number, partSize: number): number {
  return Math.ceil(Number(size) / partSize);
}

/** The largest object, in bytes, `partSize` can carry within the 10,000-part ceiling. */
export function maxObjectBytes(partSize: number): number {
  return partSize * S3_MAX_PARTS;
}
