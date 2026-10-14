# AGENTS.md

Shared rules for AI assistants working on this codebase (loaded by OpenCode, and by Claude Code through `CLAUDE.md`). Area rules live in nested `AGENTS.md` files: `apps/api`, `apps/web`, `apps/cli`. How the tools share files: [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md).

## Project overview

Web application foundation: React UI + Node API + PostgreSQL, with OAuth authentication, RBAC, a settings framework, a background job queue with remote worker nodes, and an AI-backed transcription, notes and knowledge-graph product on top.
Stack: Node.js + TypeScript; NestJS on Fastify + Prisma + Zod (API); React + MUI, sigma.js + graphology for the graph explorer (web); Commander + ink (`kvox` CLI); PostgreSQL; Passport (Google OAuth required); Nginx same-origin; OpenTelemetry, Uptrace, Pino; Docker Compose. Tests: Jest + Supertest (API), Vitest + React Testing Library (web), Vitest (CLI).
Three apps (`apps/api`, `apps/web`, `apps/cli`) and one package, `packages/shared` (product identity and the ontology definition). Start at [README.md](README.md) and [docs/README.md](docs/README.md).

## Repository structure

```
apps/api/           NestJS API: src/, test/, prisma/ (schema.prisma, migrations/, seed), Dockerfile
apps/web/           React app: src/, src/__tests__/, Dockerfile
apps/cli/           `kvox` CLI: src/commands/, src/tui/ (ink menu), README.md, bootstrap-vps.sh
packages/shared/    identity.json; ontology sources (src/ontology/) and COMMITTED compiled output (ontology/)
docs/               ARCHITECTURE, API, SECURITY-ARCHITECTURE, DEVELOPMENT, TESTING; specs/, runbooks/, deployment/
infra/compose/      base, dev, devdb, prod, otel, test, vps, worker, worker.build .compose.yml; .env.example
infra/nginx/, infra/otel/   Nginx routing; OTEL Collector + Uptrace config
tests/e2e/          optional E2E tests
install.sh          CLI installer (with apps/cli/bootstrap-vps.sh)
worktrees/          git-ignored feature worktrees
```

## Where to read more

Full index: [docs/README.md](docs/README.md). The most used:

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (table inventory §6.4, permission catalog and RBAC §7.3, navigation destinations §9.6, job queue and worker fleet §12)
- API conventions and per-endpoint reference (also `/api/docs`): [docs/API.md](docs/API.md)
- Dev loop, gotchas, environment variables: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#environment-variables)
- Testing tiers and helpers: [docs/TESTING.md](docs/TESTING.md)
- Security design: [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md)
- Specs index (settings-ui, job-queue, worker-nodes, transcription, notes, ontology, ...): [docs/specs/](docs/specs/), listed in [docs/README.md](docs/README.md)
- Recipes: [add a job type](apps/api/src/jobs/handlers/README.md), [add a notification](apps/api/src/notifications/README.md)
- Runbooks: [docs/README.md#runbooks](docs/README.md#runbooks); `kvox` CLI: [apps/cli/README.md](apps/cli/README.md)

## Working with a small context window

- Read docs by section: `grep -n '^#' <file>` for headings, then Read with `offset`/`limit`.
- Never read `docs/ARCHITECTURE.md`, `docs/SECURITY-ARCHITECTURE.md`, `docs/API.md` or a spec whole.
- Use one subagent at a time; hand it the doc section to read, not the whole doc.
- Area rules are in the nested `AGENTS.md` of the folder you work in.

## MANDATORY: Issue-Driven Development (Traceability)

Every feature and bug fix is tracked by a GitHub issue, filed **before** implementation planning is finalized (features) or the fix starts (bugs), and before any worktree or branch is created. `gh issue create` inside the repo infers the repository.

- **New feature**: `gh issue create --template feature_request.yml` (real problem, solution, component, priority, not placeholders). **Larger initiative**: `--template epic.yml`; child issues reference the epic number.
- **Bug fix**: `--template bug_report.yml` (reproduction, expected vs. actual, component, logs). Reuse an existing issue; never file a duplicate.
- Link the work with `Fixes #<n>` / `Relates to #<n>` in commits and the PR; update or close the issue as the PR resolves it. Feature and bug work only; `chore`/`docs`/`refactor` need no issue.

## MANDATORY: Worktree-Based Feature Development

The main checkout stays on `main`. Every feature or fix is developed in a Git worktree.

- Worktrees live under `worktrees/<short-name>` (git-ignored, flat names); branches are `<type>/<short-name>`. The **main agent** creates them after the issue exists: `git worktree add worktrees/<short-name> -b <type>/<short-name>`.
- All development and commits happen inside the worktree. To finish: commit, then `git worktree remove worktrees/<short-name>`; the branch remains for the PR.
- Never check out a feature branch or work on a feature in the main checkout. One worktree per branch; reuse an existing one.
- **Exception**: when the environment has already put you on a designated branch (a cloud session), work there; do not create a worktree.

## MANDATORY: Claude Git Rules — Commit, Then Always Open a PR

Assume the branch already exists and is checked out; do not create branches. Every change, however small and whether or not the request mentions it, ships as a pull request against `main`. The ask is standing.

1. Commit the work in slices (rules below).
2. Push the branch: `git push -u origin <branch>`.
3. Open the PR against `main`, filling `.github/pull_request_template.md` and linking the issue (`Fixes #123` / `Relates to #123`).
4. Merge once CI is green and nothing is outstanding on it (review threads answered).

- **Never merge to `main` by pushing to it.** `main` is only written by a merge.
- **Green first, merge second.** Never disable, skip or quarantine a check to merge. If a check is red for a reason this diff did not cause, say so on the PR.
- **A merged PR is finished.** Follow-up work is a fresh branch off updated `main` and a new PR; never push onto a merged branch.
- **Commit early, commit often**: small, coherent, one intent per commit. No unrelated refactors, repo-wide formatting or dependency upgrades. If the diff feels big, you waited too long.
- **A behaviour change carries its tests** in the same commit or the next one.
- **Format** (Conventional Commits): `<type>(<scope>): <short imperative summary>`.
- Types: `feat`, `fix`, `refactor` (no behaviour change), `test`, `docs`, `chore`.
- Scopes: `api` `web` `db` `infra` `auth` `chat` `ui` `core` `jobs` `docs` `tests` `ai` `cli`.
- **Cadence**: scaffold or wiring, core slice, edge cases and validation, tests, cleanup, docs (only if the task needs them).
- **Sequence**: `git status`, `git diff`, stage intentionally (`git add -p` or named files), `git commit`, `git status`.
- **Tests not run** (missing env, tool unavailable): still commit and say so in the body (`Notes: tests not run (DB env not available).`).

## MANDATORY: CLI Version Bump on Improvement

Every improvement to the CLI (`apps/cli`, `install.sh`, `apps/cli/bootstrap-vps.sh`) bumps the version in `apps/cli/package.json`, the only place it lives (`apps/cli/src/package-info.ts` reads it and exports `CLI_VERSION`; never hardcode or import it elsewhere). It is recorded as `appctlVersion` in a deployment's state file, `deployedBy.version` in `deploy-info/info.json`, and the User-Agent on every API request.

- **PATCH** by default (`1.0.0` -> `1.0.1`); **MINOR** for a genuinely new command or subcommand.
- **One bump per PR**, not per commit.
- Regenerate the lockfile: `npm install --package-lock-only` (its `apps/cli` workspace entry carries the version). The bump is incomplete without it.

Detail: `apps/cli/AGENTS.md`.

## MANDATORY: Settings UI Pattern

Every settings surface, admin or per-user, is a **registry-driven hub**, not a tab strip and not an ungoverned route. Detail and history: [docs/specs/settings-ui.md](docs/specs/settings-ui.md); web specifics in `apps/web/AGENTS.md`.

1. **Every new settings page is declared in a section registry.** Admin cards: `apps/web/src/config/adminSections.tsx` (`ADMIN_SECTIONS`, entries are `SettingsCardDef`); per-user cards: `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`). A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver would disagree about it.
2. **A settings page is never added as a new tab on an existing settings page.** Tabs are legitimate only inside one destination, for genuinely **parallel** content (example: `apps/web/src/pages/Admin/UsersPage.tsx`, Users and Allowlist). A destination gate is about reachability; a tab gate is about content. Tabs are permitted, never required.
3. **The card's `permission` is the exact string the API controller enforces**, never invented or approximated:
   - `system_settings:read` / `:write` -> `system-settings.controller.ts`
   - `system_settings:read` -> `about.controller.ts` (About card; deliberately no `about:read`)
   - `users:read` -> `users.controller.ts`
   - `allowlist:read` -> `allowlist.controller.ts` (gates content inside the Users page, not the route)
4. **Reuse `apps/web/src/components/settings/SettingsHub.tsx`.** Never fork or copy it. `/settings` (`apps/web/src/pages/UserSettingsHubPage.tsx`) is a 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`) over the same component `/admin/settings` uses.
5. **The five coupled breakpoint gates move together or not at all:**
   1. `showRail` (`up('sm')`) in `apps/web/src/components/common/Layout.tsx`
   2. `BottomNav`'s own `down('sm')` self-gate, `apps/web/src/components/navigation/BottomNav.tsx`
   3. `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx`
   4. `SettingsHub.tsx`'s `isCompactWindow` (`down('sm')`)
   5. `apps/web/src/components/navigation/AppBar.tsx`'s `isCompactWindow` (`down('sm')`)

   The boundary is `sm` (600px), never `md` (900px). No shared constant binds them, deliberately. `components/library/LibraryPageFrame.tsx` also reads `down('sm')` but is **not** a sixth gate (it places one page's create action, never mounts chrome).

## MANDATORY: Every Long-Running Activity Is a Queue Job

Design: [docs/specs/job-queue.md](docs/specs/job-queue.md#710-all-long-running-work-is-a-job--the-rule-the-exemptions-the-limit).

1. **No long-running work outside the queue.** Anything that outlives the HTTP request or cron tick that started it is a registered `JobHandler` with a declared `type`, enqueued through `JobsService`. A detached `void this.doX()`, an `@OnEvent` body that downloads or spawns, and a `@Cron` body that works inline are violations. A `@Cron` only decides whether work is due and enqueues it: reference `apps/api/src/jobs/tasks/job-history-purge.task.ts`, helper `apps/api/src/jobs/housekeeping.enqueue.ts`.
   - Exactly three permanent exemptions: `apps/api/src/jobs/tasks/job-stuck-reset.task.ts` (lease reaper), `apps/api/src/jobs/tasks/temp-file-janitor.task.ts` (sweeps this process's local disk), `apps/api/src/nodes/tasks/node-secret-sweep.task.ts` (revokes credentials brokered to nodes; a wedged queue must not leak live credentials).
   - Executable form: `apps/api/test/jobs/cron-enqueue-only.spec.ts`. A fourth exemption requires editing both the spec and the test.
   - Not covered: fire-and-forget notification dispatch (`this.notifications.notify(...)`).
2. **Node eligibility is the default posture.** A new job type SHOULD carry `nodeResultSchema` + `persistNodeResult` unless it cannot (writes as it goes, reads several tables mid-computation, needs a privilege a remote machine must never hold; database restore is server-only). Eligibility is **derived** from those two members; there is no `nodeEligible` flag (`apps/api/src/jobs/job-handler.interface.ts`). A deployment declines offload with a system setting read at claim time (`NodeOffloadService.offeredTypes()`, a handler's `nodeOffloadEnabled()`), never by editing the handler.
3. **A node never persists a job-scoped credential.** Every per-job secret is issued through `POST /api/nodes/:id/jobs/:jobId/secret`, gated by `assertJobHeldByNode`, bounded by the job's lease, held in node memory only, revoked when the job settles or by the sweep. `job_node_secrets` stores the credential's **handle**, never material. A handler declares the need by carrying a `nodeSecretBroker` (`apps/api/src/jobs/job-secret-broker.ts`). The node's own `nod_` identity token is the single exception.
4. **A job type declares its execution profile or takes the global default.** `JobHandler.profile` is optional and carries exactly `{ maxRuntimeMs, maxAttempts }` (`apps/api/src/jobs/job-execution-profile.ts`). Lease, renewal interval and reaper patience derive from `maxRuntimeMs`. Never add `leaseMs` or `heartbeatMs`.

## MANDATORY: Invariants that are easy to break

Each has an owning doc; follow the link before touching the area.

- **Raw-SQL indexes are intentional schema drift.** Partial unique and expression/trigram/HNSW/GiST indexes exist only in `migration.sql` because Prisma cannot express them: `jobs_active_dedup_uniq_idx`, `database_backup_runs_active_uniq_idx`, `transcript_speakers_transcript_id_label_key`, `kg_relations_speaker_link_uniq_idx`, `kg_items_live_statement_uniq_idx`, the `kg_proposals` draft/extracting partials, `ask_messages_one_running_turn_uniq_idx`, `kg_entities_label_trgm_idx`, `kg_*_embedding_hnsw_idx`, `kg_relations_valid_gist_idx`. Never "fix" one with `@@unique` or a `findFirst` pre-check (cannot close the race). Index inventory: [ARCHITECTURE.md §6.4](docs/ARCHITECTURE.md).
- **`search_vector` and `title_search_vector` are `GENERATED ALWAYS ... STORED` columns, never trigger-maintained** (a trigger does not fire under `pg_restore`, leaving an empty index). Hand-written in `migration.sql`. [search.md](docs/specs/search.md).
- **A backup archive is never buffered**: `pg_dump` streams into object storage; the upload and the dump's exit code are both awaited. `database_backup_runs` is not a `jobs` row. [database-backup.md](docs/specs/database-backup.md).
- **No restore pre-flight may create, drop or rename anything**; the cluster admin connection lives outside the Prisma pool, on the `postgres` database. [database-restore.md](docs/specs/database-restore.md).
- **`notify()` runs after the triggering write commits, outside any `$transaction`**; use `notifyAddress()` for a recipient with no account. [notifications README](apps/api/src/notifications/README.md).
- **A job `type` string is permanent** once jobs of that type exist. `transcription.poll` re-enqueues itself, and broadcast fan-out chunks enqueue, with `skipDedup: true`, or the backoff is silently discarded. [handlers README](apps/api/src/jobs/handlers/README.md), [transcription.md](docs/specs/transcription.md).
- **`apps/api/src/transcripts/editing/` stays pure**: no `PrismaService`, no `@Injectable`, no `randomUUID()` in a reducer; `materialize()` replays the log through the same functions the live path uses. `find_replace` is expanded to concrete ops and server-chosen ids are fixed before anything is recorded. [transcription.md](docs/specs/transcription.md).
- **Every graph write goes through `GraphWriteService`** (`apps/api/src/graph/write/`); `kg.migrate` is the one sanctioned exception. An accepted/edited `kg_*` row always carries evidence (deferred trigger `kg_assert_has_evidence`; write subject and evidence in one transaction). Nothing enters the graph except through a reviewed proposal's commit (named exceptions: speaker naming, manual entity edit). Retrieval never answers from the graph alone. Edit ontology sources in `packages/shared/src/ontology/`, run `npm run build:ontology --workspace=@app/shared`, commit the compiled output in the same commit. [ontology.md](docs/specs/ontology.md).
- **A `sensitive` PersonFact never leaves this deployment**, for any purpose, under any setting; `personal`-domain types are dropped from Ask tools and digests the same way.
- **AI keys are per user, in `user_ai_credentials` (cascades on user delete), never in `credentials`.** There is no deployment-wide AI key. AI jobs (`note.generate`, `note.retitle`, `kg.*`, `ask.respond`, `transcript.name_check`) are server-only permanently, run on the caller's key, and `maxAttempts: 1` where a retry would re-bill; the rate-limit throttle key is per user (`aiProviderThrottleKey`). Over-budget prompts are refused with numbers, never truncated. [notes.md](docs/specs/notes.md).
- **Private rows answer 404, never 403** (transcripts, notes, graph, Ask). There is deliberately no `*:read_any` for them. Built-in note templates are the one 403 (their existence is public).
- **A stream is a view over durable state**: SSE (notes, Ask) reads the row the job writes append-only; correctness never depends on a connected client.
- **Adding a system-settings namespace costs six edits** (miss the wire DTOs and every PATCH is a silent no-op returning 200): see the header of `apps/api/src/common/schemas/settings-parity.spec.ts`; user settings: `user-settings-parity.spec.ts`. No API key ever lives in the `ai` namespace.
- **Permissionless `@Auth()` routes get a raw `AuthenticatedUser` with `permissions` undefined**; go through `normalizeCaller`/`toRequestUser` (see `apps/api/src/onboarding/onboarding.service.ts`). Onboarding completion is derived on every read, never stored; a step never issues its own query.
- **Bulk user-data deletion fans out to `transcript.purge`/`note.purge`/`kg.purge`, clears `Restrict` FKs first and never catches an FK violation.** [user-data-deletion.md](docs/specs/user-data-deletion.md).
- **Navigation**: `apps/web/src/config/destinations.ts` is the single source; the bottom bar holds at most four non-pinned destinations, and `pinned` means a mode (`settings`, `console`), not a peer. [ARCHITECTURE.md §9.6](docs/ARCHITECTURE.md), [ux-refresh.md](docs/specs/ux-refresh.md).

## Architecture principles

1. **Separation of concerns**: the UI handles presentation only; the API handles all business logic and authorization.
2. **Same-origin hosting**: UI at `/`, API at `/api`, API reference (Scalar) at `/api/docs`.
3. **Security by default**: every endpoint requires authentication unless explicitly public.
4. **API-first**: all business logic lives in the API layer.

## Security guidelines

- Secrets come from environment variables (`infra/compose/.env.example`), never from code.
- JWT access tokens are short-lived (15 minutes default); refresh tokens live in HttpOnly cookies and rotate on use.
- Validate input on every endpoint.
- File uploads: size and type limits, randomized filenames; profile images only.
- The email allowlist restricts access to pre-authorized users; `INITIAL_ADMIN_EMAIL` always bypasses it.
- Runtime-configured credentials (SMTP, transcription key, VAPID) are encrypted with `SECRETS_ENCRYPTION_KEY` in the `credentials` table. Design: [SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md).

## Environment variables

- [`infra/compose/.env.example`](infra/compose/.env.example) is the reference; prose for each group is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#environment-variables). Do not duplicate either.
- `DATABASE_URL` is built at runtime from `POSTGRES_*`: use `npm run prisma:*`, never bare `npx prisma`.
- **Never add a commented `# KEY=value` line (or any `# KEY=value` prose) to `.env.example`**: `apps/cli`'s `parseEnvExample` reads it as a declared variable and fails the env-spec test. Document `MAINTENANCE_MODE` values as prose; the file already has exactly one commented default for it.
- Features configured at runtime in the admin UI (AI policy, transcription provider, push keys, SMTP) get no environment variable. API-side variables are bare; only the CLI uses the `KVOX_` prefix.

## Key commands

```bash
cp infra/compose/.env.example infra/compose/.env
# From infra/compose (add -f devdb.compose.yml for local Postgres, -f otel.compose.yml for Uptrace)
docker compose -f base.compose.yml -f dev.compose.yml up
docker compose -f base.compose.yml -f prod.compose.yml up          # production mode
npm test --workspace=api                    # unit + mocked integration
npm run test:db --workspace=api             # real-Postgres tier
npm run test:run --workspace=web            # also --workspace=cli
npm run typecheck --workspace=api           # also web, cli
npm run openapi:dump && npm run openapi:lint
cd apps/api && npm run prisma:generate      # after schema changes
cd apps/api && npm run prisma:migrate:dev -- --name <name>   # new migration (dev)
cd apps/api && npm run prisma:migrate       # apply migrations (production)
```

## Service URLs (Development)

- Application: http://localhost:3535 (via Nginx)
- API reference (Scalar): http://localhost:3535/api/docs
- Uptrace: http://localhost:14318 (when the otel stack is running)

## Testing requirements

- Unit tests for isolated logic (services, guards, validators); integration tests for API + DB + RBAC flows with a test DB; frontend component and hook tests; mock OAuth in CI (no real Google dependency). Details: [docs/TESTING.md](docs/TESTING.md).

## Subagents

Delegate development work to the matching agent in the tool's agents folder: `.opencode/agents/` for OpenCode, `.claude/agents/` for Claude Code. Agents: `backend-dev` (API), `frontend-dev` (React, MUI), `database-dev` (schema, migrations), `testing-dev` (tests), `docs-dev` (docs), `ops-dev` (container rebuilds, migrations, typecheck). Multi-domain work runs them in sequence (database, backend, frontend, testing, docs). Do not write controllers, services, components, Prisma schema, migrations, tests or docs directly; reading, planning and simple commands are fine. `ops-dev` never performs state-changing git operations (pull, merge, push, commit, worktree or branch management); the main agent does those.
