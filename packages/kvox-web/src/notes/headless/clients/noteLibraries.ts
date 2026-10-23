/**
 * The note libraries API, as the web app sees it: issue #720 (epic #708).
 *
 * A library is a folder of the user's own documents (Markdown, text, PDF, Word,
 * PowerPoint) imported as notes. The server never sees the folder: the client
 * walks it (`KvoxFileAccessPort`), sends a manifest to
 * `POST /notes/libraries/:id/scan`, and uploads only what the answer asks for,
 * one multipart request per file, into an import batch. The wire shapes are the
 * contract's (`@marinoscar/kvox-contract/notes`, `note-library.ts`).
 *
 * Every route is owner-only: another user's library or batch answers 404.
 *
 * WHY THE ANSWERS ARE PARSED LENIENTLY: the contract's schemas are applied with
 * `safeParse` and a failure falls back to the raw payload. A newer server may add
 * a status or a stage this build does not know; a strict parse would turn that
 * into a broken page, which is worse than a row the UI labels generically.
 */

import {
  createNoteImportBatchResponseSchema,
  noteImportBatchItemsPageSchema,
  noteImportBatchSchema,
  noteLibraryScanResponseSchema,
  noteLibrarySchema,
} from '@marinoscar/kvox-contract/notes';
import type {
  NoteImportBatch,
  NoteImportBatchItem,
  NoteImportBatchItemsPage,
  NoteImportItemAction,
  NoteImportItemStatus,
  NoteLibrary,
  NoteLibraryManifestEntry,
  NoteLibraryScanResponse,
  UpdateNoteLibraryRequest,
} from '@marinoscar/kvox-contract/notes';

import {
  kvoxDelete,
  kvoxGet,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
} from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

export type {
  NoteImportBatch,
  NoteImportBatchItem,
  NoteImportBatchItemsPage,
  NoteImportBatchStatus,
  NoteImportItemAction,
  NoteImportItemStage,
  NoteImportItemStatus,
  NoteLibrary,
  NoteLibraryManifestEntry,
  NoteLibraryScanResponse,
  UpdateNoteLibraryRequest,
} from '@marinoscar/kvox-contract/notes';

/** A schema's `safeParse`, as far as this file needs it. */
interface LenientSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function lenient<T>(schema: LenientSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : (value as T);
}

const enc = encodeURIComponent;

// =============================================================================
// Libraries
// =============================================================================

/**
 * `POST /notes/libraries`: a new, empty library.
 *
 * @param host - The host.
 * @param name - The library's name (1 to 120 characters).
 * @returns The library.
 *
 * @stability experimental
 */
export async function createNoteLibrary(host: KvoxWebHost, name: string): Promise<NoteLibrary> {
  return lenient(noteLibrarySchema, await kvoxPost<unknown>(host, '/notes/libraries', { name }));
}

/**
 * `GET /notes/libraries`: the caller's libraries, newest first.
 *
 * @param host - The host.
 * @returns The libraries.
 *
 * @stability experimental
 */
export async function listNoteLibraries(host: KvoxWebHost): Promise<NoteLibrary[]> {
  const page = await kvoxGet<{ items?: unknown }>(host, '/notes/libraries');
  const items = Array.isArray(page?.items) ? page.items : [];
  return items.map((item) => lenient(noteLibrarySchema, item));
}

/**
 * `GET /notes/libraries/:id`.
 *
 * @param host - The host.
 * @param id - The library.
 * @returns The library.
 * @throws `KvoxApiError` 404 when it does not exist or is not the caller's.
 *
 * @stability experimental
 */
export async function getNoteLibrary(host: KvoxWebHost, id: string): Promise<NoteLibrary> {
  return lenient(noteLibrarySchema, await kvoxGet<unknown>(host, `/notes/libraries/${enc(id)}`));
}

/**
 * `PATCH /notes/libraries/:id`: rename it, or change its extraction policy.
 *
 * @param host - The host.
 * @param id - The library.
 * @param patch - Any of `name`, `autoExtract`, `autoCommit`.
 * @returns The library.
 *
 * @stability experimental
 */
export async function updateNoteLibrary(
  host: KvoxWebHost,
  id: string,
  patch: UpdateNoteLibraryRequest,
): Promise<NoteLibrary> {
  return lenient(noteLibrarySchema, await kvoxPatch<unknown>(host, `/notes/libraries/${enc(id)}`, patch));
}

/**
 * `DELETE /notes/libraries/:id`. The notes made from its files are kept.
 *
 * @param host - The host.
 * @param id - The library.
 *
 * @stability experimental
 */
export async function deleteNoteLibrary(host: KvoxWebHost, id: string): Promise<void> {
  await kvoxDelete(host, `/notes/libraries/${enc(id)}`);
}

/**
 * `POST /notes/libraries/:id/scan`: diff a manifest against what the library holds.
 *
 * @param host - The host.
 * @param id - The library.
 * @param entries - What the client found (at most `NOTE_LIBRARY_MAX_MANIFEST_ENTRIES`).
 * @param complete - `false` for a partial manifest, which never marks a file missing.
 * @param signal - Aborts the request.
 * @returns What to upload, what to hash first, what is missing, and an estimate.
 *
 * @stability experimental
 */
export async function scanNoteLibrary(
  host: KvoxWebHost,
  id: string,
  entries: readonly NoteLibraryManifestEntry[],
  complete: boolean,
  signal?: AbortSignal,
): Promise<NoteLibraryScanResponse> {
  const answer = await kvoxPost<unknown>(
    host,
    `/notes/libraries/${enc(id)}/scan`,
    { entries, complete },
    signal ? { signal } : undefined,
  );
  return lenient(noteLibraryScanResponseSchema, answer);
}

// =============================================================================
// Import batches
// =============================================================================

/**
 * `POST /notes/import-batches`: an ad-hoc batch, for files that belong to no library.
 *
 * @param host - The host.
 * @returns The new batch's id.
 *
 * @stability experimental
 */
export async function createNoteImportBatch(host: KvoxWebHost): Promise<string> {
  const answer = lenient(createNoteImportBatchResponseSchema, await kvoxPost<unknown>(host, '/notes/import-batches'));
  return answer.batchId;
}

/**
 * Filters of {@link listNoteImportBatches}.
 *
 * @stability experimental
 */
export interface ListNoteImportBatchesOptions {
  /** Only the batches of this library. */
  libraryId?: string;
  /** At most this many (1 to 200; the server's default is 20). */
  limit?: number;
}

/**
 * `GET /notes/import-batches`: the caller's recent batches, newest first.
 *
 * @param host - The host.
 * @param options - Library and limit.
 * @returns The batches with their counts.
 *
 * @stability experimental
 */
export async function listNoteImportBatches(
  host: KvoxWebHost,
  options: ListNoteImportBatchesOptions = {},
): Promise<NoteImportBatch[]> {
  const page = await kvoxGet<{ items?: unknown }>(host, '/notes/import-batches', {
    query: { libraryId: options.libraryId, limit: options.limit },
  });
  const items = Array.isArray(page?.items) ? page.items : [];
  return items.map((item) => lenient(noteImportBatchSchema, item));
}

/**
 * `GET /notes/import-batches/:id`: the batch with its counts by item status and by stage.
 *
 * @param host - The host.
 * @param id - The batch.
 * @returns The batch.
 *
 * @stability experimental
 */
export async function getNoteImportBatch(host: KvoxWebHost, id: string): Promise<NoteImportBatch> {
  return lenient(noteImportBatchSchema, await kvoxGet<unknown>(host, `/notes/import-batches/${enc(id)}`));
}

/**
 * Filters and paging of {@link listNoteImportBatchItems}.
 *
 * @stability experimental
 */
export interface ListNoteImportBatchItemsOptions {
  /** Only the items in this status. */
  status?: NoteImportItemStatus;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** At most this many (1 to 200; the server's default is 50). */
  limit?: number;
}

/**
 * `GET /notes/import-batches/:id/items`: one page of items, oldest first.
 *
 * @param host - The host.
 * @param id - The batch.
 * @param options - Status filter, cursor and page size.
 * @returns The page and the cursor of the next one (`null` at the end).
 *
 * @stability experimental
 */
export async function listNoteImportBatchItems(
  host: KvoxWebHost,
  id: string,
  options: ListNoteImportBatchItemsOptions = {},
): Promise<NoteImportBatchItemsPage> {
  const answer = await kvoxGet<unknown>(host, `/notes/import-batches/${enc(id)}/items`, {
    query: { status: options.status, cursor: options.cursor, limit: options.limit },
  });
  const page = lenient(noteImportBatchItemsPageSchema, answer);
  return {
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null,
  };
}

/**
 * One file to upload into a batch.
 *
 * @stability experimental
 */
export interface NoteImportUploadFile {
  /** The bytes. */
  body: Blob;
  /** The file name the server stores (the path's last segment). */
  filename: string;
  /** The library-relative path; omit for an ad-hoc file (the server uses the file name). */
  path?: string;
  /** Last modified time, milliseconds since the epoch. */
  mtime?: number;
}

/**
 * The answer of {@link uploadNoteImportFile}.
 *
 * @stability experimental
 */
export interface NoteImportUploadResult {
  /** The batch item the file became. */
  itemId: string;
  /** Whether the file is new to the library or a changed one. */
  action: NoteImportItemAction;
  /** The library already imported exactly these bytes: nothing was queued. */
  skipped: boolean;
}

/**
 * `POST /notes/import-batches/:id/files`: one file, multipart (`path`, `mtime`, then `file`).
 *
 * @param host - The host.
 * @param batchId - The batch.
 * @param file - The bytes, name, path and mtime.
 * @param signal - Aborts the upload.
 * @returns The item and whether it was skipped.
 * @throws `KvoxApiError` 413 over the size limit; 400 with `details.reason` for an
 *   unsupported or invalid file; 409 when the batch was cancelled.
 *
 * @stability experimental
 */
export async function uploadNoteImportFile(
  host: KvoxWebHost,
  batchId: string,
  file: NoteImportUploadFile,
  signal?: AbortSignal,
): Promise<NoteImportUploadResult> {
  const form = new FormData();
  // Fields BEFORE the file: a streaming multipart reader sees them first.
  if (file.path !== undefined) form.append('path', file.path);
  if (file.mtime !== undefined) form.append('mtime', String(Math.trunc(file.mtime)));
  form.append('file', file.body, file.filename);
  return kvoxPostFormData<NoteImportUploadResult>(
    host,
    `/notes/import-batches/${enc(batchId)}/files`,
    form,
    signal ? { signal } : undefined,
  );
}

/**
 * `POST /notes/import-batches/:id/retry`: re-queue the failed items.
 *
 * @param host - The host.
 * @param batchId - The batch.
 * @returns How many items were re-queued.
 *
 * @stability experimental
 */
export async function retryNoteImportBatch(host: KvoxWebHost, batchId: string): Promise<number> {
  const answer = await kvoxPost<{ requeued?: unknown }>(host, `/notes/import-batches/${enc(batchId)}/retry`);
  return typeof answer?.requeued === 'number' ? answer.requeued : 0;
}

/**
 * `POST /notes/import-batches/:id/retry-extractions`: re-run graph extraction for the
 * items whose extraction failed. A server without the route answers 404; the batch
 * page then hides the action.
 *
 * @param host - The host.
 * @param batchId - The batch.
 * @returns How many extractions were re-queued.
 *
 * @stability experimental
 */
export async function retryNoteImportBatchExtractions(host: KvoxWebHost, batchId: string): Promise<number> {
  const answer = await kvoxPost<{ requeued?: unknown }>(
    host,
    `/notes/import-batches/${enc(batchId)}/retry-extractions`,
  );
  return typeof answer?.requeued === 'number' ? answer.requeued : 0;
}
