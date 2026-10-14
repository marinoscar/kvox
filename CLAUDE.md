# CLAUDE.md

@AGENTS.md

Claude Code loads the shared rules above (project overview, structure, every MANDATORY section, key commands) from [AGENTS.md](AGENTS.md). This file adds only what is specific to Claude Code: the full documentation table, the subagent delegation rules and the cloud-session exception. How Claude Code and OpenCode share these files: [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md).

## Cloud sessions

The worktree rule in AGENTS.md has an exception: when the environment has already put you on a designated branch (for example a cloud session), work there instead of creating a worktree. The pull request rule still applies: open a PR against `main` when the work is committed and pushed, without waiting to be asked.

## Where things are documented

Full index with a doc map by task: [docs/README.md](docs/README.md). Read by section (`grep -n '^#'`, then `offset`/`limit`), never whole.

| Topic | Read |
|---|---|
| Architecture, subsystem map; table inventory (§6.4), RBAC and permission catalog (§7.3), API architecture, frontend and navigation destinations (§9.6), job queue and worker fleet (§12), testing architecture, agent model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Security design: authentication, credential kinds, sessions, email allowlist, encryption of stored credentials | [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) |
| API conventions (auth, response envelope, errors, pagination, ETags, SSE) and the endpoint reference; generated reference at `/api/docs` | [docs/API.md](docs/API.md) |
| Dev loop, Fastify/Prisma/Passport gotchas, debugging, environment variables | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Testing (tiers, helpers, real-database specs, replay harnesses, e2e) | [docs/TESTING.md](docs/TESTING.md) |
| Renaming a fork | [docs/RENAMING.md](docs/RENAMING.md) |
| Device authorization (RFC 8628) and personal access tokens | [docs/DEVICE-AUTH.md](docs/DEVICE-AUTH.md), [docs/personal-access-tokens.md](docs/personal-access-tokens.md) |
| Spec: settings UI (registry hub, rejected alternatives, accessibility, the five breakpoint gates) | [docs/specs/settings-ui.md](docs/specs/settings-ui.md) |
| Spec: UX refresh (navigation destinations, bottom bar, rail, Console mode) | [docs/specs/ux-refresh.md](docs/specs/ux-refresh.md) |
| Spec: background job queue (claim, lease, profile, the rule and its exemptions: §7.10) | [docs/specs/job-queue.md](docs/specs/job-queue.md) |
| Spec: worker nodes (registration, claim/lease, data plane, job secrets, fleet health) | [docs/specs/worker-nodes.md](docs/specs/worker-nodes.md), [docs/deployment/worker-nodes.md](docs/deployment/worker-nodes.md), [docs/runbooks/node-job-secrets.md](docs/runbooks/node-job-secrets.md) |
| Spec: audio transcription (state machines, provider contract, pipeline job types, correction operation log, versions, shares, exports) | [docs/specs/transcription.md](docs/specs/transcription.md), [docs/specs/transcript-export.v1.schema.json](docs/specs/transcript-export.v1.schema.json) |
| Spec: AI name correction for transcripts (keyterms, `transcript.name_check`) | [docs/specs/transcript-name-correction.md](docs/specs/transcript-name-correction.md) |
| Spec: notes, note templates, AI settings and the AI layer (bring-your-own-key, token budget, streaming, exports, task models) | [docs/specs/notes.md](docs/specs/notes.md), [docs/runbooks/ai-provider-keys.md](docs/runbooks/ai-provider-keys.md) |
| Spec: connected knowledge (ontology, `kg_*` tables, extraction, resolution, review and commit, graph explorer, Ask agent, RDF export/import) | [docs/specs/ontology.md](docs/specs/ontology.md), [docs/runbooks/ontology-migration.md](docs/runbooks/ontology-migration.md) |
| Spec: full-text and hybrid search | [docs/specs/search.md](docs/specs/search.md) |
| Spec: first-run onboarding (derived checklist, user and admin steps) | [docs/specs/onboarding.md](docs/specs/onboarding.md) |
| Spec: deleting your own data (Danger Zone, `user.data.purge`, scope matrix) | [docs/specs/user-data-deletion.md](docs/specs/user-data-deletion.md) |
| Spec: browser notifications and Web Push; VAPID runbook | [docs/specs/browser-notifications.md](docs/specs/browser-notifications.md), [docs/runbooks/vapid-keys.md](docs/runbooks/vapid-keys.md) |
| Spec: admin notification broadcasts | [docs/specs/notification-broadcasts.md](docs/specs/notification-broadcasts.md) |
| Spec: database backup; PostgreSQL client version runbook | [docs/specs/database-backup.md](docs/specs/database-backup.md), [docs/runbooks/postgres-client-version.md](docs/runbooks/postgres-client-version.md) |
| Spec: database restore; restore runbook (usable with the app down) | [docs/specs/database-restore.md](docs/specs/database-restore.md), [docs/runbooks/database-restore.md](docs/runbooks/database-restore.md) |
| Spec: maintenance mode; runbook | [docs/specs/maintenance-mode.md](docs/specs/maintenance-mode.md), [docs/runbooks/maintenance-mode.md](docs/runbooks/maintenance-mode.md) |
| Spec: VPS deploy (`kvox deploy`, deploy-info schema, uninstall, update adoption) and the operator runbook | [docs/specs/vps-deploy.md](docs/specs/vps-deploy.md), [docs/specs/deploy-spec.md](docs/specs/deploy-spec.md), [docs/deployment/vps.md](docs/deployment/vps.md) |
| Runbooks (operator procedures): secrets-key rotation, S3 CORS | [docs/runbooks/rotate-secrets-encryption-key.md](docs/runbooks/rotate-secrets-encryption-key.md), [docs/runbooks/s3-cors.md](docs/runbooks/s3-cors.md); all runbooks: [docs/README.md#runbooks](docs/README.md#runbooks) |
| `kvox` CLI: usage, install, flags, CI setup, `deploy`, `node` command reference | [apps/cli/README.md](apps/cli/README.md) |
| Recipe: add a job type (live node-eligible example, optional members) | [apps/api/src/jobs/handlers/README.md](apps/api/src/jobs/handlers/README.md) |
| Recipe: add a notification (event, templates, `notify()` call site) | [apps/api/src/notifications/README.md](apps/api/src/notifications/README.md) |
| Release history, product vision | [CHANGELOG.md](CHANGELOG.md), [VISION.md](VISION.md) |

## Specialized Subagents (MANDATORY)

Delegate development work to the matching subagent in `.claude/agents/`. Each agent carries its domain's rules and points to the docs that own the details, so delegation keeps patterns consistent. Do not attempt development tasks directly.

| Agent | Domain | MUST use for |
|---|---|---|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **Any** backend code: endpoints, services, guards, middleware, JWT, OAuth |
| `frontend-dev` | React, MUI, TypeScript | **Any** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **Any** database work: schema changes, migrations, seeds, queries |
| `testing-dev` | Jest/Supertest (API), Vitest/RTL (web, CLI) | **Any** testing: unit, integration, typecheck, fixtures |
| `docs-dev` | Technical documentation | **Any** documentation: ARCHITECTURE.md, SECURITY-ARCHITECTURE.md, API.md, README, specs, runbooks |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck |

Delegation rules:

1. Backend code changes -> `backend-dev`.
2. Frontend code changes -> `frontend-dev`.
3. Database/Prisma changes -> `database-dev`.
4. Writing or updating tests -> `testing-dev`.
5. Documentation updates -> `docs-dev`.
6. Routine ops (container rebuilds, migrations, typecheck) -> `ops-dev`. `ops-dev` must **never** perform state-changing git operations (pull, merge, push, commit, worktree or branch management); the main agent does those, and `ops-dev` refuses them.

Multi-domain tasks invoke several agents in sequence, for example a new user preference: `database-dev` (migration) -> `backend-dev` (endpoint) -> `frontend-dev` (UI) -> `testing-dev` (tests) -> `docs-dev` (docs).

```
"Use backend-dev to implement the user settings endpoint"
"Use frontend-dev to create the theme toggle component"
"Use database-dev to add an audit_events table migration"
"Use testing-dev to write integration tests for auth"
"Use docs-dev to update SECURITY-ARCHITECTURE.md with the new auth flow"
"Use ops-dev to rebuild the api container and run migrations"
```

### What You Should NOT Do Directly

Do not write NestJS controllers, services or guards, React components or pages, Prisma schema or migrations, Jest/Vitest/RTL tests, or documentation files without the matching agent. The only exceptions:

- Reading files to understand context.
- Answering questions about the codebase.
- Planning and coordinating between agents.
- Running simple commands (`git status`, `npm install`, etc.).
