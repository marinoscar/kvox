import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NOTE_DOCUMENT_MIME_TYPES } from '../extraction/document-format';

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
// `.describe()` on each field is what `@nestjs/swagger` renders as the property
// description — the zod equivalent of `@ApiProperty({ description })`, which is
// what CI's document lint reads.
// =============================================================================

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
      'The `note.source.extract` job that will turn the document into text. Poll the object, or simply create the note — generation fails with a readable sentence if extraction has not finished or produced no text.',
    ),
  status: z
    .literal('extracting')
    .describe(
      'Always `extracting` on creation. Extraction is a queue job because a document outlives the request that uploaded it.',
    ),
});

export class NoteSourceDocumentDto extends createZodDto(
  noteSourceDocumentResponseSchema,
) {}
