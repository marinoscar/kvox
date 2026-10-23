import { z } from 'zod';

import { DOCX_MIME_TYPE, PPTX_MIME_TYPE } from './document-format.js';

// =============================================================================
// Note libraries: a folder of documents imported as notes (issue #710, epic #708)
// =============================================================================
//
// A "library" is a named set of files a person keeps in a folder (Markdown, text, PDF,
// Word, PowerPoint). The client walks the folder and sends a MANIFEST (path, size, mtime,
// optionally a hash); the server answers which files to upload, which to hash first and
// which are gone; the files then go up as an import batch, one note per file.
//
// WHY THE SERVER NEVER SEES A FOLDER: a browser or Desktop host reads its own disk, the
// server only ever receives a manifest and the bytes it asked for. That keeps the
// protocol identical for the web (File System Access / directory input) and for Desktop.
//
// ⚠ EVERY STRING TUPLE BELOW IS STORED OR SENT OVER THE WIRE: append, never rename.
//
// The `note.library.import` job `type` string is permanent. Job types live in the API
// package (`packages/kvox-api/src/notes/job-types.ts`, `NOTE_LIBRARY_IMPORT_JOB_TYPE`),
// not here; it is mentioned so a reader of the contract can find it.
//
// PURE: no Nest, no Node built-in, loads in the browser.
// =============================================================================

// -----------------------------------------------------------------------------
// What may be imported
// -----------------------------------------------------------------------------

/**
 * The file extensions a library import reads (lower case, no dot).
 *
 * @stability experimental
 */
export const NOTE_IMPORT_EXTENSIONS = ['md', 'markdown', 'txt', 'text', 'pdf', 'docx', 'pptx'] as const;

/** One importable extension. @stability experimental */
export type NoteImportExtension = (typeof NOTE_IMPORT_EXTENSIONS)[number];

const MIME_BY_EXTENSION: Readonly<Record<NoteImportExtension, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  pdf: 'application/pdf',
  docx: DOCX_MIME_TYPE,
  pptx: PPTX_MIME_TYPE,
};

/**
 * The value for an `<input type="file" accept>`: every importable extension with its dot,
 * then the MIME types, so a picker filters by either.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_ACCEPT: string = [
  ...NOTE_IMPORT_EXTENSIONS.map((extension) => `.${extension}`),
  ...Array.from(new Set(Object.values(MIME_BY_EXTENSION))),
].join(',');

/**
 * The media type to send a file with, from its extension.
 *
 * @param extension - with or without the leading dot, any case.
 * @returns the MIME type, or `null` for an extension that cannot be imported.
 * @stability experimental
 */
export function noteImportMimeTypeForExtension(extension: string): string | null {
  const key = extension.replace(/^\./, '').toLowerCase();
  return Object.hasOwn(MIME_BY_EXTENSION, key) ? MIME_BY_EXTENSION[key as NoteImportExtension] : null;
}

// -----------------------------------------------------------------------------
// Statuses (stored or sent over the wire: append only)
// -----------------------------------------------------------------------------

/**
 * Where one file of a library stands.
 *
 * `diverged` means the note made from the file was edited after import and the file
 * has changed since: a re-import would overwrite the edit, so it waits for a decision.
 *
 * @stability experimental
 */
export const NOTE_LIBRARY_FILE_STATUSES = [
  'pending',
  'importing',
  'imported',
  'failed',
  'missing',
  'unsupported',
  'diverged',
] as const;

/** One library file status. @stability experimental */
export type NoteLibraryFileStatus = (typeof NOTE_LIBRARY_FILE_STATUSES)[number];

/**
 * Where an import batch stands.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_BATCH_STATUSES = [
  'scanning',
  'running',
  'completed',
  'completed_with_errors',
  'cancelled',
] as const;

/** One batch status. @stability experimental */
export type NoteImportBatchStatus = (typeof NOTE_IMPORT_BATCH_STATUSES)[number];

/**
 * What a batch item does to the library: add a file, update a changed one, or record
 * that a file vanished.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_ITEM_ACTIONS = ['new', 'changed', 'missing'] as const;

/** One item action. @stability experimental */
export type NoteImportItemAction = (typeof NOTE_IMPORT_ITEM_ACTIONS)[number];

/**
 * Where one batch item stands.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_ITEM_STATUSES = ['queued', 'importing', 'imported', 'failed', 'missing', 'skipped'] as const;

/** One item status. @stability experimental */
export type NoteImportItemStatus = (typeof NOTE_IMPORT_ITEM_STATUSES)[number];

/**
 * How far an item has travelled through the pipeline. DERIVED by the server for the UI
 * (from the item, its note, the search index and the graph proposal); never stored.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_ITEM_STAGES = [
  'uploaded',
  'parsed',
  'indexed',
  'extracting',
  'extracted',
  'in_graph',
  'failed',
] as const;

/** One derived item stage. @stability experimental */
export type NoteImportItemStage = (typeof NOTE_IMPORT_ITEM_STAGES)[number];

// -----------------------------------------------------------------------------
// Manifest paths
// -----------------------------------------------------------------------------

/**
 * The most entries one scan request may carry. A library larger than this is scanned in
 * several partial (`complete: false`) requests.
 *
 * @stability experimental
 */
export const NOTE_LIBRARY_MAX_MANIFEST_ENTRIES = 20000;

/** The longest library-relative path the server keeps, in characters. */
const MAX_LIBRARY_PATH_CHARS = 1024;

/**
 * Normalises a library-relative path the way both ends must agree on it: POSIX separators,
 * no leading `./`. Anything that could escape the library or is not a printable path is
 * refused rather than repaired.
 *
 * Refused (returns `null`): empty, longer than 1024 characters, containing NUL or another
 * control character, absolute (`/x`, `\x`), with a drive letter (`C:\x`), or with a `..`
 * segment. A `.` segment and doubled separators are collapsed.
 *
 * @param raw - the path as the host's file API reports it.
 * @returns the normalised path, or `null` when it must not be accepted.
 * @stability experimental
 */
export function normalizeLibraryPath(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_LIBRARY_PATH_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  const posix = raw.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;

  const segments: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '..') return null;
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }
  if (segments.length === 0) return null;

  const normalized = segments.join('/');
  return normalized.length > MAX_LIBRARY_PATH_CHARS ? null : normalized;
}

// -----------------------------------------------------------------------------
// Wire schemas
// -----------------------------------------------------------------------------

/**
 * A library as listed and returned.
 *
 * @stability experimental
 */
export const noteLibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Extract graph proposals from each imported note automatically. */
  autoExtract: z.boolean(),
  /** Commit those proposals without review. */
  autoCommit: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastScanAt: z.string().nullable(),
  counts: z.object({
    total: z.number().int().min(0),
    imported: z.number().int().min(0),
    failed: z.number().int().min(0),
    missing: z.number().int().min(0),
    diverged: z.number().int().min(0),
    unsupported: z.number().int().min(0),
    pending: z.number().int().min(0),
  }),
});

/** A library. @stability experimental */
export type NoteLibrary = z.infer<typeof noteLibrarySchema>;

/**
 * `POST /notes/libraries` body.
 *
 * @stability experimental
 */
export const createNoteLibraryRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

/** @stability experimental */
export type CreateNoteLibraryRequest = z.infer<typeof createNoteLibraryRequestSchema>;

/**
 * `PATCH /notes/libraries/:id` body: any of the three, at least one.
 *
 * @stability experimental
 */
export const updateNoteLibraryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    autoExtract: z.boolean(),
    autoCommit: z.boolean(),
  })
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one of name, autoExtract or autoCommit is required',
  });

/** @stability experimental */
export type UpdateNoteLibraryRequest = z.infer<typeof updateNoteLibraryRequestSchema>;

/**
 * One file the client found: enough to decide whether it changed, without its bytes.
 *
 * @stability experimental
 */
export const noteLibraryManifestEntrySchema = z.object({
  /** Library-relative path; the server normalises it with {@link normalizeLibraryPath}. */
  path: z.string().min(1).max(MAX_LIBRARY_PATH_CHARS),
  size: z.number().int().min(0),
  /** Last modified time, milliseconds since the epoch. */
  mtime: z.number().int(),
  /** Hex SHA-256 of the content, when the client already computed it. */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** @stability experimental */
export type NoteLibraryManifestEntry = z.infer<typeof noteLibraryManifestEntrySchema>;

/**
 * `POST /notes/libraries/:id/scan` body.
 *
 * `complete: false` marks a partial manifest (a file watcher reporting a few changes, or
 * one chunk of a huge library): nothing absent from it is marked `missing`.
 *
 * @stability experimental
 */
export const noteLibraryScanRequestSchema = z.object({
  entries: z.array(noteLibraryManifestEntrySchema).max(NOTE_LIBRARY_MAX_MANIFEST_ENTRIES),
  complete: z.boolean().default(true),
});

/** @stability experimental */
export type NoteLibraryScanRequest = z.input<typeof noteLibraryScanRequestSchema>;

/**
 * What the server wants after a scan: the paths to upload, the paths whose hash it needs
 * first (size or mtime changed), the paths now missing, and a cost estimate.
 *
 * @stability experimental
 */
export const noteLibraryScanResponseSchema = z.object({
  /** The batch the uploads belong to; `null` when there is nothing to do. */
  batchId: z.string().min(1).nullable(),
  upload: z.array(z.string()),
  hashNeeded: z.array(z.string()),
  missing: z.array(z.string()),
  unchanged: z.number().int().min(0),
  estimate: z.object({
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
    approxInputTokens: z.number().int().min(0),
  }),
});

/** @stability experimental */
export type NoteLibraryScanResponse = z.infer<typeof noteLibraryScanResponseSchema>;

const countsBy = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.object(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0)])) as Record<T[number], z.ZodNumber>);

/**
 * An import batch with per-status and per-stage counts.
 *
 * @stability experimental
 */
export const noteImportBatchSchema = z.object({
  id: z.string().min(1),
  libraryId: z.string().min(1).nullable(),
  status: z.enum(NOTE_IMPORT_BATCH_STATUSES),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: countsBy(NOTE_IMPORT_ITEM_STATUSES),
  stageCounts: countsBy(NOTE_IMPORT_ITEM_STAGES),
});

/** @stability experimental */
export type NoteImportBatch = z.infer<typeof noteImportBatchSchema>;

/**
 * One file of a batch and what became of it.
 *
 * @stability experimental
 */
export const noteImportBatchItemSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  path: z.string().nullable(),
  action: z.enum(NOTE_IMPORT_ITEM_ACTIONS),
  status: z.enum(NOTE_IMPORT_ITEM_STATUSES),
  stage: z.enum(NOTE_IMPORT_ITEM_STAGES),
  failureReason: z.string().nullable(),
  failureMessage: z.string().nullable(),
  noteId: z.string().nullable(),
  noteVersion: z.number().int().nullable(),
  proposalId: z.string().nullable(),
  proposalStatus: z.string().nullable(),
  diverged: z.boolean(),
  updatedAt: z.string(),
});

/** @stability experimental */
export type NoteImportBatchItem = z.infer<typeof noteImportBatchItemSchema>;

/**
 * One page of batch items, cursor-paginated.
 *
 * @stability experimental
 */
export const noteImportBatchItemsPageSchema = z.object({
  items: z.array(noteImportBatchItemSchema),
  nextCursor: z.string().nullable(),
});

/** @stability experimental */
export type NoteImportBatchItemsPage = z.infer<typeof noteImportBatchItemsPageSchema>;

/**
 * `POST /notes/import-batches` answer.
 *
 * @stability experimental
 */
export const createNoteImportBatchResponseSchema = z.object({
  batchId: z.string().min(1),
});

/** @stability experimental */
export type CreateNoteImportBatchResponse = z.infer<typeof createNoteImportBatchResponseSchema>;
