import { inflateRawSync } from 'node:zlib';

// =============================================================================
// Reading text back out of a rendered `.docx` (issue #54)
// =============================================================================
//
// Issue #54's acceptance criterion is that provenance is asserted **against
// extracted text, not file size** — so the DOCX suite has to actually open the
// document it produced. A `.docx` is a ZIP of XML parts, so this is a ~40-line
// ZIP reader plus a tag strip.
//
// ⚠ NODE BUILTINS ONLY, DELIBERATELY. `jszip` happens to be on disk as a
// transitive dependency of `docx`, and reaching for it here would make this
// suite fail confusingly the day that library changes its own dependencies. A
// ZIP's central directory and `inflateRaw` are both in `node:zlib`'s reach.
// =============================================================================

/** End-of-central-directory signature. */
const EOCD = 0x06054b50;
/** Central-directory file-header signature. */
const CENTRAL = 0x02014b50;

/** Every entry's path in a ZIP archive. */
export function zipEntries(archive: Buffer): string[] {
  return [...readEntries(archive).keys()];
}

/** One entry's decompressed bytes, or null when it is not in the archive. */
export function readZipEntry(archive: Buffer, path: string): Buffer | null {
  const entry = readEntries(archive).get(path);

  if (!entry) return null;

  // The local header repeats the name and carries its own extra field, whose
  // length may differ from the central directory's — so the data offset has to
  // be computed from the LOCAL header, never from the central one.
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const body = archive.subarray(start, start + entry.compressedSize);

  return entry.method === 0 ? Buffer.from(body) : inflateRawSync(body);
}

/**
 * The visible text of a `.docx`, one paragraph per line.
 *
 * `<w:t>` runs are the text; `<w:p>` boundaries are the line breaks. Everything
 * else — styles, numbering references, the relationship graph — is markup a
 * reader never sees and an assertion should not depend on.
 */
export function docxText(archive: Buffer, part = 'word/document.xml'): string {
  const xml = readZipEntry(archive, part)?.toString('utf8') ?? '';

  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_match, text: string) => text)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(archive: Buffer): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();

  let eocd = -1;

  // Scan backwards: the comment field at the end is variable length, so the
  // EOCD record's position is not fixed.
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (archive.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }

  if (eocd < 0) return entries;

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL) break;

    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.set(name, { method, compressedSize, localOffset });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
