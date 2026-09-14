// =============================================================================
// Note export request and response shapes (issue #54, docs/specs/notes.md §8)
// =============================================================================
//
// ZOD, NOT class-validator — `note.dto.ts`'s header carries the full reason and
// it applies with extra force here: `options` is a free-form object whose shape
// is decided by the EXPORTER, and an inert `class-validator` decorator would
// let an arbitrary body reach a renderer while looking validated. The envelope
// below is validated by the global `ZodValidationPipe`; the `options` object
// inside it is validated a second time, against the chosen exporter's own
// schema, by `NoteExportService`. Two passes, because the pipe cannot know
// which exporter the `format` field is about to name.
//
// ⚠ `options` IS `z.record(z.string(), z.unknown())` HERE ON PURPOSE. Making it
// a union of the three exporters' option shapes would put the registry's
// contents into a DTO — so adding a fourth exporter, which §8.1 promises is
// "one new class registering itself", would silently also require editing this
// file. That is precisely the coupling the registry exists to remove.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `note_exports.status`. */
export const NOTE_EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;

// -----------------------------------------------------------------------------
// GET /api/notes/exporters
// -----------------------------------------------------------------------------

/** One option an exporter accepts, as the dialog renders it. */
export const noteExportOptionFieldSchema = z.object({
  key: z.string().describe('The key to send inside `options`.'),
  label: z.string().describe('Sentence-case label for the control.'),
  description: z.string().describe('One line saying what turning this on does.'),
  type: z.literal('boolean').describe('The control to draw. Only booleans exist in v1.'),
  default: z.boolean().describe('The value used when the request omits this key.'),
});

export class NoteExportOptionFieldDto extends createZodDto(noteExportOptionFieldSchema) {}

/** One available format. */
export const noteExporterSchema = z.object({
  format: z.string().describe('Send this as `format`. Permanent once published.'),
  label: z.string().describe('What to call this format in a menu.'),
  mimeType: z.string().describe('Content type of the rendered file.'),
  extension: z.string().describe('Filename extension, without the dot.'),
  options: z.array(noteExportOptionFieldSchema).describe('Every option this format accepts.'),
});

export class NoteExporterDto extends createZodDto(noteExporterSchema) {}

export const noteExportersSchema = z.object({
  exporters: z
    .array(noteExporterSchema)
    .describe('Every registered note export format, ordered by `format`.'),
});

export class NoteExportersDto extends createZodDto(noteExportersSchema) {}

// -----------------------------------------------------------------------------
// POST /api/notes/:id/exports
// -----------------------------------------------------------------------------

export const createNoteExportSchema = z.object({
  format: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .describe('A `format` from `GET /api/notes/exporters` — `markdown`, `pdf` or `docx`.'),
  version: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("The version to export. Omitted or null means the note's current version."),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Format options. Validated against the chosen exporter's own schema — an unknown " +
        'key is a 400 rather than a silently ignored field. Omitted means all defaults.',
    ),
});

export type CreateNoteExportDto = z.infer<typeof createNoteExportSchema>;

export class CreateNoteExportBodyDto extends createZodDto(createNoteExportSchema) {}

// -----------------------------------------------------------------------------
// The export resource
// -----------------------------------------------------------------------------

export const noteExportSchema = z.object({
  id: z.string().describe('The export id, for `GET /api/notes/exports/{id}/download`.'),
  noteId: z.string().describe('The note this export was rendered from.'),
  version: z.number().int().describe('The version that was rendered.'),
  format: z.string().describe('The exporter that rendered it.'),
  options: z
    .record(z.string(), z.unknown())
    .describe('The options it was rendered with, defaults applied.'),
  status: z
    .enum(NOTE_EXPORT_STATUSES)
    .describe('`pending` while the job runs, then `ready` or `failed`.'),
  /**
   * `reused` is the one field that is about THIS REQUEST rather than about the
   * row. It tells a client that its 200 is an existing render rather than a new
   * one — useful in the dialog ("ready already") and, more importantly, the
   * only way a caller can tell the two success codes apart when a proxy or a
   * fetch wrapper has swallowed the status line.
   */
  reused: z
    .boolean()
    .describe('True when this response returned an export that already existed.'),
  mimeType: z.string().describe('Content type of the rendered file.'),
  filename: z.string().describe('The filename the download is served as.'),
  sizeBytes: z
    .string()
    .nullable()
    .describe('Byte length of the rendered file as a decimal string, or null until ready.'),
  error: z.string().nullable().describe('Why the render failed, when it did.'),
  downloadUrl: z
    .string()
    .nullable()
    .describe(
      'A short-lived signed URL that serves the file as an attachment. Null unless ready.',
    ),
  downloadExpiresAt: z
    .string()
    .nullable()
    .describe('When `downloadUrl` stops working, ISO-8601.'),
  expiresAt: z.string().describe('When the export itself is deleted, ISO-8601 (7 days).'),
  createdAt: z.string().describe('When the export was requested, ISO-8601.'),
});

export class NoteExportDto extends createZodDto(noteExportSchema) {}

export const noteExportListSchema = z.object({
  exports: z
    .array(noteExportSchema)
    .describe("This note's exports, newest first. Expired ones are already gone."),
});

export class NoteExportListDto extends createZodDto(noteExportListSchema) {}

// -----------------------------------------------------------------------------
// GET /api/notes/exports/:exportId/download
// -----------------------------------------------------------------------------

export const noteExportDownloadSchema = z.object({
  url: z.string().describe('A short-lived signed URL serving the file as an attachment.'),
  expiresAt: z.string().describe('When `url` stops working, ISO-8601.'),
  filename: z.string().describe('`<title> (v<n>).<ext>`, signed into the URL.'),
  mimeType: z.string().describe('Content type of the rendered file.'),
  sizeBytes: z.string().describe('Byte length as a decimal string.'),
});

export class NoteExportDownloadDto extends createZodDto(noteExportDownloadSchema) {}
