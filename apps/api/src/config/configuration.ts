import { identityConfiguration } from '@marinoscar/platform-api/identity';

import { buildDatabaseUrl } from '../common/database-url';
import { resolveServiceName } from '../common/otel/service-name';

export default () => {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const dbName = process.env.POSTGRES_DB || 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';

  // Built by the shared helper, NOT interpolated here. This module used to do
  // its own interpolation without percent-encoding, and because the line below
  // assigns the result to process.env.DATABASE_URL — which PrismaService then
  // trusts — that unencoded string overwrote the encoded one the service had
  // been careful to build. See src/common/database-url.ts.
  const databaseUrl = buildDatabaseUrl();

  // Prisma reads DATABASE_URL (prisma.config.ts, and the generated client),
  // so publish the derived value for it.
  process.env.DATABASE_URL = databaseUrl;

  return {
    // Application
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    appUrl: process.env.APP_URL || 'http://localhost:3535',

    // Database
    database: {
      host,
      port: parseInt(port, 10),
      user,
      password,
      name: dbName,
      ssl,
      url: databaseUrl,
    },

  // Identity (#465, epic #462): `jwt`, `auth`, `google`, `initialAdminEmail`,
  // `deviceAuth` and `tenancy`, built by the platform so the keys the packaged
  // identity slice reads with `ConfigService.get(...)` cannot drift from what it
  // expects. The environment variable names are unchanged: `JWT_SECRET`,
  // `JWT_ACCESS_TTL_MINUTES`, `JWT_REFRESH_TTL_DAYS`, `GOOGLE_CLIENT_ID`,
  // `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `INITIAL_ADMIN_EMAIL`,
  // `DEVICE_CODE_EXPIRY_MINUTES`, `DEVICE_CODE_POLL_INTERVAL`,
  // `DEVICE_TOKEN_EXPIRY_DAYS`, `DEVICE_PAT_EXPIRY_DAYS`; `TENANCY_MODE` stays
  // unset (single-organization mode) and `AUTH_PRINCIPAL_CACHE_TTL_SECONDS` is
  // new and optional.
  //
  // Device flow lifetimes, for the record, because the comment that used to sit
  // here is still the reason there are two: `tokenExpiryDays` is the session
  // credential the activation page produces (a JWT, not revocable, so short);
  // `patExpiryDays` is the lifetime of the personal access token minted when a
  // device asks for `clientInfo.tokenType: 'pat'` (revocable, so it can be 90
  // days). Conflating them would weaken every device session to serve the CLI.
  ...identityConfiguration(),

  // SECRETS_ENCRYPTION_KEY is DELIBERATELY ABSENT from this object (#116,
  // epic #108). It is read directly from process.env by
  // common/crypto/secret-cipher.ts, which caches it once and never re-reads,
  // and validated at bootstrap by common/crypto/encryption-key-startup-check.ts.
  // Adding it here would create a second source of truth that could disagree
  // with the cached one, and would put raw key material into the ConfigService
  // object — a structure that is far easier to log, dump to a debug endpoint or
  // serialise wholesale than a module-private Buffer. Do not add it.

  // Web Push (issue #229, epic #215) — deploy-time VAPID key pair.
  //
  // Read exactly like `google` above: plain `process.env`, no default, no
  // validation at this layer. `undefined` is the correct value for a
  // deployment that has not generated keys.
  //
  // AS OF #355, THIS IS A FALLBACK, NOT THE ONLY SOURCE. Web Push is now also
  // admin-UI-configurable at runtime (`PushConfigController`/
  // `PushConfigService`, a `webPush` `system_settings` row plus a
  // `push_vapid` credential); `PushConfigService.resolveActiveVapidConfig()`
  // is the ONE place that decides which of the two — the runtime config or
  // these env vars — is actually active, and it prefers the runtime config
  // whenever one has ever been saved. These three keys stay here, read
  // exactly as before, purely so a deployment that never touches the new
  // admin page keeps working with zero action required.
  //
  // Deliberately NOT run through `common/crypto/secret-cipher.ts` /
  // `SECRETS_ENCRYPTION_KEY`, for the same reason `google.clientSecret` isn't:
  // that machinery encrypts credentials an ADMIN ENTERS AT RUNTIME through the
  // app before they land in the `credentials` table — which, as of #355, a
  // VAPID private key can now also be, through `PushConfigService` (that path
  // uses the credential store directly, not this cipher — see
  // `push-vapid-credential.constants.ts`). A key pair supplied through THIS
  // env var instead is deploy-time config, exactly like `GOOGLE_CLIENT_SECRET`
  // — there is no runtime entry path for these three specific variables, so
  // there is nothing for that cipher to do here.
  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT,
  },

  // Background job queue — the terminal state machine's budgets and backoff
  // (issue #261, epic #254).
  //
  // TWO INDEPENDENT BUDGETS, and conflating them is the mistake to avoid.
  // `maxAttempts` bounds BUGS: a handler that keeps throwing should burn
  // through a small budget quickly and land in `failed` where a human sees
  // it. `rateLimitMaxHits` bounds WAITING: a provider throttling us is not
  // the job failing, so a deferral must not spend the attempt budget at all
  // (`JobTerminalService` explicitly un-charges the claim-time increment) and
  // it gets its own, much larger, allowance on a much longer timescale.
  // A single combined counter would let a long backfill against a
  // rate-limited provider exhaust it in the first minute and fail
  // permanently for a transient reason that was never its fault.
  //
  // Each pair of *BaseMs / *MaxMs feeds the same equal-jitter exponential
  // backoff (`src/jobs/backoff.util.ts`); only the constants differ —
  // seconds for a retry, minutes for a provider cooldown.
  //
  // THE WORKER POOL'S OWN FIVE (issue #262) sit in the same block because
  // they bound the same thing from the other end: the four above decide what
  // happens to a job that stopped, these decide how many jobs may be running
  // at once, how eagerly an empty queue is asked again, which types this
  // process is allowed to take, and how long one job may hold a slot.
  //
  // `workerMode` is a plain string rather than a union parsed here, and
  // `JobWorker.mode()` validates it on every claim: an unrecognised value
  // FAILS OPEN to "all" with a single warning, because a typo in an env file
  // silently stopping every background job is a far worse outcome than
  // running the default loudly. Validating it here would have to decide
  // between throwing at boot (the fail-closed outcome, rejected) and
  // silently rewriting the value (the same fallback, further from the log
  // line that explains it).
  //
  // The lease a claim is taken with is DERIVED from `jobTimeoutMs` rather
  // than configured, so it cannot be set shorter than the timeout it has to
  // outlive — see `LEASE_GRACE_MS` in `src/jobs/job.worker.ts`.
  jobs: {
    maxAttempts: parseInt(process.env.JOBS_MAX_ATTEMPTS || '3', 10),
    retryBaseMs: parseInt(process.env.JOBS_RETRY_BASE_MS || '2000', 10),
    retryMaxMs: parseInt(process.env.JOBS_RETRY_MAX_MS || '60000', 10),
    rateLimitMaxHits: parseInt(process.env.JOBS_RATELIMIT_MAX_HITS || '10', 10),
    rateLimitBaseMs: parseInt(process.env.JOBS_RATELIMIT_BASE_MS || '30000', 10),
    rateLimitMaxMs: parseInt(process.env.JOBS_RATELIMIT_MAX_MS || '900000', 10),
    workerConcurrency: parseInt(process.env.JOBS_WORKER_CONCURRENCY || '2', 10),
    pollMs: parseInt(process.env.JOBS_POLL_MS || '5000', 10),
    workerMode: process.env.JOBS_WORKER_MODE || 'all',
    jobTimeoutMs: parseInt(process.env.JOBS_JOB_TIMEOUT_MS || '600000', 10),
    // The lease reaper's ONLY switch (#263), and deliberately not the worker
    // mode. Reaping a dead lease is a CONTROL-PLANE duty: an API running as a
    // pure control plane (`JOBS_WORKER_MODE=off` in front of an external node
    // fleet) claims nothing itself, and is also the deployment where dead
    // leases are most likely — a node's laptop closing its lid is the normal
    // case there, not an edge one. Gating the reaper on this process's
    // willingness to RUN jobs would leave that fleet's abandoned rows to
    // nobody. See `tasks/job-stuck-reset.task.ts`.
    //
    // DEFAULTS TO ON, and only the literal string turns it off, so a typo
    // fails open into "keep reaping" rather than silently leaving every
    // abandoned job stuck forever — the same direction `workerMode` fails in,
    // for the same reason.
    reaperEnabled: process.env.JOBS_REAPER_ENABLED !== 'false',
    // Split here rather than in the worker so the shape a consumer reads is
    // the shape it wants, and an unset variable is an empty list rather than
    // `['']` — which would look like a job type named "" to every caller.
    systemModeExtraTypes: (process.env.JOBS_SYSTEM_MODE_EXTRA_TYPES || '')
      .split(',')
      .map((type) => type.trim())
      .filter((type) => type.length > 0),
  },

  // Worker-fleet lifecycle (#270). Both switches are the SAME KIND of switch as
  // `jobs.reaperEnabled` above — "does this replica run this sweep" — and not a
  // policy: the thresholds themselves (`staleHeartbeatSeconds`,
  // `offlineStaleMultiplier`, `offlineRetentionDays`) are system settings an
  // administrator changes at runtime, because they are decisions about a
  // deployment's fleet rather than about a process's environment.
  //
  // BOTH DEFAULT TO ON, and only the literal string turns either off. A fleet
  // whose liveness tracking silently stopped because of a typo in an env file
  // looks exactly like a fleet that is perfectly healthy — every node reads
  // `online` forever — which is the worst failure of the two to diagnose. See
  // `nodes/tasks/node-stale-offline.task.ts`.
  //
  // ⚠ TURNING THE SWEEP OFF ALSO TURNS RETENTION OFF, whatever the prune's own
  // switch says: the prune selects `offline` rows, and without the sweep a
  // crashed node never reaches that status. The pair is ordered, not
  // independent.
  //
  // `secretSweepEnabled` (#349, epic #345) is the third of the same kind, and
  // its default matters more than the other two. It gates the sweep that
  // revokes per-job credentials the settle-event path missed — and that path
  // STRUCTURALLY CANNOT cover three cases (a job reaped by an `updateMany`
  // that emits nothing, a replica that died between settling and revoking, a
  // `write-failed` terminal outcome), so this is not belt-and-braces. Switched
  // off, a deployment accumulates live database credentials nobody destroys
  // until each one's own expiry catches up. Note it does NOT gate whether
  // credentials may be issued at all: that is the `nodes.jobSecretBrokerEnabled`
  // SYSTEM SETTING, because it is a decision about the deployment's trust
  // boundary rather than about which replica runs a timer.
  nodes: {
    staleOfflineEnabled: process.env.NODE_STALE_OFFLINE_ENABLED !== 'false',
    offlinePruneEnabled: process.env.NODE_OFFLINE_PRUNE_ENABLED !== 'false',
    secretSweepEnabled: process.env.NODE_SECRET_SWEEP_ENABLED !== 'false',
  },

  // Database backup scheduling (#282). ONE switch, and — like the two groups
  // above — it decides whether THIS PROCESS runs the timer, never what the
  // policy is: the schedule, the timezone, the retention count and the stale
  // window are all system settings an administrator edits at runtime, because
  // they are decisions about a deployment rather than about a process.
  //
  // ⚠ DELIBERATELY NOT `JOBS_WORKER_MODE`, AND STILL NOT SINCE #351 MADE THE
  // DUMP A QUEUE JOB. This switch governs whether this process runs the
  // ten-minute cron that DECIDES a backup is due and enqueues it — a decision
  // about the deployment's schedule, not about the queue. An API running as a
  // pure control plane in front of an external node fleet is still the only
  // component with a database connection, so gating the schedule on its
  // willingness to execute jobs would leave that deployment's database backed
  // up by nobody.
  //
  // What DOES depend on the worker is the execution: `db.backup.run` is
  // server-only by derivation, so `JOBS_WORKER_MODE=system` claims it and
  // `off` does not. An enqueue-only deployment therefore queues backups it
  // never takes, which is what `off` means and is why the stale sweep now ages
  // out `pending` run rows.
  //
  // DEFAULTS TO ON, and only the literal string turns it off. A deployment
  // whose backups silently stopped because of a typo in an env file is
  // indistinguishable from one that is being backed up, right up until
  // somebody needs a restore — which makes fail-open the only defensible
  // direction here. See `db-backup/tasks/db-backup-schedule.task.ts`.
  dbBackup: {
    scheduleEnabled: process.env.DB_BACKUP_SCHEDULE_ENABLED !== 'false',
  },

  // Knowledge graph migration scheduler (#384). Whether THIS process runs the
  // hourly tick that enqueues `kg.migrate` for owners whose graph rows an
  // ontology migration still has to reshape. The tick only enqueues; the
  // reshape is a queue job. Same fail-open rule as the backup schedule: only
  // the literal 'false' turns it off. See `graph/migrate/kg-migrate-scheduler.task.ts`.
  kgMigrate: {
    scheduleEnabled: process.env.KG_MIGRATE_SCHEDULE_ENABLED !== 'false',
  },

  // Observability
  otel: {
    enabled: process.env.OTEL_ENABLED === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: resolveServiceName(),
  },

  // Storage Configuration
  //
  // THE OBJECT STORE ITSELF IS NOT CONFIGURED HERE (#469). The active driver,
  // bucket, region, endpoint and the secret access key are the `storage` system
  // settings plus the credential store, edited at /admin/settings/storage; the
  // former `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`,
  // `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `STORAGE_STALE_UPLOAD_HOURS`
  // are no longer read (the stale-upload threshold is `STALE_UPLOAD_HOURS` in
  // `platform/storage/storage.config.ts`). What stays are the deployment limits
  // the platform's objects API reads through `ConfigService`.
  storage: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10737418240', 10), // 10GB default
    // `audio/*` joined the default list in #21. It was the one obvious media
    // family missing, and an audio upload is exactly the workload the rest of
    // that issue exists for — a multi-GB recording resumed over a phone
    // connection. Adding it to the DEFAULT rather than expecting every
    // deployment to override ALLOWED_MIME_TYPES keeps a fork that never
    // touches the variable from rejecting the files it was forked to handle.
    //
    // ⚠ THIS LIST IS NOW ENFORCED. Until #21 neither this nor `maxFileSize`
    // was read anywhere, so widening or narrowing it had no effect at all;
    // `ObjectsService.initUpload` reads both.
    allowedMimeTypes: (
      process.env.ALLOWED_MIME_TYPES || 'image/*,application/pdf,video/*,audio/*'
    ).split(','),
    signedUrlExpiry: parseInt(process.env.SIGNED_URL_EXPIRY || '3600', 10), // 1 hour default
    partSize: parseInt(process.env.STORAGE_PART_SIZE || '10485760', 10), // 10MB default
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  };
};
