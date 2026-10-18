import { z } from 'zod';
import { NOTE_DOCUMENT_MIME_TYPES } from './document-format.js';

// =============================================================================
// Note source documents — the response body (issue #51, epic #45)
// =============================================================================
//
// ONE RESPONSE SHAPE, AND NO REQUEST SCHEMA. The request is
// `multipart/form-data` with a single `file` part, which is not something a Zod
// body schema can describe — the controller reads it off the Fastify request
// and validates the part itself (see the endpoint's own comment on why the
// checks happen at the door).
//
// `.describe()` on each field is what the Swagger module renders as the property
// description — the zod equivalent of `@ApiProperty({ description })`, which is
// what CI's document lint reads.
// =============================================================================

/**
 * Zod schema for the note source document response wire shape.
 *
 * @stability experimental
 */
export const noteSourceDocumentResponseSchema = z.object({
  objectId: z
    .string()
    .describe(
      'The `storage_objects` row holding the uploaded document. Pass it as `sourceObjectId` when creating a note. Managed by the notes module, so it is absent from `GET /api/storage/objects` and its generic `DELETE` answers 409.',
    ),
  filename: z.string().describe('The uploaded filename, as the client sent it.'),
  mimeType: z
    .enum(NOTE_DOCUMENT_MIME_TYPES)
    .describe('The canonical accepted type this document was stored as.'),
  size: z.number().describe('Bytes accepted, as measured by this server.'),
  jobId: z
    .string()
    .describe(
      'The `note.source.extract` job that will turn the document into text. Poll `GET /api/notes/sources/documents/{objectId}` for its progress, or simply create the note — generation fails with a readable sentence if extraction has not finished or produced no text.',
    ),
  status: z
    .literal('extracting')
    .describe(
      'Always `extracting` on creation. Extraction is a queue job because a document outlives the request that uploaded it.',
    ),
});

/**
 * The three states a source document's extraction can be in, as
 * `GET /api/notes/sources/documents/{objectId}` reports them.
 *
 * @stability experimental
 */
export const NOTE_SOURCE_DOCUMENT_STATUSES = ['extracting', 'extracted', 'unextractable'] as const;

/**
 * Zod schema for the note source document status response wire shape
 * (`GET /api/notes/sources/documents/{objectId}`, issue #596).
 *
 * It replaces the notes UI reading the object's `metadata` through the generic
 * storage read: the notes slice serves the status itself, so a host needs no
 * storage object route for notes. Every recorded shape the server cannot
 * understand reads as `extracting`, never as an error.
 *
 * @stability experimental
 */
export const noteSourceDocumentStatusResponseSchema = z.object({
  objectId: z
    .string()
    .describe('The source document\'s `storage_objects` id, as `POST /api/notes/sources/documents` returned it.'),
  status: z
    .enum(NOTE_SOURCE_DOCUMENT_STATUSES)
    .describe(
      '`extracting` until the `note.source.extract` job records a result (also for any recorded shape this server cannot read); `extracted` when plain text exists and a note can be generated from it; `unextractable` when the document holds no readable text (password-protected, scanned images only, corrupt). Terminal states never change back.',
    ),
  message: z
    .string()
    .nullable()
    .describe(
      'The user-facing sentence the extraction recorded — for `unextractable`, why no text could be read. `null` while `extracting`, or when the recorded result carries none.',
    ),
  characters: z
    .number()
    .nullable()
    .describe(
      'Characters of extracted text, when the recorded result carries the count (normally only `extracted`). `null` otherwise.',
    ),
});

/**
 * The note source document status response wire shape.
 *
 * @stability experimental
 */
export type NoteSourceDocumentStatusResponse = z.infer<typeof noteSourceDocumentStatusResponseSchema>;
