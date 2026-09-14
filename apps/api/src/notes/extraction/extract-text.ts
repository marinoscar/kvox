// =============================================================================
// Plain text and Markdown extraction (issue #51, epic #45)
// =============================================================================
//
// The easy half of extraction, and it is only easy if three things are handled
// rather than assumed:
//
//   1. A BYTE ORDER MARK. Notepad, Excel's CSV export and a great deal of
//      Windows tooling write UTF-8 with a leading `EF BB BF`. `Buffer.toString
//      ('utf8')` decodes it to U+FEFF — an invisible character that survives
//      into the assembled prompt, lands at position 0 of the text, and shows up
//      in a note's first heading as a stray glyph the user cannot delete
//      because it is not in their source file's visible content. The issue
//      names a BOM fixture specifically.
//
//   2. AN ENCODING THAT IS NOT UTF-8. A file exported from an older editor is
//      commonly UTF-16 (with a BOM, so detectable) or Windows-1252 (without
//      one, so detectable only by UTF-8 decoding failing). Decoding either as
//      UTF-8 produces U+FFFD replacement characters — silently, with no error —
//      which reach the model as noise the user pays input tokens for.
//
//   3. LINE ENDINGS. `\r\n` is normalized to `\n` so that the same document
//      uploaded from Windows and from macOS produces the same text, the same
//      token count, and the same budget decision. Nothing else about the
//      content is touched: a Markdown fence, its indentation and its blank
//      lines all survive byte for byte, which is the property the Markdown
//      fixture asserts.
//
// ⚠ PURE. No Nest, no I/O. See `document-format.ts`'s header.
// =============================================================================

import type { ExtractionEncoding, ExtractionOutcome } from './extraction-result';

/** UTF-8 BOM: `EF BB BF`. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** UTF-16 little-endian BOM: `FF FE`. */
const UTF16LE_BOM = [0xff, 0xfe];

/** UTF-16 big-endian BOM: `FE FF`. */
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;

  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Decode `bytes` to a string, reporting which encoding actually worked.
 *
 * THE ORDER IS THE ALGORITHM: an explicit BOM always wins, because it is the
 * file stating its own encoding and no heuristic beats a statement. Only when
 * there is none does this fall back to a STRICT UTF-8 decode — `fatal: true`,
 * which throws rather than substituting U+FFFD — and only when that throws does
 * it treat the file as Windows-1252, the encoding an 8-bit Western text file
 * overwhelmingly is when it is not UTF-8.
 *
 * ⚠ `fatal: true` IS THE WHOLE POINT OF THIS FUNCTION. A non-fatal decode
 * cannot fail, so it can never tell us the guess was wrong — it just produces
 * replacement characters and calls it success.
 */
export function decodeTextBytes(bytes: Uint8Array): {
  text: string;
  encoding: ExtractionEncoding;
} {
  if (startsWith(bytes, UTF8_BOM)) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(UTF8_BOM.length)),
      encoding: 'utf-8-bom',
    };
  }

  if (startsWith(bytes, UTF16LE_BOM)) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(UTF16LE_BOM.length)),
      encoding: 'utf-16le',
    };
  }

  if (startsWith(bytes, UTF16BE_BOM)) {
    // Node's ICU-less builds do not ship a `utf-16be` decoder, and the
    // byte-swap is two lines — cheaper than a dependency and than depending on
    // which ICU a deployment's Node was built with.
    const swapped = Buffer.from(bytes.subarray(UTF16BE_BOM.length));
    swapped.swap16();

    return {
      text: new TextDecoder('utf-16le').decode(swapped),
      encoding: 'utf-16be',
    };
  }

  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
    };
  } catch {
    // Not valid UTF-8. Windows-1252 maps every one of the 256 byte values to a
    // character, so this decode cannot fail in turn — which is exactly why it
    // is the fallback and not the first guess.
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      encoding: 'windows-1252',
    };
  }
}

/**
 * Extract text from an uploaded `.txt` or `.md` file.
 *
 * ⚠ MARKDOWN IS NOT PARSED, RENDERED OR SANITIZED — it is passed through. The
 * model reads Markdown natively, and a fenced code block, a table or an
 * indented list is information about the document's structure that a plain-text
 * conversion would destroy. The issue's Markdown fixture asserts exactly that
 * fences survive intact.
 *
 * A file that is empty, or that holds only whitespace, is `empty_document`
 * rather than an empty success — `NoteSourceService` must never be handed an
 * empty source, because a model given nothing produces a fluent note about
 * nothing and no error anywhere says so.
 */
export function extractPlainText(bytes: Uint8Array): ExtractionOutcome {
  const { text, encoding } = decodeTextBytes(bytes);

  // `\r\n` → `\n`, and a lone `\r` (classic Mac line ending) too. Nothing else
  // is rewritten.
  const normalized = text.replace(/\r\n?/g, '\n');

  if (normalized.trim().length === 0) {
    return { outcome: 'unextractable', reason: 'empty_document', pageCount: null };
  }

  return { outcome: 'extracted', text: normalized, pageCount: null, encoding };
}
