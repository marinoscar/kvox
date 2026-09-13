/**
 * The database-backup API, as the web app sees it (issue #287, epic #254).
 *
 * ONE MODULE FOR TEN ROUTES ON ONE CONTROLLER, shaped exactly like
 * `services/jobs.ts` (#266) and `services/nodes.ts` (#271): `services/api.ts`
 * stays the transport — the `ApiService` instance, the refresh dance, the
 * maintenance recogniser — and an epic's own surface gets a module where its
 * calls sit next to the types they produce. Everything below goes through the
 * shared `api` client, so a backup request inherits the token refresh, the 401
 * retry and the maintenance interception like every other call in the app.
 * That last one is not incidental here: this is the one page in the
 * application that deliberately causes a maintenance window, and it must be
 * gated by the same central recogniser as everything else rather than by a
 * special case of its own.
 *
 * =============================================================================
 * THE BYTE COUNTS ARE STRINGS, AND THEY STAY STRINGS
 * =============================================================================
 *
 * `sizeBytes` and `bytesWritten` are `BigInt` columns, and the API publishes
 * them as DECIMAL STRINGS (`^\d+$`) rather than as JSON numbers, because a
 * multi-terabyte dump exceeds `Number.MAX_SAFE_INTEGER` and JSON has no integer
 * type to protect it. They are typed as `string` here for the same reason, and
 * nothing in this app widens them to `number` at the boundary.
 *
 * `parseByteCount` is the ONE place a string becomes a number, it is used only
 * for FORMATTING and for the progress ratio, and it says so: at those sizes a
 * few bits of mantissa are invisible in "1.4 TB" and in a percentage, whereas
 * the same rounding applied at the transport boundary would silently corrupt a
 * value that later gets compared or summed. It returns `null` rather than
 * `NaN` for anything it cannot read, so a caller cannot accidentally render
 * "NaN B".
 *
 * =============================================================================
 * THE PRECONDITION PREDICATES MIRROR THE API'S REFUSALS
 * =============================================================================
 *
 * `db-backup.controller.ts` answers 400 for a download of a run that is not
 * `completed`, for a delete of a run that is still active, for a cancel of a
 * run that has finished, for a restore of a run that is not `completed`, and
 * for a rollback of a run that was never restored. Each of those has a
 * predicate below, and the page disables the corresponding control from it —
 * so a precondition is READ OFF THE UI rather than discovered by clicking and
 * being refused. They are exported from the service module, next to the routes
 * whose rules they mirror, exactly as `isJobActionable` and
 * `nodeCredentialStatus` are.
 *
 * =============================================================================
 * THE CONFIRMATION LITERALS ARE CONSTANTS, AND THEY ARE DIFFERENT WORDS
 * =============================================================================
 *
 * `RESTORE` and `ROLLBACK` are Zod literals on the API's DTOs
 * (`db-backup-restore.dto.ts`), and the pipe refuses anything else before the
 * service is reached — so a mis-fired or replayed POST cannot reconstruct one
 * by accident. They are two DIFFERENT words on purpose: a body copied from one
 * route to the other is refused rather than silently accepted. The dialog makes
 * the operator type the literal, and it compares against these constants rather
 * than against a string typed a second time in a component.
 */

import { api } from './api';

// =============================================================================
// Enumerations — the API's own, restated so a bad value cannot compile
// =============================================================================

/**
 * `DatabaseBackupRunDto.status` — the lifecycle of one dump.
 *
 *   `pending`   — claimed, nothing streamed yet.
 *   `running`   — `pg_dump` is streaming into object storage.
 *   `completed` — archive uploaded, checksummed and read back.
 *   `failed`    — the dump or the upload failed; the partial archive is gone.
 *   `stale`     — the run stopped heartbeating and the sweep released its slot.
 *                 NOT the same as `failed`: nobody knows how it ended, and its
 *                 archive may or may not exist. See the table module for why
 *                 that difference is drawn on screen and not just in the enum.
 */
export const DB_BACKUP_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'stale',
] as const;
export type DbBackupRunStatus = (typeof DB_BACKUP_RUN_STATUSES)[number];

/**
 * What caused a run. `pre_restore` is the safety dump the restore path takes
 * immediately before a swap, and an operator must be able to tell it from a
 * backup they asked for — it is the archive a rollback falls back to.
 */
export const DB_BACKUP_TRIGGERS = ['manual', 'scheduled', 'pre_restore'] as const;
export type DbBackupTrigger = (typeof DB_BACKUP_TRIGGERS)[number];

/** `databaseBackup.frequency`. */
export const DB_BACKUP_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type DbBackupFrequency = (typeof DB_BACKUP_FREQUENCIES)[number];

/**
 * `databaseBackup.restoreRollbackMode` — what a restore does with the database
 * it displaces, and therefore what a rollback COSTS.
 *
 *   `retain_database` — keep it, renamed. Rolling back is a catalog rename:
 *                       SECONDS. Costs roughly double the volume for
 *                       `oldDatabaseRetentionHours`.
 *   `drop_database`   — drop it. Rolling back means restoring the pre-restore
 *                       dump: HOURS.
 */
export const RESTORE_ROLLBACK_MODES = ['retain_database', 'drop_database'] as const;
export type RestoreRollbackMode = (typeof RESTORE_ROLLBACK_MODES)[number];

/**
 * What the rollback route will ACTUALLY be able to do, which is not always what
 * was configured — `pre_restore_dump` is the downgrade the disk gate forces.
 * See `RestoreRollbackPlan.downgraded`.
 */
export type EffectiveRollbackMode = 'retain_database' | 'pre_restore_dump';

/**
 * The restore audit state on the run the restore was performed FROM.
 *
 * `restoring` → `verifying` → `swapping` → `completed` | `failed`, plus
 * `rolled_back` once a completed restore has been undone. `null` means this
 * archive has never been restored, which is what makes the rollback route a
 * 400 rather than a no-op.
 */
export const RESTORE_STATUSES = [
  'restoring',
  'verifying',
  'swapping',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type RestoreStatus = (typeof RESTORE_STATUSES)[number];

/**
 * The pre-flight gates, by id. Every one of them is reported on every restore
 * attempt, passes included — see `RestorePreflight.gates`.
 */
export const RESTORE_GATE_IDS = [
  'pg_client_version',
  'admin_connection',
  'createdb_privilege',
  'extensions',
  'disk_space',
  'replicas',
  'schema_compatibility',
] as const;
export type RestoreGateId = (typeof RESTORE_GATE_IDS)[number];

/** What KIND of thing a gate checks; it decides what a failure can be answered with. */
export type RestoreGateKind = 'capability' | 'disk' | 'replicas' | 'overridable';

/** One gate's answer. `warning` is a real verdict, not a soft failure. */
export type RestoreGateVerdict = 'pass' | 'warning' | 'block';

/**
 * The exact strings the API's Zod literals require
 * (`db-backup-restore.dto.ts`). Two different words, deliberately.
 */
export const RESTORE_CONFIRMATION = 'RESTORE';
export const ROLLBACK_CONFIRMATION = 'ROLLBACK';

/**
 * The one value `block.overrideParameter` can name today, and the field the
 * dialog's separate override control sets.
 *
 * The API is explicit that this flag unblocks THE SCHEMA GATE AND NOTHING
 * ELSE: no amount of accepting a mismatch makes a role without `CREATEDB` able
 * to create a database. The dialog therefore offers the override only when the
 * block names this parameter, never as a general "force" switch.
 */
export const OVERRIDE_SCHEMA_CHECK_PARAMETER = 'overrideSchemaCheck';

// =============================================================================
// Response shapes — mirrors of `apps/api/src/db-backup/dto/`
// =============================================================================

/**
 * The policy, plus the two computed fields the GET adds
 * (`DatabaseBackupConfigDto`).
 *
 * `nextRunAt` IS THE WHOLE REASON THE CONFIG PANEL IS WORTH RENDERING. It is
 * the server's own projection of the schedule through the stored timezone, so
 * an administrator can confirm a schedule immediately instead of finding out a
 * day later that it fires at the wrong hour — and it is recomputed by the API
 * on every save, so the number on screen is never the client's arithmetic.
 * `null` means nothing is scheduled (the policy is disabled, or the projection
 * could not be made).
 */
export interface DbBackupConfig {
  enabled: boolean;
  frequency: DbBackupFrequency;
  /** 0 = Sunday … 6 = Saturday. Read only when `frequency` is `weekly`. */
  dayOfWeek: number;
  /** 1–28. Read only when `frequency` is `monthly`; 28 is the ceiling so every month has the day. */
  dayOfMonth: number;
  /** `HH:mm`, 24-hour, in `timezone`. */
  timeOfDay: string;
  /** An IANA zone name. The API validates it by PERFORMING the projection — see below. */
  timezone: string;
  /** How many completed archives to keep. */
  retentionCount: number;
  /** Empty means "whatever storage provider is active". */
  storageProvider: string;
  /** How long a run may go without a heartbeat before the sweep calls it `stale`. */
  runStaleMinutes: number;
  /** 0–9, `pg_dump`'s own scale. 0 is "no compression", not "default". */
  compressionLevel: number;
  restoreRollbackMode: RestoreRollbackMode;
  /** How long a retained pre-restore database is kept before it is dropped. */
  oldDatabaseRetentionHours: number;
  /** Server-computed. `null` when nothing is scheduled. */
  nextRunAt: string | null;
  /** The run currently holding the single active slot, or `null`. */
  activeRunId: string | null;
}

/**
 * The body `PUT config` accepts (`UpdateDatabaseBackupConfigDto`) — every field
 * optional, and the two computed ones absent because they are not settable.
 */
export type UpdateDbBackupConfigInput = Partial<
  Omit<DbBackupConfig, 'nextRunAt' | 'activeRunId'>
>;

/**
 * One run as the list and the detail return it (`DatabaseBackupRunDto`).
 *
 * The eight `restore*` fields are the RESTORE AUDIT, and they live on the
 * backup run rather than in a table of their own: "this archive was restored,
 * at this time, by this person, and here is what happened" is a property of the
 * archive. `preRestoreBackupId` points at the safety dump taken just before the
 * swap — the archive a `drop_database` rollback restores from.
 */
export interface DbBackupRun {
  id: string;
  status: DbBackupRunStatus;
  trigger: DbBackupTrigger;
  /** Decimal string — see the module header. Live during the dump. */
  bytesWritten: string;
  /** Decimal string. The final archive size; `'0'` until the dump finishes. */
  sizeBytes: string;
  storageProvider: string;
  storageKey: string;
  bucket: string;
  format: string;
  /** `null` until the archive has been read back and checksummed. */
  checksumSha256: string | null;
  /** When the archive was read back from storage and verified. `null` if it never was. */
  verifiedAt: string | null;
  dbVersion: string | null;
  appVersion: string | null;
  /** The migration the schema was on when the dump was taken. */
  migrationName: string | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  createdById: string | null;
  restoreStatus: RestoreStatus | null;
  restoreError: string | null;
  restoredAt: string | null;
  restoredById: string | null;
  /** The scratch database the archive was restored into before the swap. */
  restoreScratchDb: string | null;
  /** The database the swap displaced, if it was retained. */
  restoreOldDb: string | null;
  swappedAt: string | null;
  preRestoreBackupId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET runs` — server-side pagination, one-based, `pageSize` capped at 100. */
export interface DbBackupRunListResponse {
  items: DbBackupRun[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** The query `GET runs` honours, and nothing more — see `dbBackupTable.tsx`. */
export interface DbBackupRunListParams {
  /** One-based. */
  page?: number;
  /** Max 100. */
  pageSize?: number;
  status?: DbBackupRunStatus;
  trigger?: DbBackupTrigger;
}

/** A signed, expiring URL for one archive (`BackupDownloadUrlDto`). */
export interface BackupDownloadUrl {
  url: string;
  /** Seconds. */
  expiresIn: number;
}

/**
 * What a cancel actually managed (`CancelBackupResultDto`).
 *
 * ⚠ READ `outcome`, NOT ONLY THE STATUS CODE. A dump is stopped by signalling a
 * child process, and only the API instance holding that handle can do it, so a
 * run executing elsewhere answers 200 with `not_running_here` and changes
 * nothing. That is not an error and retrying does not help.
 */
export interface CancelBackupResult {
  runId: string;
  outcome: 'signalled' | 'not_running_here';
  detail: string;
}

/** What a delete managed (`DeleteBackupResultDto`). */
export interface DeleteBackupResult {
  id: string;
  /** `false` when the row went but the stored object could not be removed. */
  objectDeleted: boolean;
}

// =============================================================================
// The pre-flight
// =============================================================================

/** One gate's verdict, with the action item that goes with it. */
export interface RestoreGate {
  id: RestoreGateId;
  kind: RestoreGateKind;
  verdict: RestoreGateVerdict;
  title: string;
  detail: string;
  /** What to do about it. `null` when there is nothing to do — typically a pass. */
  action: string | null;
}

/**
 * What rolling back will cost if this restore goes ahead.
 *
 * `downgraded` is the field that matters: it means the configured
 * `retain_database` could not be honoured (short disk, typically), so the way
 * back is a full restore of the pre-restore dump — HOURS instead of SECONDS.
 * That changes the recovery guarantee the operator is deciding against, so the
 * dialog surfaces it before the confirmation rather than after.
 */
export interface RestoreRollbackPlan {
  configured: RestoreRollbackMode;
  effective: EffectiveRollbackMode;
  downgraded: boolean;
  reason: string | null;
}

/**
 * Every gate that ran, plus the facts they ran against.
 *
 * `outcome` MIRRORS the response's `mode`, so a caller never has to work out
 * which one won. `gates` carries the PASSES too, deliberately: an operator
 * about to replace a production database should be able to see what was
 * checked, not only what objected.
 */
export interface RestorePreflight {
  outcome: 'ok' | 'guided' | 'blocked';
  runId: string;
  targetDatabase: string;
  scratchDatabase: string;
  oldDatabase: string;
  gates: RestoreGate[];
  rollback: RestoreRollbackPlan;
  /** The migration the ARCHIVE was taken on. `null` when it could not be read. */
  archiveMigration: string | null;
  /** The migration the LIVE database is on. */
  liveMigration: string | null;
  /** Decimal string, or `null`. */
  databaseSizeBytes: string | null;
  /** Decimal string, or `null` — and `null` is COMMON: many hosts do not expose it. */
  freeDiskBytes: string | null;
}

/** The paste-ready answer the `guided` outcome exists to deliver. */
export interface GuidedRestoreInstructions {
  reason: string;
  /** A multi-line shell block with real names, hosts and ports. Rendered monospace, copied whole. */
  commands: string;
  /** A repository-relative path, NOT a URL — see the dialog for how it is rendered. */
  runbook: string;
}

/** Why the schema gate refused, and what (if anything) unblocks it. */
export interface RestoreBlock {
  gateId: RestoreGateId;
  message: string;
  overridable: boolean;
  /** `'overrideSchemaCheck'`, or `null` when nothing unblocks this gate. */
  overrideParameter: string | null;
}

/**
 * The three NORMAL outcomes of `POST runs/{id}/restore`. ⚠ ALL THREE ARE 200 —
 * read `mode`, never the status code.
 *
 *   `running` — gates passed, the restore is under way in the background.
 *   `guided`  — a CAPABILITY gate failed. NOTHING was started, and this is not
 *               an error: the body carries a complete command block so the same
 *               restore can be done by hand with a superuser.
 *   `blocked` — the schema gate refused. Nothing was started.
 *
 * `guidance` and `block` are HOISTED to the top level and are not duplicated
 * inside `preflight`, so a renderer reads each exactly once.
 */
export type StartRestoreResult =
  | {
      mode: 'running';
      runId: string;
      scratchDatabase: string;
      oldDatabase: string;
      preflight: RestorePreflight;
    }
  | {
      mode: 'guided';
      runId: string;
      guidance: GuidedRestoreInstructions;
      preflight: RestorePreflight;
    }
  | {
      mode: 'blocked';
      runId: string;
      block: RestoreBlock;
      preflight: RestorePreflight;
    };

/**
 * The three outcomes of `POST runs/{id}/rollback`. All three are 200, and
 * `detail` is always present and always renderable.
 *
 *   `renamed`         — the displaced database was renamed back. SECONDS, and
 *                       the process exits at the end of it.
 *   `restore_started` — there was nothing to rename, so this delegated into the
 *                       restore path against the pre-restore dump. HOURS. Poll
 *                       `preRestoreRunId`, NOT this run.
 *   `unavailable`     — the retained database is past its retention window and
 *                       there is no pre-restore backup to fall back on. A 200
 *                       and not a failure: nothing went wrong just now, the
 *                       rollback window simply closed.
 *
 * There is deliberately NO `preflight` on any of them: a rollback runs no
 * gates.
 */
export type RollbackRestoreResult =
  | { mode: 'renamed'; runId: string; promoted: string; parked: string; detail: string }
  | { mode: 'restore_started'; runId: string; preRestoreRunId: string; detail: string }
  | { mode: 'unavailable'; runId: string; detail: string };

// =============================================================================
// Requests
// =============================================================================

const BASE = '/admin/db-backup';

/** `GET config` — the policy, plus `nextRunAt` and `activeRunId`. */
export async function getDbBackupConfig(): Promise<DbBackupConfig> {
  return api.get<DbBackupConfig>(`${BASE}/config`);
}

/**
 * `PUT config` — the policy as it now stands.
 *
 * A 400 here is INFORMATION, not a client bug: the API refuses a timezone this
 * runtime cannot resolve (it checks by performing the very projection
 * `nextRunAt` publishes) and a `storageProvider` this deployment does not have.
 * Nothing in this app second-guesses either with a list of its own — a
 * hand-kept IANA list would rot, and the runtime's own ICU data is the
 * authority on what it can schedule against. The page renders the API's
 * message.
 */
export async function updateDbBackupConfig(
  input: UpdateDbBackupConfigInput,
): Promise<DbBackupConfig> {
  return api.put<DbBackupConfig>(`${BASE}/config`, input);
}

/**
 * `POST runs` — take a backup now. Answers 202 with the claimed run while the
 * dump is still streaming, or 409 with `details.activeRunId` when one is
 * already going.
 */
export async function startBackupRun(): Promise<DbBackupRun> {
  return api.post<DbBackupRun>(`${BASE}/runs`);
}

/** `GET runs` — newest first, paginated, optionally filtered by status or trigger. */
export async function getBackupRuns(
  params: DbBackupRunListParams = {},
): Promise<DbBackupRunListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.status) query.set('status', params.status);
  if (params.trigger) query.set('trigger', params.trigger);

  return api.get<DbBackupRunListResponse>(`${BASE}/runs?${query}`);
}

/** `GET runs/{id}` — one run, in the same shape the list returns. */
export async function getBackupRun(id: string): Promise<DbBackupRun> {
  return api.get<DbBackupRun>(`${BASE}/runs/${id}`);
}

/** `GET runs/{id}/download` — a signed, expiring URL. 400 unless the run is `completed`. */
export async function getBackupDownloadUrl(id: string): Promise<BackupDownloadUrl> {
  return api.get<BackupDownloadUrl>(`${BASE}/runs/${id}/download`);
}

/** `POST runs/{id}/cancel` — ⚠ read `outcome`, not only the status code. */
export async function cancelBackupRun(id: string): Promise<CancelBackupResult> {
  return api.post<CancelBackupResult>(`${BASE}/runs/${id}/cancel`);
}

/** `DELETE runs/{id}` — the row and its archive. 400 while the run is active. */
export async function deleteBackupRun(id: string): Promise<DeleteBackupResult> {
  return api.delete<DeleteBackupResult>(`${BASE}/runs/${id}`);
}

/**
 * `POST runs/{id}/restore` — REPLACES THE PRODUCTION DATABASE.
 *
 * The confirmation literal is sent from the constant above rather than typed
 * here a second time, and `overrideSchemaCheck` is omitted unless it is
 * actually being set: sending `false` explicitly is the same request as
 * omitting it, and a flag in the body of a destructive call that changes
 * nothing is a flag somebody will later read as "an override was requested".
 */
export async function startRestore(
  id: string,
  options: { overrideSchemaCheck?: boolean } = {},
): Promise<StartRestoreResult> {
  const body: { confirmation: string; overrideSchemaCheck?: boolean } = {
    confirmation: RESTORE_CONFIRMATION,
  };
  if (options.overrideSchemaCheck) body.overrideSchemaCheck = true;

  return api.post<StartRestoreResult>(`${BASE}/runs/${id}/restore`, body);
}

/** `POST runs/{id}/rollback` — ⚠ read `mode`: the two routes back differ by hours. */
export async function rollbackRestore(id: string): Promise<RollbackRestoreResult> {
  return api.post<RollbackRestoreResult>(`${BASE}/runs/${id}/rollback`, {
    confirmation: ROLLBACK_CONFIRMATION,
  });
}

// =============================================================================
// Shared predicates — mirrors of the API's own refusals
// =============================================================================

/** Holding the single active slot: `pending` or `running`. */
export function isBackupRunActive(run: Pick<DbBackupRun, 'status'>): boolean {
  return run.status === 'pending' || run.status === 'running';
}

/**
 * Whether an archive can be downloaded or restored.
 *
 * `completed` and nothing else — the same rule `getDownloadUrl` and
 * `requireRunForRestore` both enforce. A `stale` run is deliberately NOT
 * downloadable: nobody knows how it ended, so its archive may be truncated.
 */
export function isBackupDownloadable(run: Pick<DbBackupRun, 'status'>): boolean {
  return run.status === 'completed';
}

/** Restoring has the same `completed`-only precondition the download does. */
export function isBackupRestorable(run: Pick<DbBackupRun, 'status'>): boolean {
  return run.status === 'completed';
}

/** The API refuses to delete a run that is still active — its archive is mid-upload. */
export function isBackupDeletable(run: Pick<DbBackupRun, 'status'>): boolean {
  return !isBackupRunActive(run);
}

/** Only an active run can be cancelled; one that has finished is a 400. */
export function isBackupCancelable(run: Pick<DbBackupRun, 'status'>): boolean {
  return isBackupRunActive(run);
}

/**
 * Whether a restore performed FROM this archive is still moving.
 *
 * The three non-terminal states, and what the page watches to know a restart is
 * expected.
 */
export function isRestoreInFlight(run: Pick<DbBackupRun, 'restoreStatus'>): boolean {
  return (
    run.restoreStatus === 'restoring' ||
    run.restoreStatus === 'verifying' ||
    run.restoreStatus === 'swapping'
  );
}

/**
 * Whether the rollback route has a swap to undo.
 *
 * `restoreStatus !== null` on a `completed` run, which is exactly what
 * `rollbackRestore` checks before it refuses with `restore_never_ran`. Note it
 * is deliberately NOT narrowed to `restoreStatus === 'completed'`: a restore
 * that failed mid-swap is precisely the case an operator most needs to undo.
 */
export function isRollbackAvailable(
  run: Pick<DbBackupRun, 'status' | 'restoreStatus'>,
): boolean {
  return run.status === 'completed' && run.restoreStatus !== null;
}

/**
 * A decimal byte string as a number, for FORMATTING ONLY — see the module
 * header on why the transported value stays a string.
 *
 * `null` (not `NaN`, and not `0`) for anything unreadable, so a caller renders
 * "unknown" rather than a confident wrong number. `null` in means `null` out:
 * `freeDiskBytes` is genuinely absent on many hosts, and that is a different
 * fact from "zero bytes free".
 */
export function parseByteCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}
