// =============================================================================
// The backup subsystem's admin read/act surface (issue #283, epic #254)
// =============================================================================
//
// Everything a human does to backups from outside them: look at the policy and
// when it will next fire, change it, take one by hand, page through the
// history, watch one progress, fetch an archive, cancel and delete. Like
// `JobAdminService`, it is a deliberately SMALL service that owns almost
// nothing of its own and borrows the rest — every hard decision in this
// subsystem already lives somewhere, and re-deciding any of it here would give
// the API and the engine two opinions about one question.
//
// -----------------------------------------------------------------------------
// WHAT THIS SERVICE IS NOT ALLOWED TO REIMPLEMENT
// -----------------------------------------------------------------------------
//
//   - THE CLAIM. `POST runs` calls `DatabaseBackupRunnerService.queueBackup`
//     and nothing else (`startBackup` before #351 moved the dump onto the
//     queue). The single-active-run index is only a guarantee if there is ONE
//     writer of this table (`db-backup.module.ts` says so where it exports the
//     runner), and an admin path that inserted its own row — or that enqueued
//     its own `db.backup.run` job beside one — would be a second writer racing
//     the scheduler on another replica.
//   - THE SCHEDULE. `nextRunAt` is `nextFireAt` from `schedule.util.ts`, the
//     same pure function `previousFireBoundary` sits beside and that #282's
//     cron uses to decide what was due. A second projection of "when does this
//     fire" is how the time an operator READS and the time a backup RUNS start
//     to differ, and nobody looks at a backup schedule again after the day they
//     set it.
//   - THE SETTINGS WRITE. `PUT config` delegates to
//     `SystemSettingsService.patchSettings`, which owns the merge, the
//     unknown-key preservation (#130) and the row's version counter. A second
//     writer to that JSONB column is a second chance to destroy a key this
//     build does not model. This is the identical argument
//     `MaintenanceModeService.setMaintenance` makes, and it is why there is
//     exactly one settings writer in this application.
//   - THE STORAGE-PROVIDER RULE. `assertStorageProviderUsable` is called on the
//     runner, which forwards to the one pure helper in `db-backup-storage.ts`
//     that the run path also uses. Two copies of that comparison is how a
//     settings form and a backup engine start disagreeing about where archives
//     go — the one kind of wrong in this subsystem that is only ever discovered
//     during a restore.
//   - THE RESTORE, AND THE GATES (#286). `startRestore` and `rollbackRestore`
//     call `DatabaseRestoreService` and add exactly three things #284 and #285
//     both say belong here: the run lookup, the `completed`-only rule, and the
//     actor. They do NOT re-run the pre-flight — `DatabaseRestoreService
//     .startRestore` runs it itself, deliberately, so that no caller can reach
//     a restore with no gates by forgetting to.
//
// -----------------------------------------------------------------------------
// ⚠ THE TWO RESTORE METHODS THROW DOMAIN ERRORS, NOT HTTP EXCEPTIONS (#286)
// -----------------------------------------------------------------------------
//
// Every other method in this file raises `NotFoundException` and
// `BadRequestException` directly, and that stays right for them. The restore
// pair is different and deliberately inconsistent with its neighbours:
//
//   - THE RESTORE PATH IS REACHED FROM MORE THAN THE HTTP LAYER. A rollback in
//     `pre_restore_dump` mode re-enters `startRestore` from inside a running
//     restore, with no request to answer; #287 will reach it again. A framework
//     exception raised on that path is an HTTP object travelling a code path
//     that has nowhere to send it.
//   - IT KEEPS EVERY STATUS-CODE DECISION FOR THESE TWO ROUTES IN ONE READABLE
//     BLOCK, next to the OpenAPI annotations that publish it. For the one
//     surface in this application where a mis-fired request is an outage rather
//     than a duplicate row, "which answers are errors and which are normal" is
//     worth being able to read in a single screen.
//
// `db-backup.controller.ts` does the mapping: not-found → 404, not-allowed →
// 400, and the `already_running` RESULT (not an error — see
// `db-backup.errors.ts`) → 409 with `details.activeRunId`.
//
// -----------------------------------------------------------------------------
// TWO PRE-WRITE VALIDATIONS ON `PUT config`, AND BOTH EARN THEIR KEEP
// -----------------------------------------------------------------------------
//
// A bad value in this namespace does not fail at save time. It fails HOURS
// LATER, inside a cron tick, on a night nobody is watching — and the symptom is
// that a backup did not happen, which looks exactly like a deployment that is
// being backed up. So two classes of value are refused at the moment they are
// typed:
//
//   1. A TIMEZONE THIS RUNTIME DOES NOT KNOW. Checked by PERFORMING the very
//      projection the response is about to publish: if `nextFireAt` cannot
//      resolve the zone it throws `InvalidTimezoneError`, which becomes a 400.
//      Validating THROUGH THE REAL SEAM rather than against a hand-kept list of
//      IANA names is the point — the runtime's own ICU data is the authority on
//      what it can schedule against, a list would rot, and a zone that saves is
//      then by construction a zone that schedules. Note it is checked even when
//      `enabled` is false; see the call site for why that matters.
//   2. A `storageProvider` NAMING A PROVIDER THIS DEPLOYMENT DOES NOT HAVE.
//      Empty means "whatever is active"; anything else must equal the active
//      provider's id. Rejected here so the mistake is caught by the person
//      making it, and rejected AGAIN at run time by the runner, so a value that
//      predates this check (a seed, a restored settings blob, a provider swap)
//      cannot quietly redirect tonight's backup.
//
// Both run BEFORE `patchSettings`, so a refused write leaves the stored policy
// exactly as it was. A partially-applied policy — timezone accepted, provider
// rejected — would be worse than either outcome.
//
// -----------------------------------------------------------------------------
// ⚠ MACHINE-READABLE ERROR DATA GOES UNDER `details`, AND NOWHERE ELSE
// -----------------------------------------------------------------------------
//
// `common/filters/http-exception.filter.ts` REBUILDS every error body from a
// fixed set of keys: it reads `message` and `details` off the thrown payload,
// DERIVES `code` from the status (discarding any the exception supplied), and
// adds `statusCode`, `timestamp` and `path`. A field added at the TOP LEVEL of
// a thrown payload is therefore silently dropped and never reaches the client.
//
// That matters most for the 409 below, whose entire value to the caller is the
// id of the run that is already in flight. `{ activeRunId }` at the top level
// would vanish; `{ details: { activeRunId } }` survives. And because
// `exception.getResponse()` returns the payload BEFORE the filter has touched
// it, a test that asserts on `getResponse()` proves nothing about the wire —
// which is why `test/db-backup/db-backup-admin.integration.spec.ts` asserts
// through the real router and the real filter instead.
//
// -----------------------------------------------------------------------------
// REJECTED: PROXYING THE ARCHIVE THROUGH THE API
// -----------------------------------------------------------------------------
//
// `GET runs/:id/download` returns a pre-signed URL. The obvious alternative —
// streaming the object back through this process as the response body — was
// rejected, and not on taste:
//
//   - It puts a MULTI-GIGABYTE RESPONSE through an application server and every
//     reverse proxy in front of it, for a file whose size is by definition the
//     size of the whole database. Nginx buffering, proxy read timeouts and
//     load-balancer idle limits all sit in that path, and none of them is
//     configured for a two-hour transfer.
//   - It occupies a worker for the duration of the download, so one operator
//     fetching a backup degrades the API for everyone else.
//   - `StorageProvider` ALREADY EXPOSES `getSignedDownloadUrl`, and the whole
//     point of that method is that the bytes travel from storage to the client
//     without transiting this process. `ObjectsService.getDownloadUrl` made the
//     same call for ordinary user files, which are orders of magnitude smaller.
//
// What the API keeps is the part it is actually needed for: the permission
// check, the `completed`-only refusal, and a SHORT expiry.
// =============================================================================

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseBackupRun, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { PatchSystemSettingsDto } from '../settings/dto/update-system-settings.dto';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { DatabaseBackupRunnerService } from './db-backup-runner.service';
import { DatabaseRestoreService } from './database-restore.service';
import type {
  RestoreRollbackResult,
  StartRestoreResult,
} from './database-restore.service';
import {
  DatabaseBackupAlreadyRunningError,
  DatabaseBackupStorageProviderError,
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreRunNotFoundError,
} from './db-backup.errors';
import { PgJobRoleBroker } from './pg-job-role.broker';
import { backupScheduleToCron, InvalidTimezoneError, nextFireAt } from './schedule.util';
import {
  ACTIVE_BACKUP_STATUSES,
  toRunDto,
  type BackupRunResponse,
} from './dto/db-backup-run.dto';
import type { BackupRunListQuery } from './dto/db-backup-list-query.dto';
import type {
  DatabaseBackupConfigResponse,
  UpdateDatabaseBackupConfig,
} from './dto/db-backup-config.dto';
import type { NodeCredentialPreflight } from './dto/db-backup-node-credential.dto';
import type {
  BackupDownloadUrl,
  CancelBackupResult,
  DeleteBackupResult,
} from './dto/db-backup-actions.dto';

/**
 * How long a backup download URL stays valid.
 *
 * FIVE MINUTES, and short on purpose: the URL is a credential-free capability
 * over a complete copy of this deployment's database, so its lifetime is the
 * window in which a leaked link — a browser history entry, a chat message, a
 * proxy log — is still usable.
 *
 * It is NOT a transfer budget, and that is the misunderstanding worth heading
 * off. S3-compatible providers check a pre-signed URL's expiry when the request
 * is RECEIVED, not throughout the response, so a download that starts at 4:59
 * completes however long it takes. Five minutes is "long enough to click",
 * which is all it needs to be.
 *
 * A CONSTANT, not a setting. Nothing an operator could choose here would be a
 * better answer than "short", and a knob whose wrong settings are silent — a
 * 24-hour URL works perfectly right up until it is the reason a database
 * leaked — is a knob worth not having. `storage.signedUrlExpiry` is deliberately
 * NOT reused: that default (an hour) is sized for user-uploaded files, and a
 * database archive is not one.
 */
export const BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS = 300;

/** One page of runs, in the flat shape every paginated list in this API uses. */
export interface BackupRunListResult {
  items: BackupRunResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

@Injectable()
export class DatabaseBackupAdminService {
  private readonly logger = new Logger(DatabaseBackupAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly runner: DatabaseBackupRunnerService,
    // The restore engine, injected whole. This service adds the run lookup, the
    // `completed`-only rule and the actor; it re-decides nothing about HOW a
    // restore happens, for the same reason it does not reimplement the claim or
    // the schedule (see this file's header).
    private readonly restore: DatabaseRestoreService,
    // The ACTIVE provider, injected directly rather than through
    // `ObjectsService`, exactly as the runner and the retention sweep inject
    // it: a backup is not a `storage_objects` row, and routing it through the
    // interactive object API would give every archive a user-facing object
    // record an administrator could delete outside the retention policy that
    // owns its lifetime.
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    // The PostgreSQL job-role broker (#350, epic #345), for ONE read: whether
    // this deployment could mint a node credential. Injected whole rather than
    // reimplemented, so the verdict an administrator reads and the verdict a
    // node's request is refused with come from the same probe — a second
    // implementation of "can we CREATE ROLE?" is how a screen starts saying yes
    // while the claim path says no.
    private readonly jobRoles: PgJobRoleBroker
  ) {}

  // =========================================================================
  // Config
  // =========================================================================

  /**
   * The stored policy, plus the two things it does not contain: when the
   * schedule will next fire, and whether a backup is happening right now.
   *
   * @param now injected so a test can pin the projection without moving the
   * wall clock — the same reason `DatabaseBackupRetentionService.prune` takes
   * one.
   */
  async getConfig(now: Date = new Date()): Promise<DatabaseBackupConfigResponse> {
    const [policy, activeRunId] = await Promise.all([
      this.settings.getDatabaseBackupPolicy(),
      this.findActiveRunId(),
    ]);

    return {
      ...policy,
      nextRunAt: this.projectNextRunAt(policy, now)?.toISOString() ?? null,
      activeRunId,
    };
  }

  /**
   * Whether this deployment can hand a worker node a database credential, and
   * what to run if it cannot.
   *
   * ⚠ A READ THAT CHANGES NOTHING, and the same rule
   * `docs/specs/database-restore.md` states for a restore pre-flight applies
   * here for the same reason: an administrator asks "could this work?" exactly
   * when they have not decided to switch it on. The broker's `usable()` contract
   * forbids side effects and `pg-job-role.broker.spec.ts` asserts no DDL is
   * issued.
   *
   * TWO INDEPENDENT FACTS, REPORTED SEPARATELY — see
   * `db-backup-node-credential.dto.ts` for why. The CAPABILITY comes from the
   * broker (a live `CREATEROLE` probe against the cluster); the POLICY comes
   * from the `nodes` settings namespace, through the same narrow accessor the
   * fleet crons and the claim path read, so there is exactly one read path for
   * "may a node hold a credential here".
   *
   * ⚠ `=== true`, MATCHING `NodeLifecycleService.getPolicy`'s FAIL-CLOSED RULE.
   * A missing key, a string `"true"` or a number all mean OFF: the safe answer
   * to "may a node hold a credential to this database?" when the stored setting
   * is not a literal `true` is no, and this screen must report the same answer
   * the claim path acts on rather than a friendlier one.
   */
  async getNodeCredentialPreflight(): Promise<NodeCredentialPreflight> {
    const [verdict, nodes] = await Promise.all([
      this.jobRoles.preflight(),
      this.settings.getNodesPolicy(),
    ]);

    return {
      outcome: verdict.outcome,
      kind: verdict.kind,
      databaseRole: verdict.databaseRole,
      targetDatabase: verdict.targetDatabase,
      brokerEnabled: nodes?.jobSecretBrokerEnabled === true,
      detail: verdict.detail,
      guidance: verdict.outcome === 'guided' ? verdict.guidance : null,
    };
  }

  /**
   * Writes a partial policy, after refusing the two values that would fail
   * silently later.
   *
   * Returns the config as it now stands — the same body `GET config` produces,
   * including a RECOMPUTED `nextRunAt`. That is the point of returning anything
   * at all: the administrator who just changed the hour sees, in the response
   * to the write, the actual instant their change will take effect. A `204`
   * would leave them to re-fetch and hope.
   */
  async updateConfig(
    patch: UpdateDatabaseBackupConfig,
    userId: string,
    now: Date = new Date()
  ): Promise<DatabaseBackupConfigResponse> {
    const current = await this.settings.getDatabaseBackupPolicy();

    // The policy AS IT WOULD BE after this patch. Both validations below run
    // against this rather than against the patch alone, because the value that
    // matters is the one the scheduler will read: a patch that changes only
    // `frequency` still has to produce a schedule the stored `timezone` can be
    // projected in.
    const effective: SystemDatabaseBackupValue = { ...current, ...patch };

    // 1. The provider name. Cheapest, and the one whose failure is a silent
    //    write to the wrong place.
    try {
      this.runner.assertStorageProviderUsable(effective.storageProvider);
    } catch (error) {
      if (error instanceof DatabaseBackupStorageProviderError) {
        throw new BadRequestException({
          message: error.message,
          details: {
            field: 'storageProvider',
            configured: error.configured,
            active: error.active,
            reason: 'storage_provider_unavailable',
          },
        });
      }

      throw error;
    }

    // 2. The timezone, checked by performing the projection itself. See the
    //    header: the runtime's own zone support is the authority, and doing the
    //    real computation is what makes "it saved" and "it will schedule" the
    //    same statement rather than two hopeful ones.
    //
    //    ⚠ IT IGNORES `enabled`, AND THAT IS THE POINT. `computeNextRunAt`
    //    short-circuits to `null` for a disabled schedule, which is correct for
    //    a READ and exactly wrong for this check: configuring the schedule
    //    while backups are still off is the ORDINARY order of events, so a
    //    validation that skipped itself in that state would accept the bad
    //    timezone, save it, and surface it the night after somebody enabled
    //    backups — a failure separated from its cause by however long that
    //    took. So this calls the projection directly.
    //
    //    The RESULT is deliberately discarded — this call is here for its
    //    throw. The value published below is recomputed from what was actually
    //    STORED, because `patchSettings` merges and validates and the row is
    //    what every other reader will see.
    try {
      nextFireAt(backupScheduleToCron(effective), now, effective.timezone);
    } catch (error) {
      if (error instanceof InvalidTimezoneError) {
        throw new BadRequestException({
          message: error.message,
          details: {
            field: 'timezone',
            timezone: error.timezone,
            reason: 'unknown_timezone',
          },
        });
      }

      throw error;
    }

    // THE ONE SETTINGS WRITER. See the header for why this is not a Prisma
    // update on the `system_settings` row.
    await this.settings.patchSettings(
      { databaseBackup: patch } as PatchSystemSettingsDto,
      userId
    );

    this.logger.log(
      `Database backup policy updated by user ${userId} ` +
        `(${Object.keys(patch).join(', ') || 'no fields'}).`
    );

    // RE-READ, rather than returning `effective`. `patchSettings` merges,
    // validates and may normalise, and the stored row is the thing every other
    // reader will see — publishing this service's own idea of the merge would
    // be a second projection of the same question, which is the mistake this
    // file's header spends four bullets avoiding.
    //
    // Going back through `getConfig` rather than assembling a body here is the
    // same rule one level up: the write's response and the read's response are
    // then the SAME object by construction, so a client can apply one to the
    // state it holds for the other without wondering whether the two agree.
    return this.getConfig(now);
  }

  // =========================================================================
  // Runs
  // =========================================================================

  /**
   * Takes a backup now.
   *
   * AWAITS THE ENQUEUE AND NOTHING MORE. `queueBackup` writes the
   * `db.backup.run` job and its `pending` run row in one transaction and
   * returns, so this responds in milliseconds with a real run id — which is
   * the only shape that works: a multi-gigabyte dump takes tens of minutes,
   * and every reverse proxy in front of this process has a response timeout
   * measured in seconds. A synchronous handler would 504 on exactly the
   * databases worth backing up, and the operator's retry would be refused by
   * the single-active index while the first dump — which nobody is now
   * watching — carried on. Poll `GET runs/:id` for progress.
   *
   * ⚠ THE RESPONSE SHAPE IS UNCHANGED BY #351, AND ONE FIELD IN IT NOW MEANS
   * SOMETHING MORE HONEST. The run comes back `pending` rather than `running`,
   * because a worker has not claimed the job yet and nothing has in fact
   * started; the handler writes `running` and `startedAt` at the moment a dump
   * genuinely begins. `pending` was always in `ACTIVE_BACKUP_STATUSES` and in
   * the DTO's status enum, so no client contract moves — what moves is that
   * the row stops asserting a `pg_dump` exists before one does.
   *
   * @throws 409 carrying `details.activeRunId` when the slot is taken —
   * whether it was the queue's dedup index or the run table's single-active
   * index that refused. Both arrive here as the same typed error.
   */
  async startRun(userId: string): Promise<BackupRunResponse> {
    try {
      const { run, job } = await this.runner.queueBackup({
        trigger: 'manual',
        createdById: userId,
      });

      this.logger.log(
        `Manual database backup ${run.id} queued by user ${userId} as job ${job.id}.`
      );

      return toRunDto(run);
    } catch (error) {
      if (error instanceof DatabaseBackupAlreadyRunningError) {
        // ⚠ `activeRunId` GOES UNDER `details`. At the top level the exception
        // filter would drop it and the caller would get "one is already
        // running" with no way to find out which — see the header.
        throw new ConflictException({
          message: error.message,
          details: {
            activeRunId: error.activeRunId,
            reason: 'backup_already_running',
          },
        });
      }

      if (error instanceof DatabaseBackupStorageProviderError) {
        // The runner refuses before it claims, so there is no row to point at.
        // A 400 rather than a 500: nothing is broken, the policy is wrong.
        throw new BadRequestException({
          message: error.message,
          details: {
            field: 'storageProvider',
            configured: error.configured,
            active: error.active,
            reason: 'storage_provider_unavailable',
          },
        });
      }

      throw error;
    }
  }

  /**
   * One page of runs, newest first.
   *
   * `orderBy: { createdAt: 'desc' }` is served by the `[status, createdAt
   * DESC]` index the retention sweep already walks, and `createdAt` rather than
   * `startedAt` because it is never null — a run that failed before it started
   * still has to appear, and it is precisely the run an operator is looking for.
   */
  async listRuns(query: BackupRunListQuery): Promise<BackupRunListResult> {
    const { page, pageSize } = query;

    const where: Prisma.DatabaseBackupRunWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.trigger) where.trigger = query.trigger;

    const [rows, total] = await Promise.all([
      this.prisma.databaseBackupRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.databaseBackupRun.count({ where }),
    ]);

    return {
      // ⚠ `toRunDto` HERE TOO, not only on the single get. The list is the path
      // most likely to be "optimised" into returning rows directly, and it is
      // the path where a raw `BigInt` reaches the serializer.
      items: rows.map(toRunDto),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * One run. The progress-polling endpoint: while a dump streams, `bytesWritten`
   * and `lastHeartbeatAt` advance about every twenty seconds.
   */
  async getRun(id: string): Promise<BackupRunResponse> {
    return toRunDto(await this.requireRun(id));
  }

  /**
   * A short-lived, pre-signed URL for the archive.
   *
   * REFUSED UNLESS THE RUN IS `completed`, and the refusal is not pedantry.
   * A `running` run's object is HALF WRITTEN — handing out a URL to it produces
   * a file that looks like an archive, downloads without error, and restores
   * nothing. A `failed` or `stale` run has had its partial object DELETED by
   * the failure path, so the URL would sign a key that does not exist and 404
   * at storage, minutes after the API said 200. Only `completed` means the
   * bytes are all there AND were read back and proved to be a readable archive.
   */
  async getDownloadUrl(id: string): Promise<BackupDownloadUrl> {
    const run = await this.requireRun(id);

    if (run.status !== 'completed') {
      throw new BadRequestException({
        message:
          `Database backup run ${id} is "${run.status}" and cannot be downloaded. Only a ` +
          'completed run has a whole archive that has been read back and verified; a ' +
          'running run\'s object is half written, and a failed one\'s was deleted.',
        details: { runId: id, status: run.status, reason: 'backup_not_completed' },
      });
    }

    const url = await this.storage.getSignedDownloadUrl(run.storageKey, {
      expiresIn: BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS,
      // The stored key's own last segment, so the saved file is named after the
      // run it came from. Derived from the key rather than composed here: the
      // key already carries the slugified application name, the timestamp and
      // the run id (see `buildBackupStorageKey`), and nothing in this
      // repository may hard-code an application name.
      responseContentDisposition: `attachment; filename="${basename(run.storageKey)}"`,
    });

    this.logger.log(
      `Issued a ${BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS}s download URL for database backup ` +
        `run ${id}.`
    );

    return { url, expiresIn: BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS };
  }

  /**
   * Deletes one run: THE ARCHIVE FIRST, THEN THE ROW.
   *
   * ⚠ THE ORDER IS THE WHOLE POINT, and it is the same order
   * `DatabaseBackupRetentionService.deleteRun` uses. The row is the ONLY index
   * of what exists in the bucket, so deleting it first and then failing to
   * delete the object leaves a multi-gigabyte orphan nothing will ever look
   * for, billed forever. In this order the worst case is the opposite and it is
   * harmless: an object gone while the row remains, which the operator can see
   * and remove.
   *
   * REFUSED FOR A `pending`/`running` ROW. That row holds the single-active-run
   * slot and its bytes are still being written: deleting it would not stop the
   * dump, and the dump would carry on streaming into a key whose row is gone —
   * an orphan created deliberately, with the active slot freed so a second dump
   * could start beside the first. Cancel it first; cancellation runs the
   * ordinary failure path, which deletes the partial object for you.
   */
  async deleteRun(id: string): Promise<DeleteBackupResult> {
    const run = await this.requireRun(id);

    if ((ACTIVE_BACKUP_STATUSES as readonly string[]).includes(run.status)) {
      throw new BadRequestException({
        message:
          `Database backup run ${id} is "${run.status}" and cannot be deleted while it holds ` +
          'the active slot and is still writing its archive. Cancel it first — cancellation ' +
          'deletes the partial object and settles the row, which can then be deleted.',
        details: { runId: id, status: run.status, reason: 'backup_active' },
      });
    }

    const objectDeleted = await this.deleteArchive(run.storageKey);

    // `deleteMany` rather than `delete` so a row that vanished under us (a
    // concurrent delete, a retention sweep that reached it first) is a 404
    // rather than an unhandled `P2025`. The archive is already gone either way,
    // which is correct: it belonged to a run that no longer exists.
    const deleted = await this.prisma.databaseBackupRun.deleteMany({ where: { id } });

    if (deleted.count === 0) throw backupRunNotFound(id);

    this.logger.log(
      `Database backup run ${id} deleted (archive "${run.storageKey}" ` +
        `${objectDeleted ? 'removed' : 'was already gone or could not be removed'}).`
    );

    return { id, objectDeleted };
  }

  /**
   * Stops a run, and REPORTS HONESTLY WHEN IT CANNOT.
   *
   * Cancellation works through a process-local child-process handle, so only
   * the replica that spawned the dump can signal it. `runner.cancel` already
   * returns a discriminated result rather than a `boolean` for exactly that
   * reason, and this method's job is to carry the distinction through to the
   * client rather than flatten it.
   *
   * ⚠ `not_running_here` IS A 200 WITH AN HONEST BODY, NOT AN ERROR STATUS.
   * Nothing about the request was wrong: the run exists, the caller may cancel
   * it, and the server understood and acted. What is true is that this process
   * holds no handle — and the operator's correct next step is NOT to retry,
   * which is what a 409 or a 503 would suggest. It is to wait for #282's
   * staleness sweep to release the slot (a run whose heartbeat has stopped is
   * marked `stale` within `runStaleMinutes`) or to reach the replica that owns
   * it. `outcome` and `detail` say so; a client that only reads the status code
   * gets "your cancel was processed", which is exactly what happened.
   */
  async cancelRun(id: string): Promise<CancelBackupResult> {
    const run = await this.requireRun(id);

    if (!(ACTIVE_BACKUP_STATUSES as readonly string[]).includes(run.status)) {
      throw new BadRequestException({
        message:
          `Database backup run ${id} has already finished (status "${run.status}") and ` +
          'cannot be cancelled.',
        details: { runId: id, status: run.status, reason: 'backup_not_active' },
      });
    }

    const result = this.runner.cancel(id);

    if (result.outcome === 'signalled') {
      this.logger.warn(`Database backup run ${id} was cancelled by an operator.`);

      return {
        runId: id,
        outcome: 'signalled',
        detail:
          'The dump process was stopped and its upload torn down. The run settles as ' +
          'failed, with its partial archive deleted, and its `db.backup.run` job settles ' +
          'as failed with it; poll the run to watch that happen.',
      };
    }

    this.logger.warn(
      `Database backup run ${id} could not be cancelled from this process: no local handle ` +
        '(it belongs to another replica, or it settled just now).'
    );

    return {
      runId: id,
      outcome: 'not_running_here',
      detail:
        'Nothing was stopped. A dump is cancelled by signalling its child process, and only ' +
        'the instance running it holds that handle — so this run has not been claimed by a ' +
        'worker yet, is executing on another instance, or has just settled. Re-read the ' +
        'run: a pending one has no dump to stop and can be cancelled once it starts, and a ' +
        'running one is released by the staleness sweep once its heartbeat stops.',
    };
  }

  // =========================================================================
  // Restore and rollback (issue #286)
  // =========================================================================

  /**
   * Runs the pre-flight and, if the gates permit it, starts the restore.
   *
   * ⚠ RETURNS AS SOON AS THE CHEAP GATES HAVE RUN. The restore itself is
   * DETACHED and takes hours — it downloads the archive, rebuilds every index
   * in the database from scratch and only then swaps — so awaiting it here
   * would produce an HTTP request measured in hours, which every proxy in the
   * stack would give up on long before it finished. The caller polls
   * `GET runs/{id}` and watches `restoreStatus`.
   *
   * ⚠ THE CONFIRMATION LITERAL IS CHECKED BY THE PIPE, NOT HERE, AND THAT IS
   * WHY NOTHING RUNS ON A BAD ONE. `StartRestoreRequestDto` declares
   * `confirmation` as a Zod literal, so a missing, misspelt or lower-case value
   * is rejected by the global `ZodValidationPipe` before this method is
   * entered — no run lookup, no cluster probe, no download. The integration
   * spec asserts exactly that: on a bad confirmation the restore service is
   * never called at all.
   *
   * ⚠ WHAT THIS METHOD ADDS THAT `DatabaseRestoreService` DOES NOT: the run
   * lookup, the `completed`-only rule, and the actor. #284 and #285 both say in
   * their headers that those belong here — they take a ROW and answer a
   * question about it, exactly as `getDownloadUrl` does.
   *
   * It does NOT re-run the gates, and must not: `startRestore` runs the
   * pre-flight itself, deliberately, so that no caller can reach a restore with
   * no gates by forgetting to.
   *
   * @throws {DatabaseRestoreRunNotFoundError} mapped to 404 by the controller.
   * @throws {DatabaseRestoreNotAllowedError} mapped to 400 by the controller.
   */
  async startRestore(
    id: string,
    options: { overrideSchemaCheck: boolean; actorUserId: string }
  ): Promise<StartRestoreResult> {
    const run = await this.requireRestorableRun(id);

    this.logger.warn(
      `Database restore of backup run ${run.id} requested by user ${options.actorUserId} ` +
        `(overrideSchemaCheck=${options.overrideSchemaCheck}).`
    );

    return this.restore.startRestore(run, {
      actorUserId: options.actorUserId,
      // The endpoint's field name maps onto the service's option name here, in
      // the ONE place that knows both. The names differ because they answer
      // different questions: the request field says what the operator is
      // waiving, the option says what the pre-flight compares.
      overrideSchemaMismatch: options.overrideSchemaCheck,
    });
  }

  /**
   * Undoes a restore, by whichever of the two routes this deployment still has.
   *
   * ⚠ THE TWO ROUTES ARE NOT COMPARABLE IN COST, which is why the result is a
   * discriminated union and not a boolean. `retain_database` renames a database
   * back and is done in SECONDS. `pre_restore_dump` has nothing to rename, so
   * it delegates into the restore path against the safety archive and takes
   * HOURS. An operator choosing to press this must be told which they got, and
   * the response's `mode` is where.
   *
   * A run that has never been restored is refused with a 400 rather than
   * answered `unavailable`: `unavailable` means "the way back has expired",
   * which is a fact about a restore that happened, and reporting it for a
   * backup nobody ever restored would be a different sentence wearing the same
   * word.
   *
   * @throws {DatabaseRestoreRunNotFoundError} mapped to 404 by the controller.
   * @throws {DatabaseRestoreNotAllowedError} mapped to 400 by the controller.
   */
  async rollbackRestore(id: string, actorUserId: string): Promise<RestoreRollbackResult> {
    const run = await this.requireRunForRestore(id);

    if (run.restoreStatus === null) {
      throw new DatabaseRestoreNotAllowedError(
        id,
        'restore_never_ran',
        `Database backup run ${id} has never been restored, so there is nothing to roll ` +
          'back. Rolling back undoes a swap that happened; restoring this archive would be a ' +
          'new restore, which is a different request.'
      );
    }

    this.logger.warn(
      `Rollback of the restore of backup run ${run.id} requested by user ${actorUserId}.`
    );

    return this.restore.rollback(run, actorUserId);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * One `completed` run, or a typed refusal.
   *
   * The `completed`-only rule is the SAME ONE `getDownloadUrl` enforces, and it
   * matters more here. A `running` run's object is half written and a `failed`
   * run's partial object was deleted by the failure path — either would be
   * downloaded without complaint and would restore nothing, but where a bad
   * download costs a wasted click, a bad restore costs hours, a safety dump and
   * a scratch database before the archive is found to be unreadable.
   *
   * (The archive's BYTES are still re-verified by the restore itself, before
   * anything is created. This check is about the row; that one is about the
   * object. Neither replaces the other.)
   */
  private async requireRestorableRun(id: string): Promise<DatabaseBackupRun> {
    const run = await this.requireRunForRestore(id);

    if (run.status !== 'completed') {
      throw new DatabaseRestoreNotAllowedError(
        id,
        'backup_not_completed',
        `Database backup run ${id} is "${run.status}" and cannot be restored. Only a ` +
          'completed run has a whole archive that was read back and proved readable; a ' +
          "running run's object is half written, and a failed one's was deleted."
      );
    }

    return run;
  }

  /**
   * One run, or the TYPED not-found error the restore routes' controller maps.
   *
   * A second lookup rather than a shared one with {@link requireRun}, and the
   * three duplicated lines are the cheap half of the trade. `requireRun` throws
   * a `NotFoundException` — a framework object — which is right for #283's
   * eight routes and wrong here: the restore path is reached from more than the
   * HTTP layer (the rollback delegation enters it from inside a running
   * restore, with no request to answer), and every status-code decision for
   * these two routes deliberately lives in one block in the controller. Making
   * `requireRun` throw a domain error instead would have turned all eight of
   * those routes into 500s unless each grew its own mapping.
   */
  private async requireRunForRestore(id: string): Promise<DatabaseBackupRun> {
    const run = await this.prisma.databaseBackupRun.findUnique({ where: { id } });

    if (run === null) throw new DatabaseRestoreRunNotFoundError(id);

    return run;
  }

  /** One run or a 404. Every route that takes an `:id` starts here. */
  private async requireRun(id: string): Promise<DatabaseBackupRun> {
    const run = await this.prisma.databaseBackupRun.findUnique({ where: { id } });

    if (run === null) throw backupRunNotFound(id);

    return run;
  }

  /**
   * The id of whichever run currently occupies the active slot, or `null`.
   *
   * A DISPLAY VALUE ONLY — see `dto/db-backup-config.dto.ts`. Nothing in this
   * service reads it to decide whether a backup may start; that decision
   * belongs to the partial unique index and to nothing else.
   */
  private async findActiveRunId(): Promise<string | null> {
    const row = await this.prisma.databaseBackupRun.findFirst({
      where: { status: { in: [...ACTIVE_BACKUP_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  /**
   * {@link computeNextRunAt}, but never throwing.
   *
   * USED ON EVERY READ PATH, and the difference matters: `GET config` is the
   * screen an operator opens TO FIX a broken timezone. If a stored zone this
   * runtime does not know made that read a 500, the only way to repair the
   * setting would be to hand-edit JSONB in production — the exact situation
   * `readKnownSettings` degrades gracefully to avoid on every other field.
   *
   * So a projection failure becomes `null` plus a log line, and the write path
   * (which is where a bad value can still be REFUSED) keeps the throw.
   */
  private projectNextRunAt(policy: SystemDatabaseBackupValue, now: Date): Date | null {
    try {
      return this.computeNextRunAt(policy, now);
    } catch (error) {
      this.logger.warn(
        `The database backup schedule could not be projected, so nextRunAt is null ` +
          `(the stored policy needs fixing): ${toError(error).message}`
      );

      return null;
    }
  }

  /**
   * When the schedule fires next, in UTC.
   *
   * `nextFireAt` does a BOUNDED day-by-day walk over CIVIL DATES in the
   * configured zone, converting each candidate to UTC independently — because
   * "the same local time tomorrow" is not a fixed number of milliseconds across
   * a DST boundary, it is 23 or 25 hours, and a projection that added
   * 86_400_000ms would drift by an hour twice a year and stay drifted. It reads
   * nothing and writes nothing: the cron in `tasks/db-backup-schedule.task.ts`
   * is the only thing that fires a backup.
   *
   * `null` when backups are DISABLED — asked before the walk, because a
   * disabled schedule has no next run to project and computing one anyway would
   * publish a time nothing is going to honour.
   *
   * ⚠ THE WRITE PATH DOES NOT USE THIS. `updateConfig` calls `nextFireAt`
   * itself, precisely so that the `enabled` short-circuit above cannot make its
   * timezone check a no-op on a deployment that has not switched backups on
   * yet — which is the state a schedule is normally configured in.
   *
   * @throws {InvalidTimezoneError} which the read path swallows. See
   * {@link projectNextRunAt}.
   */
  private computeNextRunAt(policy: SystemDatabaseBackupValue, now: Date): Date | null {
    if (!policy.enabled) return null;

    return nextFireAt(backupScheduleToCron(policy), now, policy.timezone);
  }

  /**
   * Removes one archive from storage. BEST-EFFORT, by contract.
   *
   * @returns `true` when the delete landed. `false` means storage had nothing
   * to remove or refused — see `dto/db-backup-actions.dto.ts` for why that must
   * not fail the request. Never throws: a caller that cannot delete an object
   * still has to be able to delete the row, or a missing object would leave a
   * row nobody can ever remove.
   */
  private async deleteArchive(storageKey: string): Promise<boolean> {
    try {
      await this.storage.delete(storageKey);

      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete the backup object "${storageKey}"; deleting the run row anyway so ` +
          `it does not become undeletable: ${toError(error).message}`
      );

      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The last `/`-separated segment of a storage key. */
function basename(storageKey: string): string {
  const parts = storageKey.split('/');

  return parts[parts.length - 1] || storageKey;
}

/**
 * The 404 every `:id` route answers for a run that is not there.
 *
 * The id goes in `details` and nowhere else: the exception filter rebuilds the
 * body from `message` and `details` only, so a top-level field would be dropped
 * before it reached the client. See this file's header.
 */
function backupRunNotFound(id: string): NotFoundException {
  return new NotFoundException({
    message: `Database backup run ${id} was not found.`,
    details: { runId: id },
  });
}
