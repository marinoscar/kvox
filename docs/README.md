# Documentation index

Every document in this repository, grouped by what you need it for. Links are relative to `docs/`.

- A **spec** (`specs/`) describes the design of one feature and serves as its reference: the model, the rules, and the rejected alternatives. It is written for developers extending the application.
- A **runbook** (`runbooks/`, plus the two guides in `deployment/`) is a step-by-step procedure for an operator running a deployment.
- A **recipe** lives next to the code it describes (see [Developer recipes in the code](#developer-recipes-in-the-code)).

## Read first

In this order:

1. [../README.md](../README.md): what the application is, what you get, how to start it.
2. [../AGENTS.md](../AGENTS.md): the rules every contributor and AI assistant follows, with a link to the doc that owns each detail.
3. [ARCHITECTURE.md](ARCHITECTURE.md): the system map, permission catalog, tables and job types.
4. [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md): authentication, credential kinds, RBAC, transport and data protection.
5. [DEVELOPMENT.md](DEVELOPMENT.md): the dev loop and the Fastify, Prisma and Passport gotchas.
6. [TESTING.md](TESTING.md): test layers, helpers and how to run each suite.

## Doc map by task

Find the right doc without loading the whole index. Read a doc by section (grep its headings, then read a range), never whole.

| Task | Read |
|---|---|
| Understand the system, permission catalog, tables, job types | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Auth, credential kinds, sessions, RBAC | [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) |
| Add or change an endpoint | [API.md](API.md), [../apps/api/AGENTS.md](../apps/api/AGENTS.md), then `/api/docs` (OpenAPI) |
| Run the dev loop, change the database | [DEVELOPMENT.md](DEVELOPMENT.md), [../apps/api/AGENTS.md](../apps/api/AGENTS.md) |
| Change the schema (fragments, platform migrations, drift allowlist) | [DEVELOPMENT.md](DEVELOPMENT.md#making-database-changes), [platform-adoption/local-exceptions.md](platform-adoption/local-exceptions.md), the `platform-migration` skill ([../.claude/skills/platform-migration/SKILL.md](../.claude/skills/platform-migration/SKILL.md)), [runbooks/kvox-domain-migration.md](runbooks/kvox-domain-migration.md) for the domain tables |
| Add a slice to, check or release a `@marinoscar/kvox-*` package | [PACKAGES.md](PACKAGES.md), [runbooks/release-kvox-packages.md](runbooks/release-kvox-packages.md) |
| Bind or implement the host ports of the domain packages (AI, object store, jobs, identity, notify, ...), run the conformance suite | [specs/kvox-ports.md](specs/kvox-ports.md), [PACKAGES.md](PACKAGES.md) |
| Build a host for the domain packages (KVox Desktop): install, embedded database, ports, the Copilot `KVOX_AI` adapter, offline behaviour, conformance | [guides/kvox-desktop.md](guides/kvox-desktop.md), [desktop/README.md](desktop/README.md), [specs/kvox-ports.md](specs/kvox-ports.md), [../examples/bare-host/README.md](../examples/bare-host/README.md) |
| Baseline a database onto the platform history | [runbooks/application-role.md](runbooks/application-role.md) | You move an existing database to the ordinary application role the API connects as (row-level security), or roll back |
| [runbooks/database-baseline.md](runbooks/database-baseline.md) |
| Understand why the system is shaped as it is (packages first, Desktop shell, graph store, local-only data, AI layering) | [decisions/README.md](decisions/README.md) |
| Write or run tests | [TESTING.md](TESTING.md) |
| Add a job type or any long-running work | the `add-job-type` skill ([../.claude/skills/add-job-type/SKILL.md](../.claude/skills/add-job-type/SKILL.md)), [specs/job-queue.md](specs/job-queue.md); the queue itself is `@marinoscar/platform-api/jobs` (contract in the package README and the `JobHandler` TSDoc) |
| Make a job type run on a worker node | [specs/worker-nodes.md](specs/worker-nodes.md), [deployment/worker-nodes.md](deployment/worker-nodes.md) |
| Add a notification event or an email template | the `add-notification` skill ([../.claude/skills/add-notification/SKILL.md](../.claude/skills/add-notification/SKILL.md)), [specs/browser-notifications.md](specs/browser-notifications.md), [ARCHITECTURE.md](ARCHITECTURE.md) §7.9 |
| Add a settings page (admin or per-user) | [specs/settings-ui.md](specs/settings-ui.md), [../apps/web/AGENTS.md](../apps/web/AGENTS.md), the `add-settings-page` skill ([../.claude/skills/add-settings-page/SKILL.md](../.claude/skills/add-settings-page/SKILL.md)) |
| Add a settings namespace (system or per-user) or a credential purpose | [DEVELOPMENT.md](DEVELOPMENT.md#settings-namespace-registry), [ARCHITECTURE.md](ARCHITECTURE.md) §7.7, [platform-adoption/local-exceptions.md](platform-adoption/local-exceptions.md) |
| Change navigation, the bottom bar or the rail | [specs/ux-refresh.md](specs/ux-refresh.md), [../apps/web/AGENTS.md](../apps/web/AGENTS.md) |
| Touch the transcript editor or correction model | [specs/transcription.md](specs/transcription.md) (§4), [specs/transcript-name-correction.md](specs/transcript-name-correction.md) |
| Add a transcript or note export format | [specs/transcription.md](specs/transcription.md), [specs/notes.md](specs/notes.md), [specs/transcript-export.v1.schema.json](specs/transcript-export.v1.schema.json) |
| Touch notes, templates or the AI layer | [specs/notes.md](specs/notes.md), [runbooks/ai-provider-keys.md](runbooks/ai-provider-keys.md), [runbooks/ai-platform-migration.md](runbooks/ai-platform-migration.md) |
| Touch the knowledge graph or the Ask agent | [specs/ontology.md](specs/ontology.md), [runbooks/ontology-migration.md](runbooks/ontology-migration.md) |
| Change search | [specs/search.md](specs/search.md) |
| Change onboarding | [specs/onboarding.md](specs/onboarding.md) |
| Change the Danger Zone or user data deletion | [specs/user-data-deletion.md](specs/user-data-deletion.md) |
| Change broadcasts | [specs/notification-broadcasts.md](specs/notification-broadcasts.md) |
| Change backups or restore | [specs/database-backup.md](specs/database-backup.md), [specs/database-restore.md](specs/database-restore.md) |
| Change maintenance mode | [specs/maintenance-mode.md](specs/maintenance-mode.md), [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md) |
| Change the CLI or `kvox deploy` | [../apps/cli/AGENTS.md](../apps/cli/AGENTS.md), [../apps/cli/README.md](../apps/cli/README.md), [specs/vps-deploy.md](specs/vps-deploy.md), [specs/deploy-spec.md](specs/deploy-spec.md) |
| Deploy to a VPS | [deployment/vps.md](deployment/vps.md) |
| Run worker nodes | [deployment/worker-nodes.md](deployment/worker-nodes.md) |
| Sign in from a CLI or device | [DEVICE-AUTH.md](DEVICE-AUTH.md), [personal-access-tokens.md](personal-access-tokens.md) |
| Rename or rebrand the application | [RENAMING.md](RENAMING.md) |
| Work with Claude Code or OpenCode on this repo | [AI-ASSISTANTS.md](AI-ASSISTANTS.md), [../AGENTS.md](../AGENTS.md) |
| Configure or move object storage, change the part size | [runbooks/storage-configuration.md](runbooks/storage-configuration.md), [runbooks/s3-cors.md](runbooks/s3-cors.md) |
| Operate a deployment (secrets, CORS, VAPID, restore) | [Runbooks](#runbooks) |

## Guides

| Guide | What it covers |
|---|---|
| [AI-ASSISTANTS.md](AI-ASSISTANTS.md) | How Claude Code and OpenCode share the repository rules, where each config file lives, the local model setup |
| [API.md](API.md) | API reference: conventions, auth schemes, response envelope, pagination, errors, every endpoint group |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture: components, permission catalog, database tables, job types |
| [DEVELOPMENT.md](DEVELOPMENT.md) | The dev loop, database changes, framework gotchas, repository tooling (platform pin, single-instance check, changesets) |
| [DEVICE-AUTH.md](DEVICE-AUTH.md) | Integrating a CLI or device with the RFC 8628 device flow |
| [decisions/README.md](decisions/README.md) | Architecture decisions (ADRs): packages first, the Desktop shell, the graph store, local-only data, AI layering, Desktop inputs |
| [desktop/README.md](desktop/README.md) | The starting README of the KVox Desktop repository: principle, architecture, stack, privacy, roadmap |
| [guides/README.md](guides/README.md) | Consumer guides for the published packages: [KVox Desktop](guides/kvox-desktop.md) (the ports to implement, the embedded database, the Copilot `KVOX_AI` adapter, what changes offline) |
| [PACKAGES.md](PACKAGES.md) | The four publishable `@marinoscar/kvox-*` packages: slices, the README/TSDoc/TypeDoc standard, peers per slice, the `host-neutral` rule, the checks and CI |
| [platform-adoption/README.md](platform-adoption/README.md) | The platform adoption program: module classification, drift baselines, [local exceptions](platform-adoption/local-exceptions.md) (every shim and deviation, and the issue that removes it) |
| [personal-access-tokens.md](personal-access-tokens.md) | Creating and using `pat_` tokens for scripts and CI |
| [RENAMING.md](RENAMING.md) | Renaming or rebranding the application |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | Authentication, authorization, transport and data protection |
| [TESTING.md](TESTING.md) | Test layers, helpers and how to run each suite |

## Feature specs

| Spec | Feature |
|---|---|
| [specs/browser-notifications.md](specs/browser-notifications.md) | Notification channels, service worker, Web Push |
| [specs/database-backup.md](specs/database-backup.md) | Scheduled and on-demand `pg_dump` backups, node offload |
| [specs/database-restore.md](specs/database-restore.md) | Restore and rollback from a backup |
| [specs/deploy-spec.md](specs/deploy-spec.md) | Portable implementation specification of the deploy CLI |
| [specs/job-queue.md](specs/job-queue.md) | The Postgres-backed background job queue |
| [specs/kvox-ports.md](specs/kvox-ports.md) | The host ports of the domain packages, their web adapters, the fakes and the conformance suite |
| [specs/maintenance-mode.md](specs/maintenance-mode.md) | The 503 maintenance window and its layers |
| [specs/notes.md](specs/notes.md) | AI-generated notes, templates, the AI layer |
| [specs/notification-broadcasts.md](specs/notification-broadcasts.md) | Admin broadcasts to every user |
| [specs/onboarding.md](specs/onboarding.md) | The first-run checklist |
| [specs/ontology.md](specs/ontology.md) | Connected knowledge: the ontology, graph, Ask agent, explorer |
| [specs/search.md](specs/search.md) | Ranked full-text search over transcripts and notes |
| [specs/settings-ui.md](specs/settings-ui.md) | The registry-driven settings hub |
| [specs/transcript-export.v1.schema.json](specs/transcript-export.v1.schema.json) | Public JSON Schema of the transcript export document |
| [specs/transcript-name-correction.md](specs/transcript-name-correction.md) | AI name correction for transcripts |
| [specs/transcription.md](specs/transcription.md) | Audio to transcript: pipeline, editing model, versions, sharing |
| [specs/user-data-deletion.md](specs/user-data-deletion.md) | The Danger Zone and bulk deletion of a user's data |
| [specs/ux-refresh.md](specs/ux-refresh.md) | The navigation destination model and UX refresh |
| [specs/vps-deploy.md](specs/vps-deploy.md) | Design of `kvox deploy` (VPS deployment) |
| [specs/worker-nodes.md](specs/worker-nodes.md) | Remote worker nodes and their data plane |

## Deployment

| Guide | What it covers |
|---|---|
| [deployment/vps.md](deployment/vps.md) | Deploying to a VPS: prerequisites, install, first login, troubleshooting |
| [deployment/worker-nodes.md](deployment/worker-nodes.md) | Running worker nodes that execute jobs remotely |

## Runbooks

| Runbook | Use it when |
|---|---|
| [runbooks/ai-platform-migration.md](runbooks/ai-platform-migration.md) | You move user AI keys and AI settings from the app's own AI layer to the platform AI slice (`npm run ai:migrate-legacy`), or roll that back |
| [runbooks/ai-provider-keys.md](runbooks/ai-provider-keys.md) | AI provider keys and note generation need setup or diagnosis |
| [runbooks/database-baseline.md](runbooks/database-baseline.md) | You baseline a database onto the platform migration history (`platform db baseline --through 14`), or review the rehearsal record |
| [runbooks/database-restore.md](runbooks/database-restore.md) | You restore the database from a backup |
| [runbooks/kvox-domain-migration.md](runbooks/kvox-domain-migration.md) | You change a domain table (transcripts, notes, search, graph, ask), author a migration with `kvox-db promote`, install the domain into a new host or fix a failing `kvox-db check` |
| [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md) | You open, close or recover a maintenance window |
| [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md) | You configure per-job database credentials for worker nodes |
| [runbooks/ontology-migration.md](runbooks/ontology-migration.md) | An ontology bump needs `kg.migrate` run or retried |
| [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md) | `pg_dump` fails on a client/server version mismatch |
| [runbooks/release-kvox-packages.md](runbooks/release-kvox-packages.md) | You publish the `@marinoscar/kvox-*` packages, set up npm trusted publishing, roll a release back or leave pre mode |
| [runbooks/rotate-secrets-encryption-key.md](runbooks/rotate-secrets-encryption-key.md) | You rotate `SECRETS_ENCRYPTION_KEY` |
| [runbooks/s3-cors.md](runbooks/s3-cors.md) | Browser uploads or playback need bucket CORS |
| [runbooks/storage-configuration.md](runbooks/storage-configuration.md) | You configure, move or diagnose object storage (`/admin/settings/storage`), or change the multipart part size |
| [runbooks/vapid-keys.md](runbooks/vapid-keys.md) | You generate, enable, rotate or disable Web Push keys |

## Developer recipes in the code

| Recipe | What it covers |
|---|---|
| [../.claude/skills/add-job-type/SKILL.md](../.claude/skills/add-job-type/SKILL.md) | Adding a job type on the packaged queue (`@marinoscar/platform-api/jobs`): handler, explicit `orgId`, labels, node eligibility |
| [../packages/kvox-api/src/notes/contracts/README.md](../packages/kvox-api/src/notes/contracts/README.md) | Job contracts: the result shape a worker node posts back, kept beside the module that owns the job type |
| [../.claude/skills/add-notification/SKILL.md](../.claude/skills/add-notification/SKILL.md) | Adding a notification on the packaged slices (`@marinoscar/platform-api/notifications`, `/email`): template in `email-templates/`, `registerNotification` in `notifications-registry/`, `notify()` after commit |
| [../apps/cli/README.md](../apps/cli/README.md) | `kvox`: install, `login`, `api`, `config`, `deploy`, `node`, CI usage |

## Agent rules

| File | Scope |
|---|---|
| [../AGENTS.md](../AGENTS.md) | The shared rule set for the whole repository |
| [../CLAUDE.md](../CLAUDE.md) | Claude Code entry point: imports `AGENTS.md`, adds cloud-session and subagent rules |
| [../apps/api/AGENTS.md](../apps/api/AGENTS.md) | Backend rules |
| [../apps/web/AGENTS.md](../apps/web/AGENTS.md) | Frontend rules |
| [../apps/cli/AGENTS.md](../apps/cli/AGENTS.md) | CLI rules, including the version bump |
| [AI-ASSISTANTS.md](AI-ASSISTANTS.md) | How the rule files, agents and skills fit together |
