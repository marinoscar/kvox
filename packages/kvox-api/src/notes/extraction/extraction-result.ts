// =============================================================================
// What extracting a document produces (issue #51, epic #45)
// =============================================================================
//
// ONE RETURN TYPE WITH TWO ARMS, AND NEITHER OF THEM IS A THROWN ERROR.
//
// An encrypted PDF, a scanned page with no text layer, and a corrupt file are
// all PERMANENT conditions: no retry changes the answer, and the user's only
// useful next action is to upload a different file. The issue is explicit that
// "failure is a domain outcome, not a crash" — so the extractor RETURNS one of
// these rather than throwing, `note.source.extract` records the reason, and the
// job completes normally. A thrown error would spend the job's attempts
// rediscovering something already known, and would surface in the admin job
// list as an incident rather than in the note UI as a sentence.
//
// ⚠ THE `no_text_layer` MESSAGE SAYS "OCR IS NOT SUPPORTED", ON PURPOSE. The
// issue calls this out by name: "this PDF contains no extractable text, only
// images" tells the user what is wrong AND what this application will never do
// about it, which is what makes it actionable. "Extraction failed" tells them
// to try again, which cannot work.
//
// A genuine BUG — a provider that cannot be reached, a stream that dies
// halfway — still throws, and should: that one is worth retrying and worth an
// operator seeing.
//
// ⚠ PURE. No Nest, no I/O, no logger. See `document-format.ts`'s header.
// =============================================================================

// The two tuples (and their types) are part of the wire contract a worker node returns, so they
// live in `@marinoscar/kvox-contract/notes` (issue #495) and are re-exported here.
import {
  EXTRACTION_ENCODINGS,
  EXTRACTION_FAILURE_REASONS,
  type ExtractionEncoding,
  type ExtractionFailureReason,
} from '@marinoscar/kvox-contract/notes';

export { EXTRACTION_ENCODINGS, EXTRACTION_FAILURE_REASONS, type ExtractionEncoding, type ExtractionFailureReason };

/**
 * Why a document produced no text, permanently.
 *
 * ⚠ THESE STRINGS ARE STORED — they land in the source object's own metadata
 * (spec §4.7) and travel across the wire in a worker node's result, so they are
 * as permanent as a job type string. A rename means every already-extracted
 * source carries a reason the reader no longer recognises.
 */

/**
 * How the bytes of a text document were decoded.
 *
 * `pdf-text` is not a character encoding and is deliberately in the same field:
 * what a reader of this value actually wants to know is "how did you turn these
 * bytes into those characters", and for a PDF the honest answer is "the PDF's
 * own text operators decided", not "UTF-8". A separate nullable column for the
 * PDF case would make every reader handle a null it has nothing to do with.
 */

/** A document that yielded text. */
/**
 * ExtractedDocument.
 *
 * @stability experimental
 */
export interface ExtractedDocument {
  /** Discriminant: the document yielded text. */
  outcome: 'extracted';
  /** The plain text, line endings normalized to `\n`, BOM removed. */
  text: string;
  /**
   * Pages, for a paginated format; `null` for one that has no pages.
   *
   * NULL RATHER THAN 1 for a `.txt` or `.md` file. A text file does not have
   * one page — it has no notion of a page at all, and storing `1` would make
   * "a one-page PDF" and "a text file" indistinguishable to anything reading
   * this back.
   */
  pageCount: number | null;
  /** The character encoding the text was decoded from. */
  encoding: ExtractionEncoding;
}

/** A document that yielded no text, permanently. */
/**
 * UnextractableDocument.
 *
 * @stability experimental
 */
export interface UnextractableDocument {
  /** Discriminant: the document yielded no text. */
  outcome: 'unextractable';
  /** Why no text could be read. */
  reason: ExtractionFailureReason;
  /** Pages, when the file was structurally readable enough to count them. */
  pageCount: number | null;
}

/** The result of trying to extract one document. */
/**
 * ExtractionOutcome.
 *
 * @stability experimental
 */
export type ExtractionOutcome = ExtractedDocument | UnextractableDocument;

/**
 * The sentence a user is shown for one permanent failure.
 *
 * WRITTEN FOR THE PERSON WHO UPLOADED THE FILE, not for an operator reading a
 * log. Each one names the condition and the next action, and the scanned-PDF
 * case states plainly that OCR is not supported rather than leaving somebody to
 * infer it from a retry that keeps failing.
 */
export function describeExtractionFailure(reason: ExtractionFailureReason): string {
  switch (reason) {
    case 'encrypted_pdf':
      return (
        'This PDF is password-protected, so none of its text can be read. ' +
        'Remove the password from the file and upload it again.'
      );
    case 'no_text_layer':
      return (
        'This PDF contains no extractable text, only images — it was most likely produced ' +
        'by a scanner or a photograph of a page. Reading text out of images (OCR) is not ' +
        'supported, so there is nothing here to write a note from. Upload a PDF that was ' +
        'exported from a document rather than scanned, or paste the text in directly.'
      );
    case 'corrupt_file':
      return (
        'This file could not be read. It is damaged, incomplete, or not the kind of file its ' +
        'name says. Try exporting it again.'
      );
    case 'unsupported_office_format':
      return (
        'This is an older Word or PowerPoint file (.doc or .ppt), or an Office file protected ' +
        'by a password, so it cannot be read. Save it as .docx or .pptx without a password ' +
        'and import it again.'
      );
    case 'archive_too_large':
      return (
        'This document is too large to read safely: once unpacked it exceeds the size limits. ' +
        'Split it into smaller files or remove large embedded media, then import it again.'
      );
    case 'empty_document':
      return 'This document contains no text at all, so there is nothing to write a note from.';
    default: {
      // Unreachable through the union, reachable through a value read back from
      // JSONB written by a later build than this one.
      const exhaustive: never = reason;

      return `This document could not be read (${String(exhaustive)}).`;
    }
  }
}
