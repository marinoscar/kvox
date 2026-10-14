# Documentation index

Every document in this repository, grouped by what you need it for. Links are
relative to `docs/`.

- A **spec** (`specs/`) describes the design of one feature and serves as its reference: the model, the rules, and the rejected alternatives.
- A **runbook** (`runbooks/`, `deployment/`) is a step-by-step procedure for an operator running a deployment.

## Read first

In this order:

1. [../README.md](../README.md): what the application is and how to start it.
2. [../AGENTS.md](../AGENTS.md): the shared rules every contributor and AI assistant follows (nested `apps/{api,web,cli}/AGENTS.md` hold the area rules).
3. [ARCHITECTURE.md](ARCHITECTURE.md): the subsystem map, permission catalog (§7.3), table inventory (§6.4), navigation destinations (§9.6).
4. [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md): authentication, RBAC, transport and data protection.
5. [DEVELOPMENT.md](DEVELOPMENT.md): the dev loop, gotchas and the environment variables.
6. [TESTING.md](TESTING.md): test layers, helpers and how to run each suite.

## Doc map by task

Find the right doc without loading the whole index. Read a doc by section (grep its headings, then read a range), never whole. `API.md` is about 350 KB.

| Task | Read |
|---|---|
| Add or change an endpoint | [API.md](API.md) (`grep -n '^### '`), then [../apps/api/AGENTS.md](../apps/api/AGENTS.md) |
| Add a job type or long-running work | [../apps/api/src/jobs/handlers/README.md](../apps/api/src/jobs/handlers/README.md), [specs/job-queue.md](specs/job-queue.md), the `add-job-type` skill |
| Make a job run on a worker node | [specs/worker-nodes.md](specs/worker-nodes.md), [deployment/worker-nodes.md](deployment/worker-nodes.md) |
| Add a settings page | [specs/settings-ui.md](specs/settings-ui.md), [../apps/web/AGENTS.md](../apps/web/AGENTS.md), the `add-settings-page` skill |
| Add a notification | [../apps/api/src/notifications/README.md](../apps/api/src/notifications/README.md), [specs/browser-notifications.md](specs/browser-notifications.md) |
| Change the database schema | [DEVELOPMENT.md](DEVELOPMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md) (table inventory §6.4) |
| Touch the transcript editor | [specs/transcription.md](specs/transcription.md) §4 |
| Touch notes or the AI layer | [specs/notes.md](specs/notes.md), [runbooks/ai-provider-keys.md](runbooks/ai-provider-keys.md) |
| Touch the knowledge graph or Ask | [specs/ontology.md](specs/ontology.md) |
| Touch search | [specs/search.md](specs/search.md) |
| Change the CLI or the VPS deploy | [../apps/cli/README.md](../apps/cli/README.md), [specs/vps-deploy.md](specs/vps-deploy.md) |
| Change navigation or the bottom bar | [ARCHITECTURE.md](ARCHITECTURE.md) (§9.6), [specs/ux-refresh.md](specs/ux-refresh.md) |
| Write or run tests | [TESTING.md](TESTING.md) |
| Rename or start a new app | [RENAMING.md](RENAMING.md) |
| Work with Claude Code or OpenCode on this repo | [AI-ASSISTANTS.md](AI-ASSISTANTS.md) |
| Operate a deployment | [Runbooks](#runbooks), [Deployment](#deployment) |

## Guides

| Guide | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data model, permission catalog, table inventory, frontend and infrastructure architecture |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | Authentication, authorization, secrets, transport and data protection |
| [API.md](API.md) | Per-endpoint reference for every route group, response envelope, errors |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local development, gotchas, database changes and the environment variables |
| [TESTING.md](TESTING.md) | The testing framework: tiers, helpers, commands |
| [DEVICE-AUTH.md](DEVICE-AUTH.md) | Integrating a CLI or device with the RFC 8628 device flow |
| [personal-access-tokens.md](personal-access-tokens.md) | Creating and using `pat_` tokens for scripts and CI |
| [RENAMING.md](RENAMING.md) | Renaming this template for a new product |
| [AI-ASSISTANTS.md](AI-ASSISTANTS.md) | How Claude Code and OpenCode share the repository rules: `AGENTS.md` files, `CLAUDE.md` imports, agents folders and context budgets |

## Feature specs

| Spec | Subject |
|---|---|
| [specs/transcription.md](specs/transcription.md) | Audio to trusted transcript: pipeline, corrections, versions, sharing, export |
| [specs/transcript-name-correction.md](specs/transcript-name-correction.md) | AI name correction and `keyterms` |
| [specs/transcript-export.v1.schema.json](specs/transcript-export.v1.schema.json) | The published transcript export JSON schema |
| [specs/notes.md](specs/notes.md) | AI-generated notes, templates and the AI layer |
| [specs/ontology.md](specs/ontology.md) | Connected knowledge: ontology, extraction, graph, explorer, Ask |
| [specs/search.md](specs/search.md) | Content search |
| [specs/onboarding.md](specs/onboarding.md) | The first-run checklist |
| [specs/user-data-deletion.md](specs/user-data-deletion.md) | The Danger Zone: bulk deletion of one user's data |
| [specs/browser-notifications.md](specs/browser-notifications.md) | Browser notifications and Web Push |
| [specs/notification-broadcasts.md](specs/notification-broadcasts.md) | Admin notification broadcasts |
| [specs/job-queue.md](specs/job-queue.md) | The background job queue |
| [specs/worker-nodes.md](specs/worker-nodes.md) | Worker nodes |
| [specs/database-backup.md](specs/database-backup.md) | Database backup |
| [specs/database-restore.md](specs/database-restore.md) | Database restore |
| [specs/maintenance-mode.md](specs/maintenance-mode.md) | Maintenance mode |
| [specs/vps-deploy.md](specs/vps-deploy.md) | `kvox deploy` design |
| [specs/deploy-spec.md](specs/deploy-spec.md) | Portable implementation specification of the deploy CLI |
| [specs/settings-ui.md](specs/settings-ui.md) | The registry-driven settings hub |
| [specs/ux-refresh.md](specs/ux-refresh.md) | The UX refresh and the navigation destination model |

## Deployment

- [deployment/vps.md](deployment/vps.md): deploy to a VPS with `kvox deploy`.
- [deployment/worker-nodes.md](deployment/worker-nodes.md): running worker nodes.

## Runbooks

- [runbooks/ai-provider-keys.md](runbooks/ai-provider-keys.md): AI provider keys and note generation.
- [runbooks/database-restore.md](runbooks/database-restore.md): restore the database from a backup.
- [runbooks/maintenance-mode.md](runbooks/maintenance-mode.md): open, close and recover a maintenance window.
- [runbooks/node-job-secrets.md](runbooks/node-job-secrets.md): per-job database credentials for worker nodes.
- [runbooks/ontology-migration.md](runbooks/ontology-migration.md): ontology migrations (`kg.migrate`).
- [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md): PostgreSQL client/server version mismatch.
- [runbooks/rotate-secrets-encryption-key.md](runbooks/rotate-secrets-encryption-key.md): rotate `SECRETS_ENCRYPTION_KEY`.
- [runbooks/s3-cors.md](runbooks/s3-cors.md): bucket CORS for browser uploads and playback.
- [runbooks/vapid-keys.md](runbooks/vapid-keys.md): generate, enable, rotate and disable VAPID keys.

## Developer recipes in the code

- [../apps/api/src/jobs/handlers/README.md](../apps/api/src/jobs/handlers/README.md): adding a job type.
- [../apps/api/src/jobs/contracts/README.md](../apps/api/src/jobs/contracts/README.md): job contracts.
- [../apps/api/src/notifications/README.md](../apps/api/src/notifications/README.md): adding a notification.
- [../apps/cli/README.md](../apps/cli/README.md): `kvox` install, commands, CI usage, deploying, worker nodes.

## Agent rules

- [../AGENTS.md](../AGENTS.md): shared rules and the MANDATORY sections (`CLAUDE.md` imports it).
- Area rules: [../apps/api/AGENTS.md](../apps/api/AGENTS.md), [../apps/web/AGENTS.md](../apps/web/AGENTS.md), [../apps/cli/AGENTS.md](../apps/cli/AGENTS.md).
- Agents: `.claude/agents/` (Claude Code) and `.opencode/agents/` (OpenCode), kept in parity. Skills: `.claude/skills/`.
