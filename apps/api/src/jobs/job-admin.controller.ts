// =============================================================================
// The queue's admin routes (issue #264, epic #254)
// =============================================================================
//
// Eight routes over two services, mounted at `/api/admin/jobs`: six from #264
// over `JobAdminService`, and #265's `insights` pair over
// `JobInsightsService`. The controller does nothing but bind, document and
// authorize; every decision about what a request means lives in a service, and
// every decision about what "stuck" means lives further down still, in
// `job-stuck.service.ts`.
//
// TWO SERVICES BEHIND ONE CONTROLLER, and that is deliberate rather than
// accidental: these are one admin surface to the operator holding it — the
// same `/api/admin/jobs` prefix, the same two permissions, the same route
// table whose ORDER is the load-bearing property below. A second controller
// mounted on the same path would put half of that ordering constraint in a
// file that cannot see the other half, which is precisely how a `:id` route
// ends up shadowing a literal one. What is split is the WORK: `insights` is a
// read-only analytical surface with its own lock-safety contract (see
// `job-insights.service.ts`), and folding it into `JobAdminService` — which
// exists to retry, reset and delete rows — would put that contract in a file
// whose other half writes.
//
// -----------------------------------------------------------------------------
// ⚠ LITERAL ROUTES ARE DECLARED BEFORE `:id`, AND THE ORDER IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nest matches routes in DECLARATION ORDER, not by specificity. Move
// `@Post(':id/retry')` above `@Post('retry-failed')` and the second route
// becomes unreachable: `POST /admin/jobs/retry-failed` would match `:id/retry`
// with `id = 'retry-failed'`... except it would not even get that far, because
// `retry-failed` has no `/retry` segment — it would instead be `POST :id` if
// one existed, and `reset-stuck` genuinely WOULD be swallowed by a `:id`
// route.
//
// The failure this prevents is the nastiest kind: no error at boot, no warning
// in the log, just an operator pressing "reset stuck jobs" and getting a 400
// about a malformed UUID — or, in a version of this file where `:id` took a
// plain string, a 404 for a job whose id is the literal text `reset-stuck`.
// `test/jobs/job-admin.integration.spec.ts` asserts the order by driving
// `POST /api/admin/jobs/reset-stuck` through the real router and checking that
// the sweep ran, so re-ordering these methods fails a test rather than a
// production incident.
//
// The declaration order below is therefore: `stats`, `insights`,
// `insights/reset-history`, `retry-failed`, `reset-stuck`, `/`, then
// `:id/retry` and `:id`. Keep every literal above every parameterised route.
//
// `insights/reset-history` is two segments deep, so today it could not be
// captured by `:id` (one segment) or by `:id/retry` (whose second segment is
// literal) whatever the order — but it is declared with the other literals
// anyway. The rule that survives is "every literal above every parameterised
// route", not "every literal that would currently break"; a future `:id/:action`
// route would swallow it silently, and by then nobody is re-deriving which
// literals were safe by accident.
//
// -----------------------------------------------------------------------------
// TWO PERMISSIONS, SPLIT ON READ VERSUS WRITE
// -----------------------------------------------------------------------------
//
// `jobs:read` for `stats`, `insights` and the list; `jobs:write` for the five
// routes that change something. Both are seeded to ADMIN ONLY (`prisma/seed-data.ts`), and
// `@Auth({ roles: [ROLES.ADMIN], permissions: [...] })` states both — the role
// admits, the permission is what the guard checks. The pair is what a settings
// card's `permission` field must mirror byte-for-byte (CLAUDE.md, Settings UI
// Pattern rule 3), so the strings here are the API's half of that contract and
// must not be approximated on the other side.
//
// The split is not decoration. A read of this surface exposes job payload
// metadata, subject ids and the shape of a deployment's workload; a write can
// requeue every failed job in the queue or discard the lifetime rollup.
// `insights/reset-history` sits on the WRITE side even though it deletes no
// job and changes no job's state, because what it destroys — accumulators
// summarising rows that have already been purged — is unrecoverable by any
// other means: the evidence needed to rebuild it is exactly what the purge
// deleted. A later issue that wants to give an
// operations role visibility without control has a permission to hand out that
// does not also hand out the reset button.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { JobAdminService } from './job-admin.service';
import { JobInsightsService } from './job-insights.service';
import {
  ResetStuckDto,
  ResetStuckResultDto,
  RetryFailedDto,
  RetryFailedResultDto,
} from './dto/job-actions.dto';
import { JobListQueryDto, PROCESSED_WITHIN_VALUES } from './dto/job-list-query.dto';
import { JOB_STATUSES, JobDto } from './dto/job-response.dto';
import {
  JobInsightsDto,
  JobInsightsQueryDto,
  MAX_INSIGHTS_WINDOW_DAYS,
  ResetHistoryResultDto,
} from './dto/job-insights.dto';
import { JobStatsDto } from './dto/job-stats.dto';

@ApiTags('Jobs')
@Controller('admin/jobs')
export class JobAdminController {
  constructor(
    private readonly jobs: JobAdminService,
    private readonly insights: JobInsightsService
  ) {}

  // -------------------------------------------------------------------------
  // Literal routes. These MUST stay above `:id` — see the file header.
  // -------------------------------------------------------------------------

  @Get('stats')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'Summarize the job queue',
    description:
      'Totals, a per-status breakdown, a per-type breakdown with display labels, how many ' +
      'pending jobs are waiting out a backoff, and how many running jobs the lease reaper ' +
      'would reclaim right now. `stuckRunning` is counted with the reaper\'s own predicate, ' +
      'against the threshold reported as `stuckThresholdMinutes`, so the number here and the ' +
      'rows a reset would touch can never disagree. Cached in-process for about two seconds — ' +
      'shorter than any sensible dashboard poll, so a deliberate refresh always sees fresh counts.',
  })
  @ApiResponse({ status: 200, description: 'Queue summary', type: JobStatsDto })
  async stats(): Promise<unknown> {
    return this.jobs.stats();
  }

  @Get('insights')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'Analyse queue throughput and estimate completion',
    description:
      'Answers the two questions the summary cannot: how long the outstanding work will take, ' +
      'and whether the queue is getting faster or slower. Returns live counts (including how ' +
      'many jobs are scheduled, rate-limited or retried), duration percentiles over succeeded ' +
      'jobs in the window, a per-type completion estimate, and all-time totals merged from the ' +
      'lifetime rollup. Computed on demand from pure `SELECT`s, so it never blocks the worker ' +
      'pool it reports on — there is no snapshot table and no background refresh. Each ' +
      'estimate carries a `basis` saying whether it used that type\'s own history (`live`), ' +
      'the overall average (`partial`), or no history at all (`none`). Lifetime figures are ' +
      'counts and averages only: percentiles cannot be reconstructed from purged history.',
  })
  @ApiQuery({
    name: 'windowDays',
    required: false,
    type: Number,
    description: `Days of history the percentiles cover. Default 7, max ${MAX_INSIGHTS_WINDOW_DAYS}.`,
  })
  @ApiResponse({ status: 200, description: 'Queue insights', type: JobInsightsDto })
  @ApiResponse({ status: 400, description: 'windowDays out of range' })
  async getInsights(@Query() query: JobInsightsQueryDto): Promise<unknown> {
    return this.insights.insights(query);
  }

  @Post('insights/reset-history')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear the lifetime statistics rollup',
    description:
      'Deletes every `JobStatsRollup` row — the accumulators that preserve counts and durations ' +
      'for jobs the history purge has already deleted — and returns how many were removed (one ' +
      'per job type, not one per job). Live job rows are NOT touched: no job is deleted, no ' +
      'job changes state, and every live-derived number in the insights response is identical ' +
      'afterwards. Lifetime totals simply restart from the rows still in the table. Intended ' +
      'for a rollup that has been corrupted or seeded with fictional history, which nothing ' +
      'else can correct because the rows that would disprove it were purged.',
  })
  @ApiResponse({ status: 200, description: 'Rollup rows deleted', type: ResetHistoryResultDto })
  async resetInsightsHistory(): Promise<unknown> {
    return this.insights.resetHistory();
  }

  @Post('retry-failed')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry every failed job',
    description:
      'Moves failed jobs back to `pending` with their attempt and rate-limit budgets reset. ' +
      'Pass `type` to restrict the sweep to one job type. Idempotent: a job it retries is no ' +
      'longer failed, so calling it twice is harmless. A job whose deduplication key is already ' +
      'held by a pending or running job is counted in `skipped` rather than retried — the work ' +
      'it describes is already queued. At most 500 rows per call; check `remaining`.',
  })
  @ApiResponse({ status: 200, description: 'What the sweep did', type: RetryFailedResultDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async retryFailed(@Body() dto: RetryFailedDto): Promise<unknown> {
    return this.jobs.retryFailed(dto.type);
  }

  @Post('reset-stuck')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reclaim jobs abandoned by their executor',
    description:
      'Runs the lease reaper on demand: running jobs whose claim has aged out, whose lease has ' +
      'expired, or that were never stamped at all are requeued, and those that have already ' +
      'spent their attempt budget are failed permanently. Send an empty body to use the ' +
      '`jobs.stuckThresholdMinutes` system setting — the same threshold the scheduled sweep ' +
      'uses. `olderThanMinutes` overrides it for this call only, and is echoed back as ' +
      '`thresholdMinutes`.',
  })
  @ApiResponse({ status: 200, description: 'What the sweep did', type: ResetStuckResultDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async resetStuck(@Body() dto: ResetStuckDto): Promise<unknown> {
    return this.jobs.resetStuck(dto.olderThanMinutes);
  }

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'List jobs',
    description:
      'Newest first, filterable and paginated. `scheduled=true` selects pending jobs waiting ' +
      'out a backoff and OVERRIDES any `status` sent with it, because a job in backoff is ' +
      'pending by definition. `processedWithin` filters on when a job last did something — ' +
      '`finishedAt`, falling back to `createdAt` — so a job enqueued days ago that failed a ' +
      'minute ago still appears in the 4-hour window. Job payloads are not included.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiQuery({ name: 'status', required: false, enum: JOB_STATUSES })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'subjectType', required: false, type: String })
  @ApiQuery({ name: 'subjectId', required: false, type: String })
  @ApiQuery({
    name: 'scheduled',
    required: false,
    enum: ['true', 'false'],
    description: 'true selects pending jobs in backoff and overrides `status`.',
  })
  @ApiQuery({ name: 'processedWithin', required: false, enum: PROCESSED_WITHIN_VALUES })
  @ApiDataResponse(JobDto, { pagination: 'flat', description: 'Paginated job list' })
  async list(@Query() query: JobListQueryDto): Promise<unknown> {
    return this.jobs.list(query);
  }

  // -------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // -------------------------------------------------------------------------

  @Post(':id/retry')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry one job',
    description:
      'Resets the job to `pending` with its attempt count, error, schedule, rate-limit counters ' +
      'and claim all cleared, so any worker may take it immediately. Refused for a running job: ' +
      'an executor may still be working on it, and resetting the row would let a second worker ' +
      'take the same job. Use reset-stuck for a job whose executor is gone — it checks the lease.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The job as it now stands', type: JobDto })
  @ApiResponse({ status: 400, description: 'The job is running and cannot be retried' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({
    status: 409,
    description: 'Another pending or running job already holds this job\'s deduplication key',
  })
  async retry(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.jobs.retry(id);
  }

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete one job',
    description:
      'Removes the row. Refused for a running job: deleting it would not stop its executor, ' +
      'which would then finish, find no row to write to, and leave work that ran with no record ' +
      'that it existed — while its freed deduplication key let a duplicate be enqueued.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Job deleted' })
  @ApiResponse({ status: 400, description: 'The job is running and cannot be deleted' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.jobs.remove(id);
  }
}
