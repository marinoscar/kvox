# CLAUDE.md

This file provides guidance for AI assistants working on this codebase.

## Project Overview

Web Application Foundation with React UI + Node API + PostgreSQL. Production-grade foundation with OAuth authentication, RBAC authorization, and flexible settings framework.

## Technology Stack

- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material UI (MUI)
- **CLI**: TypeScript, Commander (subcommands) + ink (interactive menu)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth required)
- **Testing**: Jest + Supertest (backend), React Testing Library + Vitest (frontend), Vitest (CLI)
- **Observability**: OpenTelemetry, Uptrace, Pino structured logging
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Nginx (same-origin routing)

## Repository Structure

```
/
  apps/
    api/                    # Backend API
      src/
      test/
      prisma/
        schema.prisma
        migrations/
      Dockerfile            # API container (near its code)
    web/                    # Frontend React app
      src/
      src/__tests__/
      Dockerfile            # Web container (near its code)
    cli/                    # First-party command-line client (`kvox`)
      src/
        commands/           # `login`, `api`, `config` subcommands
        tui/                # Interactive ink menu (real terminals only)
      README.md             # CLI usage, install, CI setup
  docs/                     # Documentation
  infra/                    # Infrastructure configuration
    compose/
      base.compose.yml       # Core services: api, web, nginx
      dev.compose.yml        # Development overrides (hot reload, volumes)
      prod.compose.yml       # Production overrides (resource limits)
      otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
      .env.example           # Environment variables template
    nginx/
      nginx.conf             # Nginx routing configuration
    otel/
      otel-collector-config.yaml   # OTEL Collector config
      uptrace.yml            # Uptrace configuration
  tests/e2e/                # Optional E2E tests
```

## MANDATORY: Issue-Driven Development (Traceability)

Every feature and bug fix MUST be tracked by a GitHub issue, filed **before** implementation planning is finalized (for features) or the fix starts (for bugs). This applies before any worktree or branch is created — traceability starts at the issue, not the code. Running `gh issue create` from inside the repo infers the target repository from the git remote automatically, so no repo owner/URL needs to be specified.

- **New feature**: Before finalizing an implementation plan, create (or confirm an existing) issue with `gh issue create --template feature_request.yml`. Fill in the real problem statement, proposed solution, affected component, and priority — not placeholder text.
- **Larger initiative**: If the work will span multiple features or sessions, file an Epic instead with `gh issue create --template epic.yml`. Child feature issues must reference the epic number in their body or task list.
- **Bug fix**: Before starting the fix, create (or confirm an existing) issue with `gh issue create --template bug_report.yml`. Fill in the description, reproduction steps, expected vs. actual behavior, component, and environment/logs if known. Do not file a duplicate if one already exists for the same bug — reuse it.
- **Link the work**: Reference the issue number in commit messages and/or the PR description (`Fixes #123` / `Relates to #123`), per the `.github/pull_request_template.md` convention.
- **Keep it current**: Update or close the issue as the corresponding PR resolves it, so issue state reflects real progress.
- **Scope**: This applies to feature and bug work specifically. Routine `chore`/`docs`/`refactor` commits don't each need their own tracking issue.

## MANDATORY: Worktree-Based Feature Development

Every feature or fix MUST be developed in a Git worktree. The main checkout stays on `main` at all times.

### Worktree Location & Naming
- All worktrees live under `worktrees/` in the repo root (git-ignored, never committed)
- Use **flat short names**: `worktrees/<short-name>` (e.g., `worktrees/add-export`, `worktrees/fix-auth-bug`)
- The branch name follows conventional format: `feat/<short-name>`, `fix/<short-name>`, etc.

### Workflow (Claude MUST follow)

**Starting feature work:**
0. Ensure a tracking issue exists, per [MANDATORY: Issue-Driven Development (Traceability)](#mandatory-issue-driven-development-traceability) above.
1. From the main checkout, create the worktree:
   ```bash
   git worktree add worktrees/<short-name> -b <type>/<short-name>
   ```
   Example: `git worktree add worktrees/add-export -b feat/add-export`
2. All development happens inside `worktrees/<short-name>/`
3. Commits follow all existing commit rules (see below)

**Finishing feature work:**
1. Ensure all changes are committed inside the worktree
2. Remove the worktree:
   ```bash
   git worktree remove worktrees/<short-name>
   ```
3. The branch remains for PR/merge

### Rules
- NEVER checkout feature branches in the main working directory
- NEVER work on features directly in the main checkout
- One worktree per feature branch (Git enforces this)
- If the worktree already exists for the requested feature, work inside it (don't recreate)

## MANDATORY: Claude Git Rules — Commit, Then Always Open a PR

Claude: these rules are **MANDATORY**. Follow them exactly.  
Your job is to create clean, frequent commits while implementing the requested
work, and then to **land that work through a pull request**.  
Assume the branch already exists and is checked out. Do **not** create branches.

### Every change ships as a PR (MANDATORY)

**Never merge to `main` by pushing to it.** Every change — however small, and
whether or not the request mentions one — is opened as a pull request against
`main` and merged from there. Do not wait to be asked for a PR; the ask is
standing. `main` is only ever written by a merge.

The order is fixed:

1. Commit the work in slices, per the cadence rules below.
2. Push the branch (`git push -u origin <branch>`).
3. Open the PR against `main`, filling in
   [`.github/pull_request_template.md`](.github/pull_request_template.md) and
   linking its tracking issue (`Fixes #123` / `Relates to #123`).
4. Merge it once CI is green and nothing is left outstanding on it.

⚠ **Green first, merge second.** A PR is merged when its checks pass and its
review threads are answered — never before, and never by disabling, skipping or
quarantining a check to get there. If a check is genuinely red for a reason this
diff did not cause, say so on the PR rather than merging past it silently.

⚠ **A merged PR is finished.** Follow-up work is a fresh branch off the updated
`main` and a new PR; never push new commits onto an already-merged branch.

---

### Core Commit Rules (MANDATORY)
1. **Commit early, commit often.** Do not leave large uncommitted change sets.
2. Each commit must be **small, coherent, and reviewable**.
3. **One intent per commit** (no “misc fixes” bundles).
4. **Do not include unrelated refactors** unless explicitly requested.
5. If you change behavior, you must add/adjust tests in the same commit or the next immediate commit.

---

### Commit Message Standard (MANDATORY: Conventional Commits)
Use this format:

`<type>(<scope>): <short imperative summary>`

Allowed types:
- `feat:` new functionality
- `fix:` bug fix
- `refactor:` internal change, no behavior change
- `test:` add/adjust tests only
- `docs:` documentation only
- `chore:` tooling, deps, formatting, build, CI

Scopes (pick one relevant area):
- `api`, `web`, `db`, `infra`, `auth`, `chat`, `ui`, `core`, `jobs`, `docs`, `tests`

Examples:
- `feat(chat): add permit search prompt builder`
- `fix(api): handle missing location gracefully`
- `test(api): cover permit filter edge cases`
- `chore(web): run formatter`

---

### Commit Cadence (MANDATORY)
Make commits at these checkpoints:

1) **Scaffold / wiring**
- New files, routes, handlers, basic plumbing (even if incomplete).
- Example: `feat(api): scaffold permit lookup endpoint`

2) **Core functionality**
- Implement the smallest working slice end-to-end.
- Example: `feat(core): implement permit filtering by location radius`

3) **Edge cases + validation**
- Input validation, error handling, fallback behavior.
- Example: `fix(api): validate lat/lng inputs and return 400`

4) **Tests**
- Unit/integration tests for the new behavior and critical edge cases.
- Example: `test(api): add coverage for location filter and empty results`

5) **Cleanup**
- Remove dead code, rename for clarity, small refactors strictly related to the change.
- Example: `refactor(core): extract permit query builder`

6) **Docs (if needed)**
- Only if the task requires it.
- Example: `docs(api): document permit endpoint parameters`

---

### What to Include / Exclude (MANDATORY)
#### Include
- Code + tests for the same feature area
- Minimal config changes needed to run/build/test
- Small, related refactors that reduce complexity for the feature

#### Exclude
- Repo-wide formatting changes unless required
- Dependency upgrades unless required
- Unrelated cleanup in neighboring modules

---

### Commit Command Sequence (MANDATORY)
Before committing:
1. `git status`
2. `git diff`
3. Stage intentionally:
   - `git add -p` (preferred) or `git add <files>`

Commit:
- `git commit -m "<type>(<scope>): <summary>"`

After commit:
- `git status`

Repeat until the next checkpoint is complete, then commit again.

---

### Handling Mixed Changes (MANDATORY)
If you accidentally made unrelated edits:
- Revert them before committing, or
- Split into separate commits (preferred). Only keep the unrelated commit if explicitly requested.

---

### If Tests Cannot Be Run (MANDATORY)
If you cannot run tests for a valid reason (missing env, tool not available):
- Still commit, but include a clear note in the commit body.

Example:
- Subject: `feat(api): implement permit search by address`
- Body: `Notes: tests not run (DB env not available).`

---

### Golden Rule (MANDATORY)
If the diff feels “big,” you waited too long. **Split the work and commit sooner.**

## MANDATORY: CLI Version Bump on Improvement

Every improvement or set of improvements to the CLI (`apps/cli`, and the
`install.sh`/`apps/cli/bootstrap-vps.sh` scripts that install it) MUST bump
the version in `apps/cli/package.json` — the only place it lives;
`apps/cli/src/package-info.ts` reads it from there at runtime and exports
`CLI_VERSION` (see that file's own header for why it is never hardcoded or
imported directly elsewhere). The version is not cosmetic: `CLI_VERSION` is
recorded into a deployment's state file as `appctlVersion`, into
`deploy-info/info.json` as `deployedBy.version`, and sent as the User-Agent on
every API request — so a stale version makes two different installs
indistinguishable in a deployment record, which is the failure this rule
prevents.

- **Default to a PATCH bump** (SemVer's third field) — e.g. `1.0.0` ->
  `1.0.1` — for a CLI improvement, or a set of them shipped together.
- **A genuinely new user-facing capability** (a new command or subcommand)
  takes a **MINOR** bump instead — e.g. `1.0.0` -> `1.1.0`.
- **One bump per PR, not per commit.** A set of improvements shipped
  together in one PR gets a single version bump.
- Bumping `apps/cli/package.json` also requires regenerating
  `package-lock.json` — its `apps/cli` workspace entry carries the version
  too — with `npm install --package-lock-only`. Easy to forget; the bump is
  incomplete without it.

## MANDATORY: Settings UI Pattern

Every settings surface in this app — admin or per-user — is a **registry-driven
hub**, not a tab strip and not an ungoverned route. This was established by
epic #90 (issues #91–#96) and is documented in full, with rationale and
rejected alternatives, in [`docs/specs/settings-ui.md`](docs/specs/settings-ui.md).
This section states the rules; that file explains why.

### Core Rules (MANDATORY)

1. **Every new settings page MUST be declared in a section registry.**
   Admin cards go in `apps/web/src/config/adminSections.tsx`
   (`ADMIN_SECTIONS`); per-user cards go in
   `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`).
   A route added without a registry entry is not acceptable — it is a route
   the hub, the Console rail, and the AppBar title resolver all disagree
   about, because none of the three has any way to know it exists.

2. **A settings page MUST NOT be added as a new tab on an existing settings
   page.** Tabs remain legitimate **inside** a single destination, but only
   for genuinely **parallel** content — two views of the same question. The
   live example is `apps/web/src/pages/Admin/UsersPage.tsx`, which keeps its
   two tabs (Users, Allowlist) on purpose: they are two views of one question
   ("who may use this application"), backed by two controllers, not a
   hierarchy. State the distinction precisely:
   - A **destination** gate (which registry card, which route) is about
     **reachability**.
   - A **tab** gate (inside one page) is about **content**.
   Tabs are **permitted** for parallel content, never **required**: epic #45
   made Transcripts and Notes two tabs of one `library` destination because
   the bottom bar had no fifth slot, and epic #105 turned them into sibling
   destinations once #106 freed one by moving `Console` off that bar. Same
   rule, different amount of room — see
   [`docs/specs/ux-refresh.md`](docs/specs/ux-refresh.md) §1.

   Conflating the two is the exact mistake epic #90 fixed:
   `SystemSettingsPage`'s three tabs (UI Settings, Feature Flags, Advanced
   JSON) were hierarchical content wearing a tab strip, not parallel content.
   Epic #90 split them into three separate cards; issue #366 later removed all
   three (and the `ui`/`features` system-settings namespaces behind them)
   as unused. Neither exists today — see
   [`docs/specs/settings-ui.md`](docs/specs/settings-ui.md) for the full history.

3. **The card's `permission` field MUST be the exact string the API
   controller enforces** — never invented, never approximated. Follow the
   real, verified mapping as the model:
   - `system_settings:read` / `system_settings:write` →
     `system-settings.controller.ts`
   - `system_settings:read` → `about.controller.ts` (the About card, epic
     #118 decision 8 — deliberately no `about:read`)
   - `users:read` → `users.controller.ts`
   - `allowlist:read` → `allowlist.controller.ts` (gates content **inside**
     the Users & Allowlist page, not the route — see rule 2's
     reachability-vs-content distinction)

4. **New settings surfaces MUST reuse the shared
   `apps/web/src/components/settings/SettingsHub.tsx` component.** Do not
   fork it, do not copy it. The worked example is `/settings`
   (`apps/web/src/pages/UserSettingsHubPage.tsx`): it is a 4-prop binding
   (`sections`, `hubKey`, `title`, `subtitle`) over the exact same component
   `/admin/settings` uses — nothing more.

5. **The five coupled breakpoint gates move together or not at all.** Never
   change one without checking all five:
   1. `Layout.tsx`'s `showRail` (`up('sm')`) — mounts/unmounts `NavigationRail`
   2. `BottomNav`'s own `down('sm')` self-gate
   3. `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx`
   4. `SettingsHub.tsx`'s `isCompactWindow` (`down('sm')`)
   5. `AppBar.tsx`'s `isCompactWindow` (`down('sm')`)

   The boundary is `sm` (600px), never `md` (900px) — gating at 900px hands
   the phone treatment to 600–899px tablets, foldables, and landscape
   phones. There is deliberately no shared constant binding these five: see
   `docs/specs/settings-ui.md` §5 for why.

   ⚠ **Still exactly five.** `components/library/LibraryPageFrame.tsx` reads
   `down('sm')` too, and it is **not** a sixth gate: it is the page-level read
   `LibraryPage` always had, relocated when #106 split that page in two. It
   decides where one page puts its create action (a header button or a FAB),
   never whether a piece of app chrome mounts. The rail's collapsed *width*
   also moved 56 → 72px in #106 while its breakpoint did not — a width is not
   a gate.

See [`docs/specs/settings-ui.md`](docs/specs/settings-ui.md) for the full
rationale, the rejected alternatives, and the accessibility requirements.

## MANDATORY: Every Long-Running Activity Is a Queue Job

Epic #345 makes three standing architecture decisions binding. They exist
because the database backup was, until this epic, a detached promise with no
job type, no row in `GET /api/admin/jobs`, no worker slot, and no timeout —
and the three-argument case against ever fixing that
(`docs/specs/database-backup.md`) turned out to be three defects in the queue,
not properties of backups. Fixing the queue and moving the backup onto it is
documented in full in [`docs/specs/job-queue.md`](docs/specs/job-queue.md) §7.10
and [`docs/specs/database-backup.md`](docs/specs/database-backup.md); this
section states the four rules that follow from it.

### Core Rules (MANDATORY)

1. **No long-running work outside the queue.** Any activity that outlives the
   HTTP request or cron tick that started it MUST be a registered `JobHandler`
   with a declared `type`, enqueued through `JobsService`. A detached
   `void this.doSomething()`, an `@OnEvent` body that downloads or spawns, and
   a `@Cron` body that does work inline are all violations. A `@Cron` may only
   decide *whether* work is due and enqueue it — `apps/api/src/jobs/tasks/job-history-purge.task.ts`
   is the reference `@Cron`, and `apps/api/src/jobs/housekeeping.enqueue.ts` is
   the shared helper several of the converted crons enqueue through.

   Three permanent exemptions, and only these three — the list lives in
   [`docs/specs/job-queue.md` §7.10](docs/specs/job-queue.md#710-all-long-running-work-is-a-job--the-rule-the-exemptions-the-limit)
   and `apps/api/test/jobs/cron-enqueue-only.spec.ts` is its executable form; a
   fourth requires editing both. `jobs/tasks/job-stuck-reset.task.ts` (the
   lease reaper — recovery that depends on the thing it recovers is not
   recovery), `jobs/tasks/temp-file-janitor.task.ts` (it sweeps *this
   process's* local disk, which a node or another replica claiming the job
   could not reach), and `nodes/tasks/node-secret-sweep.task.ts` (it destroys
   the short-lived database roles brokered to worker nodes — making
   credential revocation depend on the queue means a wedged queue leaks live
   credentials for as long as it stays wedged).

   Not covered: fire-and-forget notification dispatch
   (`this.notifications.notify(...)` and the delivery channels behind it).
   "Long-running" means work with a duration worth accounting for — a sweep
   over a table, a dump, a network round trip per row — not every asynchronous
   call.

2. **Node-eligibility is the default posture.** A new job type SHOULD carry
   `nodeResultSchema` + `persistNodeResult` unless it genuinely cannot —
   because it writes as it goes, reads several tables mid-computation, or
   needs a privilege a remote machine must never hold (the database restore is
   the canonical example: it renames the live database and stays server-only
   permanently). Eligibility stays **derived** from those two members; there
   is no `nodeEligible` flag and there never will be
   (`apps/api/src/jobs/job-handler.interface.ts`). A deployment declines the
   offload with a system setting consulted at claim time
   (`NodeOffloadService.offeredTypes()` and a handler's own
   `nodeOffloadEnabled()`) — never by editing the handler.

3. **A node never persists a job-scoped credential.** Every secret a node
   needs for a job is issued per job by the server through
   `POST /api/nodes/:id/jobs/:jobId/secret`, gated by `assertJobHeldByNode`,
   bounded by the job's own lease, held in the node's memory only, and revoked
   when the job settles or by the sweep above. The server stores the
   credential's **handle** in `job_node_secrets`, never its material — that
   table has no column able to hold one. A handler declares the need by
   carrying a `nodeSecretBroker` (`apps/api/src/jobs/job-secret-broker.ts`);
   presence is the declaration, exactly as `nodeResultSchema` +
   `persistNodeResult` declare eligibility. The node's own `nod_` identity
   token is the single exception to "never persisted" — it is an identity a
   node authenticates with, not a job-scoped grant.

4. **A job type declares its execution profile, or takes the global default.**
   `JobHandler.profile` is optional and, when present, carries exactly
   `{ maxRuntimeMs, maxAttempts }` — **and only those two numbers**
   (`apps/api/src/jobs/job-execution-profile.ts`). The lease, the renewal
   interval, and the reaper's patience for an implausible lease are all
   *derived* from `maxRuntimeMs`, so a lease that contradicts a declared
   timeout is unrepresentable rather than merely avoided. Do not add
   `leaseMs` or `heartbeatMs` to the profile — a declared duration that can
   disagree with `maxRuntimeMs` is exactly the state this rule exists to rule
   out.

## Architecture Principles

1. **Separation of Concerns**: UI handles presentation only; API handles all business logic and authorization
2. **Same-Origin Hosting**: UI at `/`, API at `/api`, API reference at `/api/docs`
3. **Security by Default**: All API endpoints require authentication unless explicitly public
4. **API-First**: All business logic resides in the API layer

## Key Commands

```bash
# Setup: copy environment template
cp infra/compose/.env.example infra/compose/.env

# Start development (from infra/compose folder)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start development with observability (Uptrace UI at http://localhost:14318)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Start production mode
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up

# Run API tests
cd apps/api && npm test

# Run frontend tests
cd apps/web && npm test

# Generate Prisma client after schema changes
cd apps/api && npm run prisma:generate

# Create a new migration (development)
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name>

# Apply migrations (production)
cd apps/api && npm run prisma:migrate

# Note: Use npm scripts (prisma:*) instead of direct npx commands
# They automatically construct DATABASE_URL from individual env vars
```

## Service URLs (Development)

- **Application**: http://localhost:3535 (via Nginx)
- **API Reference (Scalar)**: http://localhost:3535/api/docs
- **Uptrace**: http://localhost:14318 (when otel stack running)

## Command-Line Client (`kvox`)

`apps/cli` is the first-party CLI for this API (epic #110). It is a workspace
package (`--workspace=cli`) that is built from this monorepo and not published;
it logs in through the device authorization flow below, stores the resulting
personal access token, and exposes a single generic `api <method> <path>`
command so it does not go stale as endpoints are added or renamed.

Usage, install, flags, environment variables and CI setup are documented in
[`apps/cli/README.md`](apps/cli/README.md) — that file is the source of truth;
do not restate it here.

### Deploying to a VPS

VPS deployment (epic #168, corrected against a real server by epic #118)
lives entirely in this CLI as `kvox deploy
doctor|install|uninstall|update|status|about|list|certs` — there is no separate
deploy script or Ansible playbook anywhere in this repo, and there shouldn't
be.
The design (why it runs on the VPS with no SSH client in the CLI, why TLS is
terminated by a shared, containerized proxy instead of per-app, why there's
no `db` service, what was rejected) is documented in full in
[`docs/specs/vps-deploy.md`](docs/specs/vps-deploy.md) —
[§18](docs/specs/vps-deploy.md#18-v2-the-real-vps-epic-118) is what epic #118
corrected against the shipped code, [§19](docs/specs/vps-deploy.md#19-the-deploy-infoinfojson-schema)
is the `deploy-info/info.json` schema, and
[§21](docs/specs/vps-deploy.md#21-removing-a-deployment-what-it-refuses-to-remove-and-the-two-extras-that-must-be-asked-for-issues-261-268)
records why `uninstall` refuses to touch the shared `devnet` network, the
shared proxy container or (by default) the TLS certificates — each a
deliberate refusal, not an oversight — and, in §21.3.1 (issue #268), why the
database and the object store are **opt-in extras** rather than either a
refusal or a default: each needs its own flag plus a typed confirmation of
that resource's own real name, so a word typed for one can never authorise
the other, and
[§23](docs/specs/vps-deploy.md#23-update-adopts-a-deployment-it-has-no-record-of-issue-285)
records why `update`'s precondition asks whether a **deployment** is there
rather than whether the CLI's own state file is — it reconstructs a missing
record from the clone, the `.env` and the proxy, and never invents the two
instants (`installedAt`, `lastDeployedAt`) that no disk carries; the
operator-facing runbook —
prerequisites, first login after install, troubleshooting — is
[`docs/deployment/vps.md`](docs/deployment/vps.md). The command reference
(flags, exit codes) is [`apps/cli/README.md`](apps/cli/README.md#deploying-to-a-server)
above. Don't restate any of that here; extend those three instead.

## API Endpoints (MVP)

### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `POST /api/auth/logout-all` - Logout from all devices
- `GET /api/auth/me` - Get current user

### Device Authorization (RFC 8628)
- `POST /api/auth/device/code` - Generate device code (Public)
- `POST /api/auth/device/token` - Poll for authorization (Public)
- `GET /api/auth/device/activate` - Get activation info
- `POST /api/auth/device/authorize` - Approve/deny device
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/{id}` - Revoke device session

### Users (Admin-only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/{id}` - Get user by ID
- `PATCH /api/users/{id}` - Update user (roles, activation)
- `PUT /api/users/{id}/roles` - Update user roles

### Settings
- `GET /api/user-settings` - Get current user's settings
- `PUT /api/user-settings` - Replace user settings
- `PATCH /api/user-settings` - Partial update user settings
- `POST /api/user-settings/profile-image` - Upload a profile picture (multipart, `user_settings:write`)
- `DELETE /api/user-settings/profile-image` - Remove the uploaded profile picture (`user_settings:write`)
- `GET /api/user-settings/profile-image` - Authenticated preview of the caller's own uploaded picture regardless of selected source (`user_settings:read`)
- `GET /api/users/{userId}/avatar/{objectId}` - Public, same-origin stream of a user's uploaded avatar
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Replace system settings (Admin)
- `PATCH /api/system-settings` - Partial update system settings (Admin)

### Allowlist (Admin-only)
- `GET /api/allowlist` - List allowlisted emails (paginated, filterable)
- `POST /api/allowlist` - Add email to allowlist
- `POST /api/allowlist/{id}/reminder` - Re-email an unclaimed invitee (`allowlist:write`, issue #301). 409 if already claimed. Manual only — no cron, no job type; `reminderCount`/`lastReminderAt` mean "requested", not "delivered"
- `DELETE /api/allowlist/{id}` - Remove email from allowlist

### Storage Objects
An object whose `managed_by` is set belongs to another module (a transcript's
source audio, its exports): it is **hidden from the list** and **409s on
DELETE**, naming the module to delete it through. Reads, downloads and metadata
edits stay available to the owner — see `docs/API.md` and issue #21.
- `POST /api/storage/objects/upload/init` - Initialize resumable upload (adaptive `partSize`, persisted; first ten part URLs only)
- `POST /api/storage/objects/:id/upload/parts` - Sign the next batch of part URLs (max 100, `storage:write`)
- `GET /api/storage/objects/:id/upload/status` - Get upload progress, read from the provider's own part list
- `POST /api/storage/objects/:id/upload/complete` - Complete multipart upload (`parts` optional; omit it and the server reads the ETags back)
- `DELETE /api/storage/objects/:id/upload/abort` - Abort upload
- `POST /api/storage/objects` - Simple file upload
- `GET /api/storage/objects` - List objects (paginated; managed objects excluded)
- `GET /api/storage/objects/:id` - Get object metadata
- `GET /api/storage/objects/:id/download` - Get signed download URL
- `DELETE /api/storage/objects/:id` - Delete object (409 if managed by a module)
- `PATCH /api/storage/objects/:id/metadata` - Update metadata

### Personal Access Tokens
- `POST /api/pat` - Create a new personal access token
- `GET /api/pat` - List current user's tokens
- `DELETE /api/pat/{id}` - Revoke a token

### Jobs — the background queue (Admin-only)
Six literal routes plus the `insights` pair, all under `/api/admin/jobs`; see
[`docs/specs/job-queue.md`](docs/specs/job-queue.md). `jobs:read` for the four
reads, `jobs:write` for the four writes (`insights/reset-history` included —
it destroys unrecoverable rollup history, not a job).
- `GET /api/admin/jobs/stats` - Totals, per-status/per-type breakdown, `stuckRunning` and its threshold
- `GET /api/admin/jobs/insights?windowDays=` - Throughput, duration percentiles, per-type ETA, lifetime totals (max 90 days)
- `POST /api/admin/jobs/insights/reset-history` - Clear the `job_stats_rollup` accumulators (live jobs untouched)
- `POST /api/admin/jobs/retry-failed` - Requeue every failed job, optionally one `type` (max 500/call)
- `POST /api/admin/jobs/reset-stuck` - Run the lease reaper on demand (`olderThanMinutes` overrides the system setting)
- `GET /api/admin/jobs` - List jobs, paginated and filterable (payloads not included)
- `POST /api/admin/jobs/{id}/retry` - Requeue one job (400 if it is currently running)
- `DELETE /api/admin/jobs/{id}` - Delete one job (400 if it is currently running)

### Worker Nodes — the fleet that executes jobs remotely
Three surfaces; see [`docs/specs/worker-nodes.md`](docs/specs/worker-nodes.md).
`nodes:read` for every read, `nodes:write` for every write (minting a signed
URL and claiming a job both count as writes — see the spec for why).

**`/api/nodes/*`** — what a node talks to. Reachable by a `nod_` credential
(the *only* prefix that credential family can reach) or by a session/PAT
holding `nodes:*`; scoped to the caller's own nodes.
- `POST /api/nodes/register` - Register, or reattach to an existing `(owner, name)` row (200, not 201 — see `reattached`)
- `GET /api/nodes/job-types` - Node-eligible job types, each with its result JSON Schema
- `GET /api/nodes` - List the caller's nodes
- `GET /api/nodes/{id}` - Get one node
- `POST /api/nodes/{id}/deregister` - Mark offline (does not requeue held jobs)
- `POST /api/nodes/{id}/heartbeat` - Liveness + optional capability/concurrency refresh
- `POST /api/nodes/{id}/claim` - Claim up to `concurrency` runnable jobs under a lease
- `POST /api/nodes/{id}/jobs/{jobId}/renew` - Extend the lease
- `POST /api/nodes/{id}/jobs/{jobId}/download-url` - Signed GET for the job's input object (data plane; bytes never touch this API)
- `POST /api/nodes/{id}/jobs/{jobId}/upload-url` - Signed PUT plus the server-chosen key (data plane)
- `POST /api/nodes/{id}/jobs/{jobId}/secret` - Issue the one short-lived, job-scoped credential this job's type declares (epic #345). Bounded by the job's lease, returned once, revoked on settlement; `403` when this deployment does not broker credentials, `404` when the type declares no broker, `503` when the broker cannot mint right now
- `POST /api/nodes/{id}/jobs/{jobId}/result` - Submit a validated result; settles the job
- `POST /api/nodes/{id}/jobs/{jobId}/failure` - Report a failure (`rateLimited` defers rather than charging an attempt)

**`/api/node-credentials`** — minting/revoking `nod_…` bearer credentials.
Deliberately **not** reachable by a `nod_` credential itself (only a session
or `pat_` token), so a leaked node token can never mint another.
- `POST /api/node-credentials` - Mint a credential; the raw token is shown exactly once
- `GET /api/node-credentials` - List the caller's credentials, masked
- `DELETE /api/node-credentials/{id}` - Revoke (effective on the node's next request)

**`/api/admin/nodes/*`** (Admin-only) — the whole fleet, every owner, deliberately
on a *different* prefix so it sits outside the `nod_` allowlist by construction.
- `GET /api/admin/nodes` - Every node, with owner email and derived health
- `GET /api/admin/nodes/{id}` - One node, whoever owns it
- `DELETE /api/admin/nodes/{id}` - Delete the node record (jobs are unclaimed, not deleted)
- `GET /api/admin/nodes/credentials` - Every node credential, with its owner
- `DELETE /api/admin/nodes/credentials/{id}` - Revoke any credential, whoever owns it

### Maintenance (Admin-only)
No dedicated permission — this *is* a system setting, stored in the
`maintenance` namespace and gated by the same pair every other system setting
uses. See [`docs/specs/maintenance-mode.md`](docs/specs/maintenance-mode.md)
and [`docs/runbooks/maintenance-mode.md`](docs/runbooks/maintenance-mode.md).
- `GET /api/admin/maintenance` - Effective state plus each contributing layer (`system_settings:read`)
- `PUT /api/admin/maintenance` - Open or close the window (`system_settings:write`)

### About (Admin-only)
What is deployed here (issue #124, epic #118). Gated on `system_settings:read`
and **deliberately not a permission of its own** — an administrator's
configuration read, and the exact string the `/admin/settings/about` card
(#126) carries. Reads the CLI's `deploy-info/info.json` (`DEPLOY_INFO_PATH`,
default `/app/deploy-info/info.json`) on **every request**, **never performs
network I/O**, and **always answers 200** — the dev stack has no file and
answers `deployInfoStatus: "absent"`; an unreachable database answers
`database: null` + `databaseError`. See [`docs/API.md`](docs/API.md#about-admin-only).
- `GET /api/admin/about` - The deploy-info record (`deployInfoStatus`: `ok`/`absent`/`unreadable`/`invalid`), live runtime facts, database facts, and `updateAvailable` derived from `remote.commitsBehind` (`null` = the CLI has never checked) (`system_settings:read`)

### Database Backup (Admin-only)
- `GET /api/admin/db-backup/node-credential-preflight` - Whether a worker node can be handed a
  short-lived, SELECT-only database credential to take a backup (`db_backup:read`). Two
  independent facts: `outcome` is the **capability** (a live `CREATEROLE` probe), `brokerEnabled`
  is the **policy** (`nodes.jobSecretBrokerEnabled`). ⚠ `outcome: "guided"` is a **200** carrying
  paste-ready SQL, never a 4xx — managed PostgreSQL denying `CREATEROLE` is the ordinary case.
  See [`docs/runbooks/node-job-secrets.md`](docs/runbooks/node-job-secrets.md)
- `GET /api/admin/db-backup/config` - Backup policy, computed `nextRunAt`, active run id
- `PUT /api/admin/db-backup/config` - Update the policy (partial; every field optional)
- `POST /api/admin/db-backup/runs` - Take a backup now (returns immediately; 409 if one is running)
- `GET /api/admin/db-backup/runs` - List runs (paginated, newest first)
- `GET /api/admin/db-backup/runs/{id}` - Get one run (progress polling)
- `GET /api/admin/db-backup/runs/{id}/download` - Signed, short-lived archive URL
- `DELETE /api/admin/db-backup/runs/{id}` - Delete a run and its archive
- `POST /api/admin/db-backup/runs/{id}/cancel` - Cancel a running backup
- `POST /api/admin/db-backup/runs/{id}/restore` - Restore the database from this backup (`db_backup:restore`; body `{"confirmation":"RESTORE"}`; three normal `mode`s: `running`/`guided`/`blocked`)
- `POST /api/admin/db-backup/runs/{id}/rollback` - Undo that restore (`db_backup:restore`; body `{"confirmation":"ROLLBACK"}`; three normal `mode`s: `renamed`/`restore_started`/`unavailable`)

### Push Configuration (Admin-only)
Runtime-configurable Web Push (VAPID) keys (issue #355) — generate, rotate,
enable/disable, and remove entirely from the admin UI, no restart. See
[`docs/specs/browser-notifications.md`](docs/specs/browser-notifications.md)
and [`docs/runbooks/vapid-keys.md`](docs/runbooks/vapid-keys.md).
- `GET /api/admin/push-config` - Configuration plus masked `privateKeyStatus`; private key never returned (`push:read`)
- `PUT /api/admin/push-config` - Flip `{ enabled, subject }`; does not manufacture keys (409 if enabling with none generated) (`push:write`)
- `POST /api/admin/push-config/generate` - First-time key generation, sets `enabled: true` (409 if already configured) (`push:write`)
- `POST /api/admin/push-config/rotate` - Replace the key pair (body `{"confirmation":"ROTATE"}`; 400 if nothing configured yet) (`push:write`)
- `DELETE /api/admin/push-config` - Delete both the credential and the settings row (body `{"confirmation":"REMOVE"}`) (`push:write`)

### Transcripts
Audio in, a diarized and timestamped transcript out, and the corrections that
make it the user's rather than the AI's (issues #25 and #27, epic #19).
Gated on `transcripts:read`/`transcripts:write`, both seeded to **every** role
including Viewer. Per-transcript access is the owner, plus whoever they shared
it with (`viewer` reads, `editor` also edits); `edit` additionally requires
`transcripts:write`, because a share caps the *ceiling* an RBAC permission can
raise a user to and never the floor. **No access is a 404, never a 403** — a
403 would confirm that a specific transcript id exists, and the existence of a
private conversation's id is itself something a stranger has no business
learning. There is deliberately no admin read-any. See
[`docs/specs/transcription.md`](docs/specs/transcription.md) and the
`### Transcripts` section of [`docs/API.md`](docs/API.md); don't restate them
here.
- `POST /api/transcripts` - Create the transcript **and** its resumable upload in one call (`transcripts:write`). 409 when transcription is not configured (the deployment is not ready — not the caller's fault), 400 over the active provider's size ceiling. The upload object is created `managed_by: 'transcripts'`, which a client cannot ask for. `keyterms` (issue #327, epic #326) is an optional recognition hint — up to 200 names/terms fed forward to the transcription provider at submit time, stored regardless of what the active provider supports and clamped only at submit; see [`docs/specs/transcript-name-correction.md`](docs/specs/transcript-name-correction.md)
- `GET /api/transcripts` - List, cursor-paginated over `(updatedAt, id)` — every pipeline transition rewrites `updatedAt`, so offset paging would skip and repeat rows (`transcripts:read`)
- `GET /api/transcripts/summary` - Four lists and four counts for the home page, in one round trip (`transcripts:read`). The fourth list is `failed` — the caller's **own** failed transcripts, owner-scoped (retry is owner-only) and capped at eight, while `counts.failed` stays the true total
- `GET /api/transcripts/{id}` - Detail. Weak ETag `W/"v<currentVersion>"`, or `W/"v<currentVersion>-<fingerprint>"` once a speaker has been named (issue #323, opaque, treat as such), 304 with **no body** on a match
- `GET /api/transcripts/{id}/segments` - Compact, **no word timings** (the largest thing in this schema); same ETag
- `GET /api/transcripts/{id}/words?fromMs&toMs` - Word timings for one window, selected by **overlap** not containment; capped at 30 minutes and silently narrowed rather than refused
- `GET /api/transcripts/{id}/audio` - Signed URL, 6 h TTL: the rendition when ready, else the original
- `PATCH /api/transcripts/{id}` - Rename, and/or set `recordedAt`. **Not versioned** — a title and a recording date are metadata about the recording, not content of it
- `DELETE /api/transcripts/{id}` - Owner only. Soft-deletes to `deleting` and queues `transcript.purge`; there is no path back
- `POST /api/transcripts/{id}/retry` - Owner only. **The stage is derived from the row, not chosen by the caller** — a transcript the provider already accepted is re-polled, never re-submitted, so one recording never becomes two remote jobs
- `POST /api/transcripts/{id}/cancel` - Owner only. Cancels on the provider when it can, and marks the transcript either way
- `POST /api/transcripts/{id}/operations` - Apply up to 200 correction ops in **one transaction** and record them as a version (`transcripts:write` + `edit`). `baseVersion` is informational; the per-entity `rev` on every op is the real check, so two editors correcting **different** lines both succeed. A stale `rev` is a **409** whose `details` carries `{ currentVersion, conflicts: [{ entity, id, current }] }` — every conflict at once, `current: null` for an entity somebody deleted. A repeated `clientBatchId` returns the **original** result and creates no second version. **A batch of only `speaker.rename` identifications (or no-ops) creates no version at all** (issue #323) — naming an AI-detected speaker is metadata, not a correction; `version` in the response equals the current version unchanged, `rev` is untouched, and it's audited as `transcript.speaker_identified`
- `GET /api/transcripts/{id}/search?q&matchCase&wholeWord&speakerId` - Literal match list and an **exact** total, for the find & replace preview (`transcripts:read`)
- `GET /api/transcripts/{id}/versions?cursor` - The history, newest first. `author: null` **means the AI**, not a missing value
- `GET /api/transcripts/{id}/versions/{v}` - One materialized version, without word timings
- `POST /api/transcripts/{id}/versions/{v}/restore` - Appends a `restore` version; **history is never rewritten** and v1 is always retrievable. `baseVersion` here **must match** `currentVersion` (unlike `/operations`), because a restore carries no per-op expectations and a stale view would discard edits the caller never saw
- `GET /api/transcripts/exporters` - Every registered export format with the options it accepts, so a client builds its export UI from the server's answer rather than from a list of formats compiled into it (`transcripts:read`)
- `POST /api/transcripts/{id}/exports` - Render one version into one format. **202** when a render was queued, **200** when an identical unexpired export already exists — `reused` says which, for a client that cannot see the status line. Reuse is content-addressed on `sha256({format, version, options})` — plus a fingerprint of `speakerIdentities` when non-empty (issue #323), since naming a speaker changes what the same version renders — with the options **as parsed**, so an omitted option and an explicit default share one render; a `failed` row is never reused. Requires **view** access, which a `viewer` share satisfies: taking a conversation you were shown out of this application is a read
- `GET /api/transcripts/{id}/exports/{exportId}` - Status, and once ready a short-lived signed `downloadUrl` serving the file as `<title> (v<n>).<ext>`. The `Content-Disposition` is signed **into** the URL, so a client cannot add the filename afterwards
- `POST /api/transcripts/{id}/name-checks` - Queue an AI check for mis-transcribed names (issues #328/#330, epic #326). `mode: standard|thorough`, optional `terms`/`speakerIds`. **202** with the queued run and its cost `estimate`; 400 nothing to check; 409 `ai_not_configured`/`ai_key_missing`/`name_check_running`/`transcript_not_ready`
- `GET /api/transcripts/{id}/name-checks/estimate?mode` - What a run would cost, uncreated — no API key needed to count. A lower bound for `thorough` (`transcripts:read`)
- `GET /api/transcripts/{id}/name-checks/latest` - The latest run plus its **pending** suggestions (relocated against current text; `stale` when they can't be) and status counts (`transcripts:read`)
- `POST /api/transcripts/{id}/name-checks/{checkId}/apply` - Accept named suggestions as ordinary `segment.update_text` corrections through the same `/operations` path, batched at 200 lines; a 409 from a concurrent edit passes through unchanged
- `POST /api/transcripts/{id}/name-checks/{checkId}/reject` - Mark named pending suggestions `rejected`; the transcript is untouched

Three correction rules that are easy to break from a neighbouring file:

1. **Everything in `apps/api/src/transcripts/editing/` is pure and must stay
   that way.** No `PrismaService`, no `@Injectable`, no `randomUUID()` inside a
   reducer. `materialize()` replays a version log through *the same functions*
   the live edit path calls, which is what makes `materialize(currentVersion)
   == the live tables` true **by construction** (spec §4.4) rather than by two
   implementations being kept in step. A reducer that could read a row is a
   reducer the replay path could not call.
2. **`transcript.find_replace` is expanded into concrete `segment.update_text`
   ops before anything is recorded** (spec §4.2), and every server-chosen value
   — a split's `newSegmentId` and resolved `atWordIndex`, a `speaker.create`'s
   `speakerId` and `colorIndex` — is chosen at the same moment. A recorded
   find & replace would replay through a *future* matcher; a `randomUUID()` in
   a reducer would give every replay different ids. Both are the same bug.
3. **A snapshot is a compaction of replay work, never a second source of
   truth.** `transcript.snapshot` reads `current_version` and the state together
   under `REPEATABLE READ` and links the snapshot to the version that read
   actually saw — never to the one its payload named. Version 1 is the one
   version no sequence of ops can rebuild, which is why it is snapshotted
   unconditionally.

Two export rules, in the same spirit:

4. **Adding an export format must cost one class.** An exporter declares
   `format`, `label`, `mimeType`, `extension`, an `options` field list and a
   `render(doc, options, out: Writable)`, and registers itself with
   `TranscriptExporterRegistry` from `onModuleInit` — the same self-registration
   shape job handlers use. `GET /api/transcripts/exporters` publishes the
   registry, the export dialog renders whatever it returns, and the Zod schema
   that validates a request is **derived** from the `options` field list rather
   than written beside it. Nothing in the controller, the job handler or
   `apps/web` may branch on a format string; `apps/api/src/transcripts/export/`
   is the whole surface.
5. **`transcript.export` is server-only in v1, and not for one of rule 2's
   reasons.** Its input is a materialized snapshot — pure data a node could be
   handed with no database access — and rendering a PDF is exactly the
   CPU-bound, secret-free work rule 2 says should default to node-eligible. It
   stays server-only because **the renderers live in the API**: a second copy in
   `apps/cli` would mean one export request producing byte-for-byte different
   PDFs depending on which codebase claimed the job. That is a deliberate scope
   line, not a structural limit — the handler carries the argument in full, and
   nothing about spec §8 would have to change to add `nodeResultSchema` +
   `persistNodeResult` once the renderers are a package both can import.

### Transcription Settings (Admin-only)
Speech-to-text provider configuration (issue #23, epic #19) — which vendor, its
region and model, how audio reaches it, and what happens to it afterwards.
Gated on `system_settings:read`/`:write` and **not** a permission pair of its
own: this is a namespace (`transcription`) of the `global` system-settings row,
which `system-settings.controller.ts` already gates on exactly those strings.
The provider API key lives in the encrypted `credentials` table at
`(purpose 'transcription', name '<providerId>')`, is never returned, and is
preserved by an empty submission.
- `GET /api/transcription-settings` - Settings, a masked key status per provider, and the provider catalogue (capabilities + form-field descriptors) (`system_settings:read`)
- `PUT /api/transcription-settings` - Partial update, plus an optional write-only `apiKey` (blank/absent keeps the stored key) (`system_settings:write`)
- `POST /api/transcription-settings/test` - Probe a credential, **including one that has not been saved**; audited. ⚠ Answers **200** with `{ ok: false, detail }` on a refusal — a refused probe is a successful diagnosis (`system_settings:write`)
- `DELETE /api/transcription-settings/credentials/{provider}` - Erase one provider's key; the only path that does. Does not change the settings, so a rotation is not an outage (`system_settings:write`)
- `GET /api/transcription/config` - Narrow capability probe (`available`, provider label, size/duration ceilings, accepted types, plus `keytermsSupported`/`maxKeyterms` — issue #327) gated on `transcripts:read` (#25), which is seeded to **all three roles** — so it stays readable by every ordinary account, exactly like `GET /api/notifications/config`, while naming a real permission rather than "authenticated and nothing else"

### Notes
Turning a transcript, another note, or an uploaded document into an AI-generated,
user-correctable document (issue #48, epic #45). `notes:read`/`notes:write`, both seeded to
all three roles; **404, never 403**, for a note the caller cannot see. See
[`docs/API.md`](docs/API.md#notes) and [`docs/specs/notes.md`](docs/specs/notes.md).
- `POST /api/notes` - Create the note **and** queue its generation in one call (`notes:write`). 409 `ai_key_missing`/`ai_not_configured`, 400 over the token budget or an unpermitted model, 404 for a source/template the caller cannot read
- `GET /api/notes` - List, cursor-paginated over `updatedAt` (`notes:read`)
- `GET /api/notes/summary` - Three lists and four counts for the home page, in one round trip (`notes:read`)
- `GET /api/notes/exporters` - Every registered note export format, with its options (`notes:read`)
- `GET /api/notes/exports/{exportId}/download` - Short-lived signed download URL for a rendered export (`notes:read`)
- `GET /api/notes/{id}` - Detail. Weak ETag `W/"v<currentVersion>"`, 304 with no body on a match (`notes:read`). Carries `originTranscript` (issue #309) — the transcript this note was ultimately generated from, resolved across a chain of source notes; detail-only, `null` on any unreadable/deleted/document-sourced/cycle/over-5-hop link
- `GET /api/notes/{id}/versions` - Version history, newest first, cursor-paginated (`notes:read`)
- `GET /api/notes/{id}/versions/{version}` - One full-body version snapshot (`notes:read`)
- `GET /api/notes/{id}/context` - What the current generation sent to the AI: exact system prompt and user message, recorded before the provider call (`notes:read`)
- `GET /api/notes/{id}/generations/{generationId}/context` - Same, for one specific generation of this note (`notes:read`)
- `PATCH /api/notes/{id}` - Rename and/or edit the body. A body edit requires `baseVersion`; a stale one is a **409** naming `details.currentVersion` (`notes:write`)
- `POST /api/notes/{id}/regenerate` - The only retry path (`note.generate` is `maxAttempts: 1`). Appends a new version; history is kept (`notes:write`)
- `POST /api/notes/{id}/retitle` - Queue `note.retitle` for one note — the "Suggest a title" action. **202**, 409 while `generating`. ⚠ The **only** path that renames a `titleSource: user` note: asking for a suggestion about a note in front of you is an explicit choice (`notes:write`)
- `POST /api/notes/retitle` - The bulk sweep: queue `note.retitle` for a capped page (100) of the caller's own `ready` notes still on `titleSource: template`, oldest first, returning `{ queued, remaining }`. Deduplicated, so calling it twice never queues a note twice; a success writes `titleSource: ai` and the note leaves the selection, which is what makes `remaining` reach zero (`notes:write`)
- `POST /api/notes/{id}/versions/{version}/restore` - Appends a `restore` version; `baseVersion` must equal `currentVersion` (`notes:write`)
- `DELETE /api/notes/{id}` - Owner only. Soft-deletes to `deleting` and queues `note.purge`; 409 while generating or while another note names this one as its source (`notes:write`)
- `POST /api/notes/{id}/exports` - Render one version into `markdown`/`pdf`/`docx` as a queue job. 202 when queued, 200 when an identical unexpired export is reused (`notes:write`)
- `GET /api/notes/{id}/exports` - List a note's unexpired exports (`notes:read`)
- `POST /api/notes/sources/documents` - Upload a PDF/TXT/MD document to generate a note from (`notes:write`, not `storage:write` — see `docs/API.md`). Object is `managed_by: notes`, invisible to the generic storage surface
- `GET /api/notes/{id}/stream` / `GET /api/note-generations/{id}/stream` - SSE, resumable via `Last-Event-ID`. A view over `note_generations.content`, never the delivery mechanism (`notes:read`)

### Note Templates
CRUD over the reusable "recipe" a note is generated from, plus preview (issue #50, epic #45).
`note_templates:read`/`note_templates:write`, both seeded to all three roles — a separate
pair from `notes:*`. See [`docs/API.md`](docs/API.md#note-templates).
- `GET /api/note-templates` - List the caller's own templates plus every built-in (`note_templates:read`)
- `POST /api/note-templates/preview` - Try a saved or unsaved template against a real source. A real generation, billed to the caller's own provider account (`note_templates:write`)
- `GET /api/note-templates/{id}` - One template, own or built-in (`note_templates:read`)
- `POST /api/note-templates` - Create one, owned by the caller (`note_templates:write`)
- `PATCH /api/note-templates/{id}` - Edit one of the caller's own. **403** on a built-in, never 404 — its existence is public (`note_templates:write`)
- `DELETE /api/note-templates/{id}` - Archives rather than deletes when notes still reference it. **403** on a built-in (`note_templates:write`)
- `POST /api/note-templates/{id}/duplicate` - Copy any readable template — built-in or the caller's own — into a new, editable row owned by the caller (`note_templates:write`)
- `PUT /api/note-templates/{id}/hidden` - Hide a template (own or built-in) from the caller's own list (issue #310). A listing preference, never access control — create/regenerate/preview still accept it by id. Idempotent, 204
- `DELETE /api/note-templates/{id}/hidden` - Un-hide it. Idempotent, 204

### AI Settings (Admin-only)
The deployment AI policy — which provider is active, which models are permitted, and the
token/timeout/document ceilings (issue #47, epic #45; the active-provider axis, live model
discovery and the widened `allowedModels` entry are issue #78; the five-rank model-resolution
chain that makes typed numbers optional is issue #97). Gated on `system_settings:read`/`:write`,
not a permission pair of its own: this is the `ai` namespace of the `global` system-settings
row. **No API key lives here, ever** — epic #45 is strict bring-your-own-key; see
`ai-settings.schema.ts`'s compile-time proof, which since #78 also covers the per-model
`allowedModels` entry type. See [`docs/API.md`](docs/API.md#ai-settings) and
[`docs/specs/notes.md`](docs/specs/notes.md) §2.5.
- `GET /api/ai-settings` - The AI policy and the provider catalogue (`system_settings:read`)
- `PUT /api/ai-settings` - Partial update. `allowedModels` replaces wholesale, RFC 7396-style, capped at 200 entries (#97); an entry may be a bare model id or `{ id, label?, contextWindowTokens?, maxOutputTokens? }`, both numbers now optional — unresolvable only when neither this build's catalogue, its family derivation, nor the provider's floor can answer (#97). `taskModels` also replaces wholesale (#360); each present entry is validated: 400 `model_not_permitted` if its model isn't in the effective `allowedModels`, 400 `model_lacks_capability` if the model lacks a capability its task requires — narrowing `allowedModels` under a stored task model afterward is allowed and just falls back to the default (`system_settings:write`)
- `GET /api/ai-settings/models` - List the active (or `?provider=`-named) provider's live models, using the **calling admin's own** saved key — this deployment holds none of its own (issue #78). Every model now reports a usable context window/output ceiling plus `source`/`derivedFrom`, detected via #97's resolution chain rather than requiring typed numbers; `?includeAll=true` skips the plausible-chat-model filter. ⚠ A vendor refusal is a **200** with `ok: false`; 409 `details.reason: "ai_key_missing"` when the caller has no key (`system_settings:write`)
- `POST /api/ai-settings/test` - Reachability probe, no credential sent (this deployment holds none). ⚠ A 401/403 from the endpoint is reported as `ok: true` — it proves the endpoint exists (`system_settings:write`)

### AI Credentials
A user's own AI provider key (issue #47, epic #45). Four routes, all `@Auth()` with **no
permission string** — deliberately: the resource is the caller's own credential, scoped by
`userId` in the query itself, the same ownership-scoped posture `/api/user-settings` and
`/api/pat` already take. See [`docs/API.md`](docs/API.md#ai-credentials).
- `GET /api/ai-credentials` - The caller's own stored keys, masked (`hint`, never the key)
- `PUT /api/ai-credentials` - Save or replace the caller's own key for one provider. `apiKey` blank/absent keeps the stored key
- `POST /api/ai-credentials/test` - Test a key, including one never saved. ⚠ Answers **200** with `{ ok: false, detail }` on a refusal — the same convention `POST /api/transcription-settings/test` uses
- `DELETE /api/ai-credentials/{provider}` - The only way to erase a key
- `GET /api/ai/config` - What this deployment permits and whether **the caller** has a key, gated on `notes:read` (#47) rather than left merely authenticated — seeded to all three roles, so it stays readable by every ordinary account. Since #360 also carries `graphEnabled` and a `taskModels` entry per `AiTaskKey` (model, source, reasoningEffort, requires, usable, reason), computed per caller with the same chooser the resolver and the admin view use

### User Data
The "Danger Zone" — bulk-delete the data one user owns (issue #80). Both routes are `@Auth()`
with **no permission string**, the same ownership-scoped posture `/api/user-settings`, `/api/pat`
and `/api/ai-credentials` already take — see [`docs/specs/user-data-deletion.md`](docs/specs/user-data-deletion.md)
and [`docs/API.md`](docs/API.md#user-data).
- `GET /api/user-data/summary` - Per-category row counts and bytes (`bytes` a decimal string, same convention as the database backup's), plus the caller's own deletion already in flight, if any
- `POST /api/user-data/deletions` - Queue a `user.data.purge` job for one `scope` (`transcripts`/`notes`/`files`/`content`/`everything`). **202**; 400 if `confirmation` isn't exactly the scope uppercased, 409 if a deletion is already pending/running for this caller. ⚠ **`confirmation` IS the scope, uppercased** — a word typed for one scope can never authorise another. ⚠ **The bulk path deliberately does not honour the per-item 409 guards** `DELETE /api/notes/{id}` and `DELETE /api/transcripts/{id}` enforce — it clears the `Restrict` foreign keys those guards protect first and deletes anyway

### Search
Ranked full-text search over transcript and note content (issue #175/#177, epic #164). Reuses
`transcripts:read`/`notes:read` — no new permission — and the route itself declares neither,
since `PermissionsGuard` requires ALL declared permissions and this endpoint's requirement is
EITHER; see [`docs/specs/search.md`](docs/specs/search.md).
- `GET /api/search?q&types&limit&cursor` - Documents scored by `ts_rank_cd`, rolled up per
  document by `max` (never `sum`). `matchedDocuments`/`truncated` describe a bounded 200-document
  candidate window; there is deliberately no `total`. A caller holding only one of the two read
  permissions gets a partial answer (`searchedTypes` says which), not a 403 — the one 403 is
  holding neither. `degraded: "stopwords"` falls back to the list endpoints' own title `ILIKE`
  when `q` is all stopwords. A cursor from a different query/type-filter/caller/ranking-model
  version is refused with **400**, never silently restarted (see `docs/specs/search.md` §5)

### Onboarding
A persistent, resumable, live-derived first-run checklist for a fresh deployment and a fresh
account (issue #275, epic #271, issues #272–#281). See [`docs/specs/onboarding.md`](docs/specs/onboarding.md).
- `GET /api/onboarding` - The caller's own activation steps. `@Auth()`, **no permission** — the
  identical ownership-scoped posture `/api/ai-credentials`/`/api/pat`/`/api/user-data` already
  take, and readable by a Viewer holding no permissions at all
- `GET /api/admin/onboarding` - This deployment's setup steps, culminating in a real transcription
  rather than a green tick on a form — though since issue #299 that step (`admin.smoke_test`) is
  `recommended` and skippable, not required: the checklist settles once the two required steps
  (a transcription provider and an AI provider) are configured, whether or not this administrator
  ever transcribes anything personally. `system_settings:read` — reused rather than a new
  `onboarding:read`, per epic #118 decision 8's precedent (the About card)

### Knowledge graph
Your own connected knowledge (issue #354, epic #344). `graph:read`/`graph:write`, both seeded
to all three roles; owner-only, and **404, never 403**, for any graph row the caller cannot see
— every row is authorised through `GraphAccessService` (`apps/api/src/graph/access/`), and a
transcript share never grants graph access. See [`docs/API.md`](docs/API.md#graph) and
[`docs/specs/ontology.md`](docs/specs/ontology.md).
- `GET /api/graph/ontology` - The caller's **effective ontology**: `core` + enabled domains
  (`core`,`work` by default until #369 persists the choice) + mixins + their own
  `kg_attribute_defs` (deprecated included, flagged) — the payload every graph form is
  generated from (`graph:read`). **Not** gated on `ai.graphEnabled`: reading one's own schema
  is not an AI call
- `PATCH /api/graph/entities/{id}` - Manual entity edit (#355, §8's second named exception):
  `label` (the old label is **kept as an alias**), `props` merge (`null` clears a key; the merged
  result must validate), `addAliases`/`removeAliasIds`. `type` is a 400 — a type changes only
  through a proposal. `accepted` → `edited` on any change; evidence untouched. Audited
  `graph.entity_edited` with keys and counts only. 404 no access or merged, 403 own entity
  without `graph:write`. Afterwards enqueues `kg.embed`/`kg.entity_digest` **only while their
  handlers are registered** (the digest also behind `ai.graphEnabled`)
- `GET /api/graph/attribute-defs?entityType&includeDeprecated` - The caller's own attribute
  definitions (§17.3), live only by default (`graph:read`)
- `POST /api/graph/attribute-defs` - Define one; **201**. The key is server-generated
  (`u_` + ten `[a-z0-9]`) and permanent; kind-specific option rules; max 50 live per entity
  type (`graph:write`)
- `PATCH /api/graph/attribute-defs/{id}` - `kind`/`entityType`/`key` immutable; choices may be
  added or relabelled, **never removed** (400 names them); `deprecated` toggles (`graph:write`)
- `DELETE /api/graph/attribute-defs/{id}` - **Deprecates, never deletes**; idempotent, 200
  (`graph:write`)
- `POST /api/graph/entities/{id}/forget` - "Forget this person" (issue #357). Body
  `{"confirmation":"FORGET"}`; **202** enqueuing `kg.purge {scope:'person', entityId}`, ordinary
  dedup so asking again returns the same job. Removes the Person plus its merged tombstones,
  aliases, relations, items, mentions, evidence and draft proposal references; your transcripts
  and notes are untouched. 400 wrong confirmation or non-Person; 404 no access or merged; 403
  your own entity without `graph:write` (`graph:write`)
- `GET /api/graph/entities` - The entity index: list/search your people, organizations, projects
  and meetings (issue #370, epic #347). `type` filters (400 on an unknown key); `q` is a trigram
  fuzzy match on label/alias (top `limit`, `nextCursor` always null); `sort=updated`|`viewed`;
  `transcriptId` narrows to the Persons `IDENTIFIED_AS` a speaker in that transcript, each with
  `speakerIds` — 404 without view access to it. Keyset-paginated otherwise (`graph:read`)
- `GET /api/graph/entities/{id}` - One entity: attributes, aliases, `firstSeenAt`/`lastSeenAt`,
  and the page counts (`sensitive` person facts not counted) (`graph:read`)
- `GET /api/graph/entities/{id}/neighborhood?hops&types&relationTypes&as_of&limit` - The entity's
  bounded 1–2-hop neighbourhood as a `GraphSlice` {seedIds, asOf, nodes, edges, truncated, cap}
  (issue #370). An item is always a walk leaf; edges touching one are derived from its own
  columns (`virtual: true`) and a stored relation with the same `(type,from,to)` wins. `limit`
  ≤ 300; `sensitive` person facts never appear. 503 `graph_query_timeout` past a 3 s statement
  timeout (`graph:read`)
- `GET /api/graph/entities/{id}/timeline?as_of&kinds&includeSensitive&cursor&limit` - Everything
  dated about this entity, newest first (issue #370); a **superseded** item stays, flagged.
  `includeSensitive=true` reveals `sensitive` person facts. Keyset-paginated; 503
  `graph_query_timeout` (`graph:read`)
- `GET /api/graph/entities/{id}/mentions` - The notes/transcripts linked to this entity, newest
  first (issue #370, additive to the original route list). A deleted document or a revoked
  transcript share stays with `available: false` (`graph:read`)
- `POST /api/graph/explore/expand` - One hop out from up to 50 nodes as one `GraphSlice`, seeds
  at depth 0 (issue #370). A read, despite the verb — the node list does not fit a query string.
  `cap` ≤ 300; **all-or-nothing 404** if any `nodeIds` entry is not one of your readable
  entities/items; 503 `graph_query_timeout` (`graph:read`)
- `GET /api/graph/evidence/{id}` - Resolve one citation to an openable link — a transcript
  segment (playable at the quoted moment) or a note version (issue #370). `available: false`
  (quote still returned) when the source is gone or no longer viewable (`graph:read`)
- `GET /api/graph/evidence?ids=` - Batch-resolve up to 50 citation ids in request order for a row
  of citation chips (issue #370, additive to the original route list); unknown ids are silently
  omitted (`graph:read`)

### Health
- `GET /api/health/live` - Liveness check
- `GET /api/health/ready` - Readiness check (includes DB)

## RBAC Model

### Roles
- **Admin**: Full access, manage users and system settings
- **Contributor**: Standard capabilities, manage own settings
- **Viewer**: Least privilege (default), manage own settings

### Key Permissions
- `system_settings:read/write` - System settings access
- `user_settings:read/write` - User settings access
- `users:read/write` - User management
- `rbac:manage` - Role assignment
- `allowlist:read/write` - Allowlist management (Admin only)
- `storage:read/write/delete` - Storage object access (own objects)
- `storage:read_any/write_any/delete_any` - Storage object access (all objects, Admin only)
- `jobs:read/write` - Background job queue: inspect vs. retry/reset/delete
- `nodes:read/write` - Worker node fleet: audit vs. register/claim/revoke. **Split from
  `jobs:*`, not folded into it** — "what work is queued" and "which machines are attached
  to this deployment" are different questions, and a Settings UI Pattern rule 3 card gated
  on `jobs:read` would be advertising a permission the nodes controller never checks
- `db_backup:read/write/restore` - Database backup: inspect vs. schedule/trigger/cancel/delete
  vs. **restore or roll back**. `:restore` is a **third**, deliberately separate permission —
  not part of `:write` — because scheduling a nightly dump and replacing the live database
  are not the same authority, and a deployment must be able to grant the first to someone
  it does not trust with the second. Folding it into `:write` would let every existing
  `db_backup:write` holder silently acquire the ability to roll back production
- `broadcasts:read/write` - Admin notification broadcasts (epic #319)
- `push:read/write` - Web Push (VAPID) configuration: generate, rotate, enable/disable
  (epic #355). **Not a reuse of `system_settings:*`** — generating/rotating key material
  has a real, described blast radius (every existing subscriber goes dark until it
  re-subscribes) that should not ride along with routine settings edits, mirroring why
  `broadcasts:*` and `nodes:*` were split out rather than folded into
  `system_settings:*`/`jobs:*`
- `transcripts:read/write` - Audio transcription (issue #24, epic #19): read your own
  transcripts and shares vs. create/edit/delete them. **Seeded to all three roles — Admin,
  Contributor and Viewer** — the opposite posture from every pair above: recording and
  correcting a transcript is the core product action, not an operational surface, and this
  app's default role is Viewer. `transcripts:write` is the *additional* check
  `TranscriptAccessService` applies for `edit`-level access on top of a share — a viewer
  share can never grant editing no matter what a future role holds. **There is deliberately
  no `transcripts:read_any`**, unlike every other "any"-scoped permission in this table: a
  transcript is somebody's private recorded conversation, not shared infrastructure, so no
  permission string exists for an admin (or anyone) to read one they do not own or hold a
  share on — out of scope for this feature, not merely unused. No access answers **404,
  never 403** (`docs/specs/transcription.md` §6.1) — a 403 would confirm the transcript
  exists, which a stranger has no business learning about a private conversation.
- `notes:read/write` - AI-generated notes (issue #48, epic #45), mirroring `transcripts:*`
  exactly and for the identical reason: generating a note is the core product action this
  epic exists to enable, and a fresh account's default role is Viewer. `notes:read` gates
  every note read (list, get, versions, the generation stream, `GET /api/ai/config`);
  `notes:write` gates create/regenerate/edit/delete **and**
  `POST /api/note-templates/:id/preview` — a preview reads a template but its action is
  generating real content through the caller's own AI key, the same mechanism `note.generate`
  runs, so it is gated by the permission that governs generating, not by the template CRUD
  permission. **There is deliberately no `notes:read_any`, not even for an admin** — a note
  is derived from somebody's private conversation, exactly like a transcript, and no
  permission string for reading another user's note exists anywhere in this design, for any
  role, ever. `NoteAccessService.require` answers a caller with no access a plain **404**,
  never 403, for the identical reason `TranscriptAccessService` does.
- `note_templates:read/write` - Note template CRUD (issue #48, epic #45). A **separate pair**
  from `notes:*`, not folded in — two different controllers with two different write
  surfaces (editing a recipe versus generating content). `note_templates:write` gates
  creating, editing and deleting a user's **own** custom templates only; it does not gate
  built-ins, which are immutable through the API regardless of any permission any role holds
  — a built-in's `PATCH`/`DELETE` answers **403**, a deliberate divergence from `notes:*`'s
  404-never-403 posture, because a built-in template's existence is public by design (it is
  in every account's own catalogue) while another user's template's existence is private.
  Both permissions are seeded to all three roles.
- `graph:read/write` - Connected knowledge (issue #354, epic #344): read your own graph
  (entities, relations, facts, proposals, the effective ontology) vs. curate it (commit
  proposals, edit/merge/forget entities, manage attribute definitions). **Seeded to all three
  roles**, mirroring `notes:*`, and delivered through the idempotent seed, never a migration.
  **There is deliberately no `graph:read_any`**, for the notes/transcripts reason: a graph is
  derived from somebody's private conversations. `GraphAccessService.require` answers no
  access with a byte-identical **404** per kind; `edit` on the caller's own row without
  `graph:write` is the one **403**.

## Database Tables

- `users` - User accounts with profile info
- `user_identities` - OAuth provider identities (provider + subject)
- `roles` / `permissions` / `role_permissions` - RBAC
- `user_roles` - User-to-role assignments
- `system_settings` - Global app settings (JSONB). Namespaces on the `global` row: `notifications`, `jobs`, `nodes`, `databaseBackup`, `maintenance`, `transcription`, `ai`. ⚠ Adding one costs **six** edits — see `apps/api/src/common/schemas/settings-parity.spec.ts`'s header; miss the wire DTOs and every PATCH becomes a silent no-op that returns 200. `ai` (issue #47, epic #45) carries no API key — see `apps/api/src/ai/ai-settings.schema.ts`'s compile-time proof — and includes `ai.maxDocumentBytes`, the ceiling on one uploaded note source document; it lives in this AI namespace rather than in a storage setting because the reason to bound it is token cost on the uploading user's own vendor account, not disk. Since issue #78 it also carries `ai.provider` (the nullable active-provider axis, resolved through `AiProviderRegistry` so no consumer hardcodes `'openai'`) and its `allowedModels` entries widened from bare strings to `{ id, label?, contextWindowTokens?, maxOutputTokens? }` — the legacy string form still parses and normalises on read, forever. Since issue #97 the two numbers on an entry are optional in practice, not just in the schema: `ai-model-resolution.ts`'s five-rank chain fills an omitted number from this build's catalogue, then the provider's family derivation, then its conservative floor, before an entry is reported unresolvable — see `docs/specs/notes.md` §2.5. Since issue #360 it also carries `ai.taskModels` (a per-`AiTaskKey` model + optional `reasoningEffort` for connected-knowledge tasks, absent key meaning "use `defaultModel`", replaced wholesale on `PUT`) and `ai.graphEnabled` (default `false` — the spending switch for connected knowledge) — see `docs/specs/notes.md` §2.8
- `user_settings` - Per-user settings (JSONB). Namespaces include `onboarding` (issue #272, epic
  #271): the caller's own first-run **intent** — `welcomeSeenAt`, `dismissedAt`,
  `adminDismissedAt`, `skipped[]` — never readiness, which is derived rather than stored (see
  `### Onboarding` above and [`docs/specs/onboarding.md`](docs/specs/onboarding.md)). Absent from
  `DEFAULT_USER_SETTINGS` on purpose: absent is how "never onboarded" is spelled. Guarded by
  `apps/api/src/common/schemas/user-settings-parity.spec.ts`, the six-file parity check user
  settings never had before this namespace
- `audit_events` - Action audit log
- `refresh_tokens` - JWT refresh tokens (hashed)
- `allowed_emails` - Allowlist for access control. `reminder_count`/`last_reminder_at` (issue
  #301) track `POST /api/allowlist/{id}/reminder`: a manual, admin-pressed resend, not a
  scheduler — there is deliberately no cron or job type behind it. `reminder_count` is
  incremented in the database (`increment`, not a read-modify-write) so two admins pressing
  the button at once can't both write the same count
- `device_codes` - Device authorization codes (RFC 8628)
- `storage_objects` - File metadata, status, storage references. `part_size` (#21) is
  the part size an upload was initialised with, **persisted rather than recomputed**:
  re-deriving it from the current `STORAGE_PART_SIZE` renumbered the parts of every
  upload in flight whenever an operator changed that setting, so a resuming client
  completed a corrupt object. `managed_by` names the owning module (plain `text`, no
  enum, no FK — same reasoning as `jobs.subject_type`) and is what hides an object
  from the generic list and 409s its generic DELETE.
- `storage_object_chunks` - Multipart upload chunk tracking
- `personal_access_tokens` - User-created long-lived API tokens (hashed)
- `jobs` - The background queue (epic #254). `subject_type`/`subject_id` are both plain
  `text`, nullable, no FK either way — a job's subject is polymorphic (a storage object
  today, something else tomorrow), and a fork's own tables cannot be enumerated by a
  Prisma relation. `attempts` is charged **at claim time**, not on completion or failure —
  see `job-claim.service.ts` — so a process that dies mid-run (OOM kill, hard crash) still
  bounds its retries; a job read inside `process()` always sees its own attempt already
  counted. Two indexes exist **only** in `migration.sql`, not in `schema.prisma`, because
  Prisma cannot express a partial unique index: `jobs_active_dedup_uniq_idx` (`dedup_key`
  `WHERE status IN ('pending','running') AND dedup_key IS NOT NULL`) is the actual dedup
  enforcement, and `database_backup_runs_active_uniq_idx` below is its counterpart. This is
  deliberate, intentional schema drift — do not "fix" it by adding a `@@unique` to the model.
- `job_stats_rollup` - One row per job type, incrementally accumulating succeeded/failed
  counts and duration sums so lifetime stats survive the history purge. `sumDurationMs` is
  `Float`, not `BigInt`, to avoid crashing `JSON.stringify` at read time.
- `worker_nodes` - Registered worker node fleet (epic #254): identity, declared
  `eligibleTypes`/`concurrency`, operator `status` (`online`/`draining`/`offline`/`disabled`).
  Health is never stored — it is derived from `lastHeartbeatAt` at read time.
- `node_credentials` - `nod_…` bearer credentials a worker node authenticates with. Mirrors
  `personal_access_tokens`' hash/prefix/show-once shape, minus a mandatory expiry (a node
  runs unattended for months; revocation, not a clock, is the control).
- `job_node_secrets` - One row per short-lived, job-scoped credential a node has been issued
  (epic #345, issue #349). Records the broker `kind`, the credential's **handle** (e.g. a
  minted PostgreSQL role name) and its `expiresAt`/`revokedAt` — **never the credential's
  material**; the table has no column that could hold one. `@@unique([jobId, kind])` makes a
  second grant for the same job and broker unrepresentable, so a re-request while the lease
  is live extends the existing grant instead of minting a second. Three revocation paths can
  set `revokedAt`: the job-settle listener, `NodeSecretSweepTask`'s cron, and `VALID UNTIL`
  itself at the database level, which is why the row's `expiresAt` is bounded by the job's
  lease rather than being a clock of its own.
- `database_backup_runs` - One row per backup/restore attempt, with its own heartbeat and
  stale window — **not** a `jobs` row, because the lease reaper's `stuckThresholdMinutes`
  (default 30 min) would reset a legitimately multi-hour `pg_dump`/restore to pending and
  start a second one against the same storage key. At most one active run (`pending` or
  `running`) is enforced by `database_backup_runs_active_uniq_idx`, the same
  raw-SQL-only partial unique index pattern as `jobs` above — never by a `findFirst`
  before the insert, which cannot close the race a concurrent request needs closed.
- `transcripts` - One row per uploaded recording (issue #24, epic #19). Three
  independent status enums (`status`, `transcriptionStatus`, `playbackStatus`) rather than
  one, because transcode and transcription run **concurrently** and a single enum would need
  one member per combination of the two — the same `worker_nodes`-style split of "stated
  intent" from "sub-pipeline progress." `ownerId` **cascades** on user deletion (a transcript
  has no meaning, and this app grants no path to read it, once its owner is gone — there is
  deliberately no `transcripts:read_any`); `sourceObjectId`/`playbackObjectId`/
  `rawResultObjectId` all **restrict** instead, the opposite direction of ownership: they
  point sideways into `storage_objects` (a different module's table), and only
  `transcript.purge` deleting the transcript row first may ever free one, never an unrelated
  storage cleanup. See `docs/specs/transcription.md` §3.1 and the block comment above the
  `Transcript` model for the full reasoning, including the honestly-stated gap between a raw
  cascading user delete (removes SQL rows only) and `transcript.purge` (also removes the
  storage/provider data). `title_search_vector` (issue #174, epic #164) is a `GENERATED ALWAYS
  AS (to_tsvector('english', coalesce(title, ''))) STORED` column with its own GIN index — a
  transcript's title must be full-text searchable even when no child segment matches at all, so
  it needs its own vector rather than folding into the segment vector below. Generated, not
  trigger-maintained: a trigger does not fire under `pg_restore`'s `session_replication_role =
  replica`, so a restored database would come back with a silently empty search index. Hand-written
  in `migration.sql` only — Prisma has no DSL for a generated column's expression — the same
  intentional schema drift as `jobs`/`database_backup_runs`/`transcript_speakers`. See
  `docs/specs/search.md` §2. `speaker_identities` (JSONB, default `{}`, issue #323) maps speaker
  id to display name for a speaker **identified** rather than corrected — naming "Speaker A" as
  "Oscar" writes here and to the live speaker row without bumping `current_version`, and
  `materialize()` overlays this map onto any speaker still at its placeholder at every version;
  see `docs/specs/transcription.md` §4.6. `recorded_at` (issue #352, `timestamptz`, `NOT NULL`,
  indexed `(owner_id, recorded_at desc)`) is when the recording was made — defaulting to the
  upload instant and backfilled from `created_at`, owner/editor-correctable via `PATCH
  /api/transcripts/{id}` without moving `current_version` — and is the meeting date connected
  knowledge reads (`docs/specs/ontology.md` §5.4).
- `transcript_speakers` - One row per diarized voice in a transcript. `label` is nullable —
  the provider's own diarization letter (`"A"`) for an AI-detected speaker, `NULL` for one a
  user created directly. Unique per transcript **among labelled rows only**, via the same
  hand-written **partial** unique index pattern `jobs_active_dedup_uniq_idx` and
  `database_backup_runs_active_uniq_idx` already establish (`transcript_speakers_transcript_
  id_label_key`, `WHERE label IS NOT NULL`) — Prisma's `@@unique` DSL cannot express the
  `WHERE` clause, so it lives hand-written in `migration.sql` only. This is the **one**
  Prisma-inexpressible constraint issue #24 adds; every other uniqueness constraint on the
  transcript tables is a plain `@@unique`.
- `transcript_segments` - One row per line of transcript text. `id` is **stable across
  edits** — a `segment.split` keeps it on the earlier half specifically so a bookmark, an
  export reference, or a stale concurrent-editor `rev` still names something real.
  `speakerId` **restricts**: a speaker cannot be deleted while a segment still names it,
  `speaker.merge` re-points every segment away first. `ordinal` is a **gap-based float**, not
  a dense integer sequence, so inserting a segment only needs the midpoint between its two
  neighbours rather than renumbering every later row on every split. `wordsAlignment`
  (`exact`/`interpolated`/`none`) records how much of the per-word timing survived the last
  text edit — a token-level LCS diff, not a heuristic re-run on every read. `search_vector`
  (issue #174, epic #164) is a `GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, '')))
  STORED` column, GIN-indexed, unweighted — a segment has no title of its own to weight against,
  unlike `notes.search_vector` below. Same generated-column-not-trigger reasoning as
  `transcripts.title_search_vector` above; see `docs/specs/search.md` §2.
- `transcript_versions` - The append-only correction history `materialize()` replays
  (`docs/specs/transcription.md` §4.4): `ops` holds the **concrete** edits this version
  applied (never the abstract `find_replace` call itself — §4.2 — so replaying history stays
  correct even if the matching logic changes later), `authorId` is `NULL` **only** for the AI
  ingest version, and nothing ever deletes a row here short of purging the whole transcript.
  `@@unique([transcriptId, version])` is the sequence itself; `@@unique([transcriptId,
  clientBatchId])` is a retried-save idempotency key that needs **no** hand-written partial
  index — Postgres's standard NULLS-DISTINCT behaviour already lets any number of
  `NULL`-`clientBatchId` versions (ingest, restore) coexist for free.
- `transcript_shares` - `viewer`/`editor` grants, unique on `(transcriptId, userId)`.
  `TranscriptAccessService` combines a share with `transcripts:write` for `edit`-level access
  — a share alone can raise a viewer's ceiling, never grant authority this app's own RBAC
  withholds from their role.
- `transcript_exports` - One row per rendered export file, content-addressed by
  `(transcriptId, version, format, optionsHash)` (the index this issue declares specifically
  for `POST /:id/exports`'s reuse check, per `docs/specs/transcription.md` §8.5) so an
  identical repeat request returns the existing file instead of re-rendering. `jobId` is
  `@unique`/nullable/`SetNull`, mirroring `DatabaseBackupRun.jobId` exactly: this row's own
  7-day expiry is independent of `job.history.purge`'s retention schedule for the underlying
  `jobs` row.
- `transcript_name_checks` - One row per AI name-check **run** (issues #328/#330, epic #326):
  `mode` (`standard`/`thorough`), `status`, `basedOnVersion`, the resolved `terms` checked for,
  denormalized `candidateCount`/`suggestionCount`, cost accounting, and `jobId`
  (`@unique`/nullable/`SetNull`, mirroring `TranscriptExport.jobId`). `requestedById` is
  `SetNull`, not `Cascade` — a run is kept as transcript history after its requester is gone,
  matching `TranscriptVersion.authorId`. See
  [`docs/specs/transcript-name-correction.md`](docs/specs/transcript-name-correction.md)
- `transcript_name_suggestions` - One row per **proposed** correction a run produced: the
  segment and the `TranscriptSegment.rev` its `start`/`end` offsets were computed against
  (the same `rev`-pinning shape `TranscriptVersion` uses), `original`/`replacement`, `source`
  (`'phonetic'`/`'discovery'`), and `status` (`pending`/`accepted`/`rejected`/`stale`).
  Accepting one never writes `transcript_segments.text` directly — it becomes an ordinary
  `segment.update_text` op through the same `/operations` path every other correction uses
- `user_ai_credentials` - One AI provider API key per `(userId, provider)` (issue #47, epic
  #45): each user's own key, never a deployment-wide one — see `docs/specs/notes.md` §9.
  `secret` is `encryptSecret(rawKey, 'ai-key')` — the same cipher every other secret in this
  application uses, under a new purpose string for domain separation, so a ciphertext lifted
  out of `credentials` and pasted here fails authentication rather than decrypting into a
  context where it means something else. `userId` **cascades**, and that is the whole reason
  this is its own table rather than a row in `credentials`: `credentials` has no foreign key
  to `users` and cannot grow one (`Credential.updatedByUserId` is `SetNull` on purpose, so
  offboarding an admin never deletes a working SMTP configuration), so encoding a user id into
  `credentials.name` would leave a deleted user's personal key in that table forever with no
  FK to clean it up. Never returned by any endpoint, for any role.
- `notes` - One AI-generated, user-correctable document per row (issue #48, epic #45),
  generated from a transcript, another note, or an uploaded document. `ownerId` **cascades**
  on user deletion — a note has no meaning and this app grants no path to read it once its
  owner is gone, mirroring `transcripts.owner_id` and the deliberate absence of
  `notes:read_any`. `sourceTranscriptId`/`sourceNoteId`/`sourceObjectId` all **restrict**
  instead, the opposite direction: they point sideways into another module's table, and only
  `note.purge` deleting the note row first may ever free one. `notes.body` is a denormalized
  copy of the `note_versions` row at `currentVersion` — kept in the same transaction that
  appends a version — so `GET /api/notes/:id` answers "what does this note say right now"
  with a single-row read. See `docs/specs/notes.md` §4.1 and the block comment above the
  `Note` model. `search_vector` (issue #174, epic #164) is a single `GENERATED ALWAYS AS (...)
  STORED` column, GIN-indexed, combining `setweight(to_tsvector(title), 'A') ||
  setweight(to_tsvector(body), 'B')` — weighted, unlike `transcript_segments.search_vector`,
  because a hit in the user's own title is stronger evidence than a hit in the AI-generated body,
  and `ts_rank_cd` can reflect that asymmetry when it is computed over one combined vector. Same
  generated-column-not-trigger reasoning as the transcript columns above; see
  `docs/specs/search.md` §2.
- `note_templates` - The reusable "recipe" (instructions, output format, structure, tone,
  length, an optional per-template model) a note is generated from (issue #48, epic #45).
  `ownerId IS NULL` means **built-in**: seeded, readable by every user, and immutable through
  the API under every role (`PATCH`/`DELETE` answer 403, never 404 — see `docs/API.md`'s Note
  Templates section for the full reasoning). `PATCH`/`DELETE` on another user's own template
  answers 404. Deleting a template that notes still reference **archives** it instead
  (`isArchived`) rather than deleting the row, so a note never loses its `templateId`.
- `note_generations` - The durable buffer the SSE stream (issue #52) reads from, never the
  delivery mechanism itself: `note.generate` (issue #49) appends every delta to `content` on
  the way past, so a generation completes identically whether or not anyone is watching.
  `noteId` is nullable — `NULL` for a **template preview** (issue #50), which has no note to
  belong to, is never listed in `GET /api/notes`, and is hard-deleted by `notes.housekeeping`
  at its 10-minute TTL. `errorClass` is a proper enum (`auth`/`refusal`/`rate_limit`/`other`)
  matching `ai-errors.ts`'s taxonomy — the SSE layer's own `NoteStreamErrorClass` adds two
  wire-only values, `timeout` and `gone`, that never exist in this column because neither is a
  property of the generation (see the new Common Patterns section below). `systemPrompt`/
  `userContent`/`sourceVersion`/`contextCapturedAt` (issue #307) snapshot exactly what was sent
  to the AI provider, written before the call so a failure still records it; `NULL` on a row
  from before this feature, deliberately never backfilled.
- `note_versions` - The append-only correction history (issue #48, epic #45). **A full body
  snapshot per row, not an operation log** — unlike `transcript_versions`, deliberately: a
  note is a page or two of prose, so storing the whole markdown body per save costs kilobytes
  and needs no reducer to read back, and `GET /api/notes/:id/versions/:version` is a
  single-row read. `authorId: NULL` means the AI, the same convention
  `transcript_versions.author_id` established. `kind` is `ai_generated` / `edit` / `restore`.
- `note_exports` - One row per rendered export file, content-addressed by `(noteId, version,
  format, optionsHash)`, mirroring `transcript_exports` field for field (issue #54,
  `docs/specs/notes.md` §8). `jobId` is `@unique`/nullable/`SetNull`; the row's own 7-day
  expiry is independent of `job.history.purge`'s retention schedule for the underlying `jobs`
  row.
- `user_hidden_note_templates` - Per-user, per-template "hide from my picker" preference
  (issue #310, epic #306), `@@id([userId, templateId])`, both FKs **Cascade**. A join table
  rather than a `user_settings` namespace (real FK integrity, plain indexed `WHERE user_id =`
  queries, no cap, no six-file settings-parity cost) and rather than reusing
  `note_templates.is_archived` (that column is shared by every viewer; hiding is per-user and
  must never affect anyone else's picker, built-in included). Hiding is a listing preference
  only — it never gates create/regenerate/preview reading the template by id.
- `kg_entities` - The Connected Knowledge graph foundation's node table — Person, Organization,
  Project, Meeting (issue #351, epic #344), `type` a plain ontology key (#350), never a Prisma
  enum, so a new type costs zero migrations. `embedding vector(1536)` reuses `SearchEmbedding`'s
  exact model/dimension contract rather than a second convention; `merged_into_id` self-relation
  (SetNull) is set once §7's entity resolution merges this row into another. `owner_id` **Cascade**
  — the same reasoning `notes.owner_id`/`transcripts.owner_id` establish, and there is deliberately
  no `graph:read_any`. `pg_trgm` (new to this codebase — see `docs/specs/ontology.md` §10) backs
  `kg_entities_label_trgm_idx`, and `kg_entities_embedding_hnsw_idx` mirrors
  `search_embeddings_embedding_hnsw_idx`'s own hand-written discipline; both live only in
  `migration.sql`, never in `schema.prisma`, the same intentional drift `jobs`/`transcript_speakers`
  already establish.
- `kg_entity_aliases` - A separate table, not an array column, so an alias carries its own
  indexed exact/fuzzy lookup (`normalized`, produced by #355's `normalizeAlias()` — this
  **replaces** `citext`, not installed and not needed) plus its own provenance (`source`).
  `entity_id`/`owner_id` both Cascade. `kg_entity_aliases_normalized_trgm_idx` is hand-written
  (`gin_trgm_ops`), alongside the label index above.
- `kg_relations` - Every graph edge (§5.2's sixteen types, plain text `type`, never enum). A
  relation's `from` side is **exactly one of** a resolved entity (`from_id`) or a diarized
  speaker awaiting identification (`from_speaker_id`, a real FK into `transcript_speakers`,
  Cascade) — enforced by `kg_relations_one_source_chk`, with `from_speaker_id` restricted to
  `IDENTIFIED_AS` by `kg_relations_speaker_type_chk` and to one edge per speaker by the
  hand-written partial unique `kg_relations_speaker_link_uniq_idx`. `valid tstzrange` (§5.4) is
  `Unsupported` — Prisma cannot read or write it at all, so every write goes through
  `$executeRaw` inside the same transaction as the `create`, and every read through `$queryRaw`
  (`lower`/`upper`/`lower_inc`/`upper_inc`); `kg_relations_valid_gist_idx` is what makes the
  containment/overlap queries this shape exists for actually fast. No inverse row is ever stored
  (§5.2).
- `kg_items` - `Commitment`/`Decision`/`Claim`/`PersonFact` in **one** table, distinguished by
  `kind` (the one real Prisma enum among this graph's `type`/`kind` columns — see `kg_entities`
  above for why the others stay plain text). `meeting_id` (SetNull, backs `CREATED_IN`/
  `DECIDED_IN`), `owner_person_id`/`counterparty_id`/`subject_id` (Cascade) all point sideways
  into `kg_entities`. `sensitivity` is non-NULL **iff** `kind = 'person_fact'`
  (`kg_items_sensitivity_chk`); a `claim`/`person_fact` always carries a `subject_id`
  (`kg_items_subject_required_chk`). `kg_items_live_statement_uniq_idx` (hand-written partial
  unique, scoped to `accepted`/`edited` rows with a subject) is the §8 "known, skipped" dedup
  guard — a verbatim restatement attaches evidence instead of inserting a duplicate.
  `valid`/`embedding` mirror `kg_relations`/`kg_entities` exactly, including the `Unsupported`
  raw-SQL contract and the hand-written GiST/HNSW indexes.
- `kg_evidence` - The §5.3 citation contract. `subject_kind`/`subject_id` are **polymorphic, no
  FK** — the identical `jobs.subject_type`/`subject_id` pattern. Every real anchor FK
  (`transcript_id`/`segment_id`/`note_id`/`import_object_id`) is **SetNull, not Restrict** — a
  deliberate divergence from most of this schema's sideways pointers: an evidence row is a
  citation that must survive losing what it pointed to, and `quote` (NOT NULL) is precisely what
  keeps it readable once every anchor has gone to NULL. There is deliberately **no CHECK**
  requiring any anchor to be present. `char_start`/`char_end` are offsets into the cited **note
  version body** when `note_id` is set, or into the cited **segment's text** when `segment_id` is
  set — NULL means the whole segment; #363 relies on this exact convention. A hand-written
  **deferred constraint trigger** (#355, `kg_assert_has_evidence`, intentional schema drift)
  refuses at `COMMIT`, with SQLSTATE `23514`, any `accepted`/`edited` entity, relation or item
  left with no evidence row — so write the subject and its evidence in one transaction, and
  delete evidence **after** (or together with) its subject, never before.
- `kg_mentions` - The coarse `MENTIONS` shortcut (§5.2), distinct from `kg_evidence`'s precise
  per-claim citation — `entity_id`/`note_id`/`transcript_id` all **Cascade** (the opposite of
  `kg_evidence` above: a mention has no meaning once either side is gone). Exactly one source
  document per row (`kg_mentions_one_source_chk`).
- `kg_proposals` - One row per extraction/import/resolution run, with the **complete** proposal
  status/kind sets landed by this migration (issue #351) so #363/#364/#366/#387 never need
  `ALTER TYPE … ADD VALUE`. Only `kind = 'extraction'` has a note;
  `kg_proposals_note_source_chk` keys on `note_version`, **never** `note_id` — `note_id` is
  `SetNull` and can only go NULL after the note is hard-deleted, while `note_version` never
  changes, so the CHECK stays satisfied across that delete. Two hand-written partial uniques cap
  concurrency: at most one `draft` and at most one `extracting` proposal per note, plus at most
  one `extracting` **import** proposal per owner (scoped by `owner_id`, since an import has no
  note). `commit_log` is #366's internal undo record, never serialized to clients. `job_id`
  mirrors `TranscriptExport.jobId` (`@unique`, nullable, SetNull).
- `kg_proposal_items` - One row per proposed entity/relation/item/`closing` edit.
  `merge_into_id` (SetNull into `kg_entities`) is set **iff** `decision = 'merge_into'`
  (`kg_proposal_items_merge_into_chk`) — losing the target clears the override rather than
  blocking the delete. `payload` is always a JSON object (`kg_proposal_items_kind_payload_chk`).
  `committed_ref_id` is polymorphic, no FK — the `kg_entities`/`kg_relations`/`kg_items` row this
  item became once committed.
- `kg_merges` - One row per merge (§7), with the full reversal payload. `survivor_id`/`merged_id`
  both Cascade into `kg_entities` — a merge record has no meaning once either entity it names is
  gone.
- `kg_distinct_pairs` - Confirmed-not-the-same pairs (§7), `@@id([ownerId, aId, bId])`.
  `kg_distinct_pairs_order_chk` (`a_id < b_id`, hand-written — Prisma cannot express a
  cross-column CHECK) canonicalizes an unordered pair so `(a, b)` and `(b, a)` can never both
  exist as two different rows for the same fact.
- `kg_attribute_defs` - One row per user-defined attribute (§17.3): entity type, key, label,
  kind, extractability, sensitivity. `@@unique([ownerId, entityType, key])`; `owner_id` Cascade,
  the same reasoning every other `kg_*` table's `owner_id` follows.
- `kg_entity_digests` - §9.2's precomputed entity brief — "precompute once, read cheaply."
  `entity_id` is the **primary key**, not a separate `id`: exactly one digest per entity, always
  replaced in place, never versioned.
- `kg_entity_views` - `(user_id, entity_id, last_viewed_at)`, plain `@@unique([userId,
  entityId])` — §9.2's "recently viewed" list. The **one** table in this graph keyed on
  `user_id`, not `owner_id`: which entities a viewer has looked at is a per-viewer fact, not an
  ownership fact.

## Navigation Destination Model

`apps/web/src/config/destinations.ts` is the single source of truth for the
app's navigation targets — the bottom bar, the navigation rail and the avatar
menu all read it, so none of the three can disagree about what exists or who
may see it. Full design, with rejected alternatives, in
[`docs/specs/ux-refresh.md`](docs/specs/ux-refresh.md) §1.

**Five destinations** since epic #105: `home`, `transcripts`, `notes`,
`settings`, `console`. Each gates on the exact permission its controller
enforces (`transcripts:read`, `notes:read`, …), the same Settings UI Pattern
rule 3 discipline the admin cards follow.

**Four bottom-bar tabs, and that is the ceiling.** `BOTTOM_BAR_DESTINATIONS`
is `DESTINATIONS.filter((d) => !d.pinned)`, so the bar's four-tab limit is now
reached *by design* rather than by a coincidence of which permissions a user
happens to hold. A fifth non-pinned destination is not an addition, it is a
redesign of that bar.

⚠ **`pinned` means a MODE, not a peer.** A pinned destination renders at the
navigation rail's foot below a divider, appears in the avatar menu, and is
**omitted from the bottom bar entirely** — the bar has no foot to pin to.
`console` is the only one today. That is what makes the administrator's own
phone show Home · Transcripts · Notes · Settings rather than spending a
primary tab on an operational surface.

## Operations Admin Settings Group

A third `ADMIN_SECTIONS` group (`apps/web/src/config/adminSections.tsx`),
alongside `General` and `Access` — issue #266, epic #254. `General` is
configuration an administrator *sets*; `Operations` is the running system: work
in flight, the machines executing it, and the copies of the data taken while it
ran. Five cards at `/admin/settings/*`, each gated on the exact permission its
controller enforces (Settings UI Pattern rule 3):

- **Jobs** (`/admin/settings/jobs`, `jobs:read`) and **Job Insights**
  (`/admin/settings/jobs/insights`, `jobs:read`, nested under Jobs)
- **Worker Nodes** (`/admin/settings/workers`, `nodes:read`)
- **Database Backup** (`/admin/settings/db-backup`, `db_backup:read`)
- **Broadcasts** (`/admin/settings/broadcasts`, `broadcasts:read`, epic #319)

All five read permissions are seeded Admin-only, so writes are gated inside
each page (disabling controls) rather than by a second card permission — the
card gate is about reachability, the page gates content. `Maintenance` is a
`General` card, not an `Operations` one — it is a system setting, not a
running-system view.

## Access Control: Email Allowlist

The application uses an **email allowlist** to restrict access to pre-authorized users only.

### How It Works
1. Admins add email addresses to the allowlist before users can login
2. During OAuth login, the user's email is checked against the allowlist
3. If the email is not in the allowlist, login is denied with a clear error message
4. Exception: `INITIAL_ADMIN_EMAIL` always bypasses the allowlist check

### Configuration
- `INITIAL_ADMIN_EMAIL` environment variable grants initial admin access
- This email is automatically added to the allowlist during database seeding

### Admin Management
- Access allowlist management at `/admin/settings/users` (Allowlist tab; `/admin/users` still redirects here)
- Two tabs available:
  - **Users**: Manage existing registered users
  - **Allowlist**: Pre-authorize email addresses for future logins

### Status Tracking
- **Pending**: Email added to allowlist but user hasn't logged in yet
- **Claimed**: User has successfully logged in and created an account
- Claimed entries cannot be removed (prevents accidentally removing existing user access)

## Security Guidelines

- Secrets via environment variables only (see `.env.example`)
- JWT access tokens are short-lived (15 min default)
- Refresh tokens in HttpOnly cookies with rotation
- Input validation on all endpoints
- File uploads: images only, size/type limits, randomized filenames
- Email allowlist restricts application access to pre-authorized users

## Testing Requirements

- Unit tests: isolated logic (services, guards, validators)
- Integration tests: API + DB + RBAC flows with test DB
- Mock OAuth in CI (no real Google dependency)
- Frontend: component and hook tests

## Environment Variables

Key variables (see `infra/compose/.env.example` for full list):

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
- `NODE_SECRET_SWEEP_ENABLED` - Whether this process runs the ten-minute cron that revokes expired or orphaned per-job credentials brokered to worker nodes (epic #345, issue #349) — the third permanent job-queue exemption (see the MANDATORY rules above). Only the literal `false` turns it off (default: on). Independent of `JOBS_WORKER_MODE`, like the lease reaper, and for the same reason: a credential brokered to a node in a fleet this process does not execute jobs for still needs revoking. Whether a credential is ever brokered **at all** is the separate `nodes.jobSecretBrokerEnabled` system setting, default off — see [`docs/runbooks/node-job-secrets.md`](docs/runbooks/node-job-secrets.md)

**Maintenance Mode:**
- `MAINTENANCE_MODE` - Environment override that outranks the persisted setting. Set to `true` to force the window open even if the app cannot start (a pre-migration deploy), or to `false` to force it shut (recovery from a window opened with `allowAdmins` false). Only the literal strings `'true'`/`'false'` count; anything else (including unset) means "no override, use the stored setting". Requires an application restart to take effect. See `docs/runbooks/maintenance-mode.md`. ⚠️ Document a value for this variable as prose ("set to `true`"), never as an inline `# MAINTENANCE_MODE=true` example — `apps/cli`'s `parseEnvExample` reads *any* commented `# KEY=value` line in `infra/compose/.env.example` as declaring an optional variable, so an illustrative assignment inside prose registers as a second declaration and fails the CLI's env-spec test. `infra/compose/.env.example` already carries exactly one commented default (`# MAINTENANCE_MODE=false`) and a comment stating this rule — do not add a second commented line for this key.

**Database Backup:**
- `DB_BACKUP_SCHEDULE_ENABLED` - Whether this process runs the backup scheduler: a ten-minute cron that enqueues the housekeeping sweep, starts a backup (by enqueuing `db.backup.run`) when the configured schedule has come due, and enqueues the retained-database drop. Defaults to on; only the literal `false` turns it off, and it is deliberately independent of `JOBS_WORKER_MODE` — the *tick* is not itself queue work (it only decides whether to enqueue), so an API running as a pure control plane must still queue its own backups even though `JOBS_WORKER_MODE=off` means nothing on this process will execute them. Everything about the schedule itself (enabled, frequency, time of day, timezone, retention count, stale window) is a `databaseBackup` system setting, not an environment variable — as is `nodeOffloadEnabled` (default **false**), which decides whether a worker node may take the dump at all. See `docs/specs/database-backup.md`.

**Observability:**
- `OTEL_ENABLED` - Enable OpenTelemetry (default: true)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTEL Collector endpoint

## Common Patterns

### Adding a New API Endpoint
1. Create controller method with decorators for auth/RBAC
2. Add service method with business logic
3. Update OpenAPI annotations
4. Add unit + integration tests
5. Update API.md if needed

### Adding a New Setting
1. Update Zod schema for validation
2. Add migration if schema structure changes
3. Update TypeScript types
4. Add frontend UI if user-facing

### Adding a Notification

Three steps, and no migration — the same "one registry entry" promise the
settings hub makes on its own axis (epic #109, wired end to end by #128).

1. **Declare the event** in `apps/api/src/notifications/notification-events.ts`
   (`NOTIFICATION_EVENTS`): a stable dotted `key` (`billing.invoice_ready`), a
   `label` and `description` written as user-facing copy, the `channels` it can
   genuinely be delivered over (`email`, `browser`), and `defaultEnabled`. Add
   `mandatory: true` only for events a user must not be able to silence — a
   privilege or security change. This one entry feeds the dispatcher, the
   `/settings/notifications` matrix and the docs; there is no second list to
   update, and no preference row is created for anybody (absent means enabled).

2. **Write the template(s)**, one per channel the event declares.
   - *Email*: a new `apps/api/src/email/templates/<name>.email.ts` exporting a
     payload interface and a pure function returning `{ subject, html, text }`.
     Build the body with the `html` tagged literal so every interpolation is
     escaped by construction, pass it to `renderLayout`, put any CTA URL
     through the layout (it applies `safeUrl`), and **hand-write the text
     part** — there is deliberately no HTML-to-text helper. A template may
     opt into the one embedded brand logo by passing `emailLogoAttachment()`'s
     result through as `logo`/`attachments` — see `templates/layout.ts`'s
     header and `templates/brand-logo.ts`. Register it in
     `templates/index.ts` (`EmailTemplateDataMap` **and** `EMAIL_TEMPLATES`;
     the compiler rejects half a registration), then map the event key to the
     template name in `EVENT_EMAIL_TEMPLATES`
     (`notifications/channels/email-notification.channel.ts`). A missing entry
     is a recorded delivery failure, not a silent skip.
   - *Browser*: an entry in `EVENT_BROWSER_TEMPLATES`
     (`notifications/channels/browser-notification.channel.ts`) returning
     `{ title, body, link? }`. Optional — a miss falls back to the registry's
     label and description. `link` must be a root-relative path.
   - `test-email.email.ts` and `role-changed.email.ts` are the worked examples.

3. **Call `notify()` at the real trigger**, from a service whose module
   `imports: [NotificationsModule]`:

   ```ts
   await this.notifications.notify('billing.invoice_ready', userId, payload);
   ```

   Place it **after** the triggering write has committed and **outside** any
   `$transaction`. `notify` is detached — it schedules the dispatch and returns
   before anything is rendered or sent — so it never rejects, never joins your
   transaction, and never delays your response; a send failure becomes a
   `notification_deliveries` row, never an exception. Annotate the payload with
   the template's data type: `notify` takes `data: unknown`, so the call site is
   the only place its shape is checked.

   For a recipient who has **no user account** (an allowlist invitation), use
   `notifyAddress(eventKey, email, payload)`. It resolves the address to an
   account when one exists — so real users' preferences are never skipped — and
   otherwise dispatches through the same gate with no stored preferences, which
   the sparse absent-key contract already defines as "use the event's default".

Live examples of all three steps: `AuthService.handleGoogleLogin`
(`user.welcome`), `AllowlistService.addEmail` (`allowlist.invitation`), and
`UsersService.updateUserRoles` (`security.role_changed`, mandatory).

Epic #254's four operational events (`jobs.job_failed`, `nodes.node_offline`,
`db_backup.backup_failed`, `db_backup.restore_completed` — the last one
`mandatory: true`) are worked examples of this same recipe, registered in
`notification-events.ts` beside the ones above; see the events' own
in-file comments and `docs/specs/browser-notifications.md`'s operational-events
section for why no roll-up/digest exists for `jobs.job_failed`.

### Adding a Job Type

One class, self-register, add to your module, enqueue — the same "one
registry entry" shape as Adding a Notification above, and no migration:
`Job.type` is a plain string column precisely so a new handler costs zero
schema change (epic #254). Full recipe, with a live node-eligible example, is
[`apps/api/src/jobs/handlers/README.md`](apps/api/src/jobs/handlers/README.md);
this is the summary.

1. **Implement `JobHandler`** (`apps/api/src/jobs/job-handler.interface.ts`):
   a `readonly type` string (dotted, lowercase, product-neutral, e.g.
   `'export.csv'` — **permanent** once jobs of that type exist) and an async
   `process(job): Promise<void>`. **Throw to fail** — there is no result
   object; a thrown error becomes `Job.lastError` plus a retry, a normal
   return means the work committed and is durable. Be idempotent where you
   can: the queue is at-least-once, never exactly-once.

2. **Self-register** from `onModuleInit()`:
   ```ts
   onModuleInit(): void {
     this.registry.register(this);
   }
   ```
   There is no decorator and no central dispatch table — this one line is the
   entire mechanism. A duplicate `type` overwrites the earlier registration
   and logs a warning (a fork deliberately shadowing a framework handler).

3. **Add it as a provider** in the module that owns the feature, importing
   `JobsModule` for the registry:
   ```ts
   @Module({ imports: [JobsModule], providers: [MyHandler] })
   export class MyFeatureModule {}
   ```

4. **Enqueue** via `JobsService` (exported by `JobsModule`):
   ```ts
   await this.jobs.enqueue({
     type: 'my-feature.do-the-thing',
     reason: 'upload',
     subjectType: 'storage_object',
     subjectId: object.id,
     payload: { objectId: object.id },
   });
   ```
   `payload` is opaque JSONB — keep it to identifiers, not copies of data, so
   a job run minutes later re-reads current state. Enqueueing the same
   `type` + subject twice is deduplicated for free while an earlier job is
   `pending`/`running`; pass `skipDedup: true` when several jobs against the
   same subject are legitimately distinct work.

The type then **appears in the admin dashboard automatically** —
`JobHandlerRegistry.types()` drives it, no migration, no enum, no queue
wiring. Add a friendly label in `job-type-labels.ts` if you want one (optional
polish; an unmapped type renders as its raw string, never blank).

**Node eligibility — what makes a type node-eligible, precisely:** a handler
carries **both** `nodeResultSchema` (a Zod schema validating what a remote
worker node posts back) and `persistNodeResult(job, result): Promise<void>`
(writes an *already-validated* result down — persist only, never
recomputation, never a second call to whatever provider the node used), or
**neither** — never exactly one; a schema with no persist function describes
a payload nobody can store, and a persist function with no schema would trust
an unvalidated remote body. There is deliberately no `nodeEligible: boolean`
flag: deriving eligibility from the two members makes an inconsistent state
unrepresentable, and `JobHandlerRegistry.serverOnlyTypes()` is that
derivation — it is what the `system` worker mode and the node claim endpoint
both read, so a type missing either member is one **no node can ever claim**.

`example-echo.handler.ts` and `example-checksum.handler.ts` are the two
worked examples, and the difference between them **is** the eligibility
line above: `example.echo` is server-only — it implements only `process`,
logs its payload, and returns. `example.checksum` (#269) implements both
`process` (server path) *and* `nodeResultSchema` +
`persistNodeResult` (node path), routing both through one private write
method so a job's stored result cannot depend on which executor claimed it —
that "one write, two paths" shape is the one thing to copy when writing a
node-eligible handler of your own.

Four more optional members, all on `JobHandler`, each following the same
"presence is the declaration" rule as the pair above — implement one only
when the default is genuinely wrong for this type (see the MANDATORY rules
above for the first two as binding policy, not just options):

- `profile?: { maxRuntimeMs, maxAttempts }` — overrides the deployment-wide
  `JOBS_JOB_TIMEOUT_MS`/`JOBS_MAX_ATTEMPTS` for this type alone. Declare it for
  a type that legitimately runs for hours (`maxRuntimeMs`) or must never be
  auto-retried (`maxAttempts: 1`). The lease and its renewal interval are
  *derived* from `maxRuntimeMs` — do not add a third field.
- `deriveOutputKey?(job)` — overrides the node data plane's default upload key
  (`node-outputs/<jobId>/<uuid>`) when the artifact's location is part of its
  contract (a row records the key, a retention sweep lists a prefix). Must be
  idempotent per job — re-derive from values already fixed on the job, or
  re-read the row this job's first call already created.
- `nodeOffloadEnabled?(): Promise<boolean>` — a runtime policy read (not a
  static flag) letting a deployment say "not this workload" about a type that
  is structurally node-eligible. Read at claim time by
  `NodesService.nodeEligibleTypes`; never changes what `serverOnlyTypes()`
  reports.
- `nodeSecretBroker?: JobSecretBroker` — declares that a remote executor of
  this type needs a credential, and how to mint/revoke one. See MANDATORY
  rule 3 above and `apps/api/src/jobs/job-secret-broker.ts`.

`db-backup/handlers/db-backup-run.handler.ts` (`db.backup.run`, epic #345) is the
worked example that uses all four: a `profile` sized for a multi-hour dump
with `maxAttempts: 1`, `deriveOutputKey` re-reading the backup's own run row,
`nodeOffloadEnabled` reading `databaseBackup.nodeOffloadEnabled`, and
`nodeSecretBroker` minting a short-lived read-only PostgreSQL role. See
[`docs/specs/job-queue.md`](docs/specs/job-queue.md) and
[`docs/specs/worker-nodes.md`](docs/specs/worker-nodes.md) for the full design
— the claim's `FOR UPDATE SKIP LOCKED`, the lease, the data plane's presigned
URLs, and the rejected alternatives.

### The Transcript Pipeline

Turning an uploaded recording into a saved transcript is issue #25 of epic #19,
and it is **seven job types**, not one — because a provider takes minutes to
hours and rule 1 says nothing that outlives its request may be a detached
promise. The design (the three state machines, the provider contract, the
access model, privacy) is
[`docs/specs/transcription.md`](docs/specs/transcription.md); the endpoints are
the `### Transcripts` group above and `docs/API.md`. Four things are worth
having here because they are easy to break from a neighbouring file:

1. **`transcription.poll` re-enqueues itself with `skipDedup: true`, and that is
   required for correctness.** The job calling `enqueue()` is itself a `running`
   `transcription.poll` row for the same subject, so it matches the active-dedup
   key: without `skipDedup` the enqueue silently returns the row that is running
   right now, with its `scheduledFor` unchanged, the computed backoff is
   discarded, the current job finishes moments later with nothing scheduled, and
   the transcript sits in `submitted` **forever with no error anywhere**. A
   regression here has no other symptom. It lives in one place —
   `TranscriptPipelineService.enqueuePoll` — and `transcript-pipeline.service
   .spec.ts` pins it.
2. **The three provider-facing types are server-only under rule 3, and the
   reason is specific**: the provider API key is long-lived and account-level,
   and unlike `db.backup.run`'s PostgreSQL role there is no vendor API for
   minting a job-scoped sub-key, so there is nothing a `nodeSecretBroker` could
   broker. `media.audio.transcode` (#26) is node-eligible; nothing else in the
   pipeline is.
3. **Domain failures do not spend a job attempt.** `ProviderAuthError`,
   `ProviderInputError` and the provider's own terminal error set
   `failure_reason` + `status: failed` and the job **returns normally** — it
   succeeded at determining a permanent outcome, and retrying would re-ask a
   question whose answer cannot change. A `429` throws `RateLimitError` and is
   deferred through one shared `'transcription-provider'` throttle key across
   submit, poll and ingest, because all three share one vendor account and one
   rate-limit budget.
4. **Two enqueues are guarded on the registry**, because `media.audio.transcode`
   (#26) and `transcript.snapshot` (#27) are registered by later issues: without
   the guard they would create `pending` rows no worker can ever claim, which sit
   in the admin job list as a permanent backlog of one.

Job types, all labelled in `job-type-labels.ts`: `media.audio.transcode`,
`transcription.submit`, `transcription.poll`, `transcription.ingest`,
`transcript.snapshot`, `transcript.export`, `transcript.purge`,
`transcripts.housekeeping` — the last enqueued by a ten-minute `@Cron` that only
enqueues, like every other one. `transcript.export` runs at priority **−10**,
the opposite end of the spectrum from `HOUSEKEEPING_PRIORITY = 100`: it is the
one type in this epic where somebody is watching a spinner.

A ninth type, `transcript.name_check` (issues #328/#330, epic #326), is
server-only permanently for the same reason `note.generate` is: every request
runs on the requesting user's own AI provider key, and no vendor here offers
a job-scoped sub-key a `nodeSecretBroker` could mint instead. `profile:
{ maxRuntimeMs: 20 min, maxAttempts: 1 }` — one attempt, deliberately, so a
retry never re-runs and double-charges a click; see
[`docs/specs/transcript-name-correction.md`](docs/specs/transcript-name-correction.md) §6.

### Worker Node Fleet, Maintenance Mode

Distributed worker nodes (server + CLI + container + TUI) and the maintenance
window are the rest of epic #254 (issues #257, #266–#282). Nothing about
either needs restating here beyond the endpoint groups, permissions, tables
and environment variables already listed above in their own sections. The
design (registration, the claim/lease/data-plane mechanics, capability
probing, heap tuning, the fleet health sweep) is
[`docs/specs/worker-nodes.md`](docs/specs/worker-nodes.md); the operator guide
is [`docs/deployment/worker-nodes.md`](docs/deployment/worker-nodes.md); the
CLI's `node` command reference is
[`apps/cli/README.md`](apps/cli/README.md#running-a-worker-node). Maintenance
mode's design (why no new permission, the environment/memory/persisted layer
precedence, the `allowAdmins: false` break-glass) is
[`docs/specs/maintenance-mode.md`](docs/specs/maintenance-mode.md); the
operator runbook is
[`docs/runbooks/maintenance-mode.md`](docs/runbooks/maintenance-mode.md).

### Browser Notifications and Web Push

OS-level browser notifications — a service worker precaching the app shell
and hosting the `push`/`notificationclick` handlers Android requires, a
brand-parameterized PWA manifest, an 8-state notification capability model,
an admin kill switch that mutes the OS toast without ever muting the durable
`notifications` row, and Web Push behind a VAPID key pair that ships disabled
by default — is epic #215 (issues #216–#233). The design decisions that
shape this area (why `injectManifest` over `generateSW`, why the service
worker must never call the API, why `sw.js` must be served `no-cache`, why a
non-admin learns the toggle from `GET /api/notifications/config` rather than
`system_settings`, why nothing under `/api` is ever precached) are documented
in full, with rationale and rejected alternatives, in
[`docs/specs/browser-notifications.md`](docs/specs/browser-notifications.md).
Generating, enabling, rotating, and disabling VAPID keys is
[`docs/runbooks/vapid-keys.md`](docs/runbooks/vapid-keys.md). Since issue #355
this is also runtime-configurable, live, with no restart, through an admin UI
at `/admin/settings/push`. Don't restate either here; extend those two
instead.

### Admin Notification Broadcasts

Sending a message to every active user — composed in the app, sent now or
scheduled, over whichever of email/in-app/push the deployment supports — is
epic #319 (issues #320–#325), gated by the `broadcasts:read` /
`broadcasts:write` permission pair, raised through two registry events
(`admin.broadcast`, muteable; `admin.broadcast_critical`, `mandatory: true`),
and fanned out over two job types (`admin.broadcast.start`,
`admin.broadcast.chunk`) rather than a new scheduler or a second notification
system. The admin API lives under `/api/admin/broadcasts`; the settings
surface is the `Broadcasts` card at `/admin/settings/broadcasts`. The design
decisions this rests on (why two event keys and not a per-send flag, why the
per-broadcast channel choice can only narrow and where the `critical ⇒
browser` rule is actually enforced, why the audience is frozen at a cutoff,
why fan-out chunks must be enqueued with `skipDedup: true`, why `notifyNow()`
exists beside the detached `notify()`) are documented in full, with
rationale and rejected alternatives, in
[`docs/specs/notification-broadcasts.md`](docs/specs/notification-broadcasts.md).
Don't restate any of that here; extend that file instead.

### Database Backups

A backup **is** a queue job (`db.backup.run`, epic #345) and may be claimed by
a worker node — but `database_backup_runs` is still **not** a `jobs` row and
must not become one. `jobs.stuckThresholdMinutes` defaults to 30 minutes, so a
run kept on the queue's own clock would be reset to `pending` mid-dump and a
**second `pg_dump`** would start against the same storage key; the job survives
that only because `db.backup.run` declares its own `maxRuntimeMs` and the lease
is derived from it. `database_backup_runs` remains a dedicated table with its
own heartbeat, its own stale window (`databaseBackup.runStaleMinutes`) and its
own terminal states — and because a node cannot write that heartbeat at all,
the stale sweep asks the JOB's lease before giving up on a run. Two more
rules that are easy to break by accident: **at most one active run at a time
is enforced by a partial UNIQUE index** (`database_backup_runs_active_uniq_idx`),
never by a `findFirst` before the insert — Prisma cannot express that index,
so it lives hand-written in the migration and is intentional schema drift; and
**the archive is never buffered** — `pg_dump`'s stdout streams straight into
object storage through a metering `Transform`, with both the upload and the
dump's exit code awaited, because either one alone will happily report success
on a truncated archive.

The design (the model, why the restore audit lives on the backup's own row,
the streaming contract, the read-it-back verification, the failure ordering,
cancellation, the storage-provider constraint, and the rejected alternatives)
is documented in full in
[`docs/specs/database-backup.md`](docs/specs/database-backup.md). Diagnosing a
`pg_dump` client/server version mismatch is
[`docs/runbooks/postgres-client-version.md`](docs/runbooks/postgres-client-version.md).
Don't restate either here; extend those two instead.

Running the dump on a worker node needs a database connection, and no amount of
presigning produces one. `db-backup/pg-job-role.broker.ts` is the first
`JobSecretBroker` in this repository (epic #345): per job it mints a
`appjob_<job>_<random>` login role holding `CONNECT` + `USAGE` + `SELECT` and
nothing else, `VALID UNTIL` the job's lease + 60s, through `withAdminConnection`
outside the Prisma pool. `pg_dump` **does not need `SUPERUSER`** — `--no-owner
--no-acl` keeps ownership and grants out of the archive, so a SELECT-only role
produces the same bytes. Three layers bound a grant: the settle listener, the
sweeper, and `VALID UNTIL`, which PostgreSQL enforces itself and which no
switched-off cron can miss. A role without `CREATEROLE` is the **ordinary**
managed-PostgreSQL case and answers `guided` with paste-ready SQL, never a 4xx.
A node also needs a **network route** to PostgreSQL; there is deliberately no
tunnelling, because that would put the API in the data path the presigned-URL
data plane exists to keep it out of. Operator guide:
[`docs/runbooks/node-job-secrets.md`](docs/runbooks/node-job-secrets.md).

The type is **offered** to a node only when three things agree, all intersected
at claim time and none of them mutating the registry: `nodes
.jobSecretBrokerEnabled` (may the broker issue anything), `databaseBackup
.nodeOffloadEnabled` (may this workload leave the server — default false, and a
deliberately separate switch), and the broker's own `usable()` probe (can it
mint here at all). Verification never moves with the work: the node reports a
size, a digest and the key it was given, and the **server** reads the uploaded
archive back before setting `verified_at`. `docs/specs/database-backup.md` §16
carries the whole design, including why `bytes` crosses the wire as a decimal
string.

Restoring one is the other half, and it has two rules of its own. **No
pre-flight path may create, drop or rename anything** — an operator asks "can
I restore this?" precisely when they have not decided to. And **the cluster
admin connection lives outside the Prisma pool**, on the `postgres`
maintenance database: those pooled connections are exactly what must be gone
before a rename can succeed, and a database cannot be renamed from a session
connected to it. A capability gate that fails (managed PostgreSQL denying
`CREATEDB` is the ordinary case) answers with a ready-to-paste command block
rather than a 4xx — that `guided` outcome is a designed-in path, not a
fallback. The gates, the three outcomes, the identifier and name-builder
rules, and the rejected alternatives are in
[`docs/specs/database-restore.md`](docs/specs/database-restore.md); the
operator procedure, written to be usable with the application down, is
[`docs/runbooks/database-restore.md`](docs/runbooks/database-restore.md).
Extend those two rather than restating them here.

### Audio Transcription

Turning an uploaded recording into a speaker-aware, correctable, versioned,
shareable, exportable transcript — *"AI proposes. The user controls the
truth"* — is epic #19 (issues #20–#32): storage hardening for multi-GB
resumable uploads, a `TranscriptionProvider` registry with AssemblyAI as the
first implementation, the `transcripts`/`transcript_speakers`/
`transcript_segments`/`transcript_versions`/`transcript_shares`/
`transcript_exports` tables, an eight-job-type queue pipeline (submit → poll
→ ingest, a node-eligible `media.audio.transcode`, snapshotting, export and
purge), an operation-log correction model with full version history, and the
`transcripts:read`/`write` permission pair seeded to all three roles. The
design decisions this rests on — the three state machines, why each job
type is or is not node-eligible against the CLAUDE.md rules above, the
poll backoff schedule and why its re-enqueue must be `skipDedup: true`, the
provider contract and its error taxonomy, the gap-based `ordinal` and
LCS-based word-alignment scheme, the concurrency model's `rev`/`baseVersion`
split, why there is no `transcripts:read_any` and no access ever answers
403, and the full list of rejected alternatives — are documented in full in
[`docs/specs/transcription.md`](docs/specs/transcription.md), with the
public export contract published alongside it as
[`docs/specs/transcript-export.v1.schema.json`](docs/specs/transcript-export.v1.schema.json).
Don't restate any of that here; extend those two instead.

**AI name correction** (epic #326, issues #327–#330) builds on this pipeline:
feeding a transcript's known names to the provider as a `keyterms` hint at
submit time, then a separate, user-triggered `transcript.name_check` job that
finds and proposes fixes for names speech recognition still got wrong —
deterministic phonetic retrieval, an optional thorough LLM discovery pass,
and LLM adjudication with an over-correction guard, applied through the exact
same `/operations` correction path as any other edit. Full design in
[`docs/specs/transcript-name-correction.md`](docs/specs/transcript-name-correction.md);
don't restate it here.

### Notes, Note Templates and the AI Layer

Turning a transcript, another note, or an uploaded document into an
AI-generated, user-correctable note — epic #45 (issues #46–#59), built on top
of the transcript pipeline above. Note templates are the reusable recipe; AI
settings (`system_settings:read`/`:write`, the `ai` namespace) is deployment
policy; AI credentials are strict bring-your-own-key, one row per
`(userId, provider)` in `user_ai_credentials`, never a deployment-wide
fallback. The design — the two state machines, the token budget and why it
refuses rather than truncates, the streaming contract, the access model, the
export registry, and the full privacy statement of what leaves this
deployment and under whose account — is documented in full in
[`docs/specs/notes.md`](docs/specs/notes.md). Don't restate any of that here;
extend it instead. `AiProvider.generateStructured` (issue #358, spec §2.6) is
the schema-validated structured-output path that connected-knowledge
extraction and adjudication call instead of `generate`'s free-text stream;
`AiProvider.chat` (issue #359, spec §2.7) is the multi-turn, tool-calling path
the connected-knowledge Ask agent calls instead, gated on the same-shaped
`toolCalling` capability flag. `AiTaskModelResolver` (issue #360, spec §2.8)
is the one place any of those tasks — plus notes' own generation, via
`resolveForGeneration` — resolves which provider, model and reasoning effort
a run actually uses, sharing one `chooseTaskModel` chooser with the admin
view and `GET /api/ai/config` so the three can never disagree.
Five rules below are the ones a contributor can break from
a neighbouring file, each with its failure mode — the same editorial bar the
Audio Transcription section above sets.

1. **The generation stream is a view over durable state, never the delivery
   mechanism.** `note.generate` writes every delta into
   `note_generations.content` on the way past; `GET /api/notes/:id/stream`
   and `GET /api/note-generations/:id/stream` (`generation/note-stream.ts`)
   only read that column. A note completes identically whether or not
   anybody is connected, and closing the tab loses nothing. Anything that
   makes correctness depend on an open SSE connection — buffering a result in
   memory instead of writing it, gating the note's own commit on a client
   being attached — is a regression, and it will pass every test that runs
   in one process because the test harness never disconnects.

2. **`note.generate` declares `profile: { maxAttempts: 1 }` on purpose.**
   Every other handler's "unrecognised failure" class auto-retries
   correctly, because retrying has no side effect the user pays for twice.
   Here a retry would call the same provider with the *user's own key* a
   second time, and because a completion is non-deterministic it would show
   different text than the partial stream they already watched fail.
   `POST /api/notes/:id/regenerate` is the only retry path — a person
   pressing a button, queuing a brand-new job with its own fresh
   one-attempt budget. Someone "fixing" the profile to retry like every
   other job silently double-charges users for output they never asked to
   see twice.

3. **The provider-rate-limit throttle key is per user, not per deployment.**
   `aiProviderThrottleKey(userId)` (`notes/job-types.ts`) is the exact
   inverse of `TRANSCRIPTION_THROTTLE_KEY`: transcription shares one
   deployment-owned AssemblyAI account against one vendor rate limit, so one
   shared bucket is correct there. Here every user brings their own vendor
   account with their own limit, so a 429 against user A's key is evidence
   about user A only. A shared `'ai-provider'` key would look right — it is
   exactly the code transcription uses — and would let one busy user's 429
   defer every other user's note generation, a relationship between the
   accounts that does not exist.

4. **Over-budget prompts are refused, never truncated, and the refusal
   carries numbers.** `assertWithinBudget`/`AiBudgetError` (`ai-errors.ts`,
   `generation/token-budget.ts`) name the required and available token
   counts in the 400 body rather than silently cutting the source text.
   Truncating instead would be the worst available failure: the user is
   billed for a request that quietly generated a note from *part* of their
   source, with nothing telling them a paragraph vanished into the cut.
   `docs/specs/notes.md` §3.3 states the constructor-argument requirement
   for exactly this reason — an `AiBudgetError` that could only say "too
   large" would satisfy the type and defeat the requirement.

5. **A per-user AI key lives in `user_ai_credentials`, never in
   `credentials`, because of the cascade.** `credentials` has no foreign key
   to `users` and cannot grow one — `Credential.updatedByUserId` is
   `SetNull` on purpose so offboarding an admin never deletes a working SMTP
   configuration. Encoding a user id into `credentials.name`
   (`purpose 'ai'`, `name 'openai:<userId>'`) would mean deleting a user
   leaves their encrypted personal API key in that table forever, with no FK
   to clean it up and no enumeration path short of parsing every row's
   `name`. `user_ai_credentials.userId` **cascades**, which is the entire
   point of the table: the key is the user's, so its lifetime is the user's.

The six job types (`notes/job-types.ts`, all labelled in
`job-type-labels.ts`): `note.generate` (server-only permanently — no vendor
here offers a job-scoped sub-key the way PostgreSQL does for
`db.backup.run`, so there is nothing a `nodeSecretBroker` could broker),
`note.source.extract` (node-eligible), `note.export` (server-only — the
renderers live in the API, the same scope line `transcript.export` draws),
`note.purge`, `notes.housekeeping` (the sweep that hard-deletes expired
template previews and expired exports), and `note.retitle` (#184, epic #163 —
retroactive titling of the existing library, one job per note, `maxAttempts:
1` and server-only for `note.generate`'s reasons exactly. ⚠ **A job and
deliberately not a migration**: titling spends the note owner's own vendor key,
which `migrate deploy` must never do on their behalf).

### Deleting Your Own Data

The "Danger Zone" (`/settings/danger-zone`, issue #80) is one queue job,
`user.data.purge`, enqueued by `POST /api/user-data/deletions` and never run
inline, per the "Every Long-Running Activity Is a Queue Job" rule above.
**Server-only permanently**, for the database-restore reason at its
strongest: it holds the authority to destroy a user's entire dataset across
six tables, and there is no credential narrow enough for a
`nodeSecretBroker` to hand a worker node instead. `profile: { maxAttempts:
1 }`, for the identical reason `note.generate` carries it — a destructive
fan-out that fails part-way through must surface as a `failed` job a person
looks at, never silently resume minutes later. `POST
/api/user-data/deletions` is the retry path, the same relationship `POST
/api/notes/{id}/regenerate` has with `note.generate`.

⚠ **It clears `Restrict` foreign keys before deleting, and never catches an
FK violation.** A bulk deletion deliberately does not honour the per-item
409 guards `NotesService.remove` and `TranscriptsService.remove` enforce —
the blocking relationship is often inside the very batch being deleted, and
unfixable from the UI once it is. So `notes.source_note_id` and
`notes.source_transcript_id` are cleared first — including on **other
users'** notes derived from a transcript the caller shared, which keep
their text and lose only the provenance link — and the delete that follows
is then an ordinary one.

⚠ **It fans out to the existing `transcript.purge`/`note.purge` handlers and
deletes no bytes itself.** A transcript is soft-deleted and handed to
`transcript.purge`; a note to `note.purge`; an unmanaged upload goes through
`ObjectsService.delete`. Reimplementing byte deletion here — the shortcut a
"simplify this" pass would reach for — would orphan multi-gigabyte objects
with nothing left in the database that knows they exist, the exact failure
`transcript-purge.handler.ts`'s own header argues against.

The scope matrix (`scopeIncludes` in `apps/api/src/user-data/job-types.ts`):
`transcripts`/`notes`/`files` each remove exactly one category; `content` is
transcripts + notes + the caller's own note templates + files + the caller's
knowledge graph; `everything` is `content` plus credentials (AI provider
keys, personal access tokens). No scope deletes the account. The graph
(issue #357, epic #344) is not deleted inline like the others: `content`/
`everything` enqueue `kg.purge {scope: 'all'}` and let that job's handler own
the plan, the same fan-out-to-existing-handlers shape this module already
uses for `transcript.purge`/`note.purge`. Full design — the FK-clearing
order and why it is mandatory, and the honest gaps (a template that finishes
archived rather than deleted, a provenance link lost on a stranger's note) —
is [`docs/specs/user-data-deletion.md`](docs/specs/user-data-deletion.md).

### Onboarding

A live-derived first-run checklist for a fresh deployment's administrator and a fresh account's
ordinary user — epic #271 (issues #272–#281), `apps/api/src/onboarding/`. Full rationale,
including every rejected alternative, is [`docs/specs/onboarding.md`](docs/specs/onboarding.md);
this is two invariants a neighbouring file can break without a test failing anywhere obvious.

1. **A step's completion is DERIVED on every read, never stored.** `OnboardingService` builds a
   fresh context from live system state on every call to `GET /api/onboarding` /
   `GET /api/admin/onboarding` and hands it to every step in `onboarding-steps.ts`; nothing in
   `apps/api/src/onboarding/` writes a completion row. The only persisted onboarding state
   anywhere is the caller's own **intent** — the `onboarding` user-settings namespace above.
2. **A step never issues its own query.** `buildUserContext`/`buildAdminContext` each perform one
   bounded read pass and hand the *same* object to every step; a step function's only argument is
   that context. Adding a step must not add a database call.

⚠ **The permissionless-route trap.** `@Auth()` with no roles and no permissions (`GET
/api/onboarding`) means `RolesGuard` and `PermissionsGuard` both return early and never attach
`request.requestUser` — so `@CurrentUser()` yields the raw `AuthenticatedUser`, whose
`.permissions` is `undefined`. Read as an empty set, that silently filters every permissioned
step out of a 200. Any future permissionless route that needs the caller's permission list must
go through `normalizeCaller`/`toRequestUser`, exactly as `onboarding.service.ts` does — see that
file's `OnboardingCaller` type for the full trap, and the spec for why only an integration test
through the real guard stack, not a unit test constructing a `RequestUser` by hand, can catch it.

### Connected Knowledge (the ontology)

Turning transcripts and notes into a durable, entity-and-relationship graph
of the work itself — people, organizations, projects, meetings, decisions,
commitments and dated claims — rather than just searchable text. Full design
(the ontology, the extraction/resolution pipeline, the review-and-commit
gate, retrieval, privacy) is [`docs/specs/ontology.md`](docs/specs/ontology.md).
The same document also specifies a review UI for overriding extraction,
per-task-and-per-user AI model selection, a read-only "Ask" agent over the
graph, and an explorer/whole-graph visualization (§19–§22).
**The ontology definition package (issue #350), the `kg_*` tables (issue
#351) and the graph module scaffold (issue #354: `GraphModule`,
`GraphAccessService`, the `graph:*` permissions and `GET /api/graph/ontology`)
are built, and so is the graph write layer (issue #355: `GraphWriteService`, the evidence
invariant trigger, the manual entity edit and attribute definitions); "forget this person"
(issue #357: `POST /api/graph/entities/:id/forget`, the `kg.purge` job type, and the Danger
Zone's `graph` category) is also built; the read layer (issue #370, epic #347:
`apps/api/src/graph/read/` — the entity index, an entity's page, its
neighbourhood, timeline, mentions, citation links, and the explorer's
`expand`, exported as `GraphReadService`, `GraphNeighborhoodService` and
`GraphEvidenceService` for the entity brief (#372) and the Ask agent (#377)
to reuse) is built too; the extraction/review/commit pipeline and the
whole-graph overview arrive later.**
The extraction quality harness (issue #362: the synthetic golden set at
`apps/api/test/fixtures/kg-golden/` and `npm run kg:eval --workspace=api`, spec §6) is
built too — synthetic fixtures only, ever; real notes are evaluated locally, outside the repo.
The ontology's sources live
at `packages/shared/src/ontology/`, compiled with `npm run build:ontology
--workspace=@app/shared` into committed output at `packages/shared/ontology/`
and consumed as `@app/shared/ontology`. Edit sources, rebuild, and commit the
compiled output in the same commit as the source change — CI rebuilds and
fails on any diff. Each `kg_*` table's own rules are under "Database Tables"
above. The only `kg.*` job handlers so far are `kg.purge` (#357) and
`kg.speaker_link` (#356); every other type in `apps/api/src/graph/job-types.ts`
is still only a constant. There are no extraction/review/commit or
whole-graph-overview routes yet, and no graph UI.
Five rules a neighbouring file can
break once it is: no orphans — an accepted/edited graph row always carries
evidence back to a transcript segment or note span; nothing enters the graph
except through a reviewed proposal's commit, with two named exceptions (the
speaker-naming write and a manual edit on an entity page); retrieval never
answers from the graph alone —
FTS/vector fusion is mandatory, not a fallback; every `kg.*` job runs
server-only, on the calling user's own AI provider key, exactly like
`note.generate`; and a `sensitive`-classified `PersonFact` never leaves this
deployment for any purpose, under any setting. The ontology itself is
defined in one TypeScript + Zod file (planned: `packages/shared/ontology/`)
that is the single source of truth for every type and attribute, and every
graph row carries the `ontology_version` it was written against. Don't
restate any of that here; extend the spec instead.

**Every graph write goes through `GraphWriteService`** (`apps/api/src/graph/write/`, #355) — the
proposal commit, speaker naming, merges, imports and the manual edit alike — which validates
type, closed props, endpoints, temporal fields and evidence inside the caller's transaction,
with the deferred `kg_assert_has_evidence` trigger as the database's backstop at `COMMIT`; a
`kg_entities`/`kg_relations`/`kg_items` row written any other way should be rejected in review.

**`kg.purge` (#357) is server-only permanently and `profile: { maxAttempts: 1 }`** — the
identical `user.data.purge`/`note.generate` reasoning: a destructive fan-out across a dozen
`kg_*` tables that fails part-way must surface as a `failed` job a person looks at, never
silently resume minutes later, and there is no credential narrow enough for a
`nodeSecretBroker` to hand a worker node instead. It serves two callers: "Forget this person"
(`scope: 'person'`, `apps/api/src/graph/graph-entities.controller.ts`) and the Danger Zone's
`graph` category (`scope: 'all'`, `apps/api/src/user-data/handlers/user-data-purge.handler.ts`).
The handler is re-entrant — every step selects what is still there and deletes it — which is
what makes a person-initiated retry (asking again) safe without an automatic one.

**Speaker naming writes the graph only through `kg.speaker_link`** (#356): every
`TranscriptEditingService` save that changes a speaker's shown name — `identify()`, and (#405) a
versioned rename/clear/create/merge or a restore — emits `transcript.speakers_identified`, a
listener only enqueues the job (`skipDedup: true`), and the server-only handler reconciles each
speaker's **effective** name (the live row with the `speaker_identities` overlay, exactly as
`materialize()` shows it — never `speaker_identities` alone) into the **owner's** `Person` +
`IDENTIFIED_AS` rows — never an editor's, and only while the owner holds `graph:write`; see
`docs/specs/ontology.md` §8.

## Specialized Subagents (MANDATORY)

**CRITICAL REQUIREMENT**: This project uses specialized subagents for all development work. You MUST delegate tasks to the appropriate subagent. Do NOT attempt to perform development tasks directly without using the designated agent.

### Why Subagents Are Mandatory
- Each agent contains domain-specific knowledge from the System Specification
- Agents ensure consistent patterns and conventions across the codebase
- Agents have the full context needed for their specialized area
- Direct implementation without agents risks missing requirements

### Available Agents

| Agent | Domain | MUST Use For |
|-------|--------|--------------|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **ANY** backend code: endpoints, services, guards, middleware, JWT, OAuth |
| `frontend-dev` | React, MUI, TypeScript | **ANY** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **ANY** database work: schema changes, migrations, seeds, queries |
| `testing-dev` | Jest/Supertest (API), Vitest/RTL (web) | **ANY** testing: unit tests, integration tests, typecheck, test fixtures |
| `docs-dev` | Technical documentation | **ANY** documentation: ARCHITECTURE.md, SECURITY.md, API.md, README updates |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck. NEVER for state-changing git operations |

### Mandatory Delegation Rules

1. **Backend code changes** → ALWAYS use `backend-dev`
2. **Frontend code changes** → ALWAYS use `frontend-dev`
3. **Database/Prisma changes** → ALWAYS use `database-dev`
4. **Writing or updating tests** → ALWAYS use `testing-dev`
5. **Documentation updates** → ALWAYS use `docs-dev`
6. **Routine ops (container rebuilds, migrations, typecheck)** → use `ops-dev`. IMPORTANT: `ops-dev` must NEVER perform state-changing git operations (pull, merge, push, commit, worktree management, branch operations) — those are always handled by the main agent directly, and `ops-dev` is instructed to refuse them

### Multi-Domain Tasks

For tasks spanning multiple domains, you MUST invoke multiple agents sequentially:

**Example: "Add a new user preference setting"**
1. `database-dev` → Add migration for schema change
2. `backend-dev` → Implement API endpoint
3. `frontend-dev` → Build UI component
4. `testing-dev` → Write tests for all layers
5. `docs-dev` → Update API documentation

### Usage Examples
```
# Backend work - MUST use backend-dev
"Use backend-dev to implement the user settings endpoint"

# Frontend work - MUST use frontend-dev
"Use frontend-dev to create the theme toggle component"

# Database work - MUST use database-dev
"Use database-dev to add audit_events table migration"

# Testing work - MUST use testing-dev
"Use testing-dev to write integration tests for auth"

# Documentation work - MUST use docs-dev
"Use docs-dev to update SECURITY.md with new auth flow"

# Routine ops - use ops-dev (never for git operations)
"Use ops-dev to rebuild the api container and run migrations"
```

### What You Should NOT Do Directly
- Do NOT write NestJS controllers, services, or guards without `backend-dev`
- Do NOT create React components or pages without `frontend-dev`
- Do NOT modify Prisma schema or create migrations without `database-dev`
- Do NOT write Jest/Vitest/RTL tests without `testing-dev`
- Do NOT update documentation files without `docs-dev`

The only exceptions are:
- Reading files to understand context
- Answering questions about the codebase
- Planning and coordination between agents
- Running simple commands (git status, npm install, etc.)
