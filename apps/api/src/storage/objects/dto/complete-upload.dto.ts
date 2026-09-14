import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const completeUploadObjectSchema = z.object({
  /**
   * The uploaded parts, in any order.
   *
   * ⚠ OPTIONAL SINCE #21. When omitted the server reads the parts back from
   * the storage provider itself (`StorageProvider.listParts`). That is the
   * path a BROWSER should take: the ETag of a part lives in a response header
   * on a cross-origin `PUT`, which JavaScript cannot read unless the bucket
   * lists it in `Access-Control-Expose-Headers` — so a client that gets the
   * CORS configuration slightly wrong silently completes the upload with
   * `null` ETags and corrupts the object. The server never has that problem.
   *
   * Supplying the list is still honoured, for a client that already has the
   * ETags in hand (a server-side uploader, the CLI) and would rather not pay
   * for an extra `ListParts` round trip.
   */
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        eTag: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
});

/**
 * The request body, with an ABSENT body accepted as `{}` (#89).
 *
 * Omitting `parts` is the documented browser path above, and a browser that
 * has nothing to send sends a body-less POST: no payload, no `Content-Type`.
 * Fastify then hands the handler `body === undefined`, which a bare
 * `z.object` rejects — so every browser upload failed at 100% with a 400
 * `Validation failed`, all of its parts already sitting in the bucket.
 *
 * Only a missing (or `null`) body is normalised. A body that is present but
 * wrong — `{ "parts": [] }`, a string, an array — still fails validation.
 *
 * The preprocess does not change the published OpenAPI schema: for a pipe
 * whose input side is a transform, zod's `toJSONSchema` describes the object
 * it feeds, so `CompleteUploadBodyDto` documents exactly the same shape.
 */
export const completeUploadSchema = z.preprocess(
  (body) => body ?? {},
  completeUploadObjectSchema,
);

export type CompleteUploadDto = z.infer<typeof completeUploadSchema>;

export class CompleteUploadBodyDto extends createZodDto(completeUploadSchema) {}
