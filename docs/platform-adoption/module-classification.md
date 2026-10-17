# Module classification

Frozen baseline classification of every top-level KVox module against EnterpriseAppBase (EAB) and its `@marinoscar/platform-*` packages. Input: the generated reports [drift-baseline.md](drift-baseline.md) (apps view) and [drift-baseline-slices.md](drift-baseline-slices.md) (slice view). Part of the platform retrofit program; tracked by issue #458.

| Field | Value |
|---|---|
| EAB commit | `c20bade53ad3c745b459976e361784e4f15d95ec` |
| KVox commit | `6e44e436171464c7a2ef87c1cc3c18def7c61771` |
| Date | 2026-10-14 |

## How the numbers were produced

Both reports come from EAB's `scripts/platform-drift.mjs`, run from a scratch directory. `<EAB>` is a checkout of EnterpriseAppBase at the commit above, `<KVOX>` is a checkout of KVox at its commit, `<SCRATCH>` is a temporary directory.

```bash
# Apps view: KVox against EAB's apps/ layout (web, cli, prisma, infra, api bindings)
cd <SCRATCH> && node <EAB>/scripts/platform-drift.mjs \
  --app <KVOX> --base <EAB> --out <SCRATCH>/apps

# Slice view: each KVox base module against its packaged slice (API only)
bash <KVOX>/scripts/platform-adoption/make-slice-view.sh <EAB> <SCRATCH>/eab-slice-view
cd <SCRATCH> && node <EAB>/scripts/platform-drift.mjs \
  --app <KVOX> --base <SCRATCH>/eab-slice-view --areas api --out <SCRATCH>/slices
```

The apps view under-counts the API: EAB's `apps/api/src` holds only bindings, so KVox's base modules show as app-only with an n/a identity. For API base modules the **Drift** column therefore uses the slice view. Everything else (web, cli, prisma, infra, API modules with no slice) uses the apps view. Drift is written `identical % / lines added/removed`; identical % counts identical and normalised-identical files over the base-side files, `n/a` when the base has no file at that path. **Files (kvox)** counts the KVox files in the module.

## Categories

- **noise**: differs only in comments, whitespace, identity or issue numbers, or is a renamed-but-equal copy; or the package covers it with no behaviour loss. The package replaces it. Delete on adoption.
- **backport**: KVox changed a base module in a way the platform lacks (a feature or a fix). KVox sends no seam PRs, so each one is re-expressed as a KVox workaround on top of the package (side table, registry entry, override, wrapper). The row names the workaround.
- **domain**: KVox product code (transcription, transcripts, search, notes, graph, ask, the KVox-only web pages). Stays in KVox; packaged as `@marinoscar/kvox-*` in Epics 6 and 7.
- **kvox-divergence**: KVox and EAB solved the same problem differently and KVox keeps its own design for now. The row says whether the roadmap converges it and when.

Issue tokens (`issue 1.3`, `Epic 3`) are roadmap numbers, not GitHub issue numbers: 1.2 host, 1.3 identity, 1.4 settings and credentials, 2.1 jobs and nodes, 2.2 storage, 2.3 email and notifications, 2.4 db-backup, Epic 3 AI, 4.1 exports, 4.2 user-data, 4.3 onboarding, 4.4 CLI `createCli`, 4.5 infra, 4.6 web shell, Epic 6 domain API packages, Epic 7 domain web packages. Target names are EAB slice names from `packages/platform-slices.json`, or `@marinoscar/kvox-<x>` for domain code.

Status note (issue #466, roadmap 1.4): this page is the classification as written before adoption. Its rows for `credentials`, `common/crypto`, the `settings` module, `common/schemas`, `common/types`, `components/settings` and the settings hooks and pages describe code that #466 deleted or replaced with the packaged slices. The current state is in [`local-exceptions.md`](local-exceptions.md) and `docs/ARCHITECTURE.md` §7.7.

### KVox workarounds referenced below

| Workaround | What it is | Used by |
|---|---|---|
| `kvox_object_ownership` | Side table keyed by storage object id holding `managed_by` and `part_size`; replaces the two `storage_objects` columns | storage (2.2) |
| `kvox_allowlist_reminders` | Side table keyed by allowlist entry id holding `reminder_count`, `last_reminder_at`, plus a KVox route and email template | allowlist (1.3) |
| post-upload processor | KVox listener on the package `ObjectUploaded` event that starts the transcript pipeline | storage (2.2) |
| abort reconcile | KVox listener on `ObjectUploadAborted` that reconciles the owning transcript | storage (2.2) |
| `files` category override | Override of the package user-data `files` category so managed objects are purged through `transcript.purge`/`note.purge` | user-data (4.2) |
| embedding catalog | KVox-owned embedding model catalog and `search_embeddings` writer, kept outside the package AI platform | search, ai (Epic 3) |
| streaming tool loop | Was KVox's `AiProvider.chat` tool-calling loop used by Ask. Since #476 it is one platform `stream()` call per turn behind `KvoxAi.chat` (`packages/kvox-ai/src/chat/chat-mapping.ts`); the `AiProvider` stack is deleted (#477). | ask, ai (Epic 3, done) |
| `ai` namespace extension | KVox fields (`provider`, `allowedModels`, `taskModels`, `graphEnabled`, token limits) added to the package `ai` system-settings namespace (issue 3.1) | settings, ai (Epic 3) |
| generic user-settings change event | EAB's `UserSettingsNamespace` has no change hook. KVox adds a KVox-only `onChanged`/generic event that issue 1.4 must carry; it replaces the direct `GRAPH_PREFERENCES_CHANGED_EVENT` emit in `user-settings.service.ts` | settings (1.4) |
| job contract and label registration | KVox job contracts (`jobs/contracts/*.contract.ts`) and `job-type-labels.ts` registered on the package job registry | jobs (2.1) |
| domain template and event registration | KVox email templates and notification events registered through `registerEmailTemplate` and the notification event registry | email, notifications (2.3) |
| onboarding step registry | KVox user and admin onboarding steps registered on the package onboarding slice | onboarding (4.3) |
| exporter registry registration | KVox transcript/note renderers registered with the package export machinery | export (4.1) |
| restore-preflight wrapper | KVox `guided` restore outcome kept as a wrapper over the package preflight | db-backup (2.4) |
| `profile-image` side module | KVox avatar upload module mounted beside the `settings` slice; objects stamped with `metadata.purpose` | settings (1.4) |

## Summary

Counts are rows in the area tables below (a row can group several files; see Files for size).

| Area | noise | backport | domain | kvox-divergence | Rows |
|---|---|---|---|---|---|
| api (`apps/api/src`) | 22 | 13 | 7 | 6 | 48 |
| web (`apps/web/src`) | 20 | 8 | 19 | 12 | 59 |
| cli (`apps/cli/src`) | 2 | 0 | 1 | 5 | 8 |
| prisma and infra | 3 | 1 | 0 | 2 | 6 |
| **Total rows** | **47** | **22** | **27** | **25** | **121** |
| **Total kvox files in rows** | 380 | 347 | 1088 | 305 | 2120 |

Migrations: 22 app-only (18 domain, 2 backport, 2 kvox-divergence), 23 base-only (installed by baseline `--through`), 14 shared. Prisma models: 14 shared models with differences (4 need work: side tables for `AllowedEmail` and `StorageObject`, back-relation extensions for `Job`, `StorageObject` and `User`; the other 10 need nothing).

## API: apps/api/src

Every entry of `ls apps/api/src` is covered: `about`, `ai`, `allowlist`, `app.module.ts`, `ask`, `auth`, `common`, `config`, `credentials`, `db-backup`, `device-auth`, `email`, `export`, `graph`, `health`, `instrumentation.ts`, `jobs`, `main.ts`, `nodes`, `notes`, `notifications`, `onboarding`, `openapi`, `pat`, `prisma`, `search`, `settings`, `storage`, `test-auth`, `transcription`, `transcripts`, `user-data`, `users`. `common` has no 1:1 slice (it is split between `core`, `host` and `settings`), so its subfolders are classified individually in the `common/*` rows at the end of the table.

| Module | Files (kvox) | Drift (identical % / lines +/-) | Category | Target slice / package | Issue | Notes |
|---|---|---|---|---|---|---|
| `about` | 8 | 0% / +165/-151 | noise | `host` (about) | issue 1.2 | EAB re-architected the same report around an about-contributor registry; behaviour (deploy-info read per request, no network I/O, always 200) is the same. KVox-only `about.dto.ts`, `deploy-info.schema.ts` fold into the package. Check `updateAvailable` parity in 1.2. |
| `ai` | 51 | 0% / +47/-73 | kvox-divergence | `ai` | Epic 3 | At the baseline KVox ran its own older, strictly per-user-key AI layer (`UserAiCredential`, `AiProviderRegistry`, `AiTaskModelResolver`); 307 of 358 slice files were absent here. **Resolved by epic #472:** the platform AI slice is mounted (`platform/ai/`), every caller goes through `KvoxAi` (`ai-port/`), and `apps/api/src/ai/` and `user_ai_credentials` are deleted (#477). What stays KVox's: the embedding catalog, the task chooser and the target resolver, in `ai-port/`. |
| `allowlist` | 9 | 28.6% / +114/-14 | backport | `identity` (allowlist) | issue 1.3 | `reminderCount`/`lastReminderAt`, `POST /allowlist/{id}/reminder`, the `allowlist-invitation-reminder` email. Workaround: `kvox_allowlist_reminders` side table plus a KVox controller route and email template registration. |
| `app.module.ts` | 1 | 0% / +91/-46 | kvox-divergence | app-owned (`core` / `host` bindings) | issue 1.2 | The module list is the app's own composition root. 1.2 replaces the base module imports with `PlatformHostModule.forRoot`; domain modules stay mounted here. |
| `ask` | 54 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/ask` | Epic 6 | Saved Ask conversations and `ask.respond`. The streaming tool loop runs over `KvoxAi.chat` (the platform `stream()` call) since #476. |
| `auth` | 30 | 9.6% / +319/-1089 | noise | `identity` (auth) | issue 1.3 | Most removed lines are EAB tenancy/RLS (org-scoped tokens, principal cache) that KVox does not use (single-org mode). KVox-only files are specs. Google OAuth + allowlist login flow are in the package. |
| `config` | 1 | 0% / +62/-36 | kvox-divergence | app-owned | issue 1.2 | `configuration.ts` carries KVox env (jobs, storage, transcription, graph, backups). Stays in the app; the package reads typed options instead. |
| `credentials` | 5 | 5.3% / +45/-64 | noise | `credentials` | issue 1.4 | Package moved the DB to the `PLATFORM_PRISMA` port and extracted hint/validation helpers. Register the KVox `transcription` credential purpose (`transcription-credential.constants.ts`). `user_ai_credentials` is a different table and stays (Epic 3). |
| `db-backup` | 48 | 0% / +806/-1221 | backport | `db-backup` | issue 2.4 | `restore-preflight.service.ts` is 1,342 lines vs 977 in the package (the `guided` outcome with paste-ready SQL). Workaround: restore-preflight wrapper over the package preflight; the rest is noise. `db-backup-run.contract.ts` moves to the jobs contract registration (2.1). |
| `device-auth` | 18 | 35.3% / +122/-356 | noise | `identity` (device-auth) | issue 1.3 | RFC 8628 flow; package adds credential-link columns (base migration `add_device_session_credential_link`). KVox `device-auth/README.md` deleted with the module. |
| `email` | 51 | 4.4% / +716/-790 | backport | `email` | issue 2.3 | Domain templates (`transcript-ready`, `transcript-failed`, `shared-with-you`, `note-ready`, `note-failed`, `allowlist-invitation-reminder`). Workaround: domain template registration through the email template registry; settings schema differences are noise. |
| `export` | 4 | 0% / +3/-27 | backport | `exports` | issue 4.1 | KVox `export` is the transcript/note document rendering helper (`export-options.ts`, `exporter-registry.ts`, `pdf-fonts.ts`), not the package data-export flow. Part A (#479) moved it onto the package's `ExporterRegistry` and `hashExportRequest`; Part B (#532) mounted the package data-export slice (`/settings/data-export`) with the app's `kvox-content` source and export policy (`docs/specs/data-export.md`). Done. |
| `graph` | 246 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/graph` | Epic 6 | Connected knowledge: ontology, proposals, resolution, brief, layout, RDF export/import. |
| `health` | 5 | 0% / +32/-46 | noise | `host` (health) | issue 1.2 | One controller differs (+32/-46); the DB indicator moves to the host port. |
| `instrumentation.ts` | 1 | 0% / +65/-7 | kvox-divergence | app-owned (`otel-core` binding) | issue 1.2 | Entry-point OpenTelemetry bootstrap (+65/-7). Stays app-owned; service name and exporters come from `otel-core`/`telemetry` options. |
| `jobs` | 66 | 10% / +403/-873 | backport | `jobs` | issue 2.1 | Job type contracts (`jobs/contracts/*.contract.ts`), `job-type-labels.ts`, example handlers. Workaround: job contract and label registration from `@marinoscar/kvox-api`. The queue core (claim, lease, profile, terminal) is noise. |
| `main.ts` | 1 | 0% / +13/-32 | kvox-divergence | app-owned (`host` bootstrap) | issue 1.2 | Bootstrap (+13/-32). Stays app-owned; 1.2 swaps hand-rolled pipes, filters and docs registration for the host bootstrap. |
| `nodes` | 36 | 0% / +292/-509 | noise | `nodes` | issue 2.1 | Differences are DTO/doc and vitals (base migration `add_worker_node_vitals`). Node-eligible contracts live under `jobs/contracts`, handled in the `jobs` row. |
| `notes` | 86 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/notes` | Epic 6 | Notes, templates, generation, SSE stream, exports, retitle. |
| `notifications` | 65 | 1.3% / +1110/-1500 | backport | `notifications` | issue 2.3 | Largest changed-line module (+1,110/-1,500). KVox-only: note/transcript events in `notification-events.ts`, `browser-notification.channel.ts` templates. Workaround: domain event and template registration (`EVENT_EMAIL_TEMPLATES`, `EVENT_BROWSER_TEMPLATES`). Push, broadcasts, stream are noise. |
| `onboarding` | 7 | 0% / +216/-197 | backport | `onboarding` | issue 4.3 | `onboarding-steps.ts`, `admin-onboarding.controller.ts`. Workaround: onboarding step registry (user and admin steps registered from the app). |
| `openapi` | 16 | 22.2% / +35/-101 | noise | `host` (openapi) | issue 1.2 | Docs registration (Scalar) and version resolver; KVox-only `tags.ts` is a tag list that moves to host options. |
| `pat` | 8 | 16.7% / +47/-137 | noise | `identity` (pat) | issue 1.3 | Service shrinks (+30/-108) where the package adds org scope. |
| `prisma` | 3 | n/a / +0/-0 | kvox-divergence | app-owned (`PLATFORM_PRISMA` port) | issue 1.2 | KVox `PrismaService` is bound to the `PLATFORM_PRISMA` port by the app; KVox keeps its own generated client and schema. |
| `search` | 39 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/search` | Epic 6 | Full-text + vector search over transcripts and notes. Embedding catalog stays KVox-owned. |
| `settings` | 23 | 0% / +755/-372 | backport | `settings` | issue 1.4 | KVox system namespaces (`notifications`, `jobs`, `nodes`, `databaseBackup`, `maintenance`, `transcription`, `ai`) and user namespaces (`onboarding`, `graph`). Workarounds: `ai` namespace extension (3.1); generic user-settings change event workaround (EAB `UserSettingsNamespace` has no change hook, KVox adds a KVox-only onChanged/generic event that issue 1.4 must carry, replacing the direct `GRAPH_PREFERENCES_CHANGED_EVENT` emit); `profile-image` side module (avatar upload, absent in EAB). |
| `storage` | 35 | 1.2% / +723/-515 | backport | `storage` | issue 2.2 | `managed_by`/`part_size`, resumable-upload hardening, upload events. Workarounds: `kvox_object_ownership` side table (managedBy, partSize); post-upload processor (`ObjectUploaded` listeners); abort reconcile (`ObjectUploadAborted` listeners). |
| `test-auth` | 7 | n/a / +0/-0 | noise | `identity` (testing) | issue 1.3 | CI-only test login. No file at the same path in the package (7 app-only); EAB exposes test auth through `identity/testing`. Unsure: confirm equivalence in 1.3. |
| `transcription` | 26 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/transcription` | Epic 6 | Provider registry (AssemblyAI), settings, keyterms, normalized transcript. |
| `transcripts` | 116 | n/a / +0/-0 | domain | `@marinoscar/kvox-api/transcripts` | Epic 6 | Pipeline (7 job types), editing/versions/ops, shares, exports, name checks. |
| `user-data` | 10 | 0% / +613/-515 | backport | `user-data` | issue 4.2 | Purge handler (+335/-39) clears Restrict FKs and fans out to `transcript.purge`/`note.purge`/`kg.purge`. Workaround: `files` category override plus KVox domain categories (transcripts, notes, graph, ask) registered on the package categories. |
| `users` | 11 | 25% / +53/-194 | noise | `identity` (users) | issue 1.3 | Service shrinks (+40/-155) where the package adds org membership. |
| `common` (root files: `common.module.ts`, `database-url.ts`) | 3 | 33.3% / +28/-5 | noise | `core` | issue 1.2 | Module wiring and DB URL builder. |
| `common/constants` | 1 | 0% / +41/-16 | domain | `@marinoscar/kvox-api` (permission manifest) | issue 1.3 | `roles.constants.ts` (+41/-16) carries KVox permissions (`transcripts:*`, `notes:*`, `graph:*`, `db_backup:*`, ...). Registered through the permission manifest; base permissions come from `identity`. |
| `common/crypto` | 3 | n/a / +0/-0 | noise | `core` (secrets) | issue 1.4 | `secret-cipher.ts`, encryption-key startup check; `encryptSecret(raw, 'ai-key')` purpose strings stay in KVox. |
| `common/decorators` | 2 | 0% / +88/-2 | noise | `host` | issue 1.2 | `api-data-response.decorator.ts` (+88/-2), `trace.decorator.ts`. Unsure: confirm no KVox-only response envelope behaviour. |
| `common/dto` | 1 | n/a / +0/-0 | noise | `host` | issue 1.2 | Error DTO. |
| `common/exceptions` | 2 | n/a / +0/-0 | noise | `core` | issue 1.2 | Database seed and verbatim-error-body exceptions (RFC 8628 error shape used by device auth). |
| `common/filters` | 2 | n/a / +0/-0 | noise | `host` (http) | issue 1.2 | Global HTTP exception filter. |
| `common/interceptors` | 4 | n/a / +0/-0 | noise | `host` (http) | issue 1.2 | Logging and `{ data, meta }` transform interceptors. |
| `common/logger` | 4 | n/a / +0/-0 | noise | `host` | issue 1.2 | Pino logger module and config. |
| `common/maintenance` | 12 | 50% / +4/-1 | noise | `host` (maintenance) | issue 1.2 | Maintenance mode guard/service/controller; one file identical, one differs by 4 lines. |
| `common/middleware` | 2 | n/a / +0/-0 | noise | `host` (http) | issue 1.2 | Request-id middleware. |
| `common/otel` | 2 | 0% / +0/-0 | noise | `otel-core` | issue 1.2 | `service-name.ts`; package ships `telemetry-identity.ts` and the metric manifest. |
| `common/profile-image` | 2 | n/a / +0/-0 | backport | `settings` (KVox side module) | issue 1.4 | Avatar upload helpers (`AVATAR_PURPOSE`, size ceiling); EAB has no avatar upload. Workaround: `profile-image` side module, objects stamped via `metadata.purpose`. |
| `common/schemas` | 4 | 0% / +403/-224 | backport | `settings` | issue 1.4 | `settings.schema.ts` (+191/-130), `user-settings-namespaces.schema.ts` (+209/-35). Workaround: `ai` namespace extension and generic user-settings change event workaround, registered as namespaces on the package registry. |
| `common/services` | 2 | n/a / +0/-0 | noise | `identity` (auth) | issue 1.3 | `admin-bootstrap.service.ts`; `INITIAL_ADMIN_EMAIL` handling is in the package. |
| `common/types` | 1 | 0% / +121/-4 | backport | `settings` | issue 1.4 | `settings.types.ts` (+121/-4) typed KVox namespaces. Same workaround as `common/schemas`. |

## Web: apps/web/src

Top-level entries: `App.tsx`, `__tests__`, `components`, `config`, `contexts`, `hooks`, `main.tsx`, `pages`, `services`, `sw.ts`, `theme`, `types`, `utils`, `vite-env.d.ts`. EAB keeps its web code in `packages/platform-web`, so most KVox files have no same-path counterpart in the apps view and show `n/a`; rows marked provisional need a re-diff against the package by the owning issue before anything is deleted. Mixed folders (`components/admin`, `hooks`, `pages`, `pages/Admin`, `services`) are split into several rows that together cover every file.

apps/web/src/components: admin, ai, ask, auth, common, datatable, device-activation, graph, home, library, navigation, notes, notifications, onboarding, pwa, search, settings, transcripts, upload.

apps/web/src/pages: every file plus the `Admin` folder, grouped by owner below.

| Module | Files (kvox) | Drift (identical % / lines +/-) | Category | Target slice / package | Issue | Notes |
|---|---|---|---|---|---|---|
| `App.tsx` | 1 | 0% / +180/-270 | kvox-divergence | `shell` / `host` (app-owned routes) | issue 4.6 | Route table is the app's. 4.6 swaps providers and layout for the package shell; destinations registry stays (see `config`). |
| `main.tsx` | 1 | 0% / +0/-10 | noise | `host` | issue 4.6 | Bootstrap lost 10 lines. |
| `sw.ts` | 1 | 0% / +141/-8 | kvox-divergence | `host` (ui) | issue 4.6 | Service worker with push and notificationclick handlers (+141/-8). Kept until `host` ui offers the same injectManifest worker. |
| `vite-env.d.ts` | 1 | 100% / +0/-0 | noise | `host` | issue 4.6 | Normalised-identical. |
| `__tests__` | 273 | 7.1% / +3418/-2095 | domain | `@marinoscar/kvox-web` | Epic 7 | Tests follow their module: tests of replaced base modules are deleted by the owning issue, domain tests stay. 394 files, 121 base-only in EAB. |
| `components/admin` (users, allowlist) | 7 | n/a / +0/-0 | backport | `identity` | issue 1.3 | Allowlist reminder button and `reminderCount` columns. Workaround: `kvox_allowlist_reminders` (row action registered on the allowlist table). |
| `components/admin` (AI) | 7 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | UI for KVox's own AI policy (permitted models, task models, graph switch). Kept until the package AI admin pages cover it. |
| `components/admin` (notifications, push) | 4 | n/a / +0/-0 | noise | `notifications` | issue 2.3 | Broadcast and push configuration UI. Provisional: no per-file diff in the apps view. |
| `components/admin` (worker nodes) | 3 | n/a / +0/-0 | noise | `nodes` | issue 2.1 | Provisional: no per-file diff in the apps view. |
| `components/admin` (db backup) | 2 | n/a / +0/-0 | noise | `db-backup` | issue 2.4 | Provisional: no per-file diff in the apps view. |
| `components/ai` | 1 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | Model picker for note generation (user AI key). |
| `components/ask` | 16 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/ask` | Epic 7 | Ask conversation UI. |
| `components/auth` | 1 | n/a / +0/-0 | noise | `identity` | issue 1.3 | OAuth button. |
| `components/common` | 11 | 66.7% / +52/-22 | noise | `shell` | issue 4.6 | Layout (+52/-22), error boundary, spinner, route guards, maintenance gate/banner. Two files already identical. |
| `components/datatable` | 44 | n/a / +0/-0 | noise | `datatable` | issue 4.6 | 44 files with no same-path counterpart (EAB holds them in `platform-web/datatable`). Provisional: re-diff against the package before deleting. |
| `components/device-activation` | 5 | n/a / +0/-0 | noise | `identity` | issue 1.3 | Device authorization UI. |
| `components/graph` | 65 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/graph` | Epic 7 | sigma.js explorer, entity page, proposals review. |
| `components/home` | 15 | 0% / +0/-0 | domain | `@marinoscar/kvox-web/home` | Epic 7 | Home page sections; `QuickActions.tsx` exists only in EAB. |
| `components/library` | 7 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/library` | Epic 7 | Transcripts and notes library views. |
| `components/navigation` | 5 | 0% / +697/-31 | kvox-divergence | `shell` | issue 4.6 | Rail, bottom bar, app bar, user menu (+697/-31) built on `destinations.ts`; keep the destinations registry. Four-tab ceiling and pinned destinations are KVox UX decisions. |
| `components/notes` | 26 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/notes` | Epic 7 | Note editor, templates, generation view. |
| `components/notifications` | 1 | n/a / +0/-0 | noise | `notifications` | issue 2.3 | Permission banner. |
| `components/onboarding` | 5 | n/a / +0/-0 | backport | `onboarding` | issue 4.3 | Banner, welcome, checklist. Workaround: onboarding step registry (step paths in `onboardingPaths.ts`). |
| `components/pwa` | 2 | n/a / +0/-0 | noise | `host` (ui) | issue 4.6 | Install and update prompts. |
| `components/search` | 3 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/search` | Epic 7 | Search UI. |
| `components/settings` | 11 | n/a / +0/-0 | noise | `settings` | issue 1.4 | Settings hub, profile, theme, PAT dialogs, notification settings. `UserDataDeleteDialog.tsx` goes with `user-data` (4.2). Provisional: no per-file diff. |
| `components/transcripts` | 20 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/transcripts` | Epic 7 | Transcript viewer, editor, speakers, exports. |
| `components/upload` | 1 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/transcripts` | Epic 7 | Keep-screen-awake toggle for long uploads. |
| `config` | 3 | 0% / +264/-140 | kvox-divergence | `shell` (registries stay app-owned) | issue 4.6 | `adminSections.tsx`, `destinations.ts`, `userSettingsSections.tsx` are KVox registries (settings hub, destination model); EAB-only `shell.ts`, `androidApp.ts`. |
| `contexts` | 6 | 0% / +56/-8 | noise | `identity` | issue 1.3 | Auth, theme, notification, onboarding, upload-manager, navigation contexts. `UploadManagerContext.tsx` is domain and stays. |
| `hooks` (platform) | 27 | 50% / +357/-33 | noise | `settings` / `identity` / `jobs` / `notifications` (per hook) | issue 1.4 | Data hooks for base endpoints; `useUserSettings`/`useSystemSettings`/`useMaintenance` carry KVox typed namespaces (+93 to +116 lines). |
| `hooks` (allowlist) | 1 | n/a / +0/-0 | backport | `identity` | issue 1.3 | Reminder mutation: `kvox_allowlist_reminders`. |
| `hooks` (AI) | 3 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | AI policy and per-user credential hooks. |
| `hooks` (domain) | 40 | n/a / +0/-0 | domain | `@marinoscar/kvox-web` | Epic 7 | Graph, Ask, notes, transcripts, search, upload manager, playback hooks. `useUnsavedChangesWarning` is in the platform row. |
| `pages` (identity) | 4 | 100% / +0/-0 | noise | `identity` | issue 1.3 | `TestLoginPage.tsx` is identical; EAB places `LoginPage` under `identity/`. Files: `LoginPage.tsx`, `AuthCallbackPage.tsx`, `ActivateDevicePage.tsx`, `TestLoginPage.tsx`. |
| `pages` (host) | 1 | n/a / +0/-0 | noise | `host` (ui) | issue 4.6 | Maintenance page. Files: `MaintenancePage.tsx`. |
| `pages` (onboarding) | 1 | n/a / +0/-0 | backport | `onboarding` | issue 4.3 | Workaround: onboarding step registry. Files: `GettingStartedPage.tsx`. |
| `pages` (home) | 1 | 0% / +126/-20 | domain | `@marinoscar/kvox-web/home` | Epic 7 | Home dashboard (+126/-20). Files: `HomePage.tsx`. |
| `pages` (library) | 4 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/library` | Epic 7 | Library pages and filter helpers. Files: `NotesPage.tsx`, `TranscriptsPage.tsx`, `notesLibraryFilters.ts`, `transcriptsLibraryFilters.ts`. |
| `pages` (transcripts, notes) | 8 | n/a / +0/-0 | domain | `@marinoscar/kvox-web` | Epic 7 | Create, view and history pages. Files: `NewNotePage.tsx`, `NewTranscriptPage.tsx`, `NoteHistoryPage.tsx`, `NotePage.tsx`, `TranscriptHistoryPage.tsx`, `TranscriptPage.tsx`, `newNote.ts`, `newTranscript.ts`. |
| `pages` (knowledge) | 6 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/graph` | Epic 7 | `knowledge` destination routes. Files: `AskPage.tsx`, `GraphEntityPage.tsx`, `GraphExplorerPage.tsx`, `GraphImportPage.tsx`, `GraphIndexPage.tsx`, `GraphOverviewPage.tsx`. |
| `pages` (user settings, platform) | 6 | 0% / +1/-12 | noise | `settings` | issue 1.4 | `UserSettingsHubPage.tsx` differs by +1/-12 (binds `SettingsHub`). Tokens page goes to `identity`, notifications to `notifications`. Files: `UserAppearancePage.tsx`, `UserNotificationsPage.tsx`, `UserProfilePage.tsx`, `UserSettingsHubPage.tsx`, `UserSettingsSection.tsx`, `UserTokensPage.tsx`. |
| `pages` (user data) | 1 | n/a / +0/-0 | backport | `user-data` | issue 4.2 | Scope matrix includes KVox categories. Workaround: `files` category override and domain categories. Files: `UserDangerZonePage.tsx`. |
| `pages` (user AI) | 1 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | Per-user AI key page. Files: `UserAiPage.tsx`. Replaced in #477 by the platform `UserAiKeysPage`; the file is deleted. |
| `pages` (user, domain) | 3 | n/a / +0/-0 | domain | `@marinoscar/kvox-web` | Epic 7 | Graph preferences, note templates, search index. Files: `UserKnowledgeGraphPage.tsx`, `UserNoteTemplatesPage.tsx`, `UserSearchIndexPage.tsx`. |
| `pages/Admin` (host, settings) | 5 | 0% / +701/-16 | noise | `host` / `settings` / `email` | issue 1.2 | AboutPage (+425/-2) and MaintenancePage (+275/-2) are the largest; both are KVox-written pages for the same endpoints the package now serves. Files: `Admin/AboutPage.tsx`, `Admin/MaintenancePage.tsx`, `Admin/SettingsHubPage.tsx`, `Admin/SystemSettingsSection.tsx`, `Admin/EmailSettingsPage.tsx`. |
| `pages/Admin` (jobs, workers, db backup, notifications) | 11 | n/a / +0/-0 | noise | `jobs` / `nodes` / `db-backup` / `notifications` | issue 2.1 | Operations group pages. Provisional: no per-file diff. Files: `Admin/BroadcastsPage.tsx`, `Admin/broadcastsTable.tsx`, `Admin/DbBackupPage.tsx`, `Admin/dbBackupTable.tsx`, `Admin/JobInsightsPage.tsx`, `Admin/JobsPage.tsx`, `Admin/jobsTable.tsx`, `Admin/WorkersPage.tsx`, `Admin/workersTable.tsx`, `Admin/NotificationSettingsPage.tsx`, `Admin/PushConfigPage.tsx`. |
| `pages/Admin` (users) | 1 | n/a / +0/-0 | backport | `identity` | issue 1.3 | Users and Allowlist tabs; workaround `kvox_allowlist_reminders`. Files: `Admin/UsersPage.tsx`. |
| `pages/Admin` (setup) | 1 | n/a / +0/-0 | backport | `onboarding` | issue 4.3 | Admin setup checklist; workaround: onboarding step registry. Files: `Admin/SetupPage.tsx`. |
| `pages/Admin` (AI) | 1 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | AI policy page. Files: `Admin/AiSettingsPage.tsx`. Replaced in #477 by the platform `AiConfigPage`; the file is now a thin binding that mounts KVox's task-model, graph and ceiling sections in the page's `Sections` slot. |
| `pages/Admin` (transcription) | 1 | n/a / +0/-0 | domain | `@marinoscar/kvox-web/transcripts` | Epic 7 | Provider settings; registered as an admin section. Files: `Admin/TranscriptionSettingsPage.tsx`. |
| `services` (platform) | 12 | 0% / +80/-13 | noise | `jobs` / `nodes` / `notifications` / `db-backup` / `host` (per service) | issue 2.1 | Thin API clients for base endpoints. `maintenance.ts` differs (+80/-13). |
| `services/api.ts` | 1 | 0% / +356/-18 | kvox-divergence | `core` (api client) | issue 1.4 | HTTP client with 356 added lines of domain endpoints. Core client moves to the package; domain endpoints split out to the domain services. |
| `services` (upload) | 3 | n/a / +0/-0 | backport | `storage` | issue 2.2 | Resumable multi-GB upload client with persisted part size. Workarounds: `kvox_object_ownership`, abort reconcile (API side); client stays as a wrapper over the `storage` web slice. |
| `services` (AI) | 1 | n/a / +0/-0 | kvox-divergence | `ai` | Epic 3 | AI settings and credential client. |
| `services` (domain) | 15 | n/a / +0/-0 | domain | `@marinoscar/kvox-web` | Epic 7 | Transcripts, notes, graph, Ask, search clients and their SSE streams. `storage.ts` exists only in EAB. |
| `theme` | 5 | 0% / +104/-17 | kvox-divergence | `shell` (theme) | issue 4.6 | KVox brand tokens (dark/light +35 each). App-owned brand over the package theme factory. |
| `types` | 1 | 0% / +337/-47 | domain | `@marinoscar/kvox-web` | Epic 7 | `index.ts` (+337/-47) mixes API DTO types; platform types come from `platform-contract` after 1.x. |
| `utils` | 14 | 50% / +10/-0 | domain | `@marinoscar/kvox-web` | Epic 7 | Feed, graph, transcript and playback helpers; `relativeTime.ts` (+10) is the one platform-adjacent file. |

## CLI: apps/cli/src

Directories: `__fixtures__`, `commands`, `deploy`, `init`, `node`, `tui`; root files are grouped as `(root)`. The CLI is compared against `packages/platform-cli/src/engine`. Phase 4.4 rebuilds the program with `createCli`; the CLI-version-bump rule applies to that work, not to this classification.

| Module | Files (kvox) | Drift (identical % / lines +/-) | Category | Target slice / package | Issue | Notes |
|---|---|---|---|---|---|---|
| `__fixtures__` | 2 | n/a / +0/-0 | kvox-divergence | `deploy` (testing) | issue 4.4 | Bootstrap-VPS dry-run fixtures for `bootstrap-vps.test.ts`; follow the install script. |
| `commands` | 8 | 0% / +1752/-1271 | kvox-divergence | `commands` | issue 4.4 | `api`, `config`, `deploy`, `init`, `login`, `node` (+1,752/-1,271). 4.4 rebuilds the program with `createCli`, keeping KVox flags and the `KVOX_` prefix. |
| `deploy` | 76 | 0% / +12551/-8665 | kvox-divergence | `deploy` | issue 4.4 | Highest drift in the repository (+12,551/-8,665): the VPS engine (checks, steps, wizard, adopt, uninstall extras, deploy-info). KVox keeps its design (runs on the VPS, shared proxy, no db service) until `createCli` carries the same behaviour; 4.4 converges it. |
| `init` | 2 | 0% / +8/-23 | noise | `commands` | issue 4.4 | Local profile + `run-init`. |
| `node` | 52 | 19.3% / +381/-1581 | kvox-divergence | `node` | issue 4.4 | Worker-node daemon, enrollment, tuning, watchdog. Older than the package (+381/-1,581); converges onto `platform-cli/node`. |
| `node` (executor `media-audio-transcode.ts`) | 1 | n/a / +0/-0 | domain | `@marinoscar/kvox-node` | Epic 7 | ffmpeg transcode executor for `media.audio.transcode`; stays KVox-owned. |
| `tui` | 67 | 8.3% / +3454/-1257 | kvox-divergence | `tui` | issue 4.4 | ink menu and deploy/node screens (+3,454/-1,257). Converges screen by screen. |
| `(root)` | 30 | 22.6% / +211/-251 | noise | `core` / `engine` / `api-client` | issue 4.4 | `api-client`, `branding`, `config`, `device-auth`, `device-login`, `errors`, `output`, `package-info`, `program`, `prompt`, `cli.ts`, `index.ts`, install/rename script tests. Identity differences (kvox vs appctl) are normalised. |

## Prisma and infra

| Module | Files (kvox) | Drift (identical % / lines +/-) | Category | Target slice / package | Issue | Notes |
|---|---|---|---|---|---|---|
| `apps/api/prisma/schema.prisma` | 1 | n/a / +0/-0 | kvox-divergence | `platform-db` (schema fragments) | issue 1.1 | Single hand-maintained schema; EAB assembles from fragments + a catalog. KVox keeps its schema and extends models (see Prisma models). |
| `apps/api/prisma/seed.ts`, `seed-data.ts` | 2 | 0% / +477/-17 | backport | `platform-db` (seed) | issue 1.1 | Roles/permissions seed with KVox permission rows (+352/-11). Workaround: permission manifest registration and a KVox seed step run after the platform seed. |
| `apps/api/prisma` (tsconfig, .gitkeep) | 2 | 50% / +1/-3 | noise | `platform-db` | issue 1.1 | Config only. |
| `infra/compose` | 11 | 20% / +35/-104 | kvox-divergence | `platform-infra` | issue 4.5 | KVox compose files (worker, vps, devdb, otel) and `.env.example`; three files already normalised-identical. |
| `infra/nginx` | 3 | 0% / +10/-75 | noise | `platform-infra` | issue 4.5 | CSP and routing (+10/-75). |
| `infra/otel` | 2 | 0% / +16/-182 | noise | `platform-infra` (telemetry) | issue 4.5 | Collector config (+16/-182); the backend-specific config file was KVox-only (removed in #471). |

## Migrations

KVox has 36 migrations, EAB 37; 14 are shared by name, 0 renamed.

### App-only migrations (22)

| Migration | Category | Handling | Issue |
|---|---|---|---|
| `20260914120000_add_storage_part_size_and_managed_by` | backport | `kvox_object_ownership` side table (`managed_by`, `part_size`) | issue 2.2 |
| `20260914130000_add_transcripts` | domain | transcripts, speakers, segments, versions, shares, exports | Epic 6 |
| `20260914140000_add_notes` | domain | notes, templates, generations, versions, exports | Epic 6 |
| `20260914150000_add_user_ai_credentials` | kvox-divergence | `user_ai_credentials` kept; package uses `UserAiKey`. Data moved by #474; table dropped by migration `drop_user_ai_credentials` (#477) | Epic 3 (done) |
| `20260915120000_add_search_vectors` | domain | generated tsvector columns + GIN indexes (hand-written SQL) | Epic 6 |
| `20260915130000_add_search_embeddings` | domain | pgvector `search_embeddings`; embedding catalog stays KVox-owned | Epic 6 |
| `20260915210000_add_note_title_source` | domain | `notes.title_source` | Epic 6 |
| `20260918120000_add_allowlist_reminder_tracking` | backport | `kvox_allowlist_reminders` side table (`reminder_count`, `last_reminder_at`) | issue 1.3 |
| `20260923120000_add_note_generation_context_snapshot` | domain | `note_generations` context columns | Epic 6 |
| `20260923130000_add_user_hidden_note_templates` | domain | `user_hidden_note_templates` | Epic 6 |
| `20260923140000_add_transcript_speaker_identities` | domain | `transcripts.speaker_identities` | Epic 6 |
| `20260923150000_transcript_name_checks` | domain | `transcript_name_checks`, `transcript_name_suggestions` | Epic 6 |
| `20260923160000_add_note_body_format` | domain | `notes.body_format` | Epic 6 |
| `20260923170000_add_note_version_body_format` | domain | `note_versions.body_format` | Epic 6 |
| `20260926012548_add_knowledge_graph` | domain | `kg_*` tables, pg_trgm, pgvector HNSW | Epic 6 |
| `20260926030000_fix_kg_relations_valid_precision_chk` | domain | CHECK fix on `kg_relations` | Epic 6 |
| `20260926030100_add_transcript_recorded_at` | domain | `transcripts.recorded_at` | Epic 6 |
| `20260926030200_kg_evidence_invariant` | domain | deferred `kg_assert_has_evidence` trigger | Epic 6 |
| `20260926040000_add_kg_graph_layouts` | domain | `kg_graph_layouts` | Epic 6 |
| `20260926050000_add_ask_conversations` | domain | `ask_conversations`, `ask_messages` | Epic 6 |
| `20260926231512_add_kg_exports` | domain | `kg_exports` | Epic 6 |
| `20260927050000_ai_token_limits_follow_model` | kvox-divergence | data migration clearing `ai.maxInputTokens`/`maxOutputTokens` defaults; carried as `ai` namespace extension | Epic 3 |

App-only totals: 18 domain, 2 backport, 2 kvox-divergence, 0 noise. These migrations stay in KVox's `apps/api/prisma/migrations` and are applied after the platform migrations by `prisma migrate deploy`.

### Base-only migrations (23)

All 23 are **installed by `platform db baseline --through` (issue 1.1)**: baseline marks the 14 shared migrations as applied, then `prisma migrate deploy` applies these as new migrations. Order is by timestamp.

| Migration | Handling |
|---|---|
| `20260908120000_add_job_claim_token` | installed by baseline `--through` (issue 1.1) |
| `20260926034919_add_ai_platform` | installed by baseline `--through` (issue 1.1) |
| `20260927000000_revoke_viewer_ai_use` | installed by baseline `--through` (issue 1.1) |
| `20260927120000_add_user_credentials` | installed by baseline `--through` (issue 1.1) |
| `20260927130000_add_device_session_credential_link` | installed by baseline `--through` (issue 1.1) |
| `20260928100000_add_worker_node_vitals` | installed by baseline `--through` (issue 1.1) |
| `20260930120000_add_job_trace_context` | installed by baseline `--through` (issue 1.1) |
| `20261006120000_add_retention_created_at_indexes` | installed by baseline `--through` (issue 1.1) |
| `20261007141244_add_organizations` | installed by baseline `--through` (issue 1.1) |
| `20261007161956_split_system_org_roles` | installed by baseline `--through` (issue 1.1) |
| `20261007202337_org_scoped_rls` | installed by baseline `--through` (issue 1.1) |
| `20261007222406_add_groups` | installed by baseline `--through` (issue 1.1) |
| `20261008000859_add_grants` | installed by baseline `--through` (issue 1.1) |
| `20261008012052_add_org_settings` | installed by baseline `--through` (issue 1.1) |
| `20261008041856_add_org_credentials` | installed by baseline `--through` (issue 1.1) |
| `20261008052119_add_jobs_org_id` | installed by baseline `--through` (issue 1.1) |
| `20261008052120_add_jobs_org_id_status_index` | installed by baseline `--through` (issue 1.1) |
| `20261008080749_add_broadcast_target_org` | installed by baseline `--through` (issue 1.1) |
| `20261008120000_add_android_app` | installed by baseline `--through` (issue 1.1) |
| `20261013115831_open_job_reason` | installed by baseline `--through` (issue 1.1) |
| `20261013154013_ai_usage_feature` | installed by baseline `--through` (issue 1.1) |
| `20261013195500_add_app_metadata` | installed by baseline `--through` (issue 1.1) |
| `20261013214001_open_sharing_vocabularies` | installed by baseline `--through` (issue 1.1) |

### Shared migrations (14)

Same name on both sides, no action: `20260124223146_initial`, `20260329151231_add_personal_access_tokens`, `20260830211041_add_credentials`, `20260831010356_add_notification_deliveries`, `20260831014110_drop_stale_uuid_defaults`, `20260831030721_add_notifications`, `20260905182958_add_push_subscriptions`, `20260906120000_add_jobs`, `20260906190000_add_worker_nodes`, `20260907120000_add_database_backup_runs`, `20260907130000_add_notification_broadcasts`, `20260907140000_add_backup_run_job_link`, `20260907150000_add_job_node_secrets`, `20260907160000_add_backup_run_pg_dump_version`.

## Prisma models

26 of EAB's 41 models exist in KVox, 35 models are KVox-only (all domain, they stay in `schema.prisma`), and 15 base models are missing (`Organization`, `Membership`, `Invite`, `Group*`, `Grant`, `OrgSettings`, `OrgCredential`, `AiModel`, `AiRun`, `AiUsageEvent`, `UserAiKey`, `UserCredential`, `AndroidAppRelease`; installed by the base-only migrations above). The 14 models present on both sides with field differences:

| Model | KVox-added fields | Removed vs base | Where it goes | Notes |
|---|---|---|---|---|
| `AllowedEmail` | `lastReminderAt`, `reminderCount` | - | side table `kvox_allowlist_reminders` (`allowed_email_id` FK, `reminder_count`, `last_reminder_at`) | Carry existing values in a data step in issue 1.3, then drop the two columns. |
| `AuditEvent` | - | `org`, `orgId` | none | Base adds `org_id`; KVox runs single-org (default org backfill). |
| `DeviceCode` | - | `collectedAt`, `credentialExpiresAt`, `org`, `orgId`, `pat`, `patId`, `refreshTokens`, `revokedAt` | none | Base adds credential-link columns (base migration). |
| `Job` | `askMessage`, `kgExport`, `kgProposal`, `noteExport`, `noteGeneration`, `transcriptExport`, `transcriptNameCheck` | `claimToken`, `org`, `orgId`, `traceContext` | extend model (back-relations only) | Seven relations to KVox tables that hold the `job_id` FK; no column on `jobs`. |
| `NotificationBroadcast` | - | `targetOrg`, `targetOrgId` | none | Base adds `target_org_id`. |
| `Permission` | - | `scope` | none | Base adds `scope`. |
| `PersonalAccessToken` | - | `deviceCodes`, `org`, `orgId` | none | Base adds `org_id`. |
| `PushSubscription` | - | `platform` | none | Base adds `platform`. |
| `RefreshToken` | - | `deviceCode`, `deviceCodeId`, `org`, `orgId` | none | Base adds `org_id`, device-code link. |
| `Role` | - | `invites`, `memberships`, `scope` | none | Base adds `scope`, memberships, invites. |
| `StorageObject` | `kgEvidenceImports`, `kgExportFiles`, `managedBy`, `noteExportFiles`, `notesAsSourceObject`, `partSize`, `transcriptExportFiles`, `transcriptVersionSnapshots`, `transcriptsAsPlayback`, `transcriptsAsRawResult`, `transcriptsAsSource` | `org`, `orgId` | side table `kvox_object_ownership` (`object_id` FK, `managed_by`, `part_size`) plus extend model (back-relations only) | The two columns move to the side table in issue 2.2; the nine relations from transcripts, notes and graph tables stay as back-relations. |
| `StorageObjectChunk` | - | `org`, `orgId` | none | Base adds `org_id`. |
| `User` | `aiCredentials`, `askConversations`, `hiddenNoteTemplates`, `kgAttributeDefs`, `kgDistinctPairs`, `kgEntities`, `kgEntityAliases`, `kgEntityDigests`, `kgEntityViews`, `kgEvidence`, `kgExports`, `kgGraphLayouts`, `kgItems`, `kgMentions`, `kgMerges`, `kgProposals`, `kgRelations`, `noteExportsRequested`, `noteTemplatesOwned`, `noteVersionsAuthored`, `notes`, `searchIndexStates`, `transcriptExportsRequested`, `transcriptNameChecksRequested`, `transcriptNameSuggestionsDecided`, `transcriptSegmentEdits`, `transcriptSharesGranted`, `transcriptSharesReceived`, `transcriptVersionsAuthored`, `transcripts` | `aiKeys`, `aiModelsUpdated`, `aiRuns`, `aiUsageEvents`, `androidAppReleases`, `grantsGiven`, `grantsReceived`, `grantsRevoked`, `groupInvitesClaimed`, `groupInvitesSent`, `groupMembersAdded`, `groupMemberships`, `groupsCreated`, `invitesAccepted`, `invitesSent`, `memberships`, `metadata`, `orgCredentialUpdates`, `orgSettingsUpdates`, `organizationsCreated`, `userCredentials` | extend model (back-relations only) | Thirty relations from KVox tables (notes, transcripts, `kg_*`, Ask, AI credentials). Domain tables own the FK; `users` gets no column. |
| `WorkerNode` | - | `lastVitals`, `lastVitalsAt` | none | Base adds `last_vitals`, `last_vitals_at`. |

"Extend model" means adding relation fields to the package model through the schema assembly in issue 1.1; no column is added to the package table. "Side table" means KVox owns a new table and the package model stays untouched.
