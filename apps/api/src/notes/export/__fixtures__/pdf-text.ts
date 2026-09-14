import { extractText, getDocumentProxy } from 'unpdf';

/**
 * The text of a rendered PDF, as a reader would see it (issue #54).
 *
 * Issue #54's acceptance criterion is that provenance is asserted **against
 * extracted text, not just file size**, and a PDF's text lives in compressed
 * content streams behind a font encoding — so reading it back needs a real
 * parser rather than a regex over the bytes.
 *
 * `unpdf` is already a dependency of this package (`notes/extraction/
 * extract-pdf.ts`, issue #51), so this costs nothing new. `mergePages` gives
 * one string across the whole document, which is what an assertion about "the
 * footer appears" wants — the page it happens to fall on is not the claim.
 */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });

  return Array.isArray(text) ? text.join('\n') : text;
}
