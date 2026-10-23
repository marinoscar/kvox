import { describe, expect, it } from 'vitest';

import {
  DOCX_MIME_TYPE,
  EXTRACTION_ENCODINGS,
  EXTRACTION_FAILURE_REASONS,
  NOTE_DOCUMENT_MIME_TYPES,
  NOTE_IMPORT_ACCEPT,
  NOTE_IMPORT_EXTENSIONS,
  NOTE_LIBRARY_MAX_MANIFEST_ENTRIES,
  PPTX_MIME_TYPE,
  createNoteLibraryRequestSchema,
  noteImportBatchItemSchema,
  noteImportBatchSchema,
  noteImportMimeTypeForExtension,
  noteLibraryManifestEntrySchema,
  noteLibraryScanRequestSchema,
  noteLibraryScanResponseSchema,
  noteSourceExtractResultSchema,
  normalizeLibraryPath,
  updateNoteLibraryRequestSchema,
} from '../src/notes/index.js';

describe('document and extraction enums', () => {
  it('accepts docx and pptx and keeps the old types first', () => {
    expect(NOTE_DOCUMENT_MIME_TYPES.slice(0, 3)).toEqual(['application/pdf', 'text/plain', 'text/markdown']);
    expect(NOTE_DOCUMENT_MIME_TYPES).toContain(DOCX_MIME_TYPE);
    expect(NOTE_DOCUMENT_MIME_TYPES).toContain(PPTX_MIME_TYPE);
  });

  it('appends the new reasons and encoding', () => {
    expect(EXTRACTION_FAILURE_REASONS.slice(0, 4)).toEqual(['encrypted_pdf', 'no_text_layer', 'corrupt_file', 'empty_document']);
    expect(EXTRACTION_FAILURE_REASONS.slice(4)).toEqual(['unsupported_office_format', 'archive_too_large']);
    expect(EXTRACTION_ENCODINGS.at(-1)).toBe('ooxml');
  });

  it('still validates extract results with the new values', () => {
    expect(
      noteSourceExtractResultSchema.safeParse({ outcome: 'unextractable', text: null, reason: 'archive_too_large', pageCount: null, encoding: null }).success,
    ).toBe(true);
    expect(
      noteSourceExtractResultSchema.safeParse({ outcome: 'extracted', text: 'hi', reason: null, pageCount: 3, encoding: 'ooxml' }).success,
    ).toBe(true);
  });
});

describe('import extensions', () => {
  it('maps every extension to a MIME type and builds the accept string', () => {
    for (const extension of NOTE_IMPORT_EXTENSIONS) {
      expect(noteImportMimeTypeForExtension(extension)).not.toBeNull();
      expect(NOTE_IMPORT_ACCEPT).toContain(`.${extension}`);
    }
    expect(NOTE_IMPORT_ACCEPT).toContain(DOCX_MIME_TYPE);
    expect(noteImportMimeTypeForExtension('.PDF')).toBe('application/pdf');
    expect(noteImportMimeTypeForExtension('exe')).toBeNull();
    expect(noteImportMimeTypeForExtension('constructor')).toBeNull();
  });
});

describe('normalizeLibraryPath', () => {
  it('normalises separators, dots and doubled slashes', () => {
    expect(normalizeLibraryPath('a/b.md')).toBe('a/b.md');
    expect(normalizeLibraryPath('./a\\b\\c.md')).toBe('a/b/c.md');
    expect(normalizeLibraryPath('a//./b.md')).toBe('a/b.md');
  });

  it.each([
    '',
    '/etc/passwd',
    '\\share\\x',
    'C:\\x\\y.md',
    'c:/x.md',
    '../x.md',
    'a/../../x.md',
    'a/..\\b',
    'a\u0000b',
    'a\nb',
    '.',
    './',
    'a'.repeat(1025),
  ])('refuses %j', (raw) => {
    expect(normalizeLibraryPath(raw)).toBeNull();
  });

  it('accepts a path of exactly 1024 characters', () => {
    expect(normalizeLibraryPath('a'.repeat(1024))).toBe('a'.repeat(1024));
  });
});

describe('library schemas', () => {
  it('validates create and update requests', () => {
    expect(createNoteLibraryRequestSchema.safeParse({ name: 'Docs' }).success).toBe(true);
    expect(createNoteLibraryRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createNoteLibraryRequestSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(updateNoteLibraryRequestSchema.safeParse({ autoExtract: true }).success).toBe(true);
    expect(updateNoteLibraryRequestSchema.safeParse({}).success).toBe(false);
  });

  it('validates manifest entries', () => {
    const ok = { path: 'a.md', size: 0, mtime: 1_700_000_000_000 };
    expect(noteLibraryManifestEntrySchema.safeParse(ok).success).toBe(true);
    expect(noteLibraryManifestEntrySchema.safeParse({ ...ok, sha256: 'a'.repeat(64) }).success).toBe(true);
    expect(noteLibraryManifestEntrySchema.safeParse({ ...ok, sha256: 'A'.repeat(64) }).success).toBe(false);
    expect(noteLibraryManifestEntrySchema.safeParse({ ...ok, size: -1 }).success).toBe(false);
    expect(noteLibraryManifestEntrySchema.safeParse({ ...ok, mtime: 1.5 }).success).toBe(false);
  });

  it('defaults a scan to complete and caps the entries', () => {
    const parsed = noteLibraryScanRequestSchema.parse({ entries: [] });
    expect(parsed.complete).toBe(true);
    expect(noteLibraryScanRequestSchema.parse({ entries: [], complete: false }).complete).toBe(false);
    const entry = { path: 'a.md', size: 1, mtime: 1 };
    expect(noteLibraryScanRequestSchema.safeParse({ entries: new Array(NOTE_LIBRARY_MAX_MANIFEST_ENTRIES).fill(entry) }).success).toBe(true);
    expect(noteLibraryScanRequestSchema.safeParse({ entries: new Array(NOTE_LIBRARY_MAX_MANIFEST_ENTRIES + 1).fill(entry) }).success).toBe(false);
  });

  it('validates a scan response with a null batch', () => {
    expect(
      noteLibraryScanResponseSchema.safeParse({
        batchId: null,
        upload: [],
        hashNeeded: [],
        missing: [],
        unchanged: 4,
        estimate: { files: 0, bytes: 0, approxInputTokens: 0 },
      }).success,
    ).toBe(true);
  });

  it('validates batches and items', () => {
    const counts = { queued: 0, importing: 0, imported: 1, failed: 0, missing: 0, skipped: 0 };
    const stageCounts = { uploaded: 0, parsed: 0, indexed: 1, extracting: 0, extracted: 0, in_graph: 0, failed: 0 };
    const batch = { id: 'b1', libraryId: null, status: 'running', createdAt: 'x', finishedAt: null, counts, stageCounts };
    expect(noteImportBatchSchema.safeParse(batch).success).toBe(true);
    expect(noteImportBatchSchema.safeParse({ ...batch, status: 'bogus' }).success).toBe(false);
    expect(noteImportBatchSchema.safeParse({ ...batch, counts: { ...counts, queued: -1 } }).success).toBe(false);

    const item = {
      id: 'i1', filename: 'a.md', path: null, action: 'new', status: 'queued', stage: 'uploaded',
      failureReason: null, failureMessage: null, noteId: null, noteVersion: null, proposalId: null,
      proposalStatus: null, diverged: false, updatedAt: 'x',
    };
    expect(noteImportBatchItemSchema.safeParse(item).success).toBe(true);
    expect(noteImportBatchItemSchema.safeParse({ ...item, stage: 'nope' }).success).toBe(false);
  });
});
