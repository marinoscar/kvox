import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { StorageObjectStatus } from '@prisma/client';

/**
 * Storage object metadata as returned to a caller.
 *
 * Declared as a zod schema rather than a bare TypeScript `interface` because an
 * interface is erased at compile time: `@ApiResponse({ type: ObjectResponseDto })`
 * against one produced nothing, and the controller fell back to `type: Object`,
 * publishing an empty schema. A `createZodDto` class is both the compile-time
 * type the service already used and a real JSON Schema in the document.
 */
export const objectResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** BigInt serialized as a string — 64-bit values lose precision as JSON numbers. */
  size: z.string(),
  mimeType: z.string(),
  status: z.enum(StorageObjectStatus),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class ObjectResponseDto extends createZodDto(objectResponseSchema) {}

export const uploadStatusResponseSchema = z.object({
  objectId: z.uuid(),
  status: z.enum(StorageObjectStatus),
  /**
   * Part numbers the STORAGE PROVIDER is actually holding, so a resuming
   * client knows what to skip (#21). Read from the provider on every call,
   * not from this application's own chunk rows — those are written at
   * completion time and are empty for exactly as long as the answer matters.
   */
  uploadedParts: z.array(z.number().int()),
  totalParts: z.number().int(),
  /**
   * The part size THIS upload was initialised with (#21).
   *
   * Returned so a resuming client slices the file the same way the original
   * upload did. It is read from the row, never re-derived from the
   * deployment's current configuration — see `storage_objects.part_size`.
   */
  partSize: z.number().int().positive(),
  uploadedBytes: z.string(),
  totalBytes: z.string(),
});

export class UploadStatusResponseDto extends createZodDto(uploadStatusResponseSchema) {}
