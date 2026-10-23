import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  NOTE_IMPORT_ITEM_STATUSES,
  createNoteImportBatchResponseSchema,
  createNoteLibraryRequestSchema,
  noteImportBatchItemsPageSchema,
  noteImportBatchSchema,
  noteLibraryScanRequestSchema,
  noteLibraryScanResponseSchema,
  noteLibrarySchema,
  updateNoteLibraryRequestSchema,
} from '@marinoscar/kvox-contract/notes';

/** The most batches / items one request returns. */
export const LIBRARY_MAX_PAGE_SIZE = 200;

/** `GET /notes/import-batches` query. @stability experimental */
export const importBatchListQuerySchema = z.object({
  libraryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(LIBRARY_MAX_PAGE_SIZE).default(20),
});

/** `GET /notes/import-batches/:id/items` query. @stability experimental */
export const importBatchItemsQuerySchema = z.object({
  status: z.enum(NOTE_IMPORT_ITEM_STATUSES).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LIBRARY_MAX_PAGE_SIZE).default(50),
});

/** @stability experimental */
export type ImportBatchListQuery = z.infer<typeof importBatchListQuerySchema>;
/** @stability experimental */
export type ImportBatchItemsQuery = z.infer<typeof importBatchItemsQuerySchema>;

export class NoteLibraryDto extends createZodDto(noteLibrarySchema) {}
export class NoteLibraryListDto extends createZodDto(
  z.object({ items: z.array(noteLibrarySchema) })
) {}
export class CreateNoteLibraryBodyDto extends createZodDto(createNoteLibraryRequestSchema) {}
export class UpdateNoteLibraryBodyDto extends createZodDto(updateNoteLibraryRequestSchema) {}
export class NoteLibraryScanBodyDto extends createZodDto(noteLibraryScanRequestSchema) {}
export class NoteLibraryScanResultDto extends createZodDto(noteLibraryScanResponseSchema) {}
export class NoteImportBatchDto extends createZodDto(noteImportBatchSchema) {}
export class NoteImportBatchListDto extends createZodDto(
  z.object({ items: z.array(noteImportBatchSchema) })
) {}
export class NoteImportBatchItemsPageDto extends createZodDto(noteImportBatchItemsPageSchema) {}
export class CreateNoteImportBatchResultDto extends createZodDto(
  createNoteImportBatchResponseSchema
) {}

/** `POST /notes/import-batches/:id/files` answer (#715). @stability experimental */
export const noteLibraryUploadResultSchema = z.object({
  itemId: z.string().uuid().nullable(),
  action: z.enum(['new', 'changed']).nullable(),
  skipped: z.boolean(),
});
export class NoteLibraryUploadResultDto extends createZodDto(noteLibraryUploadResultSchema) {}

/** `POST /notes/import-batches/:id/retry` answer (#715). @stability experimental */
export const noteLibraryRetryResultSchema = z.object({ requeued: z.number().int().min(0) });
export class NoteLibraryRetryResultDto extends createZodDto(noteLibraryRetryResultSchema) {}
