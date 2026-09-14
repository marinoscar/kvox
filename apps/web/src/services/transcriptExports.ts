/**
 * The transcript export API, as the web app sees it (issue #28, epic #19).
 *
 * ONE MODULE FOR THREE ROUTES, shaped exactly like `services/jobs.ts` (#266)
 * and `services/dbBackup.ts` (#287): `services/api.ts` stays the transport —
 * the `ApiService` instance, the refresh dance, the maintenance recogniser —
 * and a feature's own surface gets a module where its calls sit beside the
 * types they produce. Everything below goes through the shared `api` client, so
 * an export request inherits the token refresh, the 401 retry and the
 * maintenance interception like every other call in the app.
 *
 * It is deliberately SEPARATE from whatever module ends up holding the
 * transcript reads (#30's `useTranscript` and friends): the export dialog is a
 * self-contained surface with its own three endpoints, and a component that
 * only opens an export has no business importing a module that also knows how
 * to poll segments.
 *
 * =============================================================================
 * THE OPTION FIELDS COME FROM THE SERVER, AND THAT IS THE WHOLE DESIGN
 * =============================================================================
 *
 * `GET /api/transcripts/exporters` returns each format WITH its option list —
 * key, label, description, type and default. The dialog renders that list
 * rather than a hardcoded set of checkboxes, which is what makes the API's
 * promise ("a future `docx` exporter is one new class") true on this side of
 * the wire too: a deployment that registers a new exporter offers it in the
 * dialog immediately, with its own options, and nothing in `apps/web` changes.
 *
 * The corollary is that this module must NOT restate any option key. There is
 * no `MARKDOWN_OPTIONS` constant here and there should never be one — it would
 * be a second copy of a list the server already publishes, and the first time
 * the two disagreed the dialog would offer a checkbox the API rejects.
 *
 * =============================================================================
 * TWO SUCCESS CODES, ONE FIELD
 * =============================================================================
 *
 * `POST /:id/exports` answers **202** for a queued render and **200** for an
 * existing one. `fetch` exposes the status, but a wrapper that unwraps
 * `{ data }` does not — so the API also publishes `reused` on the body, and
 * this module reads that rather than the status line. It is the difference
 * between "your export is being made" and "your export is ready", which is the
 * only thing the dialog needs to decide whether to start polling at all.
 */

import { api } from './api';

// =============================================================================
// Types — mirrors of `apps/api/src/transcripts/dto/transcript-export.dto.ts`
// =============================================================================

/** `TRANSCRIPT_EXPORT_STATUSES` on the API side. */
export const TRANSCRIPT_EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type TranscriptExportStatus = (typeof TRANSCRIPT_EXPORT_STATUSES)[number];

/**
 * One option an exporter accepts.
 *
 * `type` is a union of one today. It is read rather than assumed by the
 * dialog, so the day a `select` or a `number` is added the renderer has
 * somewhere to branch instead of drawing a checkbox for a value that is not a
 * boolean.
 */
export interface ExportOptionField {
  key: string;
  label: string;
  description: string;
  type: 'boolean';
  default: boolean;
}

/** One available format, as `GET /api/transcripts/exporters` publishes it. */
export interface TranscriptExporter {
  format: string;
  label: string;
  mimeType: string;
  extension: string;
  options: ExportOptionField[];
}

/** An export, at whatever stage it has reached. */
export interface TranscriptExport {
  id: string;
  transcriptId: string;
  version: number;
  format: string;
  options: Record<string, unknown>;
  status: TranscriptExportStatus;
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

/** The body of `POST /api/transcripts/{id}/exports`. */
export interface CreateTranscriptExportRequest {
  format: string;
  /** Omit for the transcript's current version. */
  version?: number;
  /** Only keys the chosen format declares — an unknown one is a 400. */
  options?: Record<string, boolean>;
}

/**
 * One entry of the version history, as the dialog's version picker needs it.
 *
 * A NARROW MIRROR of `transcriptVersionSummarySchema`, not the whole thing:
 * this picker needs a number, a sentence and a date, and nothing about
 * `opCount`, `restoredFromVersion` or `hasSnapshot` belongs in a dropdown.
 *
 * ⚠ `author: null` MEANS THE AI, not a missing value — it is the schema's own
 * convention (spec §4.5) and only version 1 ever carries it.
 */
export interface TranscriptVersionOption {
  version: number;
  kind: 'ai_original' | 'edit' | 'restore';
  summary: string | null;
  author: { id: string; name: string | null; email: string | null } | null;
  createdAt: string;
}

// =============================================================================
// Calls
// =============================================================================

/** Every registered format, with the options the dialog renders. */
export async function getExporters(): Promise<TranscriptExporter[]> {
  const response = await api.get<{ exporters: TranscriptExporter[] }>('/transcripts/exporters');

  return response.exporters;
}

/** Queue a render, or receive the identical one that already exists. */
export async function createExport(
  transcriptId: string,
  body: CreateTranscriptExportRequest,
): Promise<TranscriptExport> {
  return api.post<TranscriptExport>(`/transcripts/${transcriptId}/exports`, body);
}

/** One export's current state, and its download URL once it is ready. */
export async function getExport(
  transcriptId: string,
  exportId: string,
): Promise<TranscriptExport> {
  return api.get<TranscriptExport>(`/transcripts/${transcriptId}/exports/${exportId}`);
}

/**
 * The version history, for the dialog's "which version" picker.
 *
 * ⚠ A THIN WRAPPER OVER A ROUTE ISSUE #30 ALSO READS. It lives here rather than
 * being imported from a transcripts service because this dialog ships before
 * that module exists and must not depend on it; when #30's transcript service
 * lands, this function should be deleted and its one caller repointed. It is a
 * duplicated CALL, never a duplicated contract — there is no second copy of the
 * response shape beyond the narrow `TranscriptVersionOption` above.
 *
 * One page of up to `limit` entries, newest first, and deliberately no cursor
 * paging: a dropdown listing a hundred versions is already past the point where
 * a picker is the right control, and the current version — the default — is
 * always on the first page.
 */
export async function getExportableVersions(
  transcriptId: string,
  limit = 50,
): Promise<TranscriptVersionOption[]> {
  const response = await api.get<{ currentVersion: number; items: TranscriptVersionOption[] }>(
    `/transcripts/${transcriptId}/versions?limit=${limit}`,
  );

  return response.items;
}

// =============================================================================
// Shared helpers
// =============================================================================

/**
 * How often the dialog asks again while an export is `pending`.
 *
 * Two seconds, and a flat interval rather than a backoff: an export is
 * short-lived by design (it is one render of a document that already exists in
 * the database) and somebody is watching a spinner for the whole of it, so the
 * case a backoff optimises for — a long wait nobody is looking at — is not this
 * one.
 */
export const EXPORT_POLL_INTERVAL_MS = 2_000;

/**
 * How long the dialog keeps polling before giving up.
 *
 * The job's own ceiling is five minutes (`EXPORT_MAX_RUNTIME_MS` on the API
 * side) and it may be retried once, so this is deliberately LONGER than one
 * attempt and shorter than two full ones plus their backoff. Giving up here
 * does not cancel anything — the render continues and the export will be
 * `ready` on the next request for the identical options, which is exactly what
 * the reuse lookup is for.
 */
export const EXPORT_POLL_TIMEOUT_MS = 6 * 60 * 1_000;

/** Whether an export has finished, either way. */
export function isSettled(row: Pick<TranscriptExport, 'status'>): boolean {
  return row.status !== 'pending';
}

/**
 * Apply an exporter's defaults, so the form starts where the server would.
 *
 * The dialog sends every key it drew rather than only the changed ones. That is
 * harmless — the API hashes the PARSED options, so an explicit set of defaults
 * and an omitted object are the same export and reuse each other's render.
 */
export function defaultOptionsFor(exporter: TranscriptExporter): Record<string, boolean> {
  return Object.fromEntries(exporter.options.map((option) => [option.key, option.default]));
}

/**
 * A human byte count, for the "ready" line.
 *
 * `sizeBytes` crosses the wire as a decimal STRING because the column is a
 * `BigInt`, and this is the one place it becomes a number — for formatting
 * only, exactly as `services/dbBackup.ts` does it. Returns null rather than
 * `NaN` for anything unreadable, so a caller cannot render "NaN B".
 */
export function formatExportSize(sizeBytes: string | null): string | null {
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
