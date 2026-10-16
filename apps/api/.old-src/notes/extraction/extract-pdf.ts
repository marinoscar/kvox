// =============================================================================
// PDF text extraction (issue #51, epic #45)
// =============================================================================
//
// -----------------------------------------------------------------------------
// WHY `unpdf`
// -----------------------------------------------------------------------------
//
// Nothing already in this repository can read a PDF. `pdfkit` (a transcript
// export dependency, #28) WRITES them and has no reader, so "prefer one already
// in the tree" has no candidate here and one dependency had to be chosen.
//
// `unpdf` (MIT, unjs) is a prebuilt, runtime-agnostic packaging of Mozilla's
// pdf.js with **no runtime dependencies of its own**, ~2 MB unpacked, and both
// ESM and CommonJS entry points — which matters concretely: `apps/api` compiles
// as CommonJS under `module: NodeNext`, and its Jest config has no ESM support,
// so an ESM-only package would have to be reached through a dynamic `import()`
// that ts-jest cannot execute.
//
// REJECTED: `pdf-parse@2`, the obvious first hit. It depends on
// `@napi-rs/canvas` — a NATIVE module with prebuilt binaries per platform —
// which this application does not need (nothing here renders a page to an
// image) and which turns "does the API container build?" into a question about
// the base image's toolchain. The issue asks for no heavy dependency; a native
// canvas binding to read text out of a PDF is precisely that.
//
// REJECTED: `pdfjs-dist` directly. Same engine, 34 MB unpacked, and ESM-only
// since v4 — so it would need the dynamic-import workaround above, in a file
// Jest has to load.
//
// REJECTED: writing a PDF text extractor here. Content streams, FlateDecode,
// font CMaps and ToUnicode maps are a project, not a file, and getting any of
// it subtly wrong produces plausible-looking text that is quietly wrong — which
// then reaches a model and becomes a confident note about something the
// document does not say.
//
// -----------------------------------------------------------------------------
// THE THREE PERMANENT FAILURES ARE DISTINGUISHED BY pdf.js's OWN ERROR NAMES
// -----------------------------------------------------------------------------
//
// `PasswordException` (encrypted), `InvalidPDFException` (corrupt or not a PDF
// at all), and the no-throw-but-no-text case (a scan). All three are recognised
// by the exception's `name` rather than by matching its message, because the
// message is English prose pdf.js is free to reword between releases and the
// class name is its API.
//
// ⚠ PURE. No Nest, no database, no logger — see `document-format.ts`'s header.
// The one impurity is reading bytes it was handed, which is what the job passes
// in.
// =============================================================================

import { extractText, getDocumentProxy } from 'unpdf';

import type { ExtractionOutcome } from './extraction-result';

/** pdf.js's class name for a document that needs a password. */
const PASSWORD_EXCEPTION = 'PasswordException';

/** pdf.js's class name for a file it cannot parse as a PDF. */
const INVALID_PDF_EXCEPTION = 'InvalidPDFException';

/** pdf.js's class name for a document whose bytes end early. */
const MISSING_PDF_EXCEPTION = 'MissingPDFException';

function errorName(error: unknown): string {
  return typeof (error as { name?: unknown } | null)?.name === 'string'
    ? (error as { name: string }).name
    : '';
}

/**
 * Extract the text layer of a PDF.
 *
 * NEVER THROWS FOR A PERMANENT CONDITION — it returns an `unextractable`
 * outcome instead, which is what `note.source.extract` records and what the UI
 * shows. It DOES throw for anything it does not recognise, deliberately: an
 * unrecognised failure is a bug or a transient, and both are worth a retry and
 * worth an operator seeing in the admin job list.
 *
 * ⚠ THE EMPTY-TEXT CASE IS THE SCANNED PAGE, AND IT IS NOT AN ERROR PATH. A
 * PDF produced by a scanner parses perfectly: it has pages, it has images, and
 * it has no text operators at all. pdf.js reports success and an empty string —
 * so "no exception" must not be read as "we got text", which is the single
 * easiest mistake to make in this file. Hence the explicit check, and hence a
 * page count in the failure arm: knowing the document had 12 pages and no text
 * is what makes "only images" a credible sentence rather than a guess.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractionOutcome> {
  let pageCount: number | null = null;

  try {
    // A COPY, not the caller's buffer. pdf.js transfers ownership of the array
    // it is given and detaches it — a caller that went on to hash or re-read
    // the same bytes afterwards would find them gone.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));

    pageCount = pdf.numPages;

    const { text } = await extractText(pdf, { mergePages: true });

    // `mergePages: true` yields one string; the overload below keeps the
    // compiler honest about that without a cast.
    const merged = Array.isArray(text) ? text.join('\n') : text;
    const normalized = merged.replace(/\r\n?/g, '\n').trim();

    if (normalized.length === 0) {
      // See the header: this is the scan, not a failure to parse.
      return { outcome: 'unextractable', reason: 'no_text_layer', pageCount };
    }

    return { outcome: 'extracted', text: normalized, pageCount, encoding: 'pdf-text' };
  } catch (error) {
    const name = errorName(error);

    if (name === PASSWORD_EXCEPTION) {
      return { outcome: 'unextractable', reason: 'encrypted_pdf', pageCount };
    }

    if (name === INVALID_PDF_EXCEPTION || name === MISSING_PDF_EXCEPTION) {
      return { outcome: 'unextractable', reason: 'corrupt_file', pageCount };
    }

    // Unrecognised: a bug, or something transient. Let it retry and let it be
    // visible — see the doc comment.
    throw error;
  }
}
