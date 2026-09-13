/**
 * The job queue's admin API, as the web app sees it (issue #266, epic #254).
 *
 * ONE MODULE FOR EIGHT ROUTES, and not eight more functions bolted onto
 * `services/api.ts`. That file is the transport (`ApiService`, the refresh
 * dance, the maintenance recogniser) plus the endpoints that predate the
 * convention; this epic's surface is large enough — a list, a summary, an
 * analytical read and five writes — that keeping it together is what lets the
 * types below sit next to the calls that produce them. Everything here still
 * goes through the shared `api` client, so a job request inherits the token
 * refresh, the 401 retry and the maintenance interception exactly like every
 * other call in the app.
 *
 * =============================================================================
 * THE TYPES ARE MIRRORS OF `apps/api/src/jobs/dto/`, NOT AN INVENTION
 * =============================================================================
 *
 * Every interface below is the TypeScript shadow of a Zod schema on the API
 * side, field for field and nullability for nullability:
 *
 *   `Job`                → `jobSchema`                (dto/job-response.dto.ts)
 *   `JobListResponse`    → `@ApiDataResponse(JobDto, { pagination: 'flat' })`
 *   `JobStats`           → `jobStatsSchema`           (dto/job-stats.dto.ts)
 *   `JobInsights`        → `jobInsightsSchema`        (dto/job-insights.dto.ts)
 *   `RetryFailedResult`  → `retryFailedResultSchema`  (dto/job-actions.dto.ts)
 *   `ResetStuckResult`   → `resetStuckResultSchema`   (dto/job-actions.dto.ts)
 *   `ResetHistoryResult` → `resetHistoryResultSchema` (dto/job-insights.dto.ts)
 *
 * The nullable numbers are the ones worth being careful about. `avgMs`,
 * `p50Ms` and `p95Ms` are `number | null` because a type with no succeeded
 * jobs in the window has no average — and the API's own header says why zero
 * would be a lie: a UI renders "0 ms" as a measurement, and the ETA multiplies
 * that number by a queue depth. Typing them as `number` here and defaulting
 * with `?? 0` at a call site would reintroduce exactly that, one component at
 * a time. `samples` is the field that says whether the other three mean
 * anything, and it is always a number.
 *
 * =============================================================================
 * WHY THERE IS NO `sortBy` PARAMETER
 * =============================================================================
 *
 * `GET /api/admin/jobs` orders by `createdAt DESC` and offers nothing else —
 * deliberately, per `job-admin.service.ts`: a sortable column set needs an
 * index per column to stay usable at the sizes a queue reaches. So this module
 * has no sort argument to pass, and `pages/Admin/jobsTable.tsx` correspondingly
 * declares no `sortable` column. A sort control the endpoint cannot answer is
 * the same failure as a filter it cannot answer — it looks live and does
 * nothing.
 */

import { api } from './api';

// =============================================================================
// Enumerations — the API's own, restated so a bad value cannot compile
// =============================================================================

/** `JOB_STATUSES` in `dto/job-response.dto.ts`. */
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type JobStatusName = (typeof JOB_STATUSES)[number];

/** `JOB_REASONS` in `dto/job-response.dto.ts`. */
export const JOB_REASONS = ['upload', 'rerun', 'backfill'] as const;
export type JobReasonName = (typeof JOB_REASONS)[number];

/** `PROCESSED_WITHIN_VALUES` in `dto/job-list-query.dto.ts`. */
export const PROCESSED_WITHIN_VALUES = ['4h', '24h', '7d', '30d', 'all'] as const;
export type ProcessedWithin = (typeof PROCESSED_WITHIN_VALUES)[number];

/**
 * `JOB_ETA_BASES` in `dto/job-insights.dto.ts` — where an estimate's average
 * came from, and therefore how much of it is measurement.
 *
 *   `live`    — this type's own succeeded jobs. The estimate is measurement.
 *   `partial` — the overall average across every type, because this type has
 *               none of its own. The estimate is an analogy.
 *   `none`    — nothing has succeeded in the window; the number is a shipped
 *               constant. The estimate is a placeholder.
 */
export const JOB_ETA_BASES = ['live', 'partial', 'none'] as const;
export type JobEtaBasis = (typeof JOB_ETA_BASES)[number];

// =============================================================================
// Response shapes
// =============================================================================

/** One row of `GET /api/admin/jobs`. Payloads are never included. */
export interface Job {
  id: string;
  /** The machine key a handler is registered under; what `type=` filters on. */
  type: string;
  /** `type` through the API's `jobTypeLabel()`; equal to `type` when unmapped. */
  typeLabel: string;
  subjectType: string | null;
  subjectId: string | null;
  dedupKey: string | null;
  status: JobStatusName;
  reason: JobReasonName;
  priority: number;
  providerKey: string | null;
  modelVersion: string | null;
  /** Attempts STARTED, charged at claim time — not attempts that reported back. */
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set in the future on a `pending` row means the job is in backoff. */
  scheduledFor: string | null;
  rateLimitedAt: string | null;
  rateLimitHits: number;
  claimedByNodeId: string | null;
  leaseExpiresAt: string | null;
  executor: string | null;
}

export interface JobListResponse {
  items: Job[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface JobStatusCounts {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface JobTypeStats {
  type: string;
  label: string;
  total: number;
  byStatus: JobStatusCounts;
}

export interface JobStats {
  total: number;
  byStatus: JobStatusCounts;
  byType: JobTypeStats[];
  /** `pending` rows whose `scheduledFor` is still in the future. */
  scheduled: number;
  /** Running rows the lease reaper would reclaim right now. */
  stuckRunning: number;
  /** The threshold `stuckRunning` was counted against, so the UI never guesses. */
  stuckThresholdMinutes: number;
  generatedAt: string;
}

export interface JobDurationStats {
  /** Succeeded, fully timestamped jobs in the window. 0 means the rest is null. */
  samples: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Succeeded per minute over the LAST HOUR — see `history.throughputSince`. */
  throughputPerMin: number;
}

export interface JobTypeDurationStats extends JobDurationStats {
  type: string;
  label: string;
}

export interface JobEta {
  type: string;
  label: string;
  pending: number;
  running: number;
  remaining: number;
  /** The per-job average this estimate multiplied. Never null — read `basis`. */
  avgMs: number;
  basis: JobEtaBasis;
  /** `remaining x avgMs / concurrency`, in milliseconds. */
  estimatedMs: number;
}

export interface JobLifetimeStats {
  type: string;
  label: string;
  succeeded: number;
  failed: number;
  total: number;
  avgMs: number | null;
  durationSamples: number;
}

export interface JobInsights {
  /** The window actually used, after the API clamped it. */
  windowDays: number;
  generatedAt: string;
  /** The worker concurrency every `eta.estimatedMs` divided by. */
  concurrency: number;
  live: {
    total: number;
    byStatus: JobStatusCounts;
    byType: JobTypeStats[];
    scheduled: number;
    rateLimited: number;
    retried: number;
  };
  history: {
    windowStart: string;
    /** The instant `throughputPerMin` counts from — one hour before `generatedAt`. */
    throughputSince: string;
    overall: JobDurationStats;
    byType: JobTypeDurationStats[];
  };
  /** One entry per type with work outstanding, slowest estimate first. */
  eta: JobEta[];
  /** All-time totals per type: rollup + live, counts and averages only. */
  lifetime: JobLifetimeStats[];
}

export interface RetryFailedResult {
  retried: number;
  /** Jobs whose dedup key is already held by a pending or running job. */
  skipped: number;
  /** Failed rows still outstanding — the sweep caps at 500 per call. */
  remaining: number;
}

export interface ResetStuckResult {
  reset: number;
  /** Rows that had spent their attempt budget and were failed permanently. */
  failed: number;
  /** The threshold actually used, echoed by the API. */
  thresholdMinutes: number;
}

export interface ResetHistoryResult {
  /** Rollup rows deleted — one per job type, not one per job. */
  reset: number;
}

// =============================================================================
// Requests
// =============================================================================

/**
 * The query `GET /api/admin/jobs` accepts, mirroring `jobListQuerySchema`.
 *
 * `scheduled: true` OVERRIDES `status` on the server — a row in backoff is
 * `pending` by definition — which is why `JobsPage` never sends both. The two
 * are kept mutually exclusive in the UI rather than relying on the override,
 * so the filter chips can never describe a query the server did not run.
 */
export interface JobListParams {
  page?: number;
  pageSize?: number;
  status?: JobStatusName;
  type?: string;
  subjectType?: string;
  subjectId?: string;
  scheduled?: boolean;
  processedWithin?: ProcessedWithin;
}

export async function getJobs(params: JobListParams = {}): Promise<JobListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.status) query.set('status', params.status);
  if (params.type) query.set('type', params.type);
  if (params.subjectType) query.set('subjectType', params.subjectType);
  if (params.subjectId) query.set('subjectId', params.subjectId);
  // Sent as the literal string the schema's `z.enum(['true','false'])` expects,
  // and ONLY when true: `scheduled=false` means the same as omitting it, and
  // sending it would put a parameter in the URL that changes nothing.
  if (params.scheduled) query.set('scheduled', 'true');
  // `all` is the schema default, so it is omitted rather than sent — same
  // reasoning as above, and it keeps the request URL readable in a log.
  if (params.processedWithin && params.processedWithin !== 'all') {
    query.set('processedWithin', params.processedWithin);
  }

  return api.get<JobListResponse>(`/admin/jobs?${query}`);
}

/**
 * The queue summary.
 *
 * Cached in-process for about two seconds on the API side — shorter than any
 * sensible dashboard poll, so a deliberate refresh always sees fresh counts.
 */
export async function getJobStats(): Promise<JobStats> {
  return api.get<JobStats>('/admin/jobs/stats');
}

/** Retry ONE job. The API refuses a `running` job with a 400. */
export async function retryJob(id: string): Promise<Job> {
  return api.post<Job>(`/admin/jobs/${id}/retry`);
}

/** Delete ONE job. The API refuses a `running` job with a 400. */
export async function deleteJob(id: string): Promise<void> {
  await api.delete<void>(`/admin/jobs/${id}`);
}

/**
 * Retry every failed job, optionally restricted to one type.
 *
 * A QUEUE-WIDE action, not a bulk action over the selected rows: the server
 * sweeps every failed row it can find (up to 500 per call), whatever this page
 * happens to be showing. `JobsPage` renders it as a page-level button for
 * exactly that reason — offering it from a selection toolbar would imply the
 * selection scoped it.
 */
export async function retryFailedJobs(type?: string): Promise<RetryFailedResult> {
  return api.post<RetryFailedResult>('/admin/jobs/retry-failed', type ? { type } : {});
}

/**
 * Run the lease reaper on demand.
 *
 * `olderThanMinutes` is OMITTED unless the caller means it, so the API falls
 * through to the `jobs.stuckThresholdMinutes` system setting — the same
 * threshold the scheduled sweep uses, and the same one `stats.stuckRunning`
 * was counted against. A default invented here would be a second place the
 * threshold is decided, and it would win.
 */
export async function resetStuckJobs(olderThanMinutes?: number): Promise<ResetStuckResult> {
  return api.post<ResetStuckResult>(
    '/admin/jobs/reset-stuck',
    olderThanMinutes === undefined ? {} : { olderThanMinutes },
  );
}

/**
 * Queue analytics: live counts, duration percentiles over the window, the ETA
 * per type, and all-time totals merged from the lifetime rollup.
 *
 * `windowDays` is omitted when absent so the API applies its own default (7);
 * it clamps to 90 and echoes back what it used as `windowDays`, which is what
 * the page labels its history with rather than the number it asked for.
 */
export async function getJobInsights(windowDays?: number): Promise<JobInsights> {
  const query = new URLSearchParams();
  if (windowDays !== undefined) query.set('windowDays', String(windowDays));
  const suffix = query.toString();
  return api.get<JobInsights>(`/admin/jobs/insights${suffix ? `?${suffix}` : ''}`);
}

/**
 * Clear the lifetime statistics rollup.
 *
 * Deletes no job and changes no job's state — every live-derived number in the
 * insights response is identical afterwards. What it destroys is the
 * accumulators summarising rows the history purge already deleted, which
 * nothing can rebuild, which is why the page confirms before calling it.
 */
export async function resetJobInsightsHistory(): Promise<ResetHistoryResult> {
  return api.post<ResetHistoryResult>('/admin/jobs/insights/reset-history');
}

// =============================================================================
// Shared predicates
// =============================================================================

/**
 * Whether a job may be retried or deleted at all.
 *
 * `false` for a `running` job, and this is a MIRROR of the API's refusal
 * (`job-admin.service.ts` raises 400 for both), not an independent policy. The
 * server's reasons are worth restating because they are why the UI must not
 * offer the action rather than merely handle its failure: a retry would reset
 * a row an executor is still writing to, letting a second worker claim the
 * same job; a delete would not stop that executor, which would then finish,
 * find no row, and leave work that ran with no record it existed.
 *
 * Exported from the service rather than the table module because both the
 * row-action gate and its tests are about what the API will accept.
 */
export function isJobActionable(job: Pick<Job, 'status'>): boolean {
  return job.status !== 'running';
}
