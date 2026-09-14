import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const initUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  /**
   * The content type the client believes the file has.
   *
   * ⚠ OPTIONAL SINCE #21, and it has to be. A browser reports an EMPTY STRING
   * for `.amr` and, on several Android builds, for `.m4a` — requiring a
   * non-empty type here rejected the exact recordings this endpoint exists to
   * accept. An absent or generic type is resolved from the file extension by
   * `upload-constraints.ts`; a type that survives that is checked against
   * `storage.allowedMimeTypes`.
   *
   * ⚠ THERE IS NO `managedBy` FIELD HERE, DELIBERATELY. Marking an object as
   * owned by a module makes it invisible to the generic list and undeletable
   * through the generic endpoint; a client that could set it could mint a row
   * it can never remove. Only an in-process caller of `ObjectsService` may.
   */
  mimeType: z.string().max(255).optional(),
});

export type InitUploadDto = z.infer<typeof initUploadSchema>;

export class InitUploadBodyDto extends createZodDto(initUploadSchema) {}

export const initUploadResponseSchema = z.object({
  objectId: z.uuid(),
  /** Provider-side multipart upload id, echoed back on complete/abort. */
  uploadId: z.string(),
  /**
   * Byte length of every part but the last.
   *
   * CHOSEN PER UPLOAD and stored on the row (#21), not read from configuration
   * later — it adapts upward for large files so the part count stays inside
   * S3's 10,000-part limit. Use exactly this value when slicing the file; a
   * client that re-derives it from its own default will upload the wrong bytes
   * to every part number.
   */
  partSize: z.number().int().positive(),
  totalParts: z.number().int().positive(),
  /**
   * Signed PUT URLs for the FIRST BATCH of parts (up to ten) — a fast path so
   * a small upload needs no second round trip, NOT the whole upload. Ask
   * `POST /api/storage/objects/{id}/upload/parts` for the rest, in batches, as
   * you go: signed URLs expire, and a multi-GB upload outlives them.
   */
  presignedUrls: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: z.url(),
    }),
  ),
});

export class InitUploadResponseDto extends createZodDto(initUploadResponseSchema) {}
