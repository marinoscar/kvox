import { PassThrough } from 'node:stream';
import { inflateRawSync } from 'node:zlib';

import { extractText, getDocumentProxy } from 'unpdf';

import type { Exporter } from '../../transcripts/index.js';
import { buildNoteExportDocument, type NoteExportDocument } from '../export/note-export-document.js';

// =============================================================================
// Fixtures for the note exporters (issue #54; moved into the slice's testing entry by
// issue #495, epic #491)
// =============================================================================
//
// One note document, one way to collect an exporter's bytes, and a reader for the text of a
// rendered `.docx` and `.pdf`. They are exported so a host's own exporter specs (and a fork's
// new format) assert against the same document and the same extraction the slice's specs use.
// Importing this file needs the optional peer `unpdf`.
// =============================================================================



// =============================================================================
// One note document, and one way to collect an exporter's bytes (issue #54)
// =============================================================================
//
// Shared by the three exporter suites so that "the PDF and the DOCX say the
// same thing" is a claim about the renderers rather than about three slightly
// different fixtures. The body deliberately exercises every block kind the
// subset supports, because the renderers' block switches are where a format
// quietly stops rendering something.
// =============================================================================

/** The Markdown body of the shared export fixture: every block kind the renderers support. */
/**
 * FIXTURE_BODY.
 *
 * @stability experimental
 */
export const FIXTURE_BODY = [
  '# Summary',
  '',
  'The team agreed to **ship** the *export* feature. See `notes.md` and',
  '[the spec](https://example.test/spec).',
  '',
  '## Decisions',
  '',
  '- Ship Markdown, PDF and Word',
  '  - Word is the one a colleague edits',
  '- Defer sharing to a later epic',
  '',
  '1. Draft the API',
  '2. Write the renderers',
  '',
  '> Provenance travels with the export.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '---',
  '',
  'Closing paragraph.',
].join('\n');

/**
 * A realistic meeting note that uses every Markdown feature the web app renders (and the
 * exporters must reflect): headings h1 to h4, bold / italic / strike / inline code, links and an
 * autolink, an aligned 4-column table, a task list, nested ordered and bullet lists, a blockquote,
 * a fenced code block with a language, a rule and a hard line break.
 *
 * @stability experimental
 */
export const RICH_NOTE_BODY = [
  '# Q3 Planning Sync',
  '',
  'Attendees: Ana, Ben and Chen.  ',
  'Notes by **Ana**, reviewed by *Ben*; the ~~old~~ plan was replaced.',
  '',
  '## Agenda',
  '',
  '### Roadmap',
  '',
  '#### Open risks',
  '',
  'Read the [roadmap](https://example.test/roadmap) or <https://example.test/risks>, and run `npm run export` first.',
  '',
  '## Budget',
  '',
  '| Item | Owner | Cost | Status |',
  '| :--- | :---: | ---: | --- |',
  '| Hosting | Ben | 1,200 | approved |',
  '| Licences | Chen | 800 | pending |',
  '| Travel | Ana | 450 | declined |',
  '',
  '## Action items',
  '',
  '- [x] Send the minutes',
  '- [ ] Book the venue',
  '- [ ] Confirm the **budget** with finance',
  '',
  '## Decisions',
  '',
  '1. Ship the export feature',
  '   - PDF first',
  '   - Word second',
  '2. Defer sharing',
  '   1. Revisit in Q4',
  '',
  '> Provenance travels with the export.',
  '',
  '```ts',
  'export const answer: number = 42;',
  '```',
  '',
  '---',
  '',
  'Next sync on Friday.',
].join('\n');

/** The fixture document. Override anything a particular assertion is about. */
/**
 * noteDocument.
 *
 * @stability experimental
 */
export function noteDocument(
  overrides: Partial<NoteExportDocument> = {},
): NoteExportDocument {
  return buildNoteExportDocument({
    noteId: '11111111-1111-4111-8111-111111111111',
    title: 'Weekly Sync Recap',
    body: FIXTURE_BODY,
    version: 3,
    createdAt: new Date('2026-09-12T10:00:00.000Z'),
    exportedAt: new Date('2026-09-14T04:37:11.000Z'),
    author: { displayName: 'Ada Lovelace', email: 'ada@example.test' },
    provider: { id: 'openai', model: 'gpt-4o' },
    templateName: 'Concise Meeting Notes',
    source: {
      type: 'transcript',
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Weekly Sync',
      date: new Date('2026-09-12T09:00:00.000Z'),
    },
    ...overrides,
  });
}

/**
 * Render through an exporter and collect every byte it wrote.
 *
 * ⚠ THE COLLECTOR IS A REAL `Writable`, not a spy. The exporter contract is
 * about a stream — write, end, settle only once the destination has finished —
 * and a mock that recorded calls would let a renderer that never ends `out`
 * pass. A `PassThrough` that is actually drained is the cheapest honest
 * implementation of the other side of that contract.
 *
 * @stability experimental
 */
export async function collect<TDoc>(
  exporter: Exporter<TDoc>,
  doc: TDoc,
  options: Record<string, unknown> = {},
): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];

  out.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  await exporter.render(doc, exporter.optionsSchema.parse(options), out);

  return Buffer.concat(chunks);
}


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
/**
 * zipEntries.
 *
 * @stability experimental
 */
export function zipEntries(archive: Buffer): string[] {
  return [...readEntries(archive).keys()];
}

/** One entry's decompressed bytes, or null when it is not in the archive. */
/**
 * readZipEntry.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
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


/**
 * The text of a rendered PDF, as a reader would see it (issue #54).
 *
 * Issue #54's acceptance criterion is that provenance is asserted **against
 * extracted text, not just file size**, and a PDF's text lives in compressed
 * content streams behind a font encoding — so reading it back needs a real
 * parser rather than a regex over the bytes.
 *
 * `unpdf` is already a dependency of this package (`notes/extraction/extract-pdf.ts`, issue #51), so this costs nothing new. `mergePages` gives
 * one string across the whole document, which is what an assertion about "the
 * footer appears" wants — the page it happens to fall on is not the claim.
 *
 * @stability experimental
 */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });

  return Array.isArray(text) ? text.join('\n') : text;
}
