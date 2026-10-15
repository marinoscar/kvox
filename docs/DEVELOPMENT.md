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
   ```

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
   opt-in `devdb.compose.yml` overlay as a third `-f`:

   ```bash
   cd infra/compose
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
   ```

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
   - Seeds create the RBAC roles (admin, contributor, viewer)
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
- `POSTGRES_USER` - Database user (default: postgres)
- `POSTGRES_PASSWORD` - Database password (default: postgres)
- `POSTGRES_DB` - Database name (default: appdb)
- `POSTGRES_SSL` - Enable SSL connection (default: false)

Note: `DATABASE_URL` is constructed automatically from these variables at runtime.

**Authentication:**
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `JWT_ACCESS_TTL_MINUTES` - Access token TTL (default: 15)
- `JWT_REFRESH_TTL_DAYS` - Refresh token TTL (default: 14)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- `INITIAL_ADMIN_EMAIL` - First user with this email becomes Admin
- `DEVICE_CODE_EXPIRY_MINUTES` - Device code lifetime (default: 15)
- `DEVICE_CODE_POLL_INTERVAL` - Device polling interval in seconds (default: 5)
- `DEVICE_TOKEN_EXPIRY_DAYS` - Token lifetime for device sessions in days (default: 7)
- `DEVICE_PAT_EXPIRY_DAYS` - Lifetime of the PAT minted when a device (e.g. the CLI) requests `clientInfo.tokenType: "pat"`, in days; clamped to 1-999 (default: 90)
- `SECRETS_ENCRYPTION_KEY` - Base64-encoded 32-byte AES-256 key (generate with `openssl rand -base64 32`) that encrypts runtime-configured credentials (e.g. an SMTP password an admin enters through the app) before they are stored in the `credentials` table. Optional until a credential is stored; see `docs/runbooks/rotate-secrets-encryption-key.md`. Note: credentials configured at runtime through the UI/API live encrypted in the database, not in the environment — unlike every other secret in this section.

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
- `MAINTENANCE_MODE` - Environment override that outranks the persisted setting. Set to `true` to force the window open even if the app cannot start (a pre-migration deploy), or to `false` to force it shut (recovery from a window opened with `allowAdmins` false). Only the literal strings `'true'`/`'false'` count; anything else (including unset) means "no override, use the stored setting". Requires an application restart to take effect. See `docs/runbooks/maintenance-mode.md`. ⚠️ Document a value for this variable as prose ("set to `true`"), never as an inline `# MAINTENANCE_MODE=true` example — `apps/cli`'s `parseEnvExample` reads *any* commented `# KEY=value` line in `infra/compose/.env.example` as declaring an optional variable, so an illustrative assignment inside prose registers as a second declaration and fails the CLI's env-spec test. `infra/compose/.env.example` already carries exactly one commented default (`# MAINTENANCE_MODE=false`) and a comment stating this rule — do not add a second commented line for this key.

**Database Backup:**
- `DB_BACKUP_SCHEDULE_ENABLED` - Whether this process runs the backup scheduler: a ten-minute cron that enqueues the housekeeping sweep, starts a backup (by enqueuing `db.backup.run`) when the configured schedule has come due, and enqueues the retained-database drop. Defaults to on; only the literal `false` turns it off, and it is deliberately independent of `JOBS_WORKER_MODE` — the *tick* is not itself queue work (it only decides whether to enqueue), so an API running as a pure control plane must still queue its own backups even though `JOBS_WORKER_MODE=off` means nothing on this process will execute them. Everything about the schedule itself (enabled, frequency, time of day, timezone, retention count, stale window) is a `databaseBackup` system setting, not an environment variable — as is `nodeOffloadEnabled` (default **false**), which decides whether a worker node may take the dump at all. See `docs/specs/database-backup.md`.

**Knowledge graph:**
- `KG_MIGRATE_SCHEDULE_ENABLED` - Whether this process runs the hourly (minute 17) tick that enqueues `kg.migrate` for owners whose graph rows a declared ontology migration still has to reshape (#384). The tick only enqueues, and returns at once while `ONTOLOGY_MIGRATIONS` is empty. Only the literal `false` turns it off (default: on), the `DB_BACKUP_SCHEDULE_ENABLED` convention; an admin can still re-run one owner's migration with Retry in the job list. See `docs/runbooks/ontology-migration.md`

**Observability:**
- `OTEL_ENABLED` - Enable OpenTelemetry (default: true)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTEL Collector endpoint

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
- RBAC roles (admin, contributor, viewer)
- RBAC permissions (users:read, users:write, system_settings:read, etc.)
- Role-permission assignments
- Default system settings

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

1. **Update Prisma Schema:**
   ```bash
   cd apps/api
   # Edit prisma/schema.prisma
   ```

2. **Create Migration:**
   ```bash
   # Using npm script (recommended - handles environment variables)
   npm run prisma:migrate:dev -- --name descriptive_name

   # Or in Docker container
   docker compose exec api npm run prisma:migrate:dev -- --name descriptive_name
   ```

3. **Generate Prisma Client:**
   ```bash
   # Using npm script (recommended)
   npm run prisma:generate

   # Or in Docker container
   docker compose exec api npm run prisma:generate
   ```

4. **Update Seeds (if needed):**
   ```bash
   # Edit prisma/seed.ts

   # Using npm script (recommended)
   npm run prisma:seed

   # Or in Docker container
   docker compose exec api npm run prisma:seed
   ```

**Note:** The project uses individual database environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, etc.) instead of a single `DATABASE_URL`. The npm scripts (`prisma:*`) automatically construct the connection URL from these variables. See `apps/api/scripts/README.md` for details.

### Settings namespace registry

Every top-level key of the system settings document (the `global` row) and every optional key of a user's settings document is a **namespace**. A namespace is declared once, in the module that owns it, and composed into the wire schemas and defaults at startup. It no longer costs hand-edits in six places, and the settings module imports no domain code (issue #459).

To add a namespace:

1. **Write a declaration** next to the owning module. Use `SystemSettingsNamespace` ([`system-settings-namespace.ts`](../apps/api/src/settings/registry/system-settings-namespace.ts)) for the `global` row or `UserSettingsNamespace` ([`user-settings-namespace.ts`](../apps/api/src/settings/registry/user-settings-namespace.ts)) for per-user settings. A system declaration carries the stored, patch, PUT and wire-PATCH schemas, the response schema (or `null`) and the defaults. A user declaration carries the stored and patch schemas, `merge` and an optional `assertLimits`. Worked examples: [`transcription.system-settings.ts`](../apps/api/src/transcription/transcription.system-settings.ts) and [`graph.user-settings.ts`](../apps/api/src/graph/preferences/graph.user-settings.ts). The registration refuses a secret-named field, and a user namespace never uses `.default()` (absent means "use the defaults").
2. **Augment the type map** in the same file so `SystemSettingsValue` / `UserSettingsValue` know the key: `declare module '../settings/registry' { interface SystemSettingsNamespaces { myKey: MyValue } }` (or `UserSettingsNamespaces`).
3. **Add it to [`apps/api/src/kvox.manifest.ts`](../apps/api/src/kvox.manifest.ts)**. Registration order is the stored key order and the OpenAPI property order, so **append, never insert**.

The manifest must be the **first import of every entry point** (`main.ts`, `scripts/dump-openapi.ts`, `scripts/ask-eval/run.ts`, `app.module.ts`, `test/setup.ts`), because the request DTOs are composed from the registries at import time. The composers throw `Settings namespaces are not registered: import apps/api/src/kvox.manifest first` when it was not loaded, so a mis-wired entry point fails on start instead of silently stripping a namespace from every PATCH.

The parity specs (`common/schemas/settings-parity.spec.ts`, `user-settings-parity.spec.ts`) iterate the registries, so a registered namespace is checked automatically. The system settings service's hand-written merge is still behaviour, not a key set: cover a new system namespace there with a service test.

**Reacting to a user-namespace change.** After a PUT or PATCH of `/api/user-settings`, the service emits `USER_SETTINGS_NAMESPACE_CHANGED_EVENT` (`user-settings.namespace-changed`, [`user-settings.events.ts`](../apps/api/src/settings/user-settings/user-settings.events.ts)) once per namespace whose stored value changed, with `{ userId, key, previous, next }`. A module that cares about one namespace subscribes and filters on `key`; the graph module's forwarder ([`graph-preferences-change.forwarder.ts`](../apps/api/src/graph/preferences/graph-preferences-change.forwarder.ts)) is the example. A listener must only enqueue work, never do it inline.

The declarations sit on a small registry primitive, [`apps/api/src/common/registry/`](../apps/api/src/common/registry/) (`defineRegistry`, `RegistryError`, `freezeAllRegistries`). Registries are frozen at application bootstrap, so a late `register` throws `FROZEN`.

### Adding New API Endpoints

1. Create DTO with Zod schema
2. Add controller method with guards
3. Implement service method with business logic
4. Add OpenAPI decorators for documentation (see [API.md § How the document is built](API.md#how-the-document-is-built))
5. Write tests (unit + integration)
6. Update API.md documentation

### Adding New Guards

1. Create guard in `apps/api/src/auth/guards/`
2. Implement `canActivate()` method
3. Register in module if not global
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

Root-level tooling added for the platform adoption (epic #457, issue #461). Nothing here changes runtime behaviour: it pins the `@marinoscar/platform-*` packages, guards against duplicate copies of singleton libraries, and prepares the (still empty) `@marinoscar/kvox-*` package pipeline. The adoption baselines are in [platform-adoption/README.md](platform-adoption/README.md).

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
| `npm run check:single-instance` | Runs `scripts/check-single-instance.mjs`. Fails (exit 1) when a library with module-level state resolves to more than one copy: Nest, Fastify, Prisma client, Zod, `reflect-metadata`, `@opentelemetry/api`, React, React Router, MUI, Emotion, `ink`, plus any `packages/platform-*` workspace. It scans the lockfile and, after `npm ci`, resolves each name from every workspace and compares real paths. Flags: `--lockfile-only` (no `node_modules` needed), `--json`, `--lockfile <path>`, `--root <dir>`, `--guard <name>`. A duplicate is usually fixed by aligning a range in the workspace that drifted. |
| `npm run check:platform-imports` | ESLint over `apps/{api,web,cli}/src/**/*.{ts,tsx}` with `--max-warnings=0`. Only the deep-import ban applies: app code may not reach into a platform or `@marinoscar/kvox-*` package's `src/`, `dist/` or `internal/` paths. |
| `npm run lint:packages` | ESLint over `packages/kvox-*/src/**/*.{ts,tsx}` (`--no-error-on-unmatched-pattern`, so it passes while no such package exists). Enforces the no-deep-import rule and the slice-direction rule. |
| `npm run build:packages`, `typecheck:packages`, `test:packages`, `docs:packages` | Run the `build`, `typecheck`, `test:run` and `docs` script of every `@marinoscar/kvox-*` workspace through `scripts/run-kvox-packages.mjs`. |

`scripts/run-kvox-packages.mjs <script> [--if-present]` lists the workspaces whose name starts with `@marinoscar/kvox-` and runs `npm run <script> -w <name>...` for all of them in one call. While none exist it prints `no @marinoscar/kvox-* packages yet; nothing to <script>` and exits 0, so the four `*:packages` scripts are safe no-ops until Phase 2.

### Lint, TSDoc and TypeDoc configuration

| File | Purpose |
|---|---|
| `eslint.config.mjs` | Flat ESLint 10 config adapted from EnterpriseAppBase. Rule A: no deep imports into a package (only its `exports` map; no relative path that leaves the package, no app code, no `@app/shared`). Rule B: a slice under `packages/kvox-<pkg>/src/` may import another slice only when `packages/kvox-slices.json` lists it, and only through that slice's `index.ts`. Also applies the app deep-import ban. The apps' own `lint` scripts are untouched, and ESLint 10 ignores the legacy `.eslintrc.js`. |
| `packages/kvox-slices.json` | The slice dependency graph, `{ "kvox-<pkg>": { "<slice>": ["<allowed dependency slice>"] } }`. Currently empty for `kvox-contract`, `kvox-api` and `kvox-web`. Append-only. |
| `tsdoc.json` | TSDoc configuration. Extends TypeDoc's and declares the custom `@stability` and `@extensionPoint` block tags. |
| `typedoc.base.json` | Shared TypeDoc options for the `@marinoscar/kvox-*` packages. Each package's own `typedoc.json` extends it and sets its tsconfig, entry points and output. The generated `docs-api/` folder is git-ignored. |

### Changesets and pre mode

Releases of the `@marinoscar/kvox-*` packages use [Changesets](https://github.com/changesets/changesets) in pre mode: `.changeset/pre.json` has `"mode": "pre"` and `"tag": "next"`, so releases are `x.y.z-next.N` on the `next` dist-tag. Do not edit or delete `pre.json` by hand.

**There is nothing to do until Phase 2 (Epic 5, issue 5.1) publishes the first `@marinoscar/kvox-*` package.** Until then:

- No pull request needs a changeset, and `npx changeset status` reports nothing to release.
- `fixed` in `.changeset/config.json` stays empty, because Changesets rejects package names that do not exist yet. Issue 5.1 adds the `@marinoscar/kvox-*` group.
- `api`, `web`, `cli` and `@app/shared` are listed under `ignore`: they are versioned by their own rules (the CLI by the version bump in [AGENTS.md](../AGENTS.md)), never through a changeset.

Once a package exists, run `npx changeset` in any pull request that changes it. Writing guidance is in [`.changeset/README.md`](../.changeset/README.md). `npm run version-packages` and `npm run release` are maintainer steps at release time.

### CI: the `tooling` job

`.github/workflows/ci.yml` has a `tooling` job (Repository tooling) that runs concurrently with the others (no `needs:`). After `npm ci` it runs, in order: `check:platform-pin`, `node scripts/check-platform-pin.mjs --self-test`, `check:single-instance`, `check:platform-imports`, `lint:packages`, `build:packages`, `typecheck:packages`, `test:packages` and `npx changeset status`. To reproduce a failure locally, run the same commands from the repository root.

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
