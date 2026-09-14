// =============================================================================
// The pure extractors, against real fixture files (issue #51, epic #45)
// =============================================================================
//
// NO CONTAINER, NO DATABASE, NO STORAGE PROVIDER — which is the entire reason
// the issue requires `notes/extraction/` to be a pure module. Every case below
// is "these bytes in, this outcome out", so a regression in how a PDF is read
// fails here rather than three layers up in a job whose failure could just as
// easily have been the queue, the bucket or the settings row.
//
// THE FOUR CASES THAT MATTER MOST are the three permanent failures and the
// scanned PDF in particular. They must be DISTINGUISHABLE — an operator and a
// user both need to know which one happened — and the scanned case must say
// that OCR is not supported, because a user told only "extraction failed" will
// try the same file again.
// =============================================================================

import {
  BOM_TEXT_BODY,
  MARKDOWN_BODY,
  PDF_PAGE_ONE,
  PDF_PAGE_THREE,
  PDF_PAGE_TWO,
  bomTextFile,
  corruptPdf,
  encryptedPdf,
  markdownFile,
  multiPagePdf,
  scannedPdf,
} from '../../../test/fixtures/documents.fixture';
import { normalizeDocumentMimeType, acceptedDocumentTypesSentence } from './document-format';
import { extractDocumentText } from './index';
import { decodeTextBytes, extractPlainText } from './extract-text';
import { extractPdfText } from './extract-pdf';
import { describeExtractionFailure } from './extraction-result';

describe('normalizeDocumentMimeType', () => {
  it('accepts the three canonical types', () => {
    expect(normalizeDocumentMimeType('application/pdf')).toBe('application/pdf');
    expect(normalizeDocumentMimeType('text/plain')).toBe('text/plain');
    expect(normalizeDocumentMimeType('text/markdown')).toBe('text/markdown');
  });

  it('tolerates the spellings real clients actually send', () => {
    // Parameters, casing and whitespace all describe an accepted type, and all
    // three would fail a naive equality check.
    expect(normalizeDocumentMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeDocumentMimeType('Application/PDF')).toBe('application/pdf');
    expect(normalizeDocumentMimeType('  text/x-markdown ')).toBe('text/markdown');
  });

  it('refuses "I have no idea what this is" rather than guessing', () => {
    // Guessing from a filename extension is how an executable gets stored as
    // text/plain.
    expect(normalizeDocumentMimeType('application/octet-stream')).toBeNull();
    expect(normalizeDocumentMimeType('image/png')).toBeNull();
    expect(normalizeDocumentMimeType('application/msword')).toBeNull();
    expect(normalizeDocumentMimeType(undefined)).toBeNull();
    expect(normalizeDocumentMimeType('')).toBeNull();
  });

  it('spells the accepted list the way an error message should', () => {
    expect(acceptedDocumentTypesSentence()).toBe(
      'application/pdf, text/plain, text/markdown',
    );
  });
});

describe('decodeTextBytes', () => {
  it('strips a UTF-8 BOM rather than decoding it to an invisible character', () => {
    // U+FEFF survives `Buffer.toString('utf8')` and lands at position 0 of the
    // prompt, where it shows up as a stray glyph in the note's first heading.
    const { text, encoding } = decodeTextBytes(bomTextFile());

    expect(encoding).toBe('utf-8-bom');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).toBe(BOM_TEXT_BODY);
  });

  it('reads UTF-16, both endiannesses, by its BOM', () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Grüße aus München', 'utf16le'),
    ]);
    const beBody = Buffer.from('Grüße aus München', 'utf16le');
    beBody.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);

    expect(decodeTextBytes(le)).toEqual({ text: 'Grüße aus München', encoding: 'utf-16le' });
    expect(decodeTextBytes(be)).toEqual({ text: 'Grüße aus München', encoding: 'utf-16be' });
  });

  it('falls back to windows-1252 rather than producing replacement characters', () => {
    // `0xE9` is a lone continuation byte in UTF-8 and `é` in windows-1252. A
    // non-fatal UTF-8 decode would call this a success and store U+FFFD.
    const bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9]);

    const { text, encoding } = decodeTextBytes(bytes);

    expect(encoding).toBe('windows-1252');
    expect(text).toBe('Café');
    expect(text).not.toContain('�');
  });

  it('reads ordinary UTF-8 as UTF-8', () => {
    expect(decodeTextBytes(Buffer.from('plain ascii', 'utf8'))).toEqual({
      text: 'plain ascii',
      encoding: 'utf-8',
    });
  });
});

describe('extractPlainText', () => {
  it('keeps a Markdown file exactly as written — fences included', () => {
    const outcome = extractPlainText(markdownFile());

    expect(outcome.outcome).toBe('extracted');

    if (outcome.outcome !== 'extracted') return;

    expect(outcome.text).toBe(MARKDOWN_BODY);
    // The fence is the point: it is what tells the model "this block is code".
    expect(outcome.text).toContain('```bash');
    expect(outcome.text).toContain('npm run prisma:migrate');
    expect(outcome.text).toContain('```\n');
    // A table and a blockquote survive too.
    expect(outcome.text).toContain('| Step | Owner |');
    expect(outcome.text).toContain('> Then restart the API.');
  });

  it('has no page count, rather than pretending a text file has one page', () => {
    const outcome = extractPlainText(Buffer.from('one line', 'utf8'));

    expect(outcome.pageCount).toBeNull();
  });

  it('normalizes CRLF so the same document from Windows and macOS is one text', () => {
    const windows = extractPlainText(Buffer.from('one\r\ntwo\r\nthree', 'utf8'));
    const unix = extractPlainText(Buffer.from('one\ntwo\nthree', 'utf8'));

    expect(windows).toEqual(unix);
  });

  it('is `empty_document` for a whitespace-only file, never an empty success', () => {
    // An empty success generates a fluent note about nothing, with no error
    // anywhere saying so.
    expect(extractPlainText(Buffer.from('   \n\t\n ', 'utf8'))).toEqual({
      outcome: 'unextractable',
      reason: 'empty_document',
      pageCount: null,
    });
    expect(extractPlainText(Buffer.alloc(0)).outcome).toBe('unextractable');
  });
});

describe('extractPdfText', () => {
  it('reads every page of a multi-page PDF', async () => {
    const outcome = await extractPdfText(await multiPagePdf());

    expect(outcome.outcome).toBe('extracted');

    if (outcome.outcome !== 'extracted') return;

    expect(outcome.pageCount).toBe(3);
    expect(outcome.encoding).toBe('pdf-text');
    // Every page, not just the first — an extractor that stopped after page one
    // would pass a single-page fixture and silently truncate every real
    // document.
    expect(outcome.text).toContain(PDF_PAGE_ONE);
    expect(outcome.text).toContain(PDF_PAGE_TWO);
    expect(outcome.text).toContain(PDF_PAGE_THREE);
  });

  it('reports an encrypted PDF as `encrypted_pdf`, and does not throw', async () => {
    const outcome = await extractPdfText(await encryptedPdf());

    expect(outcome).toEqual({
      outcome: 'unextractable',
      reason: 'encrypted_pdf',
      pageCount: null,
    });
  });

  it('reports a scanned, image-only PDF as `no_text_layer` WITH its page count', async () => {
    // ⚠ THIS IS THE CASE THAT DOES NOT THROW. pdf.js parses a scan perfectly
    // and returns an empty string, so "no exception" must never be read as "we
    // got text". The page count proves the document really did parse.
    const outcome = await extractPdfText(await scannedPdf());

    expect(outcome).toEqual({
      outcome: 'unextractable',
      reason: 'no_text_layer',
      pageCount: 2,
    });
  });

  it('reports a corrupt file as `corrupt_file`', async () => {
    const outcome = await extractPdfText(corruptPdf());

    expect(outcome).toEqual({
      outcome: 'unextractable',
      reason: 'corrupt_file',
      pageCount: null,
    });
  });

  it('does not detach the caller\'s buffer', async () => {
    // pdf.js takes ownership of the array it is handed. A caller that went on
    // to hash or re-read the same bytes would find them gone.
    const bytes = new Uint8Array(await multiPagePdf());
    const before = bytes.byteLength;

    await extractPdfText(bytes);

    expect(bytes.byteLength).toBe(before);
  });
});

describe('the three permanent failures are distinct and user-readable', () => {
  it('gives each reason its own sentence', () => {
    const sentences = (
      ['encrypted_pdf', 'no_text_layer', 'corrupt_file', 'empty_document'] as const
    ).map(describeExtractionFailure);

    expect(new Set(sentences).size).toBe(sentences.length);

    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(30);
      // Written for the person who uploaded the file, not for a log reader.
      expect(sentence).not.toMatch(/extraction failed/i);
    }
  });

  it('names images and states that OCR is not supported for a scan', () => {
    const sentence = describeExtractionFailure('no_text_layer');

    expect(sentence).toMatch(/images/i);
    expect(sentence).toMatch(/OCR/);
    expect(sentence).toMatch(/not supported/i);
  });

  it('tells the user what to do about a password', () => {
    expect(describeExtractionFailure('encrypted_pdf')).toMatch(/password/i);
  });
});

describe('extractDocumentText', () => {
  it('dispatches on the canonical MIME type', async () => {
    const pdf = await extractDocumentText(await multiPagePdf(), 'application/pdf');
    const md = await extractDocumentText(markdownFile(), 'text/markdown');
    const txt = await extractDocumentText(bomTextFile(), 'text/plain');

    expect(pdf.outcome).toBe('extracted');
    expect(md.outcome).toBe('extracted');
    expect(txt.outcome).toBe('extracted');
    expect(pdf.pageCount).toBe(3);
    expect(md.pageCount).toBeNull();
  });
});
