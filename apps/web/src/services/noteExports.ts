/**
 * The note export API, as the web app sees it — issue #58, epic #45.
 *
 * The sibling of `services/transcriptExports.ts` (#28), deliberately a SECOND
 * module rather than a generic one shared with it: the two APIs are different
 * routes returning different shapes (a note export polls a LIST, a transcript
 * export polls one row by id), and a single "exports service" parameterised
 * over both would be an abstraction whose only content is an `if`.
 *
 * =============================================================================
 * ⚠ THE FORMATS COME FROM THE SERVER. NOTHING HERE MAY NAME ONE.
 * =============================================================================
 *
 * `GET /api/notes/exporters` publishes every registered format WITH its option
 * list — key, label, description, type, default — and the dialog renders
 * whatever comes back. There is no `'markdown' | 'pdf' | 'docx'` union in this
 * file and there must never be one: the API's promise that "adding a format
 * costs one class" (`note-exporter.registry.ts`) is only true if the client
 * has stopped needing to know the formats. `format` is a plain `string` for
 * exactly that reason, and a `MARKDOWN_OPTIONS` constant here would be a second
 * copy of a list the server already owns — which would offer a checkbox the API
 * rejects the first time the two disagreed.
 *
 * =============================================================================
 * TWO SUCCESS CODES, ONE FIELD, AND WHY THE REUSE MUST NOT LOOK BROKEN
 * =============================================================================
 *
 * `POST /api/notes/{id}/exports` answers **202** for a queued render and **200**
 * for one that already exists — the content-addressed reuse #54 built. A
 * wrapper that unwraps `{ data }` cannot see the status line, so the API also
 * publishes `reused` on the body and this module reads that.
 *
 * It matters to the interface, not just to the wire: a reused export is already
 * `ready`, so {@link isSettled} is true on the first answer and the dialog must
 * offer the download immediately rather than entering a poll loop that has
 * nothing to wait for. An instant result that still spun for two seconds would
 * read as a stall on the one path that is supposed to be free.
 *
 * =============================================================================
 * POLLING READS THE LIST, BECAUSE THERE IS NO READ-ONE ROUTE
 * =============================================================================
 *
 * The notes API has `GET /api/notes/{id}/exports` and no
 * `GET /api/notes/{id}/exports/{exportId}` — an export list is short (seven
 * days of one note's exports) and a route per row would be a second way to ask
 * a question the list already answers. {@link getNoteExport} is therefore a
 * find over the list, and it returns `null` for an id the list no longer
 * carries (an expiry mid-poll) rather than throwing, so the dialog can say
 * "gone" instead of "failed".
 */

import { api } from './api';

// =============================================================================
// Types — mirrors of `apps/api/src/notes/dto/note-export.dto.ts`
// =============================================================================

/** `NOTE_EXPORT_STATUSES` on the API side. */
export const NOTE_EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;

export type NoteExportStatus = (typeof NOTE_EXPORT_STATUSES)[number];

/**
 * One option an exporter accepts.
 *
 * `type` is a union of one today and is READ rather than assumed by the dialog,
 * so the day a `select` or a `number` is published the renderer has somewhere to
 * branch instead of drawing a checkbox for a value that is not a boolean.
 */
export interface NoteExportOptionField {
  key: string;
  label: string;
  description: string;
  type: 'boolean';
  default: boolean;
}

/** One available format, as `GET /api/notes/exporters` publishes it. */
export interface NoteExporter {
  format: string;
  label: string;
  mimeType: string;
  extension: string;
  options: NoteExportOptionField[];
}

/** An export, at whatever stage it has reached. */
export interface NoteExport {
  id: string;
  noteId: string;
  version: number;
  format: string;
  options: Record<string, unknown>;
  status: NoteExportStatus;
  /** True when this response returned an export that already existed. */
  reused: boolean;
  mimeType: string;
  filename: string;
  /** A decimal string, or null until the render finishes. */
  sizeBytes: string | null;
  error: string | null;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** The body of `POST /api/notes/{id}/exports`. */
export interface CreateNoteExportRequest {
  format: string;
  /** Omit for the note's current version. */
  version?: number;
  /** Only keys the chosen format declares — an unknown one is a 400. */
  options?: Record<string, boolean>;
}

// =============================================================================
// Calls
// =============================================================================

/** Every registered format, with the options the dialog renders. */
export async function getNoteExporters(): Promise<NoteExporter[]> {
  const response = await api.get<{ exporters: NoteExporter[] }>('/notes/exporters');

  return response.exporters;
}

/** Queue a render, or receive the identical one that already exists. */
export async function createNoteExport(
  noteId: string,
  body: CreateNoteExportRequest,
): Promise<NoteExport> {
  return api.post<NoteExport>(`/notes/${encodeURIComponent(noteId)}/exports`, body);
}

/** Every unexpired export of one note, newest first. */
export async function listNoteExports(noteId: string): Promise<NoteExport[]> {
  const response = await api.get<{ exports: NoteExport[] }>(
    `/notes/${encodeURIComponent(noteId)}/exports`,
  );

  return response.exports;
}

/**
 * One export's current state, or `null` if the list no longer carries it.
 *
 * A find over the list — see the file header for why there is no read-one
 * route, and why "gone" is a real answer rather than an error.
 */
export async function getNoteExport(
  noteId: string,
  exportId: string,
): Promise<NoteExport | null> {
  const rows = await listNoteExports(noteId);

  return rows.find((row) => row.id === exportId) ?? null;
}

// =============================================================================
// Shared helpers
// =============================================================================

/**
 * How often the dialog asks again while an export is `pending`.
 *
 * Two seconds, and a flat interval rather than a backoff, for the reason
 * `transcriptExports.ts` states: an export is one render of a document that
 * already exists in the database, and somebody is watching a spinner for the
 * whole of it, so the long unwatched wait a backoff optimises for is not this.
 */
export const NOTE_EXPORT_POLL_INTERVAL_MS = 2_000;

/**
 * How long the dialog keeps polling before saying so.
 *
 * ⚠ GIVING UP IS NOT A CANCELLATION. The render continues server-side and the
 * identical request afterwards REUSES it rather than rendering twice — which is
 * exactly what the content-addressed lookup is for — so the dialog says "still
 * rendering, ask again" rather than "failed".
 */
export const NOTE_EXPORT_POLL_TIMEOUT_MS = 6 * 60 * 1_000;

/** Whether an export has finished, either way. */
export function isSettled(row: Pick<NoteExport, 'status'>): boolean {
  return row.status !== 'pending';
}

/**
 * Apply an exporter's defaults, so the form starts where the server would.
 *
 * The dialog sends every key it drew rather than only the changed ones, which
 * is harmless: the API hashes the PARSED options, so an explicit set of
 * defaults and an omitted object are the same export and reuse each other's
 * render.
 */
export function defaultNoteExportOptions(exporter: NoteExporter): Record<string, boolean> {
  return Object.fromEntries(exporter.options.map((option) => [option.key, option.default]));
}

/**
 * A human byte count for the "ready" line.
 *
 * `sizeBytes` crosses the wire as a decimal STRING because the column is a
 * `BigInt`; this is the one place it becomes a number, for formatting only.
 * Returns `null` rather than `NaN` for anything unreadable, so no caller can
 * render "NaN B".
 */
export function formatNoteExportSize(sizeBytes: string | null): string | null {
  if (sizeBytes === null) return null;

  const bytes = Number(sizeBytes);

  if (!Number.isFinite(bytes) || bytes < 0) return null;

  const units = ['B', 'KB', 'MB', 'GB'];

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
