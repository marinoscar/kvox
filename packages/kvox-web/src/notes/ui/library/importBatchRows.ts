/**
 * The rows of a batch page that holds hundreds of files (issue #814, epic #811): the
 * server's items merged with this tab's uploads (files not yet items), and the filter,
 * search, sort, CSV and throughput helpers the page uses. Pure: no React.
 */

import { describeNoteImportFailure, noteImportKindOf } from '../../headless/index.js';
import type {
  BatchUpload,
  BatchUploadFile,
  NoteImportBatchItem,
  NoteImportItemStatus,
  NoteImportKind,
} from '../../headless/index.js';
import { importStageLabel } from '../components/ImportBatchItemList.js';

/**
 * The colour family of a row's stage chip.
 *
 * @stability experimental
 */
export type ImportBatchRowTone = 'default' | 'primary' | 'info' | 'success' | 'warning' | 'error';

/**
 * The filter key of a row: a server item status, or an upload state of a file that is
 * not an item yet.
 *
 * @stability experimental
 */
export type ImportBatchRowFilter = NoteImportItemStatus | 'uploading' | 'upload_failed';

/**
 * One file of a batch page.
 *
 * @stability experimental
 */
export interface ImportBatchRow {
  /** A stable key. */
  key: string;
  /** The full path. */
  path: string;
  /** The folder part of the path (`''` for none), drawn dimmed. */
  folder: string;
  /** The file name. */
  name: string;
  /** Its kind, from the extension. */
  kind: NoteImportKind | null;
  /** Its size in bytes, when this tab uploaded it. */
  size: number | null;
  /** The stage words. */
  stageLabel: string;
  /** The stage chip's colour. */
  tone: ImportBatchRowTone;
  /** Where the stage sits in the pipeline, for sorting. */
  stageOrder: number;
  /** What the status chips filter on. */
  filter: ImportBatchRowFilter;
  /** A sentence when the file failed. */
  error: string | null;
  /** The machine reason of a failure. */
  errorReason: string | null;
  /** Last change, epoch milliseconds (the server's `updatedAt`). */
  updatedAt: number | null;
  /** The server item, once there is one. */
  item: NoteImportBatchItem | null;
  /** This tab's upload of the file, when there is one. */
  upload: BatchUploadFile | null;
}

function splitPath(path: string): { folder: string; name: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { folder: '', name: path } : { folder: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** Pipeline order: uploads first, then the server's stages, failures last. */
const ORDER = {
  upload_queued: 0,
  uploading: 1,
  uploaded: 2,
  queued: 3,
  importing: 4,
  parsed: 5,
  formatting: 6,
  indexed: 7,
  extracting: 8,
  extracted: 9,
  in_graph: 10,
  skipped: 11,
  missing: 12,
  upload_cancelled: 13,
  failed: 14,
} as const;

function rowOfUpload(file: BatchUploadFile): ImportBatchRow {
  const { folder, name } = splitPath(file.path);
  const base = {
    key: `upload:${file.path}`,
    path: file.path,
    folder,
    name,
    kind: file.kind ?? noteImportKindOf(file.name),
    size: file.size,
    error: null as string | null,
    errorReason: null as string | null,
    updatedAt: null,
    item: null,
    upload: file,
  };
  switch (file.state) {
    case 'queued':
      return { ...base, stageLabel: 'Waiting to upload', tone: 'default', stageOrder: ORDER.upload_queued, filter: 'uploading' };
    case 'uploading':
      return { ...base, stageLabel: 'Uploading', tone: 'info', stageOrder: ORDER.uploading, filter: 'uploading' };
    case 'uploaded':
      return { ...base, stageLabel: 'Uploaded', tone: 'default', stageOrder: ORDER.uploaded, filter: 'queued' };
    case 'skipped':
      return { ...base, stageLabel: 'Unchanged, skipped', tone: 'default', stageOrder: ORDER.skipped, filter: 'skipped' };
    case 'cancelled':
      return {
        ...base,
        stageLabel: 'Not uploaded',
        tone: 'default',
        stageOrder: ORDER.upload_cancelled,
        filter: 'upload_failed',
      };
    case 'failed':
    default:
      return {
        ...base,
        stageLabel: 'Upload failed',
        tone: 'error',
        stageOrder: ORDER.failed,
        filter: 'upload_failed',
        error: file.message ?? 'The upload failed.',
        errorReason: file.reason ?? null,
      };
  }
}

function rowOfItem(item: NoteImportBatchItem, upload: BatchUploadFile | undefined): ImportBatchRow {
  const path = item.path ?? item.filename;
  const { folder, name } = splitPath(path);
  const updated = Date.parse(item.updatedAt);
  const base = {
    key: `item:${item.id}`,
    path,
    folder,
    name: name || item.filename,
    kind: noteImportKindOf(item.filename) ?? noteImportKindOf(path),
    size: upload?.size ?? null,
    error: null as string | null,
    errorReason: null as string | null,
    updatedAt: Number.isFinite(updated) ? updated : null,
    item,
    upload: upload ?? null,
    filter: item.status as ImportBatchRowFilter,
  };
  if (item.status === 'missing') return { ...base, stageLabel: 'No longer in the folder', tone: 'warning', stageOrder: ORDER.missing };
  if (item.status === 'skipped') return { ...base, stageLabel: 'Unchanged, skipped', tone: 'default', stageOrder: ORDER.skipped };
  if (item.status === 'queued') return { ...base, stageLabel: 'Queued', tone: 'default', stageOrder: ORDER.queued };
  if (item.status === 'importing') return { ...base, stageLabel: 'Importing', tone: 'info', stageOrder: ORDER.importing };
  if (item.status === 'failed' || item.stage === 'failed') {
    const reason = item.failureReason ?? 'internal_error';
    return {
      ...base,
      stageLabel: 'Failed',
      tone: 'error',
      stageOrder: ORDER.failed,
      error: describeNoteImportFailure(reason),
      errorReason: reason,
    };
  }
  const stage = item.stage;
  const tone: ImportBatchRowTone =
    stage === 'in_graph' ? 'success' : stage === 'extracted' ? 'warning' : stage === 'extracting' || stage === 'formatting' ? 'info' : 'primary';
  return {
    ...base,
    stageLabel: importStageLabel(stage),
    tone,
    stageOrder: (ORDER as Record<string, number>)[stage] ?? ORDER.parsed,
  };
}

/**
 * Merges the server's items with this tab's upload of the batch: every item is a row
 * (with its upload's size when there is one), and every uploaded file that is not an item
 * yet is a row of its own, matched by path.
 *
 * @param items - The server's items.
 * @param upload - This tab's upload of the batch, or `null`.
 * @returns The rows: items in their order, then the files still uploading.
 *
 * @stability experimental
 */
export function buildImportBatchRows(
  items: readonly NoteImportBatchItem[],
  upload: BatchUpload | null,
): ImportBatchRow[] {
  const byPath = new Map<string, BatchUploadFile>();
  for (const file of upload?.files ?? []) byPath.set(file.path, file);
  const seen = new Set<string>();
  const rows = items.map((item) => {
    const path = item.path ?? item.filename;
    seen.add(path);
    return rowOfItem(item, byPath.get(path));
  });
  for (const file of upload?.files ?? []) {
    if (!seen.has(file.path)) rows.push(rowOfUpload(file));
  }
  return rows;
}

/**
 * How the rows sort.
 *
 * @stability experimental
 */
export type ImportBatchRowSort = 'name' | 'stage' | 'updated';

/**
 * Filters rows by status chip and by a file-name search (case-insensitive, on the path).
 *
 * @param rows - The rows.
 * @param filter - The chip, or `undefined` for all.
 * @param query - The search.
 * @returns The rows that match.
 *
 * @stability experimental
 */
export function filterImportBatchRows(
  rows: readonly ImportBatchRow[],
  filter: ImportBatchRowFilter | undefined,
  query: string,
): ImportBatchRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) => (filter === undefined || row.filter === filter) && (needle === '' || row.path.toLowerCase().includes(needle)),
  );
}

/**
 * Sorts rows: by path, by pipeline stage (then path), or most recently changed first.
 *
 * @param rows - The rows.
 * @param sort - The order.
 * @returns A sorted copy.
 *
 * @stability experimental
 */
export function sortImportBatchRows(rows: readonly ImportBatchRow[], sort: ImportBatchRowSort): ImportBatchRow[] {
  const byPath = (a: ImportBatchRow, b: ImportBatchRow) => a.path.localeCompare(b.path, undefined, { numeric: true });
  const copy = rows.slice();
  if (sort === 'name') return copy.sort(byPath);
  if (sort === 'stage') return copy.sort((a, b) => a.stageOrder - b.stageOrder || byPath(a, b));
  return copy.sort((a, b) => (b.updatedAt ?? Infinity) - (a.updatedAt ?? Infinity) || byPath(a, b));
}

function csvCell(value: string): string {
  // A leading = + - @ would be read as a formula by a spreadsheet.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The failed rows as CSV: path, stage, reason, message.
 *
 * @param rows - The rows.
 * @returns The CSV text (header included), or `null` when nothing failed.
 *
 * @stability experimental
 */
export function importBatchFailuresCsv(rows: readonly ImportBatchRow[]): string | null {
  const failed = rows.filter((row) => row.error !== null);
  if (failed.length === 0) return null;
  const lines = [['path', 'stage', 'reason', 'message'].join(',')];
  for (const row of failed) {
    lines.push([row.path, row.stageLabel, row.errorReason ?? '', row.error ?? ''].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * One reading of how many files were finished at a moment.
 *
 * @stability experimental
 */
export interface ImportThroughputSample {
  /** Epoch milliseconds. */
  at: number;
  /** Files finished by then. */
  finished: number;
}

/**
 * Files per minute and the time left, from readings of the finished count over time.
 *
 * @param samples - Readings, oldest first.
 * @param remaining - Files not finished yet.
 * @param windowMs - Only readings this recent count. Default two minutes.
 * @returns The rate (files per minute) and the time left in milliseconds, each `null`
 *   until there is enough to say.
 *
 * @stability experimental
 */
export function importThroughput(
  samples: readonly ImportThroughputSample[],
  remaining: number,
  windowMs = 120_000,
): {
  /** Files finished per minute over the window; `null` before two samples. */
  perMinute: number | null;
  /** Time left at that rate, in milliseconds; `null` when unknown. */
  etaMs: number | null;
} {
  if (samples.length < 2) return { perMinute: null, etaMs: null };
  const last = samples[samples.length - 1]!;
  const first = samples.find((sample) => last.at - sample.at <= windowMs) ?? samples[0]!;
  const elapsed = last.at - first.at;
  const done = last.finished - first.finished;
  if (elapsed < 5_000 || done <= 0) return { perMinute: null, etaMs: null };
  const perMs = done / elapsed;
  return { perMinute: perMs * 60_000, etaMs: remaining > 0 ? remaining / perMs : 0 };
}

/**
 * A duration for a person: `under a minute`, `about 4 min`, `about 1 h 20 min`.
 *
 * @param ms - The duration.
 * @returns The phrase.
 *
 * @stability experimental
 */
export function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}
