# Development Guide

This document provides essential information for developers working on this project, including setup instructions, common patterns, and important lessons learned from implementation.

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Development Setup](#development-setup)
3. [Working with NestJS + Fastify](#working-with-nestjs--fastify)
4. [Database Patterns](#database-patterns)
5. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
6. [Testing Guidelines](#testing-guidelines)
7. [Debugging Tips](#debugging-tips)
8. [Environment variables](#environment-variables)
9. [Repository tooling](#repository-tooling)

---

## Technology Stack

### Backend
- **Framework**: NestJS with **Fastify adapter** (NOT Express)
- **ORM**: Prisma with PostgreSQL
- **Authentication**: Passport.js (Google OAuth)
- **Validation**: Zod schemas with nestjs-zod
- **Documentation**: OpenAPI 3.1, served as a Scalar reference at `/api/docs`

### Key Difference: Fastify vs Express

This application uses **Fastify** as the HTTP adapter, not Express. This has important implications for how you write controllers and work with request/response objects.

**Why Fastify?**
- Faster performance (2-3x faster than Express)
- Better TypeScript support
- Lower overhead
- Built-in schema validation support

---

## Development Setup

### Prerequisites
- Node.js 24+ (see `.nvmrc`; enforced by the `engines` field)
- Docker Desktop
- PostgreSQL 16, reachable from the API container — `base.compose.yml` has no `db` service of its own; the `devdb.compose.yml` overlay (step 3 below) is the easy way to get one locally
- Google OAuth credentials (from Google Cloud Console)

### Initial Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repository-url>
   cd <repository-directory>
   npm install
   npm run build --workspace=@marinoscar/kvox-contract
   ```

   The API and the web app import the domain wire schemas and the ontology from
   `@marinoscar/kvox-contract` through its built output (`packages/kvox-contract/dist/`,
   git-ignored), so build it once after `npm install` and again after pulling a
   change under `packages/kvox-contract/`. CI builds it right after `npm ci`, and
   both application Dockerfiles build it inside the image (`.dockerignore` drops every `dist/`).

   The API also imports `@marinoscar/kvox-api`, `@marinoscar/kvox-ai` and `@marinoscar/kvox-eval` (the `kg:eval` and `ask:eval` scripts, both thin wrappers over the `kvox-eval` commands) from their built output. On a fresh checkout run `npm run build:kvox-packages` (order: contract, db, api, ai, eval, web) instead of building one package at a time.

2. **Set up environment variables**
   ```bash
   cd infra/compose
   cp .env.example .env
   # Edit .env with your Google OAuth credentials and other settings
   ```

3. **Start development environment**

   PostgreSQL is required, but it is **not** part of the base stack —
   `base.compose.yml` deliberately declares only `nginx`, `api`, and `web`, so
   a bundled database is never fighting a Postgres this repo doesn't own (a
   shared host, a managed instance). If you don't already have one, add the
   opt-in `devdb.compose.yml` overlay as a third `-f`, followed by this app's
   `app.devdb.pgvector.compose.yml` (the platform's database image has no
   `vector` extension, which the migrations need):

   ```bash
   cd infra/compose
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f app.devdb.pgvector.compose.yml up
   ```

   > **Two database logins.** On the first start of an empty volume the overlay
   > runs `infra/compose/postgres-init/` as the bootstrap superuser `postgres`:
   > `10-application-role.sh` creates the ordinary role the API signs in as
   > (named by `POSTGRES_USER`, default `app` since the infra moved to
   > `platform-infra sync`, #483; owner of the database) and
   > `20-kvox-extensions.sh` creates `vector`, `pg_trgm` and `uuid-ossp`. The API
   > and `npm run prisma:migrate` use `POSTGRES_USER` / `POSTGRES_PASSWORD`, which
   > `.env.example` sets to that role, so no superuser is in the API's environment.
   > The database container is `pgvector/pgvector:pg16` through the
   > `app.devdb.pgvector.compose.yml` overlay: start it with
   > `-f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f app.devdb.pgvector.compose.yml`.
   > Volumes created before #471 predate the init scripts: run `docker compose ... down -v`
   > to recreate them, or follow `docs/runbooks/application-role.md`.

   > **First run on a new machine:** `base.compose.yml` attaches the API to an
   > external Docker network named `devnet`, so the very first `docker compose
   > up` on a host fails with *network devnet declared as external, but could
   > not be found* until it exists. Create it once per machine:
   >
   > ```bash
   > docker network create devnet
   > ```
   >
   > It exists so several applications built from this template can share one
   > PostgreSQL container on a development host. You need it even when you are
   > not sharing anything — the network is declared unconditionally.

   Already running your own PostgreSQL 16? Point the `POSTGRES_*` variables in
   `.env` at it and leave the overlay out:

   ```bash
   docker compose -f base.compose.yml -f dev.compose.yml up
   ```

4. **IMPORTANT: Apply the database schema**

   The API **does not migrate on startup**, and that is deliberate — its
   container command is `node dist/main` and nothing else, so a fresh database
   has no tables until you run:

   ```bash
   docker compose exec api npm run prisma:migrate
   ```

   Skipping it makes the seed below fail against an empty database.

5. **IMPORTANT: Run database seeds**

   Before your first login, you MUST seed the database with roles and permissions:

   ```bash
   docker compose exec api npm run prisma:seed
   ```

   **Why this is critical:**
   - Seeds create the RBAC roles (the system role `admin`; the organization roles `org_admin`, `contributor`, `viewer`)
   - Seeds create permissions (users:read, users:write, etc.)
   - Without seeds, user creation will fail with "Default role not found"
   - Seeds are idempotent - safe to run multiple times

6. **Access the application**
   - Frontend: http://localhost:3535
   - API: http://localhost:3535/api
   - API reference: http://localhost:3535/api/docs

### Building images directly

The `docker compose` commands above are unchanged. If you invoke `docker build`
yourself, note that **both images build from the repository root, not from the
app directory**:

```bash
# From the repository root
docker build -f apps/api/Dockerfile .
docker build -f apps/web/Dockerfile .
```

`apps/api` and `apps/web` are npm workspace members with no lockfile of their
own — the only `package-lock.json` is at the repository root. Building from the
root is what makes it reachable, so the images install with `npm ci` and match
what CI tested. Building from inside `apps/api` will fail.

### First Login

The first user to login with the email matching `INITIAL_ADMIN_EMAIL` (from .env) will automatically be granted the **admin** role. All subsequent users get the **viewer** role by default.

---

## Environment variables

Key variables (see `infra/compose/.env.example` for the full list). This section carries the prose explanations; `.env.example` remains the machine-read source of truth for names and defaults.

**Application:**
- `NODE_ENV` - Environment (development/production)
- `PORT` - API port (default: 3000)
- `APP_URL` - Base URL (default: http://localhost:3535)
- `DEPLOY_INFO_PATH` - Where `GET /api/admin/about` reads the CLI's `deploy-info/info.json` from (default: `/app/deploy-info/info.json`, the read-only bind mount `kvox deploy` sets up). Read on every request, so a rewrite needs no restart; a missing file is `deployInfoStatus: "absent"`, never an error

**Database (individual connection parameters):**
- `POSTGRES_HOST` - Database hostname (default: localhost)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - The API's database login (default: `app` in the generated template; a deployment keeps the name its `.env` already has, e.g. `kvox_app`). It must be an **ordinary** role (`NOSUPERUSER NOBYPASSRLS`) that owns the tables: a superuser skips row-level security and the Doctor check `db.rls_role` fails. The bootstrap superuser `postgres` is for administration only
- `POSTGRES_PASSWORD` - That role's password (default: postgres)
- The role `devdb.compose.yml` and `test.compose.yml` create on the first start of an **empty** volume is `POSTGRES_USER` / `POSTGRES_PASSWORD` itself (`infra/compose/postgres-init/10-application-role.sh`, then `20-kvox-extensions.sh` creates `vector`, `pg_trgm` and `uuid-ossp` as the superuser). `APP_DB_USER` / `APP_DB_PASSWORD` are no longer in the template. Not read by a deployment whose database already exists. An existing local volume predates the role: recreate it (`docker compose ... down -v`) or follow `docs/runbooks/application-role.md`
- `POSTGRES_MONITOR_USER` / `POSTGRES_MONITOR_PASSWORD` - Optional login for the telemetry collector's PostgreSQL metrics; blank reuses `POSTGRES_USER` / `POSTGRES_PASSWORD`
- `POSTGRES_DB` - Database name (default: appdb)
- `POSTGRES_SSL` - Enable SSL connection (default: false)

Note: `DATABASE_URL` is constructed automatically from these variables at runtime.

**Authentication:**
- `JWT_SECRET` - JWT signing secret (min 32 chars). Required: the identity slice treats a missing value as a boot error
- `JWT_ACCESS_TTL_MINUTES` - Access token TTL (default: 15)
- `JWT_REFRESH_TTL_DAYS` - Refresh token TTL (default: 14)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- `INITIAL_ADMIN_EMAIL` - First user with this email becomes Admin
- `DEVICE_CODE_EXPIRY_MINUTES` - Device code lifetime (default: 15)
- `DEVICE_CODE_POLL_INTERVAL` - Device polling interval in seconds (default: 5)
- `DEVICE_TOKEN_EXPIRY_DAYS` - Token lifetime for device sessions in days (default: 7)
- `DEVICE_PAT_EXPIRY_DAYS` - Lifetime of the PAT minted when a device (e.g. the CLI) requests `clientInfo.tokenType: "pat"`, in days; clamped to 1-999 (default: 90)
- `SECRETS_ENCRYPTION_KEY` - Base64-encoded 32-byte AES-256 key (generate with `openssl rand -base64 32`) that encrypts runtime-configured credentials (e.g. an SMTP password an admin enters through the app) before they are stored in the `credentials` table (and each user's own AI key in `user_ai_credentials`). Optional until a credential is stored; see `docs/runbooks/rotate-secrets-encryption-key.md`. Note: credentials configured at runtime through the UI/API live encrypted in the database, not in the environment — unlike every other secret in this section.

**Object storage:**
- There is **no variable for the bucket, region, endpoint or keys** (the former `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `STORAGE_STALE_UPLOAD_HOURS` are no longer read). Sign in as an admin and configure the store at `/admin/settings/storage` (Amazon S3, Cloudflare R2, or an S3-compatible server such as MinIO at `http://localhost:9000`), press Test, then Save. Until then every upload answers 503. The secret access key is stored encrypted with `SECRETS_ENCRYPTION_KEY`, so set that variable first. See `docs/runbooks/storage-configuration.md`
- `STORAGE_CSP_ORIGIN` is gone (#483). The generated Content Security Policy allows `https:` in `connect-src` and `media-src`, which covers presigned upload and playback URLs. A plain-http origin (MinIO at `http://localhost:9000`) is added in `infra/nginx/app.d/csp/connect-src.conf` and `media-src.conf` (`default " http://localhost:9000";`, leading space), then recreate the nginx container; the bucket also needs CORS (`docs/runbooks/s3-cors.md`). See `docs/deployment/vps.md` ("The generated infrastructure files")
- `STORAGE_PART_SIZE` - Multipart part size in bytes for every upload (default 10485760, minimum 5242880). Deployment-wide and not stored per upload: never change it while uploads are in flight, and keep `STORAGE_PART_SIZE x 10000` above `MAX_FILE_SIZE`
- `MAX_FILE_SIZE` / `ALLOWED_MIME_TYPES` / `SIGNED_URL_EXPIRY` - Largest accepted upload in bytes (413 above it, default 10 GiB), the generic-upload content-type allowlist (415 outside it; transcript uploads enforce their own fixed audio and video list), and the lifetime of a signed URL in seconds (default 3600)
- Email and Web Push have **no environment variables** since #470: SMTP and Amazon SES (access key ID and secret; `S3_REGION` survives only as the default SES region) are configured at `/admin/settings/email`, and the VAPID key pair at `/admin/settings/push` (the three `VAPID_*` lines in `.env.example` are retired and not read). The platform email and notifications slices read the stored settings and the encrypted credentials only

**Background Job Queue** (all bare/unprefixed, like `POSTGRES_*` — API-side vars never take
the CLI's `KVOX_` prefix; see `infra/compose/.env.example` for the full comments):
- `JOBS_MAX_ATTEMPTS` - Attempts before a job is permanently `failed`, charged at claim time (default: 3)
- `JOBS_RETRY_BASE_MS` / `JOBS_RETRY_MAX_MS` - Retry backoff bounds, doubling with jitter (default: 2000 / 60000)
- `JOBS_RATELIMIT_MAX_HITS` - Times a job may be provider-rate-limited before giving up — a budget separate from `JOBS_MAX_ATTEMPTS` (default: 10)
- `JOBS_RATELIMIT_BASE_MS` / `JOBS_RATELIMIT_MAX_MS` - Rate-limit deferral backoff bounds (default: 30000 / 900000)
- `JOBS_WORKER_CONCURRENCY` - Jobs this process runs at once; fixed at startup (default: 2)
- `JOBS_POLL_MS` - Idle poll interval before asking for work again (default: 5000)
- `JOBS_WORKER_MODE` - `all` (every type — the default), `system` (only types no node may claim **in this deployment right now** — the complement of `NodeOffloadService.offeredTypes()`, so a node-eligible type whose gates are closed is still claimed here), or `off` (enqueue only); an unrecognised value warns and behaves as `all`
- `JOBS_JOB_TIMEOUT_MS` - Per-job timeout before the slot is freed and the job retries/fails (0 disables; default: 600000)
- `JOBS_SYSTEM_MODE_EXTRA_TYPES` - Comma-separated types the `system` worker mode should claim **in addition** to its complement — for running a type the fleet is also allowed to run (a small or paused fleet). Never needed to keep a type running at all: a node-eligible type this deployment does not offer to nodes is already in the complement. Unset by default
- `JOBS_REAPER_ENABLED` - Whether this process reclaims jobs abandoned by a dead executor; independent of `JOBS_WORKER_MODE`. Only the literal `false` turns it off (default: on)

**Worker Node Fleet:**
- `NODE_STALE_OFFLINE_ENABLED` - Whether this process marks a node offline once its heartbeat is older than `nodes.staleHeartbeatSeconds × nodes.offlineStaleMultiplier`. Only the literal `false` turns it off (default: on)
- `NODE_OFFLINE_PRUNE_ENABLED` - Whether this process forgets offline nodes past `nodes.offlineRetentionDays` (their jobs are unclaimed, not deleted). Depends on the sweep above being on. Only the literal `false` turns it off (default: on)
- `NODE_SECRET_SWEEP_ENABLED` - Whether this process runs the ten-minute cron that revokes expired or orphaned per-job credentials brokered to worker nodes (epic #345, issue #349) — the third permanent job-queue exemption (see the queue-job rules in [`AGENTS.md`](../AGENTS.md#mandatory-every-long-running-activity-is-a-queue-job)). Only the literal `false` turns it off (default: on). Independent of `JOBS_WORKER_MODE`, like the lease reaper, and for the same reason: a credential brokered to a node in a fleet this process does not execute jobs for still needs revoking. Whether a credential is ever brokered **at all** is the separate `nodes.jobSecretBrokerEnabled` system setting, default off — see [`docs/runbooks/node-job-secrets.md`](runbooks/node-job-secrets.md)

**Maintenance Mode:**
- `MAINTENANCE_MODE` - Environment override that outranks the persisted setting. Set to `true` to force the window open even if the app cannot start (a pre-migration deploy), or to `false` to force it shut (recovery from a window opened with `allowAdmins` false). Only the literal strings `'true'`/`'false'` count; anything else (including unset) means "no override, use the stored setting". Requires an application restart to take effect. See `docs/runbooks/maintenance-mode.md`. ⚠️ Document a value for this variable as prose ("set to `true`"), never as an inline `# MAINTENANCE_MODE=true` example — `apps/cli`'s `parseEnvExample` reads *any* commented `# KEY=value` line in `infra/compose/.env.example` as declaring an optional variable, so an illustrative assignment inside prose registers as a second declaration and fails the CLI's env-spec test. `infra/compose/.env.example` is generated by `npm run platform:infra:sync`: the platform's template carries the commented defaults (`# MAINTENANCE_MODE=false` among them, all listed in `apps/cli/src/conformance.test.ts`), and an app variable goes uncommented into `infra/compose/app.env.example` — do not add a commented line for this key.

**Database Backup:**
- `DB_BACKUP_SCHEDULE_ENABLED` - Whether this process runs the backup scheduler: a ten-minute cron that enqueues the housekeeping sweep, starts a backup (by enqueuing `db.backup.run`) when the configured schedule has come due, and enqueues the retained-database drop. Defaults to on; only the literal `false` turns it off, and it is deliberately independent of `JOBS_WORKER_MODE` — the *tick* is not itself queue work (it only decides whether to enqueue), so an API running as a pure control plane must still queue its own backups even though `JOBS_WORKER_MODE=off` means nothing on this process will execute them. Everything about the schedule itself (enabled, frequency, time of day, timezone, retention count, stale window) is a `databaseBackup` system setting, not an environment variable — as is `nodeOffloadEnabled` (default **false**), which decides whether a worker node may take the dump at all. See `docs/specs/database-backup.md`.

**Knowledge graph:**
- `KG_MIGRATE_SCHEDULE_ENABLED` - Whether this process runs the hourly (minute 17) tick that enqueues `kg.migrate` for owners whose graph rows a declared ontology migration still has to reshape (#384). The tick only enqueues, and returns at once while `ONTOLOGY_MIGRATIONS` is empty. Only the literal `false` turns it off (default: on), the `DB_BACKUP_SCHEDULE_ENABLED` convention; an admin can still re-run one owner's migration with Retry in the job list. See `docs/runbooks/ontology-migration.md`

**Evaluation (developer and CI only, never set in a deployment):**
- `KVOX_EVAL_OPENAI_API_KEY` - The API key of a live `kg:eval` / `ask:eval` / `kvox-eval kg` / `kvox-eval ask` run (`kvox-eval ask --replay` needs none). Read from the environment only, never a flag, never printed. `KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are deprecated aliases, read for one more release with a one-line deprecation note on standard error. Details: [TESTING.md](TESTING.md#knowledge-graph-and-ask-evaluation)
- `KG_EVAL_REAL_DIR` - Stands in for `--real-dir` (real meetings; must resolve outside the git work tree)

**Observability** (OpenTelemetry through `@marinoscar/platform-api/otel-core`, stored in GreptimeDB by the platform telemetry slice; full design in `docs/ARCHITECTURE.md` section 11):
- `OTEL_ENABLED` - Turn the SDK on. `base.compose.yml` defaults it to `false`; `telemetry.compose.yml` sets it to `true` and points the API at the collector
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTLP collector endpoint (`http://otel-collector:4318` with the overlay)
- `OTEL_SERVICE_NAME` - Service name in every span and metric (default: `kvox-api`)
- `GREPTIME_HOST` / `GREPTIME_HTTP_PORT` / `GREPTIME_PG_PORT` / `GREPTIME_DB` - Where the API reads telemetry back from (the telemetry explorer, dashboard and AI assistant)
- `GREPTIME_WRITER_USER` / `GREPTIME_READER_USER` / `GREPTIME_ADMIN_USER` and the three `*_PASSWORD` values - The three GreptimeDB accounts. The writer is the collector's ingest login only. The reader and admin are the **deployment default**: an administrator can save a connection at `/admin/settings/telemetry` (stored encrypted in the credential store) and it then replaces both with no restart. `telemetry.compose.yml` refuses to start without the passwords
- `GREPTIME_BIND_PG_PORT` - Host port for GreptimeDB's PostgreSQL wire protocol on a VPS (bound to `127.0.0.1` only)

Local telemetry: `docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f telemetry.compose.yml -f app.devdb.pgvector.compose.yml up` starts the collector and GreptimeDB. Traces and metrics appear in the app's telemetry explorer and dashboard (Admin Console, Operations) and in GreptimeDB's own SQL dashboard at http://localhost:14000/dashboard; `psql -h localhost -p 14003 -U <GREPTIME_READER_USER>` reads them directly. The collector's OTLP ports are remapped to 4327 (gRPC) and 4328 (HTTP) on the host. The GreptimeDB container is capped at 1 GB. `scripts/dev.ps1 -Otel` uses the same overlay. Telemetry is optional: with `OTEL_ENABLED=false` or GreptimeDB unreachable the API reports telemetry as unavailable and carries on. The Pino logger in `common/logger/` is kept; `initializeOtel` forwards its records to OTLP.

---

## Working with NestJS + Fastify

### Critical Differences from Express

#### 1. Response Methods

**❌ WRONG (Express-style):**
```typescript
@Get('example')
example(@Res() res: Response) {
  return res.status(200).json({ data: 'Hello' });
}
```

**✅ CORRECT (Fastify-style):**
```typescript
@Get('example')
example(@Res() res: FastifyReply) {
  return res.code(200).send({ data: 'Hello' });
}
```

**Key Differences:**
- Use `code()` instead of `status()`
- Use `send()` instead of `json()`
- Import types from `fastify` not `express`

**Best Practice:**
Most of the time, avoid using `@Res()` decorator directly. Let NestJS handle responses:

```typescript
@Get('example')
example() {
  // NestJS automatically serializes to JSON
  return { data: 'Hello' };
}
```

#### 2. Request Objects

**Type Imports:**
```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

// NOT from express:
// import { Request, Response } from 'express';
```

**Request Properties:**
```typescript
@Get('example')
example(@Req() req: FastifyRequest) {
  // Fastify uses req.body, req.params, req.query like Express
  // But some properties differ
  const ip = req.ip;           // Client IP
  const protocol = req.protocol; // http/https
  const hostname = req.hostname; // Host header
}
```

### Passport OAuth with Fastify

Passport strategies (like Google OAuth) are designed for Express and expect Express-style request/response objects. To work with Fastify, you need special handling.

#### The Problem

Passport OAuth guards expect to work with Node.js `IncomingMessage` and `ServerResponse` objects, but Fastify wraps these in its own request/response objects.

#### The Solution

Override `getRequest()` and `getResponse()` in your OAuth guard to return the raw Node.js objects:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // IMPORTANT: Copy user from raw request to Fastify request
    // so controllers can access req.user normally
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
```

**What this does:**
1. `getRequest()` returns `request.raw` - the underlying Node.js request object
2. `getResponse()` returns `response.raw` - the underlying Node.js response object
3. Passport performs OAuth using these raw objects
4. `handleRequest()` copies the authenticated user back to the Fastify request
5. Your controllers can now access `req.user` as normal

**Example in Controller:**
```typescript
@Get('google/callback')
@Public()
@UseGuards(GoogleOAuthGuard)
async googleAuthCallback(
  @Req() req: FastifyRequest & { user?: GoogleProfile },
  @Res() res: FastifyReply,
) {
  // Guard has set req.user for us
  const profile = req.user;

  // Use Fastify methods for response
  return res.redirect(302, redirectUrl.toString());
}
```

### Cookies with Fastify

Fastify uses `@fastify/cookie` plugin for cookie handling.

**Set Cookie:**
```typescript
res.setCookie('name', 'value', {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60 * 1000, // milliseconds
});
```

**Read Cookie:**
```typescript
const value = req.cookies['name'];
```

**Clear Cookie:**
```typescript
res.clearCookie('name', { path: '/api/auth' });
```

---

## Database Patterns

### Prisma Transactions

When creating related records (e.g., user with roles), always use transactions to maintain data consistency.

#### Why Transactions Matter

Without transactions, you can encounter foreign key violations:

**❌ WRONG (No Transaction):**
```typescript
// This can fail if user creation succeeds but role assignment fails
const user = await prisma.user.create({
  data: { email, displayName }
});

await prisma.userRole.create({
  data: {
    userId: user.id,
    roleId: defaultRole.id, // FK violation if role doesn't exist
  }
});
```

**✅ CORRECT (With Transaction):**
```typescript
const user = await prisma.$transaction(async (tx) => {
  const newUser = await tx.user.create({
    data: {
      email,
      displayName,
      userRoles: {
        create: {
          roleId: defaultRole.id,
        },
      },
      userSettings: {
        create: {
          value: DEFAULT_USER_SETTINGS,
        },
      },
    },
    include: {
      userRoles: {
        include: { role: true },
      },
    },
  });

  return newUser;
});
```

**Benefits:**
- All-or-nothing: Either all records are created or none
- No orphaned records
- No foreign key violations
- Consistent database state

### Nested Creates

Prisma supports nested creates which are automatically wrapped in transactions:

```typescript
const user = await prisma.user.create({
  data: {
    email: 'user@example.com',
    // Create related records in the same operation
    identities: {
      create: {
        provider: 'google',
        providerSubject: 'google-id-123',
        providerEmail: 'user@example.com',
      },
    },
    userRoles: {
      create: {
        roleId: roleId,
      },
    },
    userSettings: {
      create: {
        value: { theme: 'light' },
      },
    },
  },
  include: {
    identities: true,
    userRoles: { include: { role: true } },
    userSettings: true,
  },
});
```

### Seeding the Database

The seed script (`apps/api/prisma/seed.ts`) is idempotent and safe to run multiple times. Always run it through the `prisma:seed` npm script, never `ts-node`/`tsx` on the file directly: the script only reads `DATABASE_URL` from the environment, and `prisma:seed` (`scripts/prisma-env.js`) is what constructs that value from the `POSTGRES_*` variables before invoking Prisma. Calling the file straight fails with "DATABASE_URL is not set" — there's no other env var supplying it.

**Running Seeds:**

**In Docker** (the container's working directory is already `/app/apps/api`):
```bash
docker compose exec api npm run prisma:seed
```

**In a local checkout** (from the repository root — the same command CI runs):
```bash
npm run prisma:seed --workspace=api
```

**What Gets Seeded:**

`prisma/seed.ts` calls `seedPlatform` (from `@marinoscar/platform-db/seed`) with the two committed catalogs in `apps/api/prisma/catalog/`, then `seedApp` (`prisma/seed-app.ts`):

- RBAC roles (the system role `admin`; the organization roles `org_admin`, `contributor`, `viewer`), from `catalog/permissions.json`
- RBAC permissions (users:read, users:write, system_settings:read, the KVox domain permissions, etc.) with their scope, and the role-permission assignments
- Default system settings, from `catalog/system-settings-defaults.json`
- The initial admin allowlist entry (`INITIAL_ADMIN_EMAIL`)
- KVox's own rows (`seedApp`): the built-in note templates

**Changing the catalogs.** The two JSON files are generated from the registries, not edited by hand: `npm run catalog:permissions` and `npm run catalog:settings` (from `apps/api`). A new KVox permission is declared in `apps/api/src/app-registrations/permissions.ts` (an org-scoped permission names the org roles it is granted to in `defaultGrants`), registered through `app-registrations/registrations.ts`, then the catalog is regenerated and the seed re-run. `src/common/constants/roles.constants.ts` derives `ROLES` and `PERMISSIONS` from the registries, so it needs no edit. `app-registrations/registrations` must be the first import of every entry point (like `kvox.manifest`, below); `main.ts` and the test setup already do.

**When to Run Seeds:**
- Before first login
- After database reset
- After pulling schema changes that add new roles/permissions
- In CI/CD before running tests

---

## Common Pitfalls and Solutions

### 1. "Default role not found" Error

**Symptom:** First OAuth login fails with database error.

**Cause:** Database hasn't been seeded with RBAC roles.

**Solution:**
```bash
docker compose exec api npm run prisma:seed
```

### 2. Passport OAuth Not Working with Fastify

**Symptom:** OAuth redirect fails, or user object is undefined in callback.

**Cause:** Passport expects Express-style request/response objects.

**Solution:** Use the guard pattern shown above with `getRequest()`, `getResponse()`, and `handleRequest()` overrides to return raw Node.js objects and copy user back to Fastify request.

### 3. Response Method Not Working

**Symptom:** `res.status(200).json()` throws an error.

**Cause:** Using Express-style methods with Fastify adapter.

**Solution:** Use Fastify methods: `res.code(200).send()` or let NestJS handle the response.

### 4. Foreign Key Violation on User Creation

**Symptom:** User creation fails with FK constraint error.

**Cause:** Not using transaction when creating user with roles.

**Solution:** Wrap in `prisma.$transaction()` or use nested creates.

### 5. Error Messages in Redirect URLs

**Symptom:** Redirect fails or displays malformed error message.

**Cause:** Error messages contain newlines or special characters not safe for URLs.

**Solution:** Sanitize error messages before adding to URL:
```typescript
const errorMessage = error instanceof Error
  ? encodeURIComponent(error.message.replace(/[\r\n]/g, ' ').substring(0, 100))
  : 'authentication_failed';
return res.redirect(`${appUrl}/auth/callback?error=${errorMessage}`);
```

---

## Testing Guidelines

### Running Tests

**Backend Tests:**
```bash
cd apps/api
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:cov        # With coverage
npm run test:e2e        # E2E tests only
```

**Frontend Tests:**
```bash
cd apps/web
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage
```

### Test Database

Backend tests use a separate test database. Configure in `apps/api/.env.test`:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/app_test"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```

**Important:** The test database is truncated between test runs. Never point tests at your development database.

### Mocking OAuth in Tests

OAuth strategies are mocked in tests to avoid external dependencies:

```typescript
import { MockGoogleStrategy } from '../../test/mocks/google-oauth.mock';

// Set custom profile for test
MockGoogleStrategy.setMockProfile({
  email: 'test@example.com',
  displayName: 'Test User',
});

// Perform OAuth test
const response = await request(app.getHttpServer())
  .get('/api/auth/google/callback')
  .expect(302);
```

---

## Debugging Tips

### Debugging OAuth Flow

1. **Check Environment Variables:**
   ```bash
   echo $GOOGLE_CLIENT_ID
   echo $GOOGLE_CLIENT_SECRET
   echo $GOOGLE_CALLBACK_URL
   ```

2. **Verify Callback URL:**
   - Must match exactly in Google Cloud Console
   - Include protocol: `http://` or `https://`
   - Include port if not 80/443: `http://localhost:3535/api/auth/google/callback`

3. **Check Container Logs:**
   ```bash
   docker compose logs api -f
   ```

4. **Test OAuth Provider Endpoint:**
   ```bash
   curl http://localhost:3535/api/auth/providers
   ```

### Debugging Database Issues

1. **Check Prisma Connection:**
   ```bash
   cd apps/api
   npx prisma db push --preview-feature
   ```

2. **Inspect Database:**

   The compose stack does not bundle a `db` service — PostgreSQL runs
   separately and is reached via the `POSTGRES_HOST`/`POSTGRES_PORT` values
   in `.env`. Connect to it directly:
   ```bash
   psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U postgres -d appdb
   \dt              # List tables
   SELECT * FROM roles;
   SELECT * FROM permissions;
   ```

3. **View Prisma Logs:**
   Set `LOG_LEVEL=debug` in `.env` to see SQL queries.

### Common Log Messages

**"Database connected"**
✅ Prisma successfully connected to PostgreSQL

**"User logged out: user@example.com"**
✅ Logout successful

**"Refresh token reuse detected for user: xxx"**
⚠️ Security alert: Possible token theft

**"Default role not found - run database seeds"**
❌ Database not seeded - run `docker compose exec api npm run prisma:seed`

---

## Development Workflow

### Making Database Changes

The Prisma schema is composed. `apps/api/prisma/schema/` is **generated** by `platform db compose` from the platform fragments in `@marinoscar/platform-db` plus KVox's own `apps/api/prisma/fragments/*.prisma`. The domain fragments (transcripts, notes, search, graph, ask) are not edited there: they live in `packages/kvox-db/schema/` and `kvox-db sync` (the first half of `npm run db:compose`) installs them as generated `fragments/kvox.<slice>.prisma` copies. There is no `schema.prisma`. Never edit a file in `prisma/schema/`: the next compose overwrites it and `db:compose:check` fails in CI.

1. **Edit a fragment:**
   ```bash
   cd apps/api
   # Domain tables: edit packages/kvox-db/schema/kvox.<slice>.prisma (transcripts, notes, search, graph, ask)
   # Web-edition side tables: edit prisma/fragments/<name>.prisma
   ```
   - A KVox model lives in the fragment of its domain. Never edit `prisma/fragments/kvox.*.prisma`: they are generated copies (`kvox-db check` fails on a changed byte).
   - A relation from a KVox model to a platform model (`User`, `StorageObject`, `Job`) needs a back-relation. Add it as `extend model User { ... }` in the fragment that owns the foreign key. An `extend` block holds back-relation fields only: the composer refuses a scalar field or an index there.
   - A column on a platform table is not possible from a fragment. Use a side table keyed by the platform id, and list the exception in `docs/platform-adoption/local-exceptions.md`.

2. **Compose the schema:**
   ```bash
   npm run db:compose
   ```
   Commit the result under `prisma/schema/` with your change.

3. **Create the migration:**
   ```bash
   # Using npm script (recommended - handles environment variables)
   npm run prisma:migrate:dev -- --name descriptive_name

   # Or in Docker container
   docker compose exec api npm run prisma:migrate:dev -- --name descriptive_name
   ```
   Only one open pull request may carry a migration at a time. For a **domain** table add `--create-only`, then move the draft into the package with `npx kvox-db promote <dir> --id <slug> --slice <slice>` and list any new special index in `packages/kvox-db/raw-sql-indexes.json`; the steps are in [runbooks/kvox-domain-migration.md](runbooks/kvox-domain-migration.md).

4. **Generate Prisma Client:**
   ```bash
   # Using npm script (recommended)
   npm run prisma:generate

   # Or in Docker container
   docker compose exec api npm run prisma:generate
   ```

5. **Check the schema and the history:**
   ```bash
   npm run db:compose:check   # prisma/schema/ equals a fresh compose
   npm run db:check           # installed platform migrations match platform.lock; installed domain fragments and migrations match packages/kvox-db (kvox.lock)
   npm run db:drift:kvox      # migrations replayed in a shadow database equal the schema (plain db:drift is not clean by design)
   ```

6. **Update Seeds (if needed):**
   ```bash
   # KVox rows: edit prisma/seed-app.ts. Roles and permissions: edit
   # src/app-registrations/permissions.ts, then npm run catalog:permissions

   # Using npm script (recommended)
   npm run prisma:seed

   # Or in Docker container
   docker compose exec api npm run prisma:seed
   ```

Rules that keep this safe:

- **`kvox-db` runs from its build.** After `npm ci` and after any change under `packages/kvox-db/src`, run `npm run build -w @marinoscar/kvox-db` (or `npm run build:kvox-packages`); until then `db:compose`, `db:check` and `db:kvox:*` fail with `Cannot find module '../dist/bin/index.js'`.
- **Domain migrations live in `packages/kvox-db`.** The installed copies in `prisma/migrations/` are proven byte-identical by `prisma/kvox.lock` (`npm run db:check`, or `npm run db:kvox:check` alone; `npm run db:kvox:check:database` also checks the extensions and raw-SQL objects in the dev database). `kvox-db sync` installs what the lock lacks and merges the package's raw-SQL index list into `platform.lock`. Never edit or rename an installed domain directory, comments included.
- **KVox never authors platform migrations.** A platform package release brings new ones. Install them with `npm run db:sync`, review the new directories under `prisma/migrations/`, commit them with `platform.lock`, then `npm run prisma:migrate`. Never edit or rename an installed directory, comments included: the lock hashes the raw bytes.
- **Raw-SQL objects stay in `migration.sql`.** Partial unique, trigram, HNSW and GiST indexes, generated `tsvector` columns, CHECK constraints and triggers cannot be declared in a fragment. Never add `@@unique` or `@@index` for one. List every new partial or expression index under `rawSqlIndexes` in `platform.lock`, with `definition` copied from `SELECT indexdef FROM pg_indexes WHERE indexname = '<name>'`.
- **`db:drift:kvox` filters `apps/api/prisma/drift-allowlist.json`.** Each entry needs `statement`, `reason` and `removeIn` (an issue number, or `permanent`). Since #469 the file holds only the 13 permanent entries for indexes and generated-column defaults Prisma cannot declare; the platform's plain `db:drift` has no ignore list and fails on them. Never add an entry to hide a real difference on a platform table.
- The first adoption of the platform history on an existing database is a one-off baseline: `docs/runbooks/database-baseline.md`. The day-to-day workflow is also in the `platform-migration` skill (`.claude/skills/platform-migration/SKILL.md`).

**Note:** The project uses individual database environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, etc.) instead of a single `DATABASE_URL`. The npm scripts (`prisma:*`, `db:*`) automatically construct the connection URL from these variables. See `apps/api/scripts/README.md` for details. `db:drift:kvox` replays the history in a shadow database: set `SHADOW_DATABASE_URL` to an empty database, or use a role that may create databases. The shadow replay runs `CREATE EXTENSION vector`, which needs a superuser (see `docs/platform-adoption/local-exceptions.md`).

### Settings namespace registry

Every top-level key of the system settings document (the `global` row) and every optional key of a user's settings document is a **namespace**. A namespace is declared once, in the module that owns it, and the platform settings slice (`@marinoscar/platform-api/settings`, mounted in `apps/api/src/platform/settings/settings.config.ts`) composes the wire schemas, the defaults and the OpenAPI document from the registries at startup (issues #459, #466). The six hand-edited places and the local parity specs are gone: the registry is the single list.

To add a namespace:

1. **Write a declaration** next to the owning module. Use `SystemSettingsNamespace` for the `global` row or `UserSettingsNamespace` for per-user settings (both from `@marinoscar/platform-api/settings`). A system declaration carries `key`, `description`, the stored, patch, PUT and wire-PATCH schemas, the response schema (or `null`), `defaults` and, because the platform requires it, a `merge` (the field-by-field PATCH merge that used to live in the settings service). A user declaration carries the stored and patch schemas, `merge` and an optional `assertLimits`. Worked examples: [`transcription.system-settings.ts`](../apps/api/src/kvox/transcription/transcription.system-settings.ts) (with `mergeTranscriptionSettings`) and [`graph.user-settings.ts`](../apps/api/src/kvox/graph/graph.user-settings.ts). The registration refuses a secret-named field, and a user namespace never uses `.default()` (absent means "use the defaults").
2. **Append it to [`apps/api/src/app-registrations/settings.ts`](../apps/api/src/app-registrations/settings.ts)** (`APP_SYSTEM_SETTINGS_NAMESPACES` or `APP_USER_SETTINGS_NAMESPACES`) and add the key to the `declare module '@marinoscar/platform-api/settings'` augmentation in the same file, so `getNamespace('myKey')` and the composed bodies are typed. Registration order is the stored key order and the OpenAPI property order, so **append, never insert**.
3. **A field KVox stores in a namespace the platform also declares** goes through `APP_SYSTEM_SETTINGS_EXTENSIONS` / `APP_USER_SETTINGS_EXTENSIONS` (`extend...Namespace`), never a silent omission: a stored key the declaration lacks is dropped on the next write. Both lists are empty today. A default KVox overrides goes in `APP_SYSTEM_SETTINGS_DEFAULTS` (today only `databaseBackup.storageProvider`, `s3`).

The platform's own namespaces are listed, in stored order, in [`settings/registry/system-settings.manifest.ts`](../apps/api/src/settings/registry/system-settings.manifest.ts) and [`user-settings.manifest.ts`](../apps/api/src/settings/registry/user-settings.manifest.ts). They are registered even where the slice that owns them is not mounted yet, because services KVox still runs read them through `SystemSettingsService.getNamespace`; when that slice mounts and tries to register its key, KVox's registration is found first and left alone. Keep that order.

[`apps/api/src/kvox.manifest.ts`](../apps/api/src/kvox.manifest.ts) must be the **first import of every entry point** (`main.ts`, `scripts/dump-openapi.ts`, `app.module.ts`, `test/setup.ts`). Its first import is `kvox.settings-manifest.ts`, a stub that imports `settings/registry/`, which registers every namespace as a side effect, because the request bodies are composed from the registries when `SettingsModule.forRoot()` runs. A mis-wired entry point fails on start instead of silently stripping a namespace from every PATCH.

The platform's `settings` conformance suite (`test/conformance.spec.ts`) iterates the registries, so a registered namespace is checked automatically. A merge is still behaviour, not a key set: cover a new namespace's `merge` with a unit test of the declaration.

**Reacting to a user-namespace change.** The platform's `UserSettingsService` emits no event. A global interceptor, [`user-settings-change.interceptor.ts`](../apps/api/src/platform/settings/user-settings-change.interceptor.ts) (`PLATFORM-ADOPTION-SHIM(#466)`), reads the caller's namespaces before `PUT`/`PATCH /api/user-settings` and diffs them against the response, then emits `USER_SETTINGS_NAMESPACE_CHANGED_EVENT` (`user-settings.namespace-changed`, [`user-settings.events.ts`](../apps/api/src/platform/settings/user-settings.events.ts)) once per namespace whose value changed, with `{ userId, key, previous, next }`. A module that cares about one namespace subscribes and filters on `key`; the graph module's forwarder ([`graph-preferences-change.forwarder.ts`](../apps/api/src/kvox/graph/graph-preferences-change.forwarder.ts)) is the example. A listener must only enqueue work, never do it inline.

The declarations sit on a small registry primitive, [`apps/api/src/common/registry/`](../apps/api/src/common/registry/) (`defineRegistry`, `RegistryError`, `freezeAllRegistries`). Registries are frozen at application bootstrap, so a late `register` throws `FROZEN`.

### Adding New API Endpoints

1. Create DTO with Zod schema
2. Add controller method with guards
3. Implement service method with business logic
4. Add OpenAPI decorators for documentation (see [API.md § How the document is built](API.md#how-the-document-is-built))
5. Write tests (unit + integration)
6. Update API.md documentation

### Adding New Guards

Authentication and the role and permission guards are the platform's (`@Auth`, `@Public`, `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard` from `@marinoscar/platform-api/identity`); do not write a competing one. A guard that checks something KVox-specific:

1. Create it next to the module that needs it (for example `apps/api/src/<module>/guards/`)
2. Implement `canActivate()` method
3. Register it in that module
4. Add tests for guard logic
5. Document usage in SECURITY.md

---

## Performance Considerations

### Fastify Performance Tips

1. **Avoid `@Res()` decorator when possible** - Let NestJS handle serialization
2. **Use schema validation** - Fastify's built-in validation is faster than runtime checks
3. **Enable compression** - Use `@fastify/compress` for large responses
4. **Connection pooling** - Prisma handles this automatically

### Database Query Optimization

1. **Use `select` to limit fields:**
   ```typescript
   const user = await prisma.user.findUnique({
     where: { id },
     select: { id: true, email: true, displayName: true },
   });
   ```

2. **Use `include` judiciously:**
   ```typescript
   // Only include what you need
   include: {
     userRoles: {
       include: { role: true }, // Avoid deep nesting
     },
   }
   ```

3. **Index frequently queried fields** - Already done in schema for email, provider combinations

---

## Repository tooling

Root-level tooling added for the platform adoption (epic #457, issue #461). Nothing here changes runtime behaviour: it pins the `@marinoscar/platform-*` packages, guards against duplicate copies of singleton libraries, and runs the `@marinoscar/kvox-*` package pipeline (issue #487: [PACKAGES.md](PACKAGES.md), [release runbook](runbooks/release-kvox-packages.md)). The adoption baselines are in [platform-adoption/README.md](platform-adoption/README.md).

### Pinned platform packages

Every `@marinoscar/platform-*` dependency is pinned to one exact version, currently `0.1.0-next.5`. The same version appears in every entry:

| Where | Entries |
|---|---|
| Root `package.json` `devDependencies` | `@marinoscar/platform-contract` |
| `apps/api/package.json` `dependencies` | `@marinoscar/platform-contract`, `@marinoscar/platform-api`, `@marinoscar/platform-db` |
| `apps/web/package.json` `dependencies` | `@marinoscar/platform-contract`, `@marinoscar/platform-web` |

Application code does not import a platform package yet; only the resolution smoke tests (`apps/api/test/platform-pin.spec.ts`, `apps/web/src/__tests__/platform-pin.test.ts`) touch them.

**Rules**

- Never use a caret, tilde, tag or range. A bump is a reviewed change, and `check:platform-pin` is strict because of it.
- Never hand-merge `package-lock.json`. Regenerate it with `npm install`. If re-pinning the same version misbehaves, delete the `@marinoscar/platform-*` entries from the lockfile and reinstall.
- The npm `latest` dist-tag points at the old bootstrap release (`0.1.0-next.3`). Always install with an explicit version (`npm install @marinoscar/platform-api@0.1.0-next.5`), never `npm install @marinoscar/platform-api`.

**How to bump**

1. Find the new version: `npm view @marinoscar/platform-api dist-tags` (use the `next` value). Confirm all six packages publish it: `for p in contract api web db cli infra; do npm view @marinoscar/platform-$p@<version> version; done`.
2. Change **every** `@marinoscar/platform-*` entry in the root, `apps/api` and `apps/web` `package.json` files to the new version. A partial change fails the pin check.
3. Run `npm install` to regenerate the lockfile.
4. Run `npm run check:platform-pin` and `npm run check:single-instance`, then `npm ls @marinoscar/platform-contract` (one deduped version).

**GitHub-release tarball fallback.** When npm is unreachable, an entry may instead be the release tarball URL of the same version. The pin check accepts this form and extracts the version from the `platform-v<version>` path segment:

```text
https://github.com/marinoscar/EnterpriseAppBase/releases/download/platform-v0.1.0-next.5/marinoscar-platform-api-0.1.0-next.5.tgz
```

The same pattern applies to `contract`, `web` and `db`. A URL pin has no registry signature and Renovate cannot bump it, so prefer npm and say so in the PR when the fallback is used.

### The contract override

The root `package.json` carries `"overrides": { "@marinoscar/platform-contract": "$@marinoscar/platform-contract", ... }`. The `$` reference resolves against the root's own devDependency, which is why that devDependency exists: without it `npm install` fails with "Unable to resolve reference". Together they force one copy of `@marinoscar/platform-contract` for the API, the web app and the platform packages that depend on it. `check:platform-pin` fails if the override entry is missing or is neither the `$` reference nor the pin.

### Check scripts

| Command | What it does |
|---|---|
| `npm run check:platform-pin` | Runs `scripts/check-platform-pin.mjs`. Reads the root and every workspace `package.json` and fails (exit 1) when a `@marinoscar/platform-*` spec is not an exact version or a release tarball URL, when two entries differ, when `package-lock.json` resolves any `node_modules/@marinoscar/platform-*` (at any depth) to another version, or when the contract override is missing. Success prints `platform pin: <version> (N entries)`. Exit 2 is a usage error. |
| `node scripts/check-platform-pin.mjs --self-test` | Runs three inline fixtures (ok, caret range, mismatch) to prove the checker itself still detects what it should. Accepts `--root <dir>` for the normal mode. |
| `npm run check:single-instance` | Runs `scripts/check-single-instance.mjs`. Fails (exit 1) when a library with module-level state resolves to more than one copy: Nest, Fastify, Prisma client, Zod, `reflect-metadata`, `@opentelemetry/api`, React, React Router, MUI, Emotion, `ink`, plus any `packages/platform-*` workspace. It scans the lockfile and, after `npm ci`, resolves each name from every workspace and compares real paths. Flags: `--lockfile-only` (no `node_modules` needed), `--json`, `--lockfile <path>`, `--root <dir>`, `--guard <name>`. `node scripts/kvox-packages/check-single-instance.mjs` wraps it for the packages pipeline: it also accepts `--guard '@marinoscar/platform-*'` patterns and always guards every `@marinoscar/kvox-*` workspace. A duplicate is usually fixed by aligning a range in the workspace that drifted. |
| `npm run check:platform-imports` | ESLint over `apps/{api,web,cli}/src/**/*.{ts,tsx}` with `--max-warnings=0`. Only the deep-import ban applies: app code may not reach into a platform or `@marinoscar/kvox-*` package's `src/`, `dist/` or `internal/` paths. |
| `npm run lint:packages` | ESLint over `packages/kvox-*/src/**/*.{ts,tsx}` (`--no-error-on-unmatched-pattern`). Enforces the no-deep-import rule and the slice-direction rule. |
| `npm run build:kvox-packages`, `typecheck:kvox-packages`, `test:kvox-packages`, `docs:kvox-packages` | Run the `build`, `typecheck`, `test:run` and `docs` script of the six `@marinoscar/kvox-{contract,db,api,ai,eval,web}` workspaces. `build:packages`, `typecheck:packages`, `docs:packages` are aliases; `test:packages` also runs `test:kvox-scripts`. |
| `npm run test:kvox-scripts` | The tests of `scripts/kvox-packages/` (`node --test`), including the fixture that pins the `host-neutral` rule. |
| `npm run check:kvox-slice-peers`, `check:kvox-package-docs`, `check:kvox-pack` | The slice and peer rules, the README and TSDoc standard, and the pack check. All three are described in [PACKAGES.md](PACKAGES.md#checks-and-commands). |

`scripts/run-kvox-packages.mjs <script> [--if-present]` is a generic helper kept from issue #461: it lists the workspaces whose name starts with `@marinoscar/kvox-` and runs `npm run <script> -w <name>...` for all of them in one call (for example `node scripts/run-kvox-packages.mjs build`). The root `*:kvox-packages` scripts name the six packages explicitly instead, so a package added later is a deliberate edit of the root `package.json` and the workflows.

### Lint, TSDoc and TypeDoc configuration

| File | Purpose |
|---|---|
| `eslint.config.mjs` | Flat ESLint 10 config adapted from EnterpriseAppBase. Rule A: no deep imports into a package (only its `exports` map; no relative path that leaves the package, no app code, no `@app/shared`). Rule B: a slice under `packages/kvox-<pkg>/src/` may import another slice only when `packages/kvox-slices.json` lists it, and only through that slice's `index.ts`. Also applies the app deep-import ban. The apps' own `lint` scripts are untouched, and ESLint 10 ignores the legacy `.eslintrc.js`. |
| `packages/kvox-slices.json` | The slice dependency graph, `{ "kvox-<pkg>": { "<slice>": ["<allowed dependency slice>"] } }`. Slices of the six packages are declared; `packages/kvox-slice-peers.json` lists the peers each slice needs ([PACKAGES.md](PACKAGES.md#peer-dependencies-per-slice)). Append-only. |
| `tsdoc.json` | TSDoc configuration. Extends TypeDoc's and declares the custom `@stability` and `@extensionPoint` block tags. |
| `typedoc.base.json` | Shared TypeDoc options for the `@marinoscar/kvox-*` packages. Each package's own `typedoc.json` extends it and sets its tsconfig, entry points and output. The generated `docs-api/` folder is git-ignored. |

### Changesets and pre mode

Releases of the `@marinoscar/kvox-*` packages use [Changesets](https://github.com/changesets/changesets) in pre mode: `.changeset/pre.json` has `"mode": "pre"` and `"tag": "next"`, so releases are `x.y.z-next.N` on the `next` dist-tag. Do not edit or delete `pre.json` by hand.

The six packages are one `fixed` group in `.changeset/config.json`, so they always share a version; `api`, `web`, `cli` and `@app/shared` are listed under `ignore`: they are versioned by their own rules (the CLI by the version bump in [AGENTS.md](../AGENTS.md)), never through a changeset. `onlyUpdatePeerDependentsWhenOutOfRange` is on, for the reason in [PACKAGES.md](PACKAGES.md#the-contract-peer-range).

Run `npx changeset` in any pull request that changes a package; `npx changeset --empty` records that a change has no release impact. Writing guidance is in [`.changeset/README.md`](../.changeset/README.md). The version pull request and the publish are automated: `.github/workflows/kvox-release.yml`, procedure in the [release runbook](runbooks/release-kvox-packages.md). `npm run version-packages` is what the workflow runs; `npm run release` (`changeset publish`) is a manual escape hatch and does not publish with provenance.

### CI: the `tooling` job

`.github/workflows/ci.yml` has a `tooling` job (Repository tooling) that runs concurrently with the others (no `needs:`). After `npm ci` it runs, in order: `check:platform-pin`, `node scripts/check-platform-pin.mjs --self-test`, `check:single-instance`, `check:platform-imports`, `lint:packages`, `build:packages`, `typecheck:packages`, `test:packages`, `db:compose:check` and `db:check` (workspace `api`: the composed schema is current and the installed domain copies match `packages/kvox-db`) and `npx changeset status` (skipped on the `kvox-release/version` pull request, which consumes the changesets). The docs, peers, pack and smoke-import checks run in `.github/workflows/kvox-packages.yml` when a package changes. To reproduce a failure locally, run the same commands from the repository root.

### The `MonoRepo` tag

`MonoRepo` is an annotated git tag on the pre-adoption commit `6e44e43`, created and pushed by a maintainer before any platform-adoption code change merged. It is the rollback point for the whole platform adoption: undoing the adoption means resetting to this tag. Never move it, re-create it or delete it. Verify it exists with `git ls-remote --tags origin MonoRepo` (one line expected).

---

## Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Fastify Documentation](https://www.fastify.io/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Passport.js Documentation](http://www.passportjs.org/)
- [Project SECURITY-ARCHITECTURE.md](./SECURITY-ARCHITECTURE.md)
- [Project TESTING.md](./TESTING.md)

---

## Getting Help

If you encounter issues:

1. Check this guide for common pitfalls
2. Review container logs: `docker compose logs api -f`
3. Verify database seeds have run
4. Check environment variables are set correctly
5. Consult the specification docs in `docs/specs/`
6. Ask the team in Slack/Teams

## Summary

Key takeaways for developers:

- ✅ **Use Fastify methods**: `code()` and `send()`, not `status()` and `json()`
- ✅ **Seed before first login**: `npm run prisma:seed` (in the API container, or from the repo root with `--workspace=api`)
- ✅ **Use transactions**: Wrap related creates in `prisma.$transaction()`
- ✅ **Return raw objects for OAuth**: Override guard methods for Passport compatibility
- ✅ **Sanitize redirect URLs**: Encode and remove newlines from error messages

Following these patterns will help you avoid the most common issues and maintain consistency with the existing codebase.
