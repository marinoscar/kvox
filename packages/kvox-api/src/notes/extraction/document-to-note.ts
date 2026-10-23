// =============================================================================
// Turning an uploaded document into a note's title and body (epic #708, issue #711)
// =============================================================================
//
// "IMPORT A DOCUMENT AS A NOTE" IS EXTRACTION PLUS A TITLE AND A BODY FORMAT.
// The extractors answer "what text is in this file"; a note also needs a title
// and to say how its body is written. Both decisions live HERE, once, so the
// upload route, the batch import and a worker node cannot disagree:
//
//   .md / .txt   decoded, then read by the contract's `parseNoteMarkdownExport`
//                (a KVox export keeps its own title; a plain file takes its
//                leading `# heading`, else the file name). Body: `markdown`.
//   .pdf         the extracted text is page text, not Markdown -> `plain_text`;
//                title = the file name without its extension.
//   .docx/.pptx  the extractor already writes Markdown -> `markdown`; title =
//                the document's own `dc:title`, else its first heading (docx) or
//                first slide title (pptx), else the file name.
//
// A title is trimmed, whitespace-collapsed and capped at the length the contract
// caps an imported title (`titleFromFilename`'s 200 characters).
//
// ⚠ PURE. No Nest, no I/O. Failure is returned, never thrown.
// =============================================================================

import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  parseNoteMarkdownExport,
  titleFromFilename,
  type NoteImportFailureReason,
} from '@marinoscar/kvox-contract/notes';

import type { NoteDocumentMimeType } from './document-format.js';
import { extractDocxMarkdown, type OoxmlExtractionOutcome } from './extract-docx.js';
import { extractPdfText } from './extract-pdf.js';
import { extractPptxMarkdown } from './extract-pptx.js';
import { decodeTextBytes } from './extract-text.js';
import {
  describeExtractionFailure,
  type ExtractionEncoding,
  type ExtractionFailureReason,
} from './extraction-result.js';

/** The longest title a note keeps; the same limit the contract applies to an imported title. */
const MAX_TITLE_CHARS = 200;

/**
 * A document read as a note.
 *
 * @stability experimental
 */
export type DocumentToNoteResult =
  | {
      ok: true;
      title: string;
      body: string;
      bodyFormat: 'markdown' | 'plain_text';
      pageCount: number | null;
      encoding: ExtractionEncoding;
    }
  | {
      ok: false;
      reason: ExtractionFailureReason | NoteImportFailureReason;
      /** A sentence a person can read. */
      message: string;
    };

function cleanTitle(raw: string | null | undefined): string | null {
  const title = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS).trim();
  return title === '' ? null : title;
}

function firstHeading(markdown: string, pattern: RegExp): string | null {
  const match = pattern.exec(markdown);
  return match ? cleanTitle(match[1].replace(/\*+|\\/g, '')) : null;
}

/**
 * Read one uploaded document as a note: its title, its body and how the body is written.
 *
 * @param bytes - the file.
 * @param mimeType - the CANONICAL type (`normalizeDocumentMimeType`).
 * @param filename - the uploaded file's name; the last-resort title.
 * @stability experimental
 */
export async function documentToNoteBody(
  bytes: Uint8Array,
  mimeType: NoteDocumentMimeType,
  filename: string,
): Promise<DocumentToNoteResult> {
  const fallbackTitle = cleanTitle(titleFromFilename(filename)) ?? 'Imported note';

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    const decoded = decodeTextBytes(bytes);
    const parsed = parseNoteMarkdownExport(decoded.text, { filename });
    if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message };

    return {
      ok: true,
      title: cleanTitle(parsed.note.title) ?? fallbackTitle,
      body: parsed.note.body,
      bodyFormat: parsed.note.bodyFormat,
      pageCount: null,
      encoding: decoded.encoding,
    };
  }

  if (mimeType === 'application/pdf') {
    const outcome = await extractPdfText(bytes);
    if (outcome.outcome === 'unextractable') {
      return { ok: false, reason: outcome.reason, message: describeExtractionFailure(outcome.reason) };
    }
    return {
      ok: true,
      title: fallbackTitle,
      body: outcome.text,
      bodyFormat: 'plain_text',
      pageCount: outcome.pageCount,
      encoding: outcome.encoding,
    };
  }

  let outcome: OoxmlExtractionOutcome;
  let headingPattern: RegExp;
  if (mimeType === DOCX_MIME_TYPE) {
    outcome = extractDocxMarkdown(bytes);
    headingPattern = /^#{1,6}[ \t]+(.+)$/m;
  } else if (mimeType === PPTX_MIME_TYPE) {
    outcome = extractPptxMarkdown(bytes);
    headingPattern = /^## Slide \d+: (.+)$/m;
  } else {
    const exhaustive: never = mimeType;
    throw new Error(`No note reader for document type "${String(exhaustive)}"`);
  }

  if (outcome.outcome === 'unextractable') {
    return { ok: false, reason: outcome.reason, message: describeExtractionFailure(outcome.reason) };
  }

  return {
    ok: true,
    title: cleanTitle(outcome.title) ?? firstHeading(outcome.text, headingPattern) ?? fallbackTitle,
    body: outcome.text,
    bodyFormat: 'markdown',
    pageCount: outcome.pageCount,
    encoding: outcome.encoding,
  };
}
