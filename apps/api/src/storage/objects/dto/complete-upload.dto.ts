import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const completeUploadSchema = z.object({
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

export type CompleteUploadDto = z.infer<typeof completeUploadSchema>;

export class CompleteUploadBodyDto extends createZodDto(completeUploadSchema) {}
