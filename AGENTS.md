# AGENTS.md

Shared rules for AI assistants working on this codebase (loaded by OpenCode, and by Claude Code through `CLAUDE.md`). Area rules live in nested `AGENTS.md` files: `apps/api`, `apps/web`, `apps/cli`. How the tools share files: [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md).

## Project overview

Web application foundation (KVox): React UI + Node API + PostgreSQL, with OAuth authentication, RBAC, a settings framework, a background job queue with worker nodes, transcription, AI notes and a connected-knowledge graph.
Stack: Node.js + TypeScript; NestJS on Fastify + Prisma (API); React + MUI, sigma.js + graphology (web); Commander + ink (`kvox` CLI); PostgreSQL; Passport (Google OAuth); Jest + Supertest (API), Vitest + React Testing Library (web, CLI); OpenTelemetry + Uptrace + Pino; Docker Compose; Nginx same-origin.
Start at [README.md](README.md) and [docs/README.md](docs/README.md) (index with a "Doc map by task").

## Repository structure

```
apps/api/        NestJS API: src/<module>/, test/, prisma/ (schema.prisma, migrations/, seed)
apps/web/        React app: src/config/ (registries), pages/, components/, __tests__/
apps/cli/        `kvox` CLI: src/commands/, src/tui/; README.md is the usage source of truth
packages/shared/ Shared code; ontology sources in src/ontology/, compiled output in ontology/
docs/            ARCHITECTURE.md, API.md, specs/, runbooks/, deployment/
infra/compose/   {base,dev,devdb,prod,otel,test,vps,worker}.compose.yml, .env.example
infra/nginx/, infra/otel/   Nginx routing; OTEL collector and Uptrace config
tests/e2e/       Optional E2E tests
```

## Where to read more

Full index: [docs/README.md](docs/README.md). The most used:

- Architecture, permission catalog, table inventory, navigation destinations: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Endpoint reference (one `###` per group; read by heading, never whole): [docs/API.md](docs/API.md)
- Security design, allowlist, sessions: [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md)
- Dev loop, environment variables: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); testing: [docs/TESTING.md](docs/TESTING.md)
- Specs: [settings-ui](docs/specs/settings-ui.md), [job-queue](docs/specs/job-queue.md), [worker-nodes](docs/specs/worker-nodes.md), [transcription](docs/specs/transcription.md), [notes](docs/specs/notes.md), [ontology](docs/specs/ontology.md)
- Recipes: [job type](.claude/skills/add-job-type/SKILL.md), [notification](.claude/skills/add-notification/SKILL.md), [CLI and deploy](apps/cli/README.md)
- Runbooks: [docs/README.md#runbooks](docs/README.md#runbooks)

## Working with a small context window

- Read docs by section: `grep -n '^#' <file>` for headings, then Read with `offset`/`limit`.
- Never read `docs/API.md` (340 KB), `docs/ARCHITECTURE.md` or a spec whole.
- Use one subagent at a time; hand it the doc section to read, not the whole doc.
- Area rules are in the nested `AGENTS.md` of the folder you work in.

## MANDATORY: Issue-Driven Development (Traceability)

Every feature and bug fix is tracked by a GitHub issue, filed **before** implementation planning is finalized (features) or the fix starts (bugs), and before any worktree or branch is created. `gh issue create` inside the repo infers the repository.

- **New feature**: `gh issue create --template feature_request.yml` (real problem statement, solution, component, priority; no placeholders). **Larger initiative**: `--template epic.yml`; child issues reference the epic number.
- **Bug fix**: `--template bug_report.yml` (reproduction, expected vs. actual, component, logs). Reuse an existing issue; never file a duplicate.
- Link the work with `Fixes #<n>` / `Relates to #<n>` in commits and the PR ([`.github/pull_request_template.md`](.github/pull_request_template.md)); keep the issue current. Feature and bug work only: `chore`/`docs`/`refactor` need no issue.

## MANDATORY: Worktree-Based Feature Development

The main checkout stays on `main`. Every feature or fix is developed in a Git worktree.

- Worktrees live under `worktrees/<short-name>` (git-ignored, flat names); branches are `<type>/<short-name>` (`feat/`, `fix/`). The **main agent** creates them after the issue exists: `git worktree add worktrees/<short-name> -b <type>/<short-name>`.
- All development and commits happen inside the worktree. To finish: commit, then `git worktree remove worktrees/<short-name>`; the branch remains for the PR.
- Never check out a feature branch or work on a feature in the main checkout. One worktree per branch; reuse an existing one.
- **Exception**: in a cloud session, or whenever the environment has already put you on a designated branch, work on the branch the session designates instead of creating a worktree.

## MANDATORY: Claude Git Rules — Commit, Then Always Open a PR

Create clean, frequent commits, then land the work through a pull request. Assume the branch already exists and is checked out; subagents never create branches.

**Every change ships as a PR. Never merge to `main` by pushing to it** (`main` is only written by a merge). Every change, however small, and whether or not the request mentions one, is a PR against `main`; do not wait to be asked (the ask is standing). The order is fixed:

1. Commit the work in slices.
2. Push the branch (`git push -u origin <branch>`).
3. Open the PR against `main`, filling in `.github/pull_request_template.md` and linking its issue (`Fixes #123` / `Relates to #123`).
4. Merge once CI is green and nothing is outstanding.

- **Green first, merge second.** Merge when checks pass and review threads are answered, never by disabling, skipping or quarantining a check. If a check is red for a reason this diff did not cause, say so on the PR.
- **A merged PR is finished.** Follow-up work is a fresh branch off the updated `main` and a new PR; never push onto a merged branch.
- **Commit early, commit often**: small, coherent, one intent per commit. No unrelated refactors, repo-wide formatting or dependency upgrades. If the diff feels big, split it sooner.
- **Include** the code and tests of one feature area, the minimal config to run/build/test, and small related refactors. **Mixed changes**: revert accidental unrelated edits before committing, or split them into their own commit.
- **A behaviour change carries its tests** in the same commit or the next one.
- **Format** (Conventional Commits): `<type>(<scope>): <short imperative summary>`. Types: `feat`, `fix`, `refactor` (no behaviour change), `test`, `docs`, `chore`. Scopes: `api` `web` `db` `infra` `auth` `chat` `ui` `core` `jobs` `docs` `tests` `ai` `cli`.
- **Cadence**: scaffold, core slice, edge cases and validation, tests, cleanup, docs (only if the task needs it).
- **Sequence**: `git status`, `git diff`, stage intentionally (`git add -p` or named files), `git commit`, `git status`.
- **Tests not run**: still commit, and say so in the body (`Notes: tests not run (DB env not available).`).

## MANDATORY: CLI Version Bump on Improvement

Every improvement to the CLI (`apps/cli`, `install.sh`, `apps/cli/bootstrap-vps.sh`) bumps the version in `apps/cli/package.json`, the only place it lives (`CLI_VERSION` is recorded in deployment state, `deploy-info/info.json` and every request's User-Agent).

- PATCH by default; MINOR for a new command or subcommand. **One bump per PR**, not per commit.
- Then run `npm install --package-lock-only` so the lockfile's `apps/cli` entry matches; the bump is incomplete without it.
- Detail and the deploy pointers: [apps/cli/AGENTS.md](apps/cli/AGENTS.md).

## MANDATORY: Settings UI Pattern

Every settings surface, admin or per-user, is a **registry-driven hub**, not a tab strip and not an ungoverned route. Rationale and rejected alternatives: [docs/specs/settings-ui.md](docs/specs/settings-ui.md); web specifics (the five gates in detail): [apps/web/AGENTS.md](apps/web/AGENTS.md).

1. **Every new settings page is declared in a section registry.** Admin cards: `apps/web/src/config/adminSections.tsx` (`ADMIN_SECTIONS`, `SettingsCardDef`); per-user cards: `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`). A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver would disagree about it.
2. **A settings page is never added as a new tab on an existing settings page.** Tabs are legitimate only **inside** one destination, for genuinely **parallel** content (live example: `apps/web/src/identity/UsersPage.tsx` with `apps/web/src/identity/usersPageSlots.ts`, the packaged Users and Allowlist page plus KVox's Reminders tab). A destination gate is about reachability; a tab gate is about content. Tabs are permitted, never required.
3. **The card's `permission` is the exact string the API controller enforces**, never invented or approximated:
   - `system_settings:read` / `:write` → `system-settings.controller.ts`; `system_settings:read` → `about.controller.ts` (deliberately no `about:read`)
   - `users:read` → the platform's users controller (`GET /api/users`, `@marinoscar/platform-api/identity`)
   - `allowlist:read` → the platform's allowlist controller and KVox's `apps/api/src/allowlist-reminders/allowlist-reminders.controller.ts` (gates content inside Users & Allowlist, not the route)
4. **New settings surfaces reuse the packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`).** Never fork or copy it, and never re-add an app-local copy under `apps/web/src/components/settings/`. `/settings` (`apps/web/src/pages/UserSettingsHubPage.tsx`) is a 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`) over the component `/admin/settings` uses.
5. **The five coupled breakpoint gates move together or not at all**; never change one without checking all five: (1) `Layout.tsx` `showRail` (`up('sm')`), (2) `BottomNav` `down('sm')` self-gate, (3) `<main>` `pb: { xs: 10, sm: 3 }` in `Layout.tsx`, (4) the packaged `SettingsHub` `isCompactWindow` (`@marinoscar/platform-web/settings/ui`), (5) `AppBar.tsx` `isCompactWindow`. The boundary is `sm` (600px), never `md` (900px). No shared constant binds them, deliberately. `LibraryPageFrame.tsx` also reads `down('sm')` but is **not** a sixth gate.

## MANDATORY: Every Long-Running Activity Is a Queue Job

Design and the full exemption list: [docs/specs/job-queue.md §7.10](docs/specs/job-queue.md#710-all-long-running-work-is-a-job--the-rule-the-exemptions-the-limit). The queue and the worker-node fleet are the platform's (`@marinoscar/platform-api/jobs` and `/nodes`); KVox owns the handlers and the type table. Recipe: the [`add-job-type` skill](.claude/skills/add-job-type/SKILL.md) (OpenCode twin: `.opencode/skills/add-job-type/SKILL.md`); the handler contract is the TSDoc of `JobHandler` in the installed package.

1. **No long-running work outside the queue.** Anything that outlives the HTTP request or cron tick that started it is a registered `JobHandler` with a declared `type`, enqueued through `JobsService`. A detached `void this.doX()`, an `@OnEvent` body that downloads or spawns, and a `@Cron` body that works inline are violations. A `@Cron` only decides whether work is due and enqueues it: helper `enqueueHousekeepingJob` from `@marinoscar/platform-api/jobs`, reference `apps/api/src/transcripts/tasks/transcripts-housekeeping.task.ts`. Every enqueue passes `orgId` explicitly (`null` for housekeeping and system jobs; the default organization's id for a job whose handler touches `storage_objects`).
   - Exactly **three permanent exemptions**: the platform's `JobStuckResetTask` (lease reaper), `TempFileJanitorTask` (sweeps this process's local disk) and `NodeSecretSweepTask` (revokes credentials brokered to nodes), all in `@marinoscar/platform-api` (`jobs/tasks/`, `nodes/tasks/`).
   - Executable form: the `cron-enqueue-only` suite of `runPlatformConformance()`, run by `apps/api/test/conformance.spec.ts`. A fourth exemption requires a platform change and the spec section.
   - Not covered: fire-and-forget `this.notifications.notify(...)`.
2. **Node eligibility is the default posture.** A new job type SHOULD carry `nodeResultSchema` + `persistNodeResult` unless it cannot (writes as it goes, reads several tables mid-computation, needs a privilege a remote machine must never hold; database restore is server-only). Eligibility is **derived** from those two members; there is no `nodeEligible` flag (`JobHandler` in `@marinoscar/platform-api/jobs`). A deployment declines offload with a system setting read at claim time (`NodeOffloadService.offeredTypes()`, a handler's `nodeOffloadEnabled()`), never by editing the handler.
3. **A node never persists a job-scoped credential.** Every per-job secret is issued through `POST /api/nodes/:id/jobs/:jobId/secret`, gated by `assertJobHeldByNode`, bounded by the job's lease, held in node memory only, revoked when the job settles or by the sweep. `job_node_secrets` stores the credential's **handle**, never material. A handler declares the need with `nodeSecretBroker` (`JobSecretBroker` in `@marinoscar/platform-api/jobs`). The node's own `nod_` identity token is the single exception.
4. **A job type declares its execution profile or takes the global default.** `JobHandler.profile` is optional and carries exactly `{ maxRuntimeMs, maxAttempts }` (`JobExecutionProfile` in `@marinoscar/platform-api/jobs`). Lease, renewal interval and reaper patience derive from `maxRuntimeMs`. Never add `leaseMs` or `heartbeatMs`.

## MANDATORY: Invariants that are easy to break

Each is enforced by a test or a spec; detail lives in the linked doc.

- **Raw-SQL indexes are intentional schema drift.** Partial unique, trigram, HNSW and GiST indexes exist only in `migration.sql`, never in `schema.prisma`: `jobs_active_dedup_uniq_idx`, `database_backup_runs_active_uniq_idx`, `transcript_speakers_transcript_id_label_key`, `kg_relations_speaker_link_uniq_idx`, `kg_items_live_statement_uniq_idx`, the `kg_proposals` partials, `ask_messages_one_running_turn_uniq_idx`, plus the `pg_trgm`/HNSW/GiST indexes. Never "fix" one with `@@unique` or a `findFirst` pre-check. Table inventory: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Search vectors are `GENERATED ALWAYS ... STORED` columns, never triggers** (a trigger does not fire under `pg_restore`): [docs/specs/search.md](docs/specs/search.md).
- **A backup archive is never buffered**: `pg_dump` streams into object storage; the upload and the dump's exit code are both awaited. **No restore pre-flight may create, drop or rename anything**; the cluster admin connection lives outside the Prisma pool ([database-backup](docs/specs/database-backup.md), [database-restore](docs/specs/database-restore.md)).
- **`notify()` runs after the triggering write commits, outside any `$transaction`** ([recipe](.claude/skills/add-notification/SKILL.md)). Email, notifications, broadcasts and Web Push are platform slices; KVox registers events in `apps/api/src/notifications-registry/` (`registerNotification`) and templates in `apps/api/src/email-templates/`. Event keys, channel ids and template names are persisted: never rename one.
- **A job `type` string is permanent** once jobs of that type exist.
- **`apps/api/src/transcripts/editing/` stays pure** (no `PrismaService`, no `@Injectable`, no `randomUUID()` in a reducer), so `materialize()` replays through the same functions as live edits ([transcription §4](docs/specs/transcription.md)).
- **Every graph write goes through `GraphWriteService`** (`apps/api/src/graph/write/`); the sole exception is `kg.migrate`. The deferred `kg_assert_has_evidence` trigger refuses an accepted/edited row with no evidence at `COMMIT` (no orphans) ([ontology](docs/specs/ontology.md)). Nothing enters the graph except through a reviewed proposal's commit (named exceptions: speaker naming, manual entity edit); retrieval never answers from the graph alone.
- **A `sensitive` PersonFact never leaves the deployment**, for any purpose or setting; it is never bulk-accepted, bulk-imported or exported.
- **AI keys are per user** in `user_ai_credentials` (cascade on user delete), never in `credentials`, never a deployment-wide fallback. **AI jobs** (`note.generate`, `kg.*`, `ask.respond`, `transcript.name_check`) are **server-only** permanently: no vendor offers a job-scoped sub-key to broker.
- **There is no `*:read_any` for transcripts, notes or the graph**; no access answers **404, never 403**.

## Architecture principles

1. **Separation of concerns**: the UI presents; the API handles all business logic and authorization.
2. **Same-origin hosting**: UI at `/`, API at `/api`, API reference (Scalar) at `/api/docs`.
3. **Security by default**: every endpoint requires authentication unless explicitly public.
4. **API-first**: all business logic lives in the API layer.

## Security guidelines

- Secrets come from environment variables (`infra/compose/.env.example`), never from code. Runtime-configured credentials are encrypted with `SECRETS_ENCRYPTION_KEY` and stored in the database.
- JWT access tokens are short-lived (15 min); refresh tokens are HttpOnly cookies, rotated on use.
- Validate input on every endpoint. Uploads: size and type limits, randomized filenames.
- The email allowlist restricts access; `INITIAL_ADMIN_EMAIL` always bypasses it.
- Identity (sign-in, sessions, PATs, the device flow, users, the allowlist) is the platform's slice, mounted in `apps/api/src/platform/identity/`; KVox has no auth code of its own. `admin` is a **system** role; `org_admin`, `contributor` and `viewer` are **org** roles held on a membership, and KVox's domain permissions (`transcripts:*`, `notes:*`, `note_templates:*`, `graph:*`) are org-scoped, declared in `apps/api/src/app-registrations/permissions.ts`. Every route carries `@Auth(...)` or `@Public()` from `@marinoscar/platform-api/identity`.

## Environment variables

- [`infra/compose/.env.example`](infra/compose/.env.example) is the reference; prose per variable: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Do not duplicate either.
- `DATABASE_URL` is built at runtime from `POSTGRES_*`: use `npm run prisma:*`, never bare `npx prisma`.
- **Never add a second commented `# MAINTENANCE_MODE=` line** (or any illustrative `# KEY=value`) to `.env.example`: the CLI's `parseEnvExample` reads any commented `# KEY=value` as a declared variable and fails the env-spec test. Describe values as prose.
- A runtime-configured feature (transcription, AI, VAPID keys, SMTP, object storage) gets no environment variable.

## Key commands

```bash
cp infra/compose/.env.example infra/compose/.env       # once
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up
#   add -f devdb.compose.yml for a local Postgres, -f otel.compose.yml for Uptrace (:14318)
#   prod: -f base.compose.yml -f prod.compose.yml
npm test --workspace=api                    # unit + mocked integration
npm run test:db --workspace=api             # real-Postgres tier (*.db.spec.ts)
npm run test:run --workspace=web            # also --workspace=cli
npm run typecheck --workspace=api           # also web, cli
npm run openapi:dump && npm run openapi:lint    # after route changes
cd apps/api && npm run prisma:generate      # after schema changes
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name>
cd apps/api && npm run prisma:migrate       # apply (production)
```

Service URLs (dev): app http://localhost:3535 (Nginx); API reference http://localhost:3535/api/docs; Uptrace http://localhost:14318.

## Testing requirements

- Unit tests for isolated logic (services, guards, validators); integration tests for API + DB + RBAC flows; frontend component and hook tests; mock OAuth in CI. Details: [docs/TESTING.md](docs/TESTING.md).

## Subagents

Delegate development work to the matching agent in the tool's agents folder: `.opencode/agents/` for OpenCode, `.claude/agents/` for Claude Code. Agents: `backend-dev` (API), `frontend-dev` (React, MUI), `database-dev` (schema, migrations), `testing-dev` (tests), `docs-dev` (docs), `ops-dev` (container rebuilds, migrations, typecheck). Multi-domain work runs them in sequence (database, backend, frontend, testing, docs). Do not write controllers, services, components, Prisma schema, migrations, tests or docs directly; reading, planning and simple commands are fine. `ops-dev` never performs state-changing git operations (pull, merge, push, commit, worktree or branch management); the main agent does those.
