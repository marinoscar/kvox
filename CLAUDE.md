# CLAUDE.md

@AGENTS.md

Claude Code loads the shared rules above (project overview, structure, every MANDATORY section, key commands) from [AGENTS.md](AGENTS.md). Area rules load from the nested `AGENTS.md` of the folder you work in (`apps/api`, `apps/web`, `apps/cli`). This file adds only what is specific to Claude Code: the documentation table, the subagent delegation rules and the cloud-session exception. How Claude Code and OpenCode share these files: [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md).

## Cloud sessions

The worktree rule in AGENTS.md has an exception: in a cloud session, or whenever the environment has already put you on a designated branch, work on the branch the session designates instead of creating a worktree. The PR rules still apply: commit in slices, push that branch, open the PR against `main`.

## Where things are documented

Full index with a "Doc map by task": [docs/README.md](docs/README.md). Read docs by section (`grep -n '^#'`, then offsets); `docs/API.md` is 340 KB.

| Topic | Read |
|---|---|
| Architecture, subsystem map, permission catalog and roles, table inventory, navigation destinations, admin settings groups, job-queue and worker-fleet architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Security design, email allowlist, sessions, secrets | [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) |
| Endpoint reference (one `###` group per area: auth, users, settings, storage, jobs, nodes, transcripts, notes, graph, Ask, ...) | [docs/API.md](docs/API.md) |
| Dev loop, environment variables, debugging | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Testing tiers, helpers, fixtures | [docs/TESTING.md](docs/TESTING.md) |
| Renaming a fork | [docs/RENAMING.md](docs/RENAMING.md) |
| Device authorization and personal access tokens | [docs/DEVICE-AUTH.md](docs/DEVICE-AUTH.md), [docs/personal-access-tokens.md](docs/personal-access-tokens.md) |
| Spec: transcription (pipeline, state machines, editing and versions, exports) | [docs/specs/transcription.md](docs/specs/transcription.md), [docs/specs/transcript-export.v1.schema.json](docs/specs/transcript-export.v1.schema.json) |
| Spec: AI name correction for transcripts | [docs/specs/transcript-name-correction.md](docs/specs/transcript-name-correction.md) |
| Spec: notes, note templates and the AI layer | [docs/specs/notes.md](docs/specs/notes.md) |
| Spec: ontology, connected-knowledge graph, Ask agent, explorer | [docs/specs/ontology.md](docs/specs/ontology.md) |
| Spec: search | [docs/specs/search.md](docs/specs/search.md) |
| Spec: onboarding | [docs/specs/onboarding.md](docs/specs/onboarding.md) |
| Spec: user-data deletion (Danger Zone) | [docs/specs/user-data-deletion.md](docs/specs/user-data-deletion.md) |
| Spec: browser notifications and Web Push | [docs/specs/browser-notifications.md](docs/specs/browser-notifications.md) |
| Spec: admin broadcasts | [docs/specs/notification-broadcasts.md](docs/specs/notification-broadcasts.md) |
| Spec: background job queue (rule 1 to 4 rationale: §7.10) | [docs/specs/job-queue.md](docs/specs/job-queue.md) |
| Spec: worker nodes | [docs/specs/worker-nodes.md](docs/specs/worker-nodes.md) |
| Spec: database backup and restore | [docs/specs/database-backup.md](docs/specs/database-backup.md), [docs/specs/database-restore.md](docs/specs/database-restore.md) |
| Spec: maintenance mode | [docs/specs/maintenance-mode.md](docs/specs/maintenance-mode.md) |
| Spec: VPS deploy (design, deploy-info schema, uninstall, update) | [docs/specs/vps-deploy.md](docs/specs/vps-deploy.md), [docs/specs/deploy-spec.md](docs/specs/deploy-spec.md) |
| Spec: settings UI (registry-driven hub, the five gates) | [docs/specs/settings-ui.md](docs/specs/settings-ui.md) |
| Spec: UX refresh (destinations, navigation) | [docs/specs/ux-refresh.md](docs/specs/ux-refresh.md) |
| Deployment guides (VPS, worker nodes) | [docs/deployment/vps.md](docs/deployment/vps.md), [docs/deployment/worker-nodes.md](docs/deployment/worker-nodes.md) |
| Runbooks (operator procedures) | [docs/README.md#runbooks](docs/README.md#runbooks) |
| Runbooks: database restore, maintenance mode, node job secrets, ontology migration | [docs/runbooks/database-restore.md](docs/runbooks/database-restore.md), [docs/runbooks/maintenance-mode.md](docs/runbooks/maintenance-mode.md), [docs/runbooks/node-job-secrets.md](docs/runbooks/node-job-secrets.md), [docs/runbooks/ontology-migration.md](docs/runbooks/ontology-migration.md) |
| Runbooks: VAPID keys, AI provider keys, secrets-encryption key rotation, object storage configuration, S3 CORS, Postgres client version | [docs/runbooks/vapid-keys.md](docs/runbooks/vapid-keys.md), [docs/runbooks/ai-provider-keys.md](docs/runbooks/ai-provider-keys.md), [docs/runbooks/rotate-secrets-encryption-key.md](docs/runbooks/rotate-secrets-encryption-key.md), [docs/runbooks/storage-configuration.md](docs/runbooks/storage-configuration.md), [docs/runbooks/s3-cors.md](docs/runbooks/s3-cors.md), [docs/runbooks/postgres-client-version.md](docs/runbooks/postgres-client-version.md) |
| `kvox` CLI usage, install, CI setup, `deploy` and `node` command reference | [apps/cli/README.md](apps/cli/README.md) |
| Recipe: add a job type (the queue and node fleet are `@marinoscar/platform-api/jobs` and `/nodes`; contract in the package README and TSDoc) | [.claude/skills/add-job-type/SKILL.md](.claude/skills/add-job-type/SKILL.md) |
| Recipe: add a notification (event in `notifications-registry/`, template in `email-templates/`, `notify()` after commit) | [.claude/skills/add-notification/SKILL.md](.claude/skills/add-notification/SKILL.md) |
| Area rules (API, web, CLI) | [apps/api/AGENTS.md](apps/api/AGENTS.md), [apps/web/AGENTS.md](apps/web/AGENTS.md), [apps/cli/AGENTS.md](apps/cli/AGENTS.md) |
| How Claude Code and OpenCode share these files, local-model setup, guard specs | [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md) |

## Specialized Subagents (MANDATORY)

Delegate development work to the matching subagent in `.claude/agents/`. Each agent carries its domain's rules and points to the docs that own the details, so delegation keeps patterns consistent.

| Agent | Domain | MUST use for |
|---|---|---|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **Any** backend code: endpoints, services, guards, middleware, JWT, OAuth, job handlers |
| `frontend-dev` | React, MUI, TypeScript | **Any** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **Any** database work: schema, migrations, seeds, queries |
| `testing-dev` | Jest/Supertest (API), Vitest/RTL (web, CLI) | **Any** testing: unit, integration, typecheck, fixtures |
| `docs-dev` | Technical documentation | **Any** documentation: ARCHITECTURE.md, SECURITY-ARCHITECTURE.md, API.md, README, specs, runbooks |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck |

Delegation rules:

1. Backend code changes → `backend-dev`.
2. Frontend code changes → `frontend-dev`.
3. Database/Prisma changes → `database-dev`.
4. Writing or updating tests → `testing-dev`.
5. Documentation updates → `docs-dev`.
6. Routine ops (container rebuilds, migrations, typecheck) → `ops-dev`. `ops-dev` must **never** perform state-changing git operations (pull, merge, push, commit, worktree or branch management); the main agent does those, and `ops-dev` refuses them.

Multi-domain tasks invoke several agents in sequence, for example a new user preference setting: `database-dev` (migration) → `backend-dev` (endpoint) → `frontend-dev` (UI) → `testing-dev` (tests) → `docs-dev` (docs).

```
"Use backend-dev to implement the user settings endpoint"
"Use testing-dev to write integration tests for auth"
"Use ops-dev to rebuild the api container and run migrations"
```

Do not write controllers, services, guards, components, Prisma schema, migrations, tests or documentation directly. The only exceptions:

- Reading files to understand context.
- Answering questions about the codebase.
- Planning and coordinating between agents.
- Running simple commands (`git status`, `npm install`, etc.).
