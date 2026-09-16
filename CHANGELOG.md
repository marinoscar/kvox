# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **UX Refresh** (epic #105): the shell, the transcript viewer and the brand, brought up to what the product had become. **Navigation**: Transcripts and Notes are now sibling destinations rather than two tabs of one Library page, and the phone's bottom bar reads Home · Transcripts · Notes · Settings — `Console` moved to the navigation rail's foot and the avatar menu, so an administrator's own phone no longer spends a primary tab on an operational surface. **Home** surfaces recent notes and in-progress generations beside transcripts. **Transcript viewer**: every line has a play button that plays exactly that line and stops, working even for a speaker the filter excludes; the speaker chip row snaps and fades rather than slicing its last chip; the speed control collapses to one cycling chip on a phone; and the skip transport now says and does 10 seconds, having drawn a 10 and claimed 15. **Notes** show the context they were generated from — source, template instructions, context text and model — and Regenerate became a form over all three that sends only what changed. **Brand**: both themes are built from one indigo-and-amber token map with every text, brand, semantic and speaker pair proven at WCAG AA in light and dark (two speaker colours had been failing), and the placeholder mark is replaced by a K monogram followed by a five-bar waveform. See `docs/specs/ux-refresh.md`.
- **Background Job Queue** (epic #254): a Postgres-backed generic work queue — no Redis, no second datastore. Atomic `FOR UPDATE SKIP LOCKED` claim, retry and rate-limit budgets tracked independently, a lease reaper that reclaims work abandoned by a dead executor, and per-type lifetime stats that survive history pruning. A new job type is one self-registering handler class: no migration, no enum, no queue wiring, and it appears in the admin dashboard automatically. Admin surface at `/admin/settings/jobs` (queue + insights), API under `/api/admin/jobs/*`, gated by `jobs:read`/`jobs:write`. See `docs/specs/job-queue.md`.
- **Distributed Worker Nodes** (epic #254): job types can optionally be computed on a remote worker node instead of the API server — the *same* handler code runs either way, with no branching. Ships as `appctl node` (enroll, register, start/stop, doctor, capability probing, heap tuning and a pre-OOM memory valve, a systemd service installer, an interactive dashboard) plus a published worker container image and compose bundle for running a fleet (`docker compose -f infra/compose/worker.compose.yml up --scale worker=N`). A node authenticates with a dedicated `nod_…` credential confined to `/api/nodes/*`, and moves job input/output directly against object storage through short-lived presigned URLs — no storage credential ever reaches a node. Admin fleet view at `/admin/settings/workers`, API under `/api/nodes/*`, `/api/node-credentials` and `/api/admin/nodes/*`, gated by `nodes:read`/`nodes:write`. See `docs/specs/worker-nodes.md` and `docs/deployment/worker-nodes.md`.
- **Maintenance Mode**: an admin-controlled maintenance window (`/admin/settings/maintenance`, `/api/admin/maintenance`) that returns `503` to ordinary requests with an operator-supplied message, with an environment-variable break-glass (`MAINTENANCE_MODE`) that outranks the persisted setting. No dedicated permission — it is a `system_settings:read`/`write`-gated system setting. See `docs/specs/maintenance-mode.md` and `docs/runbooks/maintenance-mode.md`.
- **PostgreSQL Backup**: scheduled and on-demand `pg_dump` backups streamed directly into object storage (never buffered), with their own heartbeat, stale-run detection and single-active-run enforcement independent of the job queue. Admin surface at `/admin/settings/db-backup`, API under `/api/admin/db-backup/*`, gated by `db_backup:read`/`db_backup:write`. See `docs/specs/database-backup.md`.
- **PostgreSQL Restore**: restore the application's database from a backup, or roll back a restore, gated by a dedicated `db_backup:restore` permission kept separate from `db_backup:write` on purpose — scheduling backups and replacing the live database are not the same authority. Pre-flight capability gates (e.g. managed PostgreSQL denying `CREATEDB`) answer with a ready-to-run command block instead of an error. See `docs/specs/database-restore.md` and `docs/runbooks/database-restore.md`.
- Four operational notification events: a background job giving up (`jobs.job_failed`), a worker node going offline (`nodes.node_offline`), a database backup failing (`db_backup.backup_failed`), and a database restore completing (`db_backup.restore_completed`, mandatory — this one cannot be muted).
- A new **Operations** admin settings group (Jobs, Job Insights, Worker Nodes, Database Backup, Broadcasts) alongside the existing General and Access groups.
- **AI-Generated Notes** (epic #45): turn a transcript, another note, or an uploaded document into an AI-generated, user-correctable note, streamed token-by-token and fully versioned — *"AI proposes. The user controls the truth"* applied one layer up from transcription. Reusable note templates (built-ins plus your own, with a try-before-you-save preview), strict bring-your-own AI key (every provider key is per-user, encrypted, never a deployment-wide fallback — see `user_ai_credentials`), a deployment-wide model/token policy an administrator sets independently of any key, and export to markdown/PDF/docx reusing the transcript export registry. API under `/api/notes`, `/api/note-templates`, `/api/ai-settings` (Admin), `/api/ai-credentials`, and the `GET /api/notes/{id}/stream` / `GET /api/note-generations/{id}/stream` SSE endpoints; gated by `notes:read`/`notes:write` and `note_templates:read`/`note_templates:write`, both seeded to all three roles including Viewer, with `system_settings:read`/`:write` governing deployment policy and no permission at all on the per-user credential routes. User surfaces at `/settings/ai` (your own key) and `/settings/note-templates`; admin policy at `/admin/settings/ai`. See `docs/specs/notes.md`.
- **AI model selection** (issue #78, epic #45): the `ai` system-settings namespace gained a nullable `provider` axis, resolved through a new `AiProviderRegistry` lookup so no consumer of the AI framework hardcodes `'openai'` anymore — adding another OpenAI-API-compatible vendor now costs one id and one provider class, no consumer edits. `GET /api/ai-settings/models` (`system_settings:write`) lists a provider's live models using the calling administrator's own saved key (this deployment stores no AI key of its own); a vendor refusal answers `200` with `ok: false`, and a caller with no key gets `409 ai_key_missing`. `allowedModels` entries widen from bare model ids to `{ id, label?, contextWindowTokens?, maxOutputTokens? }`, so a deployment can permit a model this build's own catalogue does not describe by supplying its context window and output ceiling directly — the legacy bare-string form still parses, forever. See `docs/specs/notes.md` §2.5.
- **Reasoning models and GPT-5.4** (issue #87): the OpenAI model catalogue gains the GPT-5.4 family — `gpt-5.4` (1,050,000 context / 128,000 output), `gpt-5.4-mini` and `gpt-5.4-nano` (400,000 / 128,000) — alongside the existing GPT-4 entries, which stay: the catalogue is not an allow-list. The shipping `defaultModel` becomes `gpt-5.4-mini`; `allowedModels` stays empty by default, so which vendor model a deployment's content actually reaches remains an administrator's decision. A new `ai.reasoningEffort` system setting (`none`/`low`/`medium`/`high`/`xhigh`, default `none`), surfaced in the Limits section of `/admin/settings/ai`, is sent as the flat `reasoning_effort` Chat Completions parameter and omitted entirely at `none` — unchanged wire format for anyone who has not opted in, including OpenAI-compatible gateways that have never heard of it. ⚠ Reasoning tokens are billed and counted as output tokens, drawn from the same ceiling as the answer: at `high` against the default `maxOutputTokens` of 16,384, a generation can spend most of its budget thinking and return a truncated answer, arriving as a `length` finish reason rather than an error. See `docs/specs/notes.md` §2.5, §3.3.
- **User Data Danger Zone** (issue #80): delete your own recordings, notes, uploaded files, note templates and AI/access-token credentials in bulk, in five scopes from narrowest (`transcripts`/`notes`/`files`) to the two composites (`content`, `everything`), each gated by a typed confirmation that is the scope's own name uppercased. Runs as a single queued `user.data.purge` job (`maxAttempts: 1`, server-only permanently) that fans out to the existing `transcript.purge`/`note.purge` handlers rather than deleting bytes itself. No scope touches your account, settings, roles, or session — you stay signed in; `everything` additionally revokes your AI provider keys and personal access tokens. `GET`/`POST /api/user-data/*`, both `@Auth()` with no permission string — the same ownership-scoped posture `/api/ai-credentials` takes. User surface at `/settings/danger-zone`. See `docs/specs/user-data-deletion.md`.
- **About** (epic #118): what is deployed, on what, and whether it's current — `GET /api/admin/about` (issue #124, gated on `system_settings:read`, not a permission of its own), the `/admin/settings/about` card (issue #126), and `kvox deploy about` (issue #128) all read the same `deploy-info/info.json` record the CLI writes on every `install`/`update`. Never performs network I/O; always answers `200`, reporting `deployInfoStatus: absent/unreadable/invalid/ok` and an independent `databaseError` so a broken deployment is still legible from its own About page. See `docs/specs/vps-deploy.md` §19 and `docs/API.md#about-admin-only`.
- **`kvox deploy about`** (issue #128): the CLI-side About — Application, Deployment and Server blocks in the terminal, every timestamp UTC with how long ago it was, `--check` to fetch the remote first, `--server` to ask an explicit API, `--json` for scripting.
- **`kvox deploy certs`** (issue #125): `certs renew` (`docker run --rm certbot/certbot renew` against the shared proxy, `docker exec … nginx -s reload` only when something actually renewed, `--dry-run`, `--install-cron` to write `/etc/cron.d/kvox-certs-<name>`) and `certs status` (every certificate behind the proxy with its expiry; exit `1` if one has expired).
- **`kvox deploy update --check`** (issue #123): fetch and report `current -> latest, N commits behind` with commit subjects, recorded into `deploy-info/info.json`, with nothing checked out, built, or written to state — the same computation `status` and `about` also run to render their own `Update: N commits behind` line.
- **`bootstrap-vps.sh`** (issue #130): a fresh-root-shell script that installs the GitHub CLI, logs it in, installs Node.js if needed, clones the repository and builds `kvox` onto `/usr/local/bin`, creates `/opt/infra/apps`, and opens the interactive menu (or, with `--no-tui`, prints the exact next command) — the whole path from an empty VPS to a running `deploy doctor` in three commands. See [`apps/cli/README.md`](apps/cli/README.md#fresh-server-in-three-commands).
- **Deploy end-to-end CI** (issue #133): a `Deploy end-to-end (issue #118)` workflow (`.github/workflows/deploy-e2e.yml`) runs `kvox deploy install`/`update --check`/`update` against a real Docker daemon and a real PostgreSQL service container on every change touching the deploy pipeline or the compose files, and nightly — closing the gap every pipeline unit test leaves by injecting a fake `runCommand` rather than ever calling real `docker`.
- **Content Search** (issue #175/#177, epic #164): `GET /api/search` ranks transcripts and notes by the actual words spoken or written, not just their titles — a term said once in a three-hour recording now finds it. Full-text only in this layer: three generated `tsvector` columns (GIN-indexed, backfilled by the migration itself with no separate ingestion job), `ts_rank_cd` cover-density scoring rolled up per document by `max` (never `sum`, which would favor long documents regardless of relevance), and a bounded 200-document candidate window paged by an opaque cursor fingerprinted to the query, type filter, caller and ranking-model version — presented against a different search, it is refused with a 400 rather than silently restarting. An all-stopword query (`degraded: "stopwords"`) falls back to the existing title-substring behaviour of `GET /api/transcripts?q=`/`GET /api/notes?q=`. Snippets are rendered with `ts_headline` and escaped before `<mark>` highlighting is added, never after. Reuses `transcripts:read`/`notes:read` — no new permission — with a partial answer (not a 403) for a caller holding only one of the two. See `docs/specs/search.md`.
- **Home "Needs attention"** (issue #171, epic #166): `GET /api/transcripts/summary` now returns a `failed` **list** beside the `failed` count it already had — the caller's own failed transcripts, newest first, capped at eight and fetched in the same single round trip as the other three lists, so the home page can put the recordings that did not make it in front of a user with a retry a tap away instead of telling them only how many there are. Owner-scoped, unlike `inProgress`, which unions the caller's shares: retry is owner-only, so somebody else's failure is not an item this caller can act on. `counts.failed` is unchanged and is still the **true total**, never the list's length — thirty failures read as `30` beside eight rows. See `docs/API.md#get-transcriptssummary`.
- **Home at Scale** (epic #166): four additions to the home page, none of which grew the number of requests it makes (`docs/specs/ux-refresh.md` §2). A **counts strip** (issue #170) turns numbers the page already holds into four deep links — Transcripts, Shared with me, Notes, and a combined Needs attention count spanning both content types — and the transcript and notes library views now seed their `?scope=`/`?status=`/`?q=` filters from the URL on first load so those links land already filtered. A **"Needs attention" section** (issue #171) lists the caller's own failed transcripts and failed notes, each with a one-tap Retry or Regenerate and its own inline error, fed by the `failed` list above. A **search entry point** in the home hero (issue #172) navigates to `/transcripts?q=<term>` on submit — a deliberate placeholder destination ahead of the Content Search epic (#164), which the field's exported `searchPathFor` names as its one-line seam. **New note** (issue #173) joins New transcript as a second, `notes:write`-gated action in the hero.

### Changed

- **VPS deploy layout and proxy** (epic #118, correcting the epic #168 design against a real server — see `docs/specs/vps-deploy.md` §18): the deploy root moved from a single `--path` flag (default `/opt/<repo-name>`) to `--apps-root`/`--name` (default `/opt/infra/apps/<name>`), with `<name>` doubling as the docker compose **project** name so two apps on one box never share containers (issue #119). Git access on the server is now the **GitHub CLI** exclusively — `install`/`update` require `gh` installed and logged in, run `gh auth setup-git`, and clone/fetch a private repository over HTTPS with `gh`'s own token; there is no SSH key handling anywhere in this pipeline (issue #123). The shared reverse proxy is addressed **only as a container**: certificates are issued and renewed with `docker run --rm certbot/certbot` and the vhost is validated/reloaded with `docker exec <container> nginx -t`/`-s reload` — there is no host `certbot` or host `nginx` anywhere, and every path the rendered vhost names is a container path, not a host one (issue #125).

### Fixed

- **Storage uploads**: deleting a storage object whose resumable upload never completed no longer orphans its S3 multipart upload and uploaded parts (issue #101). Both the generic `DELETE /api/storage/objects/:id` and the managed-object delete path used by `transcript.purge` and the notes purge now abort an active multipart upload (`s3UploadId` set, status `pending`/`uploading`) before deleting the row — the same abort-before-delete ordering `storage-cleanup.handler.ts`'s stale-upload sweep already uses — instead of relying on a bucket's `AbortIncompleteMultipartUpload` lifecycle rule (or leaking storage forever on a bucket without one). An upload S3 already reports gone (`NoSuchUpload`) is treated as aborted; any other abort failure keeps the row so the stale-upload sweep can retry it.
- **Service worker navigation caching**: installed/PWA clients no longer get stuck running a stale cached app shell carrying outdated response headers (e.g. an old `Content-Security-Policy`) after a header-only server change. Navigations are now served network-first, with the precache used only as an offline fallback — a header change such as issue #84/PR #85's CSP widening now reaches an already-installed client on its very next online navigation, with no update prompt or cache purge required (issue #88). See `docs/specs/browser-notifications.md` §1.4.
- **AI enablement**: fixed three compounding defects that together left a fresh deployment unable to turn AI on at all (issue #83). `AiConfigService` reported `provider: null` whenever AI was switched off or nothing was permitted, which disabled the key form on `/settings/ai` under a notice claiming *"An administrator has not chosen an AI provider"* — false, since `ai.provider` ships as `'openai'`; `/admin/settings/ai` loaded with `Save changes` already disabled on the shipping defaults (`allowedModels: []` with `defaultModel: 'gpt-4o'`), blocking both the enable switch and the provider select; and the only non-manual escape, `Load models from provider`, needs the administrator's own key and `409`s without one, deep-linking to the page the first defect had disabled. `provider`/`providerLabel` are now independent of `available` and reported whenever a registered vendor is configured, so a user can save and verify their own key before an administrator finishes setup — `provider: null` now means only that there is genuinely no vendor to name — and the admin page blocks `Save` only on a real contradiction, naming what it is waiting on when it does. See `docs/specs/notes.md` §2.5.
- **Storage CSP origin**: `STORAGE_CSP_ORIGIN` now derives a default from `S3_BUCKET`/`S3_REGION` for plain AWS S3 instead of defaulting to empty, so a deployment that never set it no longer has every browser upload part silently blocked by `connect-src 'self'` (issue #84). Explicit values are still required for MinIO/LocalStack/any `S3_ENDPOINT`, dotted bucket names, and CDN/custom domains. See `docs/runbooks/s3-cors.md`.
- **Transcription**: `POST /api/transcripts` no longer rejects Android `.m4a` recordings (and other audio/video files) on a deployment whose `.env` predates issue #21 and never picked up `audio/*` in `ALLOWED_MIME_TYPES`. The endpoint now enforces its own fixed `audio/*,video/*` allowlist instead of inheriting the operator-configured generic-upload setting — see `docs/specs/transcription.md` §9.6 (issue #79). `POST /api/storage/objects*` is unaffected and still governed by `ALLOWED_MIME_TYPES`; an existing deployment that wants audio accepted on that *generic* surface should still add `audio/*` there (see `docs/deployment/vps.md` § Troubleshooting).
- **Transcription stuck at "Sending to the transcription service"** (issue #95): AssemblyAI began refusing the singular `speech_model` submit parameter with an HTTP 400, which exhausted every `transcription.submit` attempt and left the transcript in `processing` forever with no visible error and no retry button. The provider now sends the vendor's current `speech_models` array (ordered; falls back through the list by language support) and reads back the model actually used from `speech_model_used`. Existing `transcription.providers.assemblyai.speechModel` settings keep working with no migration — the field is still a string, now read as a comma-separated, ordered list, with retired ids (`universal`, `best`, `nano`, `slam-1`) resolving to the new default `universal-3-5-pro, universal-2`. Separately, a new `TranscriptJobFailureListener` now fails the transcript (retryably) whenever a pipeline job for it exhausts its retry budget with no other job still working on it — closing the gap for *any* ordinary retryable failure that runs out of attempts, not just this one, so a transcript never again sits `processing` with nothing left watching it. See `docs/specs/transcription.md` §1.6, §2.7.
- **VPS deploy — the rendered vhost named host filesystem paths** (issue #125): the original vhost template pointed `ssl_certificate`/`ssl_certificate_key` and the ACME webroot at paths on the host filesystem, which a shared proxy running as a container — the only supported shape — never sees; every path is now the path the proxy container's own mounts expose (`/etc/letsencrypt/live/<domain>/…`, `/var/www/certbot`), declared once and shared by the `docker run certbot` invocation and the render so the two cannot disagree.
- **VPS deploy — `lastDeployedAt` was stamped on a failed update** (issue #120): a failed `update` could overwrite the deployment state's timestamp as though it had succeeded, so a broken deploy reported itself as current. `state.json` now stamps `lastDeployedAt` only on success, records `lastAttemptAt` separately for every attempt, and the running application's own record of "what's deployed" (`deploy-info/info.json`) is a second file the CLI writes independently, never derived from a claim the state file might get wrong.
- **VPS deploy — two apps on one box collided on the same compose project** (issue #119): before the app-folder layout, the deploy root defaulted to the apps root itself and every app on a box was the compose project `compose`, so a second app's `up -d` silently replaced the first app's containers. Each app now gets its own folder and its own project name (`<name>-api-1`, etc.), derived from `--name` and recorded in state.
- **TUI install wizard could not generate `SECRETS_ENCRYPTION_KEY`** (issue #131): the step-by-step TUI wizard that replaced the original single-screen install flow now generates all three secrets — `JWT_SECRET`, `COOKIE_SECRET` and `SECRETS_ENCRYPTION_KEY` — the same way the plain command's wizard already did, defaulting to Generate and shown masked, instead of requiring one typed by hand.
- **VPS deploy — the `deploy-info` directory could be created root-owned by Docker itself** (from PR #155): `vps.compose.yml` bind-mounts `<deploy-root>/deploy-info` into the `api` container, and if the directory did not exist yet, Docker created it as `root` on first `up -d` — leaving the CLI, running as an unprivileged user, unable to write `info.json` into it on the next deploy. `install` now creates the directory itself, with the correct ownership, before the stack can.
- **A CLI unit test shelled out to a real package install** (from PR #155): the default-steps `install` test invoked the real `apt`/package-manager path for one of its steps, making the suite depend on network access and mutate the machine running it. It now injects a fake step runner like every other pipeline test.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 22.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication
- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)
- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization
- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control
- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management
- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework
- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API
- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend
- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool
- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure
- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability
- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing
- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library
- CI pipeline with GitHub Actions

### API Endpoints

#### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `GET /api/auth/me` - Get current user

#### Device Authorization
- `POST /api/auth/device/code` - Generate device code
- `POST /api/auth/device/token` - Poll for authorization
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/:id` - Revoke device session

#### Users (Admin only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/:id` - Get user by ID
- `PATCH /api/users/:id` - Update user

#### Allowlist (Admin only)
- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove from allowlist

#### Settings
- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Update system settings (Admin)

#### Health
- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

### Technical Stack
- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx
