// =============================================================================
// `POST /api/storage/objects/:id/upload/parts` (issue #21)
// =============================================================================
//
// ZOD, NOT class-validator, and that is not a style preference. This
// application installs `ZodValidationPipe` as its single global `APP_PIPE`
// (`app.module.ts`) and never registers Nest's `ValidationPipe`, so
// `class-validator` decorators on a DTO here would be inert metadata: the body
// would reach the controller completely unvalidated while LOOKING validated.
// The constraints below are the ones the endpoint needs — an array of integers
// of at least 1, at most 100 of them, no duplicates — expressed in the
// mechanism that actually runs.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Most part numbers one call may ask for.
 *
 * Mirrors `MAX_PRESIGN_BATCH` in `objects.service.ts`, which enforces it again
 * at the service boundary — the service is reachable in-process by a module
 * that never passes through this pipe, so the check cannot live only here.
 */
export const MAX_PRESIGN_BATCH = 100;

export const presignPartsSchema = z.object({
  /**
   * The parts to sign. 1-based, matching S3 part numbering, and validated
   * against the upload's own `totalParts` by the service — a bound this
   * schema cannot know, because it depends on the row.
   */
  partNumbers: z
    .array(z.number().int().min(1))
    .min(1)
    .max(MAX_PRESIGN_BATCH)
    .refine(
      (numbers) => new Set(numbers).size === numbers.length,
      { message: 'partNumbers must not contain duplicates' },
    ),
});

export type PresignPartsDto = z.infer<typeof presignPartsSchema>;

export class PresignPartsBodyDto extends createZodDto(presignPartsSchema) {}

export const presignedPartSchema = z.object({
  partNumber: z.number().int().positive(),
  /** Signed PUT URL for exactly this part of exactly this upload. */
  url: z.url(),
  /**
   * When the URL stops working, ISO-8601.
   *
   * Returned rather than left implicit because a multi-GB upload OUTLIVES its
   * own signed URLs: a client uploading at 1 MB/s spends longer on 100 parts
   * than the default one-hour expiry, and needs to know when to come back for
   * a fresh batch rather than discovering it as a 403 mid-file.
   */
  expiresAt: z.string(),
});

export type PresignedPartDto = z.infer<typeof presignedPartSchema>;

export const presignPartsResponseSchema = z.object({
  parts: z.array(presignedPartSchema),
});

export class PresignPartsResponseDto extends createZodDto(
  presignPartsResponseSchema,
) {}
