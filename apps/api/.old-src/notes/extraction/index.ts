// =============================================================================
// Document extraction (issue #51, epic #45) — the pure core
// =============================================================================
//
// ONE FUNCTION PER FORMAT, dispatched by MIME type, with no Nest decorators
// anywhere in this directory. The issue requires that shape explicitly, and the
// reason is the same one `transcripts/editing/` states: each extractor is then
// unit-testable against a fixture buffer with no container, no database and no
// storage provider — which is what makes "an encrypted PDF produces a distinct,
// user-readable reason" a two-line test rather than an integration fixture.
//
// It is also what leaves room for the format this epic deliberately does NOT
// support: adding OCR later, or `.docx`, is a new file beside these two plus a
// line in the switch below — not a change to the job, the upload endpoint, or
// the storage layout.
// =============================================================================

import type { NoteDocumentMimeType } from './document-format';
import { extractPdfText } from './extract-pdf';
import { extractPlainText } from './extract-text';
import type { ExtractionOutcome } from './extraction-result';

export {
  NOTE_DOCUMENT_MIME_TYPES,
  acceptedDocumentTypesSentence,
  normalizeDocumentMimeType,
  type NoteDocumentMimeType,
} from './document-format';
export { decodeTextBytes, extractPlainText } from './extract-text';
export { extractPdfText } from './extract-pdf';
export {
  EXTRACTION_ENCODINGS,
  EXTRACTION_FAILURE_REASONS,
  describeExtractionFailure,
  type ExtractedDocument,
  type ExtractionEncoding,
  type ExtractionFailureReason,
  type ExtractionOutcome,
  type UnextractableDocument,
} from './extraction-result';

/**
 * Turn one uploaded document into plain text, or into the reason it cannot be.
 *
 * `mimeType` is the CANONICAL type the upload endpoint already validated (see
 * `normalizeDocumentMimeType`), never a raw header — a document whose type was
 * not one of the three never reaches a job at all, so there is no
 * "unsupported" arm here to get out of step with the endpoint's accepted list.
 */
export function extractDocumentText(
  bytes: Uint8Array,
  mimeType: NoteDocumentMimeType,
): Promise<ExtractionOutcome> {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdfText(bytes);
    case 'text/plain':
    case 'text/markdown':
      return Promise.resolve(extractPlainText(bytes));
    default: {
      // Unreachable through the union; reachable through a `mime_type` column
      // written by a build that accepted a fourth type.
      const exhaustive: never = mimeType;

      throw new Error(`No extractor for document type "${String(exhaustive)}"`);
    }
  }
}
