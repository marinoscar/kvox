// =============================================================================
// /api/admin/db-backup — the backup subsystem's admin routes (issues #283, #286)
// =============================================================================
// (epic #254)
//
// Eleven routes over one service, mounted under `admin/`: eight that manage
// backups (#283), two that RESTORE from one (#286), and one that reports
// whether a worker node could be given a credential to take one (#350). The controller does
// nothing but bind, document and authorize; every decision about what a request
// MEANS lives in `db-backup-admin.service.ts`, and every decision about what a
// backup IS lives further down still, in `db-backup-runner.service.ts`. The one
// exception is stated below and argued there: the restore pair's error mapping
// is here on purpose.
//
// MOUNTED AT `admin/db-backup` AND NOT AT `db-backup`, for the reason
// `NodesAdminController` gives about its own prefix: `JwtAuthGuard` treats
// path prefixes as part of what a non-session credential may reach, and a
// surface that hands out signed URLs to complete copies of the database belongs
// outside every such allowlist by construction rather than by a check somebody
// has to remember to write.
//
// -----------------------------------------------------------------------------
// ⚠ EVERY LITERAL ROUTE IS DECLARED ABOVE EVERY PARAMETERISED ROUTE, AND THE
// ORDER IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nest matches routes in DECLARATION ORDER, not by specificity. So the order
// below is: `config` (GET, PUT), `runs` (POST, GET) and
// `node-credential-preflight` (GET) first, and only then the
// parameterised block — `runs/:id/download`, `runs/:id/cancel`,
// `runs/:id/restore`, `runs/:id/rollback`, `runs/:id` (GET) and `runs/:id`
// (DELETE), deepest first inside that block for the same reason.
//
// BE HONEST ABOUT TODAY: every literal here is ONE segment past the prefix
// (`config`, `runs`, `node-credential-preflight`), while every parameterised
// route is two or three
// (`runs/:id`, `runs/:id/download`), so no transposition of the methods in this
// file would currently shadow anything. That is a property of the CURRENT route
// table, not a rule — and it is exactly the reasoning that produces the bug the
// next time somebody adds `@Get(':id')` at the prefix root, or a `runs/:id/:x`
// route that would silently swallow `runs/latest`.
//
// The rule that survives is therefore the one `job-admin.controller.ts` and
// `nodes-admin.controller.ts` both state — EVERY LITERAL ABOVE EVERY
// PARAMETERISED ROUTE — and not "every literal that would currently break". The
// failure it prevents is the nastiest kind: no error at boot, no warning in the
// log, just an operator pressing a button and being told
// `400 Validation failed (uuid is expected)` by `ParseUUIDPipe`, in a file
// nobody would think to open. `test/db-backup/db-backup-admin.integration
// .spec.ts` drives `GET /api/admin/db-backup/config` through the real router
// and asserts it resolved as the config route, so re-ordering these methods
// fails a test rather than a production incident.
//
// -----------------------------------------------------------------------------
// ⚠ TWO OF THESE TEN ROUTES ARE THE ONE PLACE IN THIS APPLICATION WHERE A
// MIS-FIRED OR RETRIED REQUEST IS AN OUTAGE RATHER THAN A DUPLICATE ROW
// -----------------------------------------------------------------------------
//
// `POST runs/:id/restore` and `POST runs/:id/rollback` (#286) replace the
// production database. Every other write in this API, sent twice, costs at
// worst a wasted row. These cost the deployment. Three consequences run through
// everything below and are not negotiable:
//
//   1. A TYPED CONFIRMATION LITERAL, checked by the global validation pipe
//      before any handler code runs. `{"confirmation":"RESTORE"}` and
//      `{"confirmation":"ROLLBACK"}` — deliberately different words, so a body
//      copied from one route to the other is refused. A missing or wrong
//      confirmation is a `400` HAVING STARTED NOTHING: no run lookup, no
//      cluster probe, no download. `dto/db-backup-restore.dto.ts` argues at
//      length why a boolean `confirm: true` was rejected.
//   2. THE STATUS CODE IS NOT THE ANSWER; `mode` IS. Each route has THREE
//      NORMAL OUTCOMES and all of them are `200`. In particular `guided` — the
//      capability-gate path that hands back a paste-ready command block — MUST
//      NOT be an error status: it is the expected answer on managed PostgreSQL
//      that denies `CREATEDB`, and a 4xx would tell an operator mid-incident
//      that their platform is unsupported when it is not.
//   3. THE ERROR MAPPING LIVES HERE, IN THIS FILE, and that is a departure from
//      the other eight routes whose service raises `NotFoundException` itself.
//      `DatabaseBackupAdminService`'s restore pair throws DOMAIN errors instead,
//      because the restore path is reached from more than the HTTP layer — a
//      rollback in `pre_restore_dump` mode re-enters `startRestore` from inside
//      a running restore, where there is no request to answer — and a framework
//      exception raised there would be an HTTP object with nowhere to go. The
//      mapping is: not-found → 404, not-allowed → 400, and the
//      `already_running` RESULT → 409 carrying `details.activeRunId`.
//
// -----------------------------------------------------------------------------
// THREE PERMISSIONS, AND THE THIRD IS WITHHELD ON PURPOSE
// -----------------------------------------------------------------------------
//
// `db_backup:read` for the config read, the list, the single get, the download
// and #350's node-credential pre-flight (a probe that creates nothing); `db_backup:write` for the config write, the manual trigger, the
// cancel and the delete; `db_backup:restore` — AND NOT `db_backup:write` — for
// the restore and the rollback.
//
// ⚠ THE SPLIT IS THE WHOLE POINT OF THE THIRD PERMISSION. Scheduling backups
// and replacing the production database are not the same authority, and a
// deployment must be able to grant the first to somebody it does not trust with
// the second: an operator who configures the nightly dump, an on-call engineer
// who takes an ad-hoc backup before a deploy. Folding restore under
// `db_backup:write` would spend the one permission whose entire purpose is to
// be granted separately and on purpose, and it would do so invisibly — every
// existing holder of `db_backup:write` would silently acquire the ability to
// replace the database. There is an explicit test that drives both routes as a
// user holding `db_backup:write` and expects `403`.
//
// All three are additionally gated on the Admin role, matching
// `job-admin.controller.ts` and `nodes-admin.controller.ts`: the ROLE admits,
// the PERMISSION is what the guard checks. These exact strings are the API's
// half of the contract a settings card's `permission` field must mirror byte
// for byte (CLAUDE.md, Settings UI Pattern rule 3), so they must not be
// approximated on the other side.
//
// THE DOWNLOAD SITS ON THE READ SIDE, which is worth stating because it is the
// most powerful thing on this controller: the URL it returns is a
// credential-free capability over a complete copy of the database. It is still
// a read — it changes nothing — and inventing a third gate for it would mean
// `db_backup:read` grants the ability to see that a backup exists but not to
// use it, which is a distinction no deployment has asked for and which the
// short expiry in `BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS` addresses better. What
// makes this acceptable is that `db_backup:read` is seeded to ADMIN ONLY.
// =============================================================================

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { DatabaseBackupAdminService } from './db-backup-admin.service';
import {
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreRunNotFoundError,
} from './db-backup.errors';
import {
  BackupDownloadUrlDto,
  CancelBackupResultDto,
  DeleteBackupResultDto,
} from './dto/db-backup-actions.dto';
import {
  DatabaseBackupConfigDto,
  UpdateDatabaseBackupConfigDto,
} from './dto/db-backup-config.dto';
import { BackupRunListQueryDto } from './dto/db-backup-list-query.dto';
import { NodeCredentialPreflightDto } from './dto/db-backup-node-credential.dto';
import {
  ROLLBACK_RESPONSE_DTOS,
  RollbackRestoreRequestDto,
  START_RESTORE_RESPONSE_DTOS,
  StartRestoreRequestDto,
  toRollbackResponse,
  toStartRestoreResponse,
} from './dto/db-backup-restore.dto';
import {
  BACKUP_STATUSES,
  BACKUP_TRIGGERS,
  DatabaseBackupRunDto,
} from './dto/db-backup-run.dto';

@ApiTags('Database Backup')
@Controller('admin/db-backup')
export class DatabaseBackupController {
  constructor(private readonly backups: DatabaseBackupAdminService) {}

  // ---------------------------------------------------------------------------
  // Literal routes. Nothing parameterised may be declared above this block —
  // see the file header.
  // ---------------------------------------------------------------------------

  @Get('config')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'Read the backup policy, and when it will next fire',
    description:
      'The stored `databaseBackup` settings namespace plus two fields that are computed on ' +
      'every read and stored nowhere. `nextRunAt` is the next instant the schedule is due, in ' +
      'UTC, projected by the same function the scheduler itself uses — so an administrator can ' +
      'confirm a schedule immediately instead of waiting a day to discover it was wrong. It ' +
      'walks calendar days in the configured timezone and converts each candidate to UTC ' +
      'independently, which is correct on both sides of a daylight-saving transition. It is ' +
      '`null` when backups are disabled, and also `null` when the stored timezone is one this ' +
      'runtime cannot resolve — this endpoint stays a 200 in that case precisely so the screen ' +
      'that can fix the setting still loads. `activeRunId` names the run currently holding the ' +
      'single-active-run slot; treat it as a display value, never as a pre-flight check, ' +
      'because the slot can be claimed by another instance between this read and your write.',
  })
  @ApiResponse({
    status: 200,
    description: 'The policy, plus nextRunAt and activeRunId',
    type: DatabaseBackupConfigDto,
  })
  async getConfig(): Promise<unknown> {
    return this.backups.getConfig();
  }

  @Put('config')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @ApiOperation({
    summary: 'Update the backup policy',
    description:
      'A PARTIAL update: every field is optional and anything omitted keeps its stored value, ' +
      'so changing the hour does not require echoing back the whole policy. Writes through the ' +
      'system-settings service, which owns the merge and the row version, so this is not a ' +
      'second writer of that column. Two values are refused here rather than hours later ' +
      'inside a cron tick, because a bad one fails silently at 02:00 rather than at save time: ' +
      'a `timezone` this runtime cannot resolve (checked by performing the real schedule ' +
      'projection, so a timezone that saves is a timezone that schedules) and a ' +
      '`storageProvider` naming something other than the deployment\'s active provider (leave ' +
      'it empty to mean "whichever is active"). Both are a 400 with the offending field named ' +
      'in `details`. Returns exactly the body `GET config` returns, with `nextRunAt` ' +
      'recomputed, so the response shows the instant the change takes effect.',
  })
  @ApiResponse({
    status: 200,
    description: 'The policy as it now stands',
    type: DatabaseBackupConfigDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, an unknown timezone, or a storage provider this deployment lacks',
  })
  async updateConfig(
    @Body() dto: UpdateDatabaseBackupConfigDto,
    @CurrentUser('id') userId: string
  ): Promise<unknown> {
    return this.backups.updateConfig(dto, userId);
  }

  // `202 Accepted` and not `201 Created`, deliberately. A `201` would say the
  // thing the caller asked for now exists — and what exists is a CLAIM, not a
  // backup: the dump is still streaming and may yet fail verification. `202` is
  // precisely "understood, started, not finished", which is what the returned
  // run's `running` status and its heartbeat then let the caller follow.
  @Post('runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Take a backup now',
    description:
      'Claims the single active run slot and returns IMMEDIATELY with the new run, already ' +
      '`running`, while the dump streams into object storage in the background. It cannot be ' +
      'synchronous: a dump of a real database takes tens of minutes and every proxy in front ' +
      'of this API has a response timeout measured in seconds. Poll `GET runs/{id}` for ' +
      'progress — `bytesWritten` and `lastHeartbeatAt` advance about every twenty seconds. ' +
      'A `409` means a backup is already in flight; the id of that run is in ' +
      '`details.activeRunId`. The slot is arbitrated by a partial unique index in Postgres, ' +
      'so this answer is correct even when a scheduled run on another instance claims it in ' +
      'the same second.',
  })
  @ApiResponse({
    status: 202,
    description: 'The claimed run; the dump is still streaming',
    type: DatabaseBackupRunDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The configured storage provider is not the active one',
  })
  @ApiResponse({
    status: 409,
    description: 'A backup is already running; see `details.activeRunId`',
  })
  async startRun(@CurrentUser('id') userId: string): Promise<unknown> {
    return this.backups.startRun(userId);
  }

  @Get('runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'List backup runs',
    description:
      'Newest first, filterable by status and trigger, paginated. One row per attempt, ' +
      'including the ones that failed — a failed run carries how far it got in `bytesWritten` ' +
      'and why it stopped in `lastError`, which is the pair an operator triages with. Byte ' +
      'counts are DECIMAL STRINGS, not numbers: they are 64-bit columns and a JSON number ' +
      'rounds above 2^53.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiQuery({ name: 'status', required: false, enum: BACKUP_STATUSES })
  @ApiQuery({ name: 'trigger', required: false, enum: BACKUP_TRIGGERS })
  @ApiDataResponse(DatabaseBackupRunDto, {
    pagination: 'flat',
    description: 'Paginated backup run list',
  })
  async listRuns(@Query() query: BackupRunListQueryDto): Promise<unknown> {
    return this.backups.listRuns(query);
  }

  @Get('node-credential-preflight')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'Can a worker node be given a credential to take this backup?',
    description:
      'Answers, without changing anything, whether this deployment can hand a worker node a ' +
      'SHORT-LIVED, SELECT-ONLY PostgreSQL role for the duration of one `db.backup.run` job — ' +
      'the credential epic #345 needs in order to execute a dump off the API server. Two ' +
      'independent facts come back and they mean different things: `outcome` is the ' +
      'CAPABILITY (a live probe of whether this API\'s database role may `CREATE ROLE`), and ' +
      '`brokerEnabled` is the POLICY (`nodes.jobSecretBrokerEnabled`, default off, which is an ' +
      'administrator\'s decision that the fleet is inside the trust boundary). ' +
      '⚠ `outcome: "guided"` IS A 200 AND NOT AN ERROR: managed PostgreSQL withholding ' +
      '`CREATEROLE` from an application role is the ordinary configuration, and the honest ' +
      'answer is two lines of SQL in `guidance.commands` — not a status code saying the ' +
      'platform is unsupported. A deployment that declines to run them simply leaves node ' +
      'offload off and the API keeps taking its own backups. The node also needs a NETWORK ' +
      'ROUTE to PostgreSQL, which this endpoint cannot see and deliberately does not tunnel; ' +
      'see the runbook named in `guidance.runbook`.',
  })
  @ApiResponse({
    status: 200,
    description: 'The capability verdict, the policy, and the SQL that fixes a `guided` one',
    type: NodeCredentialPreflightDto,
  })
  async getNodeCredentialPreflight(): Promise<unknown> {
    return this.backups.getNodeCredentialPreflight();
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // ---------------------------------------------------------------------------

  @Get('runs/:id/download')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'Get a signed URL for one archive',
    description:
      'Returns a short-lived pre-signed URL that downloads the archive DIRECTLY FROM OBJECT ' +
      'STORAGE; the bytes never transit this API, which is the only workable shape for a file ' +
      'the size of a whole database. Treat the URL as a credential: anyone holding it can ' +
      'fetch a complete copy of this deployment\'s data with no token at all, which is why it ' +
      'expires in minutes — the expiry is checked when the download STARTS, so a slow transfer ' +
      'is not affected. Refused with a `400` unless the run is `completed`: a running run\'s ' +
      'object is half written, and a failed run\'s partial object was deleted by the failure ' +
      'path, so either URL would produce a file that is not a restorable archive.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'A signed, expiring URL', type: BackupDownloadUrlDto })
  @ApiResponse({ status: 400, description: 'The run is not completed' })
  @ApiResponse({ status: 404, description: 'No such run' })
  async download(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.backups.getDownloadUrl(id);
  }

  @Post('runs/:id/cancel')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a running backup',
    description:
      'Stops the dump and tears down its upload, after which the run travels the ORDINARY ' +
      'failure path — partial archive deleted, row marked `failed` — because cancellation is ' +
      'deliberately not a second teardown mechanism. READ `outcome`, NOT ONLY THE STATUS ' +
      'CODE. A dump is stopped by signalling a child process, and only the API instance that ' +
      'started it holds that handle, so a run executing on another instance cannot be stopped ' +
      'from here: that answers `200` with `outcome: "not_running_here"` and changes nothing. ' +
      'It is not an error and retrying will not help — the staleness sweep releases the slot ' +
      'once the run\'s heartbeat stops. A run that has already finished is a `400`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'What the cancel actually managed; check `outcome`',
    type: CancelBackupResultDto,
  })
  @ApiResponse({ status: 400, description: 'The run has already finished' })
  @ApiResponse({ status: 404, description: 'No such run' })
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.backups.cancelRun(id);
  }

  // ---------------------------------------------------------------------------
  // ⚠ The two destructive routes (#286). Read this file's header first.
  // ---------------------------------------------------------------------------

  @Post('runs/:id/restore')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_RESTORE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore the database from this backup',
    description:
      'REPLACES THE PRODUCTION DATABASE. Requires `db_backup:restore`, which is a SEPARATE ' +
      'permission from `db_backup:write` precisely so it can be withheld from someone who ' +
      'may schedule backups but must not be able to replace the database.\n\n' +
      'The body must be exactly `{"confirmation":"RESTORE"}` (plus an optional ' +
      '`overrideSchemaCheck`). The literal is the safety feature: a retried, replayed or ' +
      'mis-fired POST cannot reconstruct it by accident, and a missing or wrong confirmation ' +
      'is a `400` that starts NOTHING — no pre-flight, no download, no row.\n\n' +
      'Returns as soon as the cheap pre-flight gates have run. ⚠ READ `mode`, NOT ONLY THE ' +
      'STATUS CODE: all three normal outcomes are `200`.\n\n' +
      '`running` — the gates passed and the restore is under way in the background. It takes ' +
      'HOURS (every index is rebuilt from the archive), so poll `GET runs/{id}` and watch ' +
      '`restoreStatus`: `restoring` → `verifying` → `swapping` → `completed`/`failed`. The ' +
      'application serves normally throughout; the only destructive window is two catalog ' +
      'renames long, and the process exits at the end of it so its connection pool can be ' +
      'rebuilt — a restart policy is a hard prerequisite.\n\n' +
      '`guided` — a CAPABILITY gate failed (typically the role lacks `CREATEDB`, which ' +
      'managed PostgreSQL routinely denies). Nothing was started. This is NOT an error: the ' +
      'body carries a complete, paste-ready command block with real names, hosts and ports, ' +
      'plus a runbook path, so the same restore can be performed by hand with a superuser.\n\n' +
      '`blocked` — the schema-compatibility gate refused. Nothing was started. Compare ' +
      '`preflight.archiveMigration` with `preflight.liveMigration` and, if you accept the ' +
      'mismatch, re-send with `overrideSchemaCheck: true`. ⚠ That flag unblocks THAT GATE ' +
      'AND NOTHING ELSE — it can never bypass a capability gate, because no amount of ' +
      'accepting makes a role without `CREATEDB` able to create a database.\n\n' +
      '`preflight.gates` lists EVERY gate that ran, including the ones that passed, so an ' +
      'operator can see what was checked rather than only what failed.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(START_RESTORE_RESPONSE_DTOS, {
    description: 'One of `running`, `guided` or `blocked`; read `mode`',
  })
  @ApiResponse({
    status: 400,
    description:
      'The confirmation was missing or wrong (nothing was started), or the run is not a ' +
      'completed backup',
  })
  @ApiResponse({ status: 404, description: 'No such run' })
  @ApiResponse({
    status: 409,
    description: 'A restore is already in flight; see `details.activeRunId`',
  })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartRestoreRequestDto,
    @CurrentUser('id') userId: string
  ): Promise<unknown> {
    // `dto.confirmation` is NOT re-checked here, and looking for the check is
    // the natural reaction to reading this method. It has already happened:
    // `confirmation` is a Zod literal on the DTO and the global
    // `ZodValidationPipe` rejects anything else before this body executes. A
    // second check would be dead code that implied the first one was not
    // trusted; the integration spec asserts the real one by proving the service
    // is never reached on a bad confirmation.
    try {
      const result = await this.backups.startRestore(id, {
        overrideSchemaCheck: dto.overrideSchemaCheck,
        actorUserId: userId,
      });

      if (result.outcome === 'already_running') {
        // ⚠ `activeRunId` GOES UNDER `details`. At the top level the exception
        // filter would drop it before the body reached the client, and the
        // operator who just clicked would be told "one is already running" with
        // no way to find out which. Same rule, same reason, as `POST runs`.
        throw new ConflictException({
          message:
            `A database restore is already in flight (backup run ${result.runId}). Wait for ` +
            'it to finish, or poll that run to see where it is.',
          details: {
            activeRunId: result.runId,
            reason: 'restore_already_running',
          },
        });
      }

      return toStartRestoreResponse(result);
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  @Post('runs/:id/rollback')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_RESTORE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo the restore that was performed from this backup',
    description:
      'Requires `db_backup:restore`, the same separate permission the restore route uses. ' +
      'The body must be exactly `{"confirmation":"ROLLBACK"}` — a DIFFERENT word from the ' +
      'restore route\'s, so a body copied from one to the other is refused rather than ' +
      'silently accepted.\n\n' +
      '⚠ READ `mode`: the two routes back are not comparable in cost, and which one you got ' +
      'is the single most important fact in the response.\n\n' +
      '`renamed` — `retain_database` mode. The database the restore displaced was renamed ' +
      'back into place. SECONDS. This is what paying roughly double the PostgreSQL volume ' +
      'during `oldDatabaseRetentionHours` buys.\n\n' +
      '`restore_started` — `pre_restore_dump` mode. There was no database to rename, so this ' +
      'delegated into the restore path against the safety backup taken immediately before ' +
      'the swap, WITH THE SCHEMA CHECK OVERRIDDEN (that dump came from the schema the code ' +
      'was running moments earlier, so a compatibility block would be spurious). HOURS. Poll ' +
      '`GET runs/{preRestoreRunId}`, not this run.\n\n' +
      '`unavailable` — the retained database has passed its retention window and been ' +
      'dropped, and there is no completed pre-restore backup to fall back on. Reported ' +
      'honestly as a `200` rather than as a failure: nothing went wrong just now, the ' +
      'rollback window simply closed, and retrying will not change it. Restoring some other ' +
      'archive is a new restore, not a rollback.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(ROLLBACK_RESPONSE_DTOS, {
    description: 'One of `renamed`, `restore_started` or `unavailable`; read `mode`',
  })
  @ApiResponse({
    status: 400,
    description:
      'The confirmation was missing or wrong (nothing was started), or this run was never ' +
      'restored so there is no swap to undo',
  })
  @ApiResponse({ status: 404, description: 'No such run' })
  @ApiResponse({
    status: 409,
    description: 'A restore is already in flight; see `details.activeRunId`',
  })
  async rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: RollbackRestoreRequestDto,
    @CurrentUser('id') userId: string
  ): Promise<unknown> {
    // `_dto` is bound and never read ON PURPOSE. Binding it is what makes the
    // pipe validate `confirmation`; the value itself carries no information
    // beyond "the caller typed the word", which the literal has already proved.
    // Dropping the parameter would drop the safety check with it.
    try {
      return toRollbackResponse(await this.backups.rollbackRestore(id, userId));
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  @Get('runs/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'Get one backup run',
    description:
      'The progress-polling endpoint. While a dump streams, `bytesWritten` and ' +
      '`lastHeartbeatAt` advance about every twenty seconds; when it finishes, `sizeBytes`, ' +
      '`checksumSha256` and `verifiedAt` are written together. `verifiedAt` is the field worth ' +
      'reading first: it is set only after the UPLOADED object was streamed back and proved to ' +
      'be a readable archive, so a completed run carrying it has been shown restorable-shaped ' +
      'at least once.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The run', type: DatabaseBackupRunDto })
  @ApiResponse({ status: 404, description: 'No such run' })
  async getRun(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.backups.getRun(id);
  }

  @Delete('runs/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete one backup run and its archive',
    description:
      'Removes the archive from object storage FIRST and the row SECOND. The row is the only ' +
      'index of what exists in the bucket, so the reverse order would leave a multi-gigabyte ' +
      'object nothing points at, billed forever. The object delete is best-effort and the ' +
      'response reports it as `objectDeleted`: `false` means storage had nothing to remove (or ' +
      'refused), the row is gone regardless, and a missing object therefore cannot leave a row ' +
      'that nobody can delete. Refused with a `400` while the run is `pending` or `running` — ' +
      'that row holds the active slot and its bytes are still being written, and deleting it ' +
      'would not stop the dump. Cancel it first; cancellation deletes the partial object for ' +
      'you. Returns a body rather than `204` because `objectDeleted` is a fact no status code ' +
      'can carry.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'The run was deleted; `objectDeleted` says what happened in storage',
    type: DeleteBackupResultDto,
  })
  @ApiResponse({ status: 400, description: 'The run is active and cannot be deleted' })
  @ApiResponse({ status: 404, description: 'No such run' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.backups.deleteRun(id);
  }

  // ---------------------------------------------------------------------------
  // Error mapping for the two restore routes
  // ---------------------------------------------------------------------------

  /**
   * The restore path's domain errors, as HTTP.
   *
   * ⚠ THIS MAPPING LIVES IN THE CONTROLLER BECAUSE THE SERVICE IS CALLED FROM
   * MORE THAN THE HTTP LAYER. `DatabaseRestoreService.rollback` re-enters
   * `startRestore` from inside a running restore in `pre_restore_dump` mode,
   * where the request that began everything was answered hours ago; #287 will
   * reach the same code again. A `NotFoundException` raised down there would be
   * a framework object on a path with no response to attach it to — it would be
   * caught, logged as an unexpected failure, and mean nothing. Keeping the
   * errors as domain types lets every caller decide for itself, and keeps all
   * of this surface's status-code policy in one screen next to the OpenAPI
   * annotations that publish it.
   *
   * Anything not recognised is RETHROWN UNCHANGED, which matters: the
   * `ConflictException` the restore handler raises for `already_running` passes
   * straight through here rather than being flattened into a 500 by a
   * catch-all.
   *
   * The identifying data goes under `details` and nowhere else — the exception
   * filter rebuilds every body from `message` and `details` alone, so a
   * top-level field is silently dropped before the client sees it. See
   * `db-backup-admin.service.ts`'s header.
   */
  private toHttp(error: unknown): unknown {
    if (error instanceof DatabaseRestoreRunNotFoundError) {
      return new NotFoundException({
        message: error.message,
        details: { runId: error.runId, reason: 'backup_run_not_found' },
      });
    }

    if (error instanceof DatabaseRestoreNotAllowedError) {
      // A 400 rather than a 409: nothing is in conflict and nothing is broken.
      // The request named a row that is not a thing this operation acts on, and
      // no amount of waiting or retrying changes that.
      return new BadRequestException({
        message: error.message,
        details: { runId: error.runId, reason: error.reason },
      });
    }

    return error;
  }
}
