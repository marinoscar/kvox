import { z } from 'zod';

// =============================================================================
// The result a worker node posts back for `note.source.extract` (issue #460; moved
// into the contract by issue #495, epic #491)
// =============================================================================
//
// A node extracts the text of an uploaded PDF, plain-text or Markdown source document
// and returns it as DATA. The server validates it with this schema before it persists
// anything (the trust boundary: docs/specs/worker-nodes.md section 22), so the schema is
// part of the contract between the API and a node, and a future `kvox-node` imports it
// from here.
//
// The `note.source.extract` job `type` string is permanent.
// =============================================================================

/**
 * Why a document yielded no text. Stored in the document's metadata and shown to the user.
 *
 * @stability experimental
 */
export const EXTRACTION_FAILURE_REASONS = [
  'encrypted_pdf',
  'no_text_layer',
  'corrupt_file',
  'empty_document',
] as const;

/** One extraction failure reason. @stability experimental */
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

/**
 * How the extracted text was decoded. Stored in the document's metadata.
 *
 * @stability experimental
 */
export const EXTRACTION_ENCODINGS = [
  'utf-8',
  'utf-8-bom',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'pdf-text',
] as const;

/** One extraction encoding. @stability experimental */
export type ExtractionEncoding = (typeof EXTRACTION_ENCODINGS)[number];

/**
 * The longest extracted text the server accepts from a node, in characters.
 *
 * @stability experimental
 */
export const NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS = 16 * 1024 * 1024;

const MAX_PAGE_COUNT = 1_000_000;

/**
 * The shape of a node's `note.source.extract` result: either the text, or the reason
 * there is none.
 *
 * @stability experimental
 */
export const noteSourceExtractResultSchema = z
  .object({
    outcome: z.enum(['extracted', 'unextractable']),
    text: z.string().min(1).max(NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS).nullable(),
    reason: z.enum(EXTRACTION_FAILURE_REASONS).nullable(),
    pageCount: z.number().int().min(0).max(MAX_PAGE_COUNT).nullable(),
    encoding: z.enum(EXTRACTION_ENCODINGS).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'extracted') {
      if (value.text === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['text'],
          message: 'text is required when outcome is "extracted"',
        });
      }
      if (value.encoding === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['encoding'],
          message: 'encoding is required when outcome is "extracted"',
        });
      }
      if (value.reason !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'reason must be null when outcome is "extracted"',
        });
      }
      return;
    }

    if (value.reason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is required when outcome is "unextractable"',
      });
    }
    if (value.text !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'text must be null when outcome is "unextractable"',
      });
    }
  });

/** A validated `note.source.extract` result. @stability experimental */
export type NoteSourceExtractResult = z.infer<typeof noteSourceExtractResultSchema>;
