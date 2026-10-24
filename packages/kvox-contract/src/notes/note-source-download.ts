import { z } from 'zod';

// -----------------------------------------------------------------------------
// GET /api/notes/:id/source
// -----------------------------------------------------------------------------

/**
 * Zod schema for the response of `GET /api/notes/{id}/source`: a short-lived signed URL
 * that serves the original file a note was imported from (docx, pptx, pdf, md, txt) as an
 * attachment.
 *
 * @stability experimental
 */
export const noteSourceDownloadSchema = z.object({
  url: z.string().describe('A short-lived signed URL serving the original file as an attachment.'),
  filename: z
    .string()
    .describe('The original file name, sanitized; signed into the URL as the attachment name.'),
  mimeType: z.string().describe('Content type of the original file.'),
  expiresAt: z.string().describe('When `url` stops working, ISO-8601.'),
});

/**
 * The response of `GET /api/notes/{id}/source`.
 *
 * @stability experimental
 */
export type NoteSourceDownload = z.infer<typeof noteSourceDownloadSchema>;

/**
 * Zod schema for the query of `GET /api/notes/{id}/source`.
 *
 * @stability experimental
 */
export const noteSourceDownloadQuerySchema = z.object({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('A version number of the note; defaults to the current version.'),
});

/**
 * The query of `GET /api/notes/{id}/source`.
 *
 * @stability experimental
 */
export type NoteSourceDownloadQuery = z.infer<typeof noteSourceDownloadQuerySchema>;
