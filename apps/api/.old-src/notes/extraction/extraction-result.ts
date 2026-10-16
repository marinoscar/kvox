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

/**
 * Why a document produced no text, permanently.
 *
 * ⚠ THESE STRINGS ARE STORED — they land in the source object's own metadata
 * (spec §4.7) and travel across the wire in a worker node's result, so they are
 * as permanent as a job type string. A rename means every already-extracted
 * source carries a reason the reader no longer recognises.
 */
export const EXTRACTION_FAILURE_REASONS = [
  'encrypted_pdf',
  'no_text_layer',
  'corrupt_file',
  'empty_document',
] as const;

/** One permanent reason a document yielded no text. */
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

/**
 * How the bytes of a text document were decoded.
 *
 * `pdf-text` is not a character encoding and is deliberately in the same field:
 * what a reader of this value actually wants to know is "how did you turn these
 * bytes into those characters", and for a PDF the honest answer is "the PDF's
 * own text operators decided", not "UTF-8". A separate nullable column for the
 * PDF case would make every reader handle a null it has nothing to do with.
 */
export const EXTRACTION_ENCODINGS = [
  'utf-8',
  'utf-8-bom',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'pdf-text',
] as const;

/** How a document's bytes were decoded. See {@link EXTRACTION_ENCODINGS}. */
export type ExtractionEncoding = (typeof EXTRACTION_ENCODINGS)[number];

/** A document that yielded text. */
export interface ExtractedDocument {
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
  encoding: ExtractionEncoding;
}

/** A document that yielded no text, permanently. */
export interface UnextractableDocument {
  outcome: 'unextractable';
  reason: ExtractionFailureReason;
  /** Pages, when the file was structurally readable enough to count them. */
  pageCount: number | null;
}

/** The result of trying to extract one document. */
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
        'This file could not be read as a PDF. It is damaged, incomplete, or was not a PDF ' +
        'to begin with. Try exporting it again from whatever produced it.'
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
