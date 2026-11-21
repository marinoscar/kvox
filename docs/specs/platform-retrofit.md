# Platform retrofit and domain packaging

**Audience:** engineers and coding agents working on the retrofit program.
**Status:** approved plan; execution starts with [#456](https://github.com/marinoscar/kvox/issues/456). Tracking: eight epics, [#457](https://github.com/marinoscar/kvox/issues/457) to [#498](https://github.com/marinoscar/kvox/issues/498).
**Baseline:** kvox at commit `6e44e43`; platform packages at `0.1.0-next.5`.

This spec is the roadmap. The issues hold the step-by-step detail. If an issue and this spec disagree, the issue wins, and this spec gets fixed.

## 1. Why

kvox began as a fork of EnterpriseAppBase (EAB). EAB has since moved its base modules into published packages: `@marinoscar/platform-{contract,api,web,db,cli,infra}`. They are on public npm at `0.1.0-next.5`.

kvox still carries its own copy of every base module. The numbers at `6e44e43`:

| Area | Fact |
|---|---|
| API | 2 of 265 base files identical to EAB's |
| Prisma | one 5,134-line `schema.prisma`; 36 migrations mixing platform and domain changes |
| Docs for agents | `CLAUDE.md` is about 190 KB; EAB uses a 24 KB `AGENTS.md` plus a thin `CLAUDE.md` |

Two goals follow.

1. **Retrofit.** Run kvox on the platform packages, using the EAB guide ([ADOPTING-THE-PLATFORM.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/ADOPTING-THE-PLATFORM.md)). Delete each kvox copy in the PR that adopts its replacement.
2. **Package the domain.** Move transcription, transcripts, search, notes, graph, ask and the ontology into `@marinoscar/kvox-*` packages.

The second goal exists for **KVox Desktop**: an offline app, React and Node, with an embedded Postgres and the Copilot SDK for AI. It reuses the domain packages. It does not use the platform packages.

## 2. Decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | Domain packages live in this repo (`packages/kvox-*`) and publish to public npm under `@marinoscar/`. | A release pipeline is part of the program (#487). |
| D2 | Desktop uses embedded Postgres. | Packages keep Prisma and Postgres SQL (`tsvector`, `tstzrange`, `pg_trgm`, `vector`). Only AI, storage, jobs, identity, notify and a few more sit behind ports. |
| D3 | Platform gaps are worked around in kvox. No seam PRs to EAB. | Every workaround is listed in section 4 and in `docs/platform-adoption/local-exceptions.md` (created in #463). |
| D4 | kvox runs single-org (`TENANCY_MODE` unset). | Domain tables have no `org_id` and no RLS. They are registered as user-owned models. |
| D5 | A job `type` string is permanent. | All 41 types at `6e44e43` keep their strings. A snapshot test pins them (#468). |
| D6 | Pixels do not change. | The visual regression suite stays green with no new baselines. |

## 3. Target architecture

### 3.1 Packages

| Package | Contents | Format |
|---|---|---|
| `@marinoscar/kvox-contract` | Zod wire schemas per slice, error codes, the ontology, the transcript export JSON schema | dual ESM and CJS |
| `@marinoscar/kvox-db` | Domain Prisma fragments, domain migrations, `kvox.lock`, `raw-sql-indexes.json`, `extensions.json`, a `kvox-db` bin | CJS |
| `@marinoscar/kvox-api` | Nest slices, each a `forRoot({ ports })` module, plus `core`, `ports`, `testing` | CJS |
| `@marinoscar/kvox-web` | `<slice>/headless` (clients, hooks, pure helpers) and `<slice>/ui` (MUI) | ESM |
| `@marinoscar/kvox-node` | The ffmpeg transcode executor. Later; not in this program. | - |

### 3.2 Subpaths

| Package | Subpaths |
|---|---|
| `kvox-contract` | `.`, `./transcription`, `./transcripts`, `./search`, `./notes`, `./graph`, `./ask`, `./ontology`, `./errors`, `./schemas/transcript-export.v1.json` |
| `kvox-api` | `./core`, `./ports`, `./testing`, `./transcription`, `./search`, `./transcripts`, `./notes`, `./graph`, `./graph-extraction`, `./graph-rdf`, `./ask`. Each slice also has a `/testing` entry. |
| `kvox-web` | `./core`, then `./<slice>/headless` and `./<slice>/ui` for transcription, transcripts, search, notes, graph, ask |

The graph slice is split into three subpaths (core, extraction, RDF) because extraction and RDF carry heavy optional dependencies (`n3`, `jsonld`, `rdf-validate-shacl`).

### 3.3 Slice graph (API)

| Slice | Depends on |
|---|---|
| `transcription` | ports, core |
| `search` | ports, core |
| `transcripts` | ports, core, transcription, search |
| `notes` | ports, core, transcripts, search |
| `graph` | ports, core, transcripts, notes, search |
| `graph-extraction` | ports, core, graph, notes, transcripts, search |
| `graph-rdf` | ports, core, graph, graph-extraction |
| `ask` | ports, core, graph, notes, search |

Search goes before transcripts. Transcripts import the search indexing module. Search only reads transcript tables through SQL.

### 3.4 Rules for packages

- Slices import only `@marinoscar/kvox-api/ports`. They never import `@marinoscar/platform-*`. The only code that imports the platform is `apps/api/src/platform-kvox/` (the web-edition adapters). A grep guard enforces this.
- Packages read no environment variables. The app reads env and passes values.
- Slices never import a generated Prisma client. They use structural row types, the pattern of EAB `packages/platform-api/src/ai/data/prisma.ts`.
- Crons only enqueue. A host without `ScheduleModule` calls the task's `tick()` itself.
- Permissions are exported as data. The app registers them.

### 3.5 Ports

| Token | Responsibility | Web edition backs it with | Desktop must implement |
|---|---|---|---|
| `KVOX_AI` | streamed text, `generateStructured`, streamed `chat` with tools, `embed`, `capabilities`, `resolveTask` | platform `ai` slice (`AiService.forUser`) plus the kvox streaming loop | Copilot SDK adapter |
| `KVOX_OBJECT_STORE` | resumable upload, put, read stream, signed URL, delete, ownership tag, upload-completed hook | platform `storage` slice (`ObjectsService`, processor registry) plus `kvox_object_ownership` | local filesystem store |
| `KVOX_JOBS` | enqueue, handler registration, provider throttle | platform `jobs` slice (`JobsService`, `JobHandlerRegistry`) | in-process queue on a `kvox_jobs` table |
| `KVOX_IDENTITY` | authenticate a request, permissions | platform `identity` slice (JWT guard, permissions guard) | one local user with all permissions |
| `KVOX_NOTIFY` | domain notification events | platform `notifications` slice (`registerNotificationEvent`) | OS notifications |
| `KVOX_EVENTS` | in-process events after commit | platform event bus | `EventEmitter2` |
| `KVOX_PRISMA` | the host's Prisma client, seen structurally | the app's `PrismaService` | Desktop client on embedded Postgres |
| `KVOX_SETTINGS` | read and patch the `transcription` namespace and per-user `graph` preferences | platform `settings` slice registries | local JSON file or table |
| `KVOX_SECRETS` | provider keys the domain owns (the transcription key) | platform `credentials` slice (`registerCredentialPurpose`) | OS keychain |
| `KVOX_AUDIT` | audit rows for settings and destructive actions; optional, no-op default | platform `AUDIT_SINK` | local log |
| `KVOX_BRAND` | product name and brand strings used in exports and prompts | `packages/shared` identity | static config |

Web side: one host port, `KvoxWebHost` (`http`, `sse`, `upload`, `viewer`, `links`, `features`). The web edition binds it in `apps/web/src/platform-kvox/KvoxHostBinding.tsx` with `createPlatformApiClient` and `connectSse` from `@marinoscar/platform-web/core`. Desktop binds it to its local server.

Fakes for every port ship in `@marinoscar/kvox-api/testing`. `describeKvoxPortsConformance` runs against the fakes and against the web-edition adapters.

### 3.6 App layout after the program

```
apps/api/src/kvox/<slice>/<slice>.config.ts   # the only place a slice is configured
apps/api/src/kvox/kvox.module.ts
apps/api/src/platform-kvox/                   # web-edition adapters for the ports
apps/web/src/platform-kvox/                   # KvoxHostBinding
apps/web/src/config/*                         # registries that spread package data
packages/kvox-{contract,db,api,web}/
examples/bare-host/                           # smoke app, no platform installed
```

## 4. Workarounds for platform gaps

All are in kvox code. None needs a change in EAB.

| Gap | Workaround | Issue |
|---|---|---|
| No domain registries in kvox base (base imports domain) | Local `defineRegistry`; registrations from `apps/api/src/kvox.manifest.ts`; boundary guard test | [#459](https://github.com/marinoscar/kvox/issues/459), [#460](https://github.com/marinoscar/kvox/issues/460) |
| `UserSettingsNamespace` has no change hook (graph preferences need one) | KVox-only `onChanged` hook, carried through the settings swap | [#459](https://github.com/marinoscar/kvox/issues/459), [#466](https://github.com/marinoscar/kvox/issues/466) |
| `platform db compose` reads one flat app fragment folder | Temporary deviations declared in `platform.lock`; later, `kvox-db sync` copies package fragments into `apps/api/prisma/fragments/` as `kvox.<slice>.prisma` | [#463](https://github.com/marinoscar/kvox/issues/463), [#489](https://github.com/marinoscar/kvox/issues/489) |
| Allowlist has no reminder counters | Side table `kvox_allowlist_reminders` plus an app route; reminder columns dropped | [#465](https://github.com/marinoscar/kvox/issues/465) |
| Storage `managed_by` | Side table `kvox_object_ownership`; one gateway, `KvoxManagedObjects`, running through `runInOrg` | [#469](https://github.com/marinoscar/kvox/issues/469) |
| Per-object `part_size` | Adopt the deployment-wide `storage.partSize`; operator rule: never change it while uploads are in flight; column dropped | [#469](https://github.com/marinoscar/kvox/issues/469) |
| No "upload completed" event | A kvox `ObjectProcessor` on the post-upload processor registry | [#469](https://github.com/marinoscar/kvox/issues/469) |
| No "upload aborted" event | Reconcile step in `transcripts.housekeeping` | [#469](https://github.com/marinoscar/kvox/issues/469) |
| Objects API signs only 10 part URLs and has no ListParts | KVox routes `POST` and `GET /api/storage/objects/:id/upload/parts` | [#469](https://github.com/marinoscar/kvox/issues/469) |
| User-data `files` category deletes managed objects | kvox `files` override that skips objects in `kvox_object_ownership` | [#480](https://github.com/marinoscar/kvox/issues/480) |
| Platform confirmation phrases differ from kvox's | Re-register `content` and `everything` with `overrideBuiltIn: true` | [#480](https://github.com/marinoscar/kvox/issues/480) |
| `ai` namespace has no tasks or `graphEnabled` | `extendSystemSettingsNamespace` plus a kvox `AI_TARGET_RESOLVER` that reproduces `chooseTaskModel` | [#473](https://github.com/marinoscar/kvox/issues/473) |
| Feature ids cannot contain dots | One feature id per call site (`note_generate`, `graph_extract`, `graph_agent`, `search_embed`, ...) plus a fixed map to task keys | [#473](https://github.com/marinoscar/kvox/issues/473) |
| Platform `AiError` codes differ from kvox wire codes | One mapper keeps `ai_not_configured`, `ai_key_missing`, `model_not_permitted`, `model_lacks_capability`, `graph_disabled`, and the job error classes | [#473](https://github.com/marinoscar/kvox/issues/473) |
| `embed()` has no model catalog | kvox embedding catalog (`text-embedding-3-small`, 1536 dimensions) in `apps/api/src/ai-port/` | [#475](https://github.com/marinoscar/kvox/issues/475) |
| Platform tool loop does not stream | kvox Ask loop over `AiUserClient.stream()`; keeps `answer-hold.ts`, `citations.ts`, caps, `finish_reason` | [#476](https://github.com/marinoscar/kvox/issues/476) |
| Platform onboarding steps duplicate kvox's | Drop kvox duplicates; register only domain steps; map stored intent | [#481](https://github.com/marinoscar/kvox/issues/481) |
| Restore does not know kvox extensions | Restore gate for `vector` and `pg_trgm`; RLS-aware role switch | [#471](https://github.com/marinoscar/kvox/issues/471) |
| Cross-slice cycles in kvox code | Shared helpers moved to `kvox-api/core` (`aiProviderThrottleKey`, ETag helpers, token budget, stream helpers); notes emits `kvox.notes.note_ready`, graph-extraction subscribes | [#490](https://github.com/marinoscar/kvox/issues/490), [#495](https://github.com/marinoscar/kvox/issues/495), [#496](https://github.com/marinoscar/kvox/issues/496) |
| Ports for secrets, audit, brand missing from the first sketch | `KVOX_SECRETS`, `KVOX_AUDIT`, `KVOX_BRAND` added | [#490](https://github.com/marinoscar/kvox/issues/490) |

## 5. Data migrations

| Migration | Mechanism | Where | Reversible by |
|---|---|---|---|
| Database history | `platform db baseline --through 14`. kvox migrations 1 to 14 equal platform 0001 to 0014 byte for byte. The 22 other kvox migrations stay as app migrations. Platform 0015 to 0037 install at the end and `prisma migrate deploy` applies them. | [#463](https://github.com/marinoscar/kvox/issues/463) | restore the pre-baseline backup |
| Roles and memberships | Platform `0024` moves `contributor` and `viewer` from `user_roles` to `memberships`. Needs the platform identity slice. | [#465](https://github.com/marinoscar/kvox/issues/465) | restore backup |
| Allowlist reminders | Columns to `kvox_allowlist_reminders`, then drop | [#465](https://github.com/marinoscar/kvox/issues/465) | restore backup |
| Object ownership | `storage_objects.managed_by` to `kvox_object_ownership`; drop `managed_by` and `part_size` | [#469](https://github.com/marinoscar/kvox/issues/469) | restore backup |
| Storage, SMTP, VAPID config | Re-entered in the admin UI (no env vars); secrets encrypted in `credentials`. Operator step in the deploy window. | [#469](https://github.com/marinoscar/kvox/issues/469), [#470](https://github.com/marinoscar/kvox/issues/470) | keep old values until verified |
| Database role | API role becomes `NOSUPERUSER NOBYPASSRLS`; ownership transferred; Doctor `db.rls_role` passes | [#471](https://github.com/marinoscar/kvox/issues/471) | role script reverse, restore backup |
| AI keys | `user_ai_credentials` to `user_ai_keys` with `importKey(..., { source: 'kvox' })`. Idempotent, dry run, per-provider counts. | [#474](https://github.com/marinoscar/kvox/issues/474) | old table stays until #477 |
| AI settings | `ai` provider settings to `ai_models`. Stored `taskModels` and `graphEnabled` keep their field names, so no rewrite. | [#474](https://github.com/marinoscar/kvox/issues/474) | old table stays until #477 |
| Onboarding intent | `onboarding.dismissedAt` to `checklistDismissedAt` | [#481](https://github.com/marinoscar/kvox/issues/481) | revert PR |
| Transcript shares (optional) | `transcript_shares` to `grants` | [#485](https://github.com/marinoscar/kvox/issues/485) | restore backup |
| Domain migrations to `kvox-db` | Files move byte for byte under original names; `kvox.lock` pins sha256 | [#489](https://github.com/marinoscar/kvox/issues/489) | revert PR |

Tenancy: single-org. There is no `org_id` on domain tables. RLS applies only to platform org tables such as `storage_objects`. Moving transcript sharing to grants is the one change that could add `org_id`, and only if #485 is taken.

## 6. Phase, epic and issue map

### 6.1 Epics

| Phase | Epic | Goal | Depends on |
|---|---|---|---|
| 0 Foundations | [#457](https://github.com/marinoscar/kvox/issues/457) (E0) | Agent tooling, drift baseline, base/domain cuts, repo tooling | none |
| 1 Adopt | [#462](https://github.com/marinoscar/kvox/issues/462) (E1) | Database, host, identity, settings | E0 |
| 1 Adopt | [#467](https://github.com/marinoscar/kvox/issues/467) (E2) | Jobs, nodes, storage, email, notifications, backup, telemetry, DB role | E1 |
| 1 Adopt | [#472](https://github.com/marinoscar/kvox/issues/472) (E3) | AI platform | E1, E2 |
| 1 Adopt | [#478](https://github.com/marinoscar/kvox/issues/478) (E4) | Exports, user-data, onboarding, CLI, infra, web shell | E3 |
| 2 Package | [#486](https://github.com/marinoscar/kvox/issues/486) (E5) | Package workspace, contract, db, ports | E0 to E4 |
| 2 Package | [#491](https://github.com/marinoscar/kvox/issues/491) (E6) | Domain API slices | E5 |
| 3 Desktop readiness | [#498](https://github.com/marinoscar/kvox/issues/498) (E7) | Domain web slices, bare-host proof, consumer guide | E6 |

### 6.2 Issues in execution order

| Order | Issue | Title | Depends on |
|---|---|---|---|
| 1 | [#456](https://github.com/marinoscar/kvox/issues/456) | 0.1 Bring EAB's Claude Code and OpenCode configuration to kvox | none (first issue) |
| 2 | [#458](https://github.com/marinoscar/kvox/issues/458) | 0.2 Commit the drift baseline and classify every module | #456 |
| 3 | [#461](https://github.com/marinoscar/kvox/issues/461) | 0.5 Repo tooling: `MonoRepo` tag, changesets, scripts, platform pin | #458. The tag must exist before #459 merges. |
| 4 | [#459](https://github.com/marinoscar/kvox/issues/459) | 0.3 Cut base-to-domain imports in AI and settings | #461 |
| 5 | [#460](https://github.com/marinoscar/kvox/issues/460) | 0.4 Turn domain registrations into registries | #459 |
| 6 | [#463](https://github.com/marinoscar/kvox/issues/463) | 1.1 Database baseline, fragments, `platform.lock`, `--through 14` | E0 |
| 7 | [#465](https://github.com/marinoscar/kvox/issues/465) | 1.3 Identity, single-org, allowlist reminder side table | #463 |
| 8 | [#466](https://github.com/marinoscar/kvox/issues/466) | 1.4 Settings and credentials | #465 |
| 9 | [#464](https://github.com/marinoscar/kvox/issues/464) | 1.2 Host core, About, Doctor | #463, #465, #466 |
| 10 | [#468](https://github.com/marinoscar/kvox/issues/468) | 2.1 Jobs and nodes | E1 |
| 11 | [#469](https://github.com/marinoscar/kvox/issues/469) | 2.2 Storage, ownership side table, upload workarounds | #468 |
| 12 | [#470](https://github.com/marinoscar/kvox/issues/470) | 2.3 Email and notifications | #469 |
| 13 | [#471](https://github.com/marinoscar/kvox/issues/471) | 2.4 DB backup, telemetry, application DB role | #469, #470 |
| 14 | [#473](https://github.com/marinoscar/kvox/issues/473) | 3.1 AI settings extension, target resolver, features, error map | E2 |
| 15 | [#474](https://github.com/marinoscar/kvox/issues/474) | 3.2 Data migration: AI keys and settings | #473 (rehearsed before #477) |
| 16 | [#475](https://github.com/marinoscar/kvox/issues/475) | 3.3 `KvoxAi` adapter; port every caller | #473 |
| 17 | [#476](https://github.com/marinoscar/kvox/issues/476) | 3.4 Ask streaming tool loop on `stream()` | #475 |
| 18 | [#477](https://github.com/marinoscar/kvox/issues/477) | 3.5 Web AI pages swap; delete `apps/api/src/ai` | #474, #476 |
| 19 | [#479](https://github.com/marinoscar/kvox/issues/479) | 4.1 Exports on the platform exporter registry | E3 |
| 20 | [#480](https://github.com/marinoscar/kvox/issues/480) | 4.2 User-data purge on platform registries | #479, #469 |
| 21 | [#481](https://github.com/marinoscar/kvox/issues/481) | 4.3 Onboarding steps and facts | #480 |
| 22 | [#482](https://github.com/marinoscar/kvox/issues/482) | 4.4 CLI on `createCli`, node executor, version bump | E3 (parallel with 4.1 to 4.3) |
| 23 | [#483](https://github.com/marinoscar/kvox/issues/483) | 4.5 Infra via `platform:infra:sync` | #482 (CLI identity file) |
| 24 | [#484](https://github.com/marinoscar/kvox/issues/484) | 4.6 Web shell and settings hub | #477 |
| 25 | [#485](https://github.com/marinoscar/kvox/issues/485) | 4.7 Transcript shares to grants (optional) | E4 done; last |
| 26 | [#487](https://github.com/marinoscar/kvox/issues/487) | 5.1 Packages workspace and release pipeline | E4 |
| 27 | [#488](https://github.com/marinoscar/kvox/issues/488) | 5.2 `kvox-contract` | #487 |
| 28 | [#489](https://github.com/marinoscar/kvox/issues/489) | 5.3 `kvox-db` | #487 (parallel with 5.2) |
| 29 | [#490](https://github.com/marinoscar/kvox/issues/490) | 5.4 `kvox-api/ports`, `/testing`, web-edition adapters | #488 |
| 30 | [#492](https://github.com/marinoscar/kvox/issues/492) | 6.1 `kvox-api/transcription` and the test host | E5 |
| 31 | [#494](https://github.com/marinoscar/kvox/issues/494) | 6.3 `kvox-api/search` | #492 |
| 32 | [#493](https://github.com/marinoscar/kvox/issues/493) | 6.2 `kvox-api/transcripts` | #492, #494 |
| 33 | [#495](https://github.com/marinoscar/kvox/issues/495) | 6.4 `kvox-api/notes` | #493, #494 |
| 34 | [#496](https://github.com/marinoscar/kvox/issues/496) | 6.5 `kvox-api/graph`, `/graph-extraction`, `/graph-rdf` | #495 |
| 35 | [#497](https://github.com/marinoscar/kvox/issues/497) | 6.6 `kvox-api/ask` | #496 |
| 36 | [#499](https://github.com/marinoscar/kvox/issues/499) | 7.1 `kvox-web/core` and `/transcription` | E6 |
| 37 | [#501](https://github.com/marinoscar/kvox/issues/501) | 7.3 `kvox-web/search` | #499 |
| 38 | [#500](https://github.com/marinoscar/kvox/issues/500) | 7.2 `kvox-web/transcripts` | #499, #501 |
| 39 | [#502](https://github.com/marinoscar/kvox/issues/502) | 7.4 `kvox-web/notes` | #500 |
| 40 | [#503](https://github.com/marinoscar/kvox/issues/503) | 7.5 `kvox-web/graph` | #502 |
| 41 | [#504](https://github.com/marinoscar/kvox/issues/504) | 7.6 `kvox-web/ask` | #503 |
| 42 | [#505](https://github.com/marinoscar/kvox/issues/505) | 7.7 Bare-host smoke app in CI | E6 (parallel with 7.2 to 7.6) |
| 43 | [#506](https://github.com/marinoscar/kvox/issues/506) | 7.8 Consumer guide for KVox Desktop | last |

### 6.3 Ordering notes

- **Epic 1 runs 1.1, 1.3, 1.4, 1.2.** The platform slice graph requires it: `settings` imports `identity`, and `host` imports both. Do not run two of them in parallel.
- **Epic 1 is a release train.** After #463 merges, the database only works fully once #465 merges. Do not deploy `main` to production until all four have merged. Run the production baseline in the maintenance window that ships the merged result. During development, use the `admin` test login.
- **Epic 2 issues are deployable one by one.** Each ends with an operator runbook step.
- Search goes before transcripts in Epics 6 and 7.

## 7. Rules during the program

| # | Rule |
|---|---|
| R1 | One slice per PR. One issue, one PR, one `Fixes #n`. |
| R2 | The PR that adopts a slice deletes the kvox code it replaces. No dead copies. |
| R3 | Only one open PR may carry a migration or baseline change at a time. |
| R4 | Pin the platform packages to one exact version (no ranges). A root `overrides` entry keeps a single copy of `@marinoscar/platform-contract`. `npm run check:platform-pin` enforces it. |
| R5 | Create the `MonoRepo` git tag on the pre-adoption commit before any adoption code merges (#461). It is the rollback anchor. |
| R6 | An installed migration is never edited. `platform.lock` and `kvox.lock` prove it. Comments inside `migration.sql` count. |
| R7 | A job `type` string is permanent. The snapshot test must pass unchanged. |
| R8 | Every CLI change bumps `apps/cli/package.json` and regenerates `package-lock.json`. |
| R9 | The kvox MANDATORY rules in `CLAUDE.md` keep applying: issue first, worktree, Conventional Commits, PR for every change, subagent delegation. |
| R10 | Gaps get a workaround and a line in `docs/platform-adoption/local-exceptions.md`. No change goes to EAB. |
| R11 | Behaviour stays the same. Same routes, same OpenAPI, same permissions. A Viewer keeps `transcripts:*`, `notes:*`, `note_templates:*`, `graph:*` and `ai:use`. |

## 8. Rollback

| Scope | How |
|---|---|
| One slice PR | Revert it. Revert in reverse merge order. |
| Epic 1 | Revert 1.2, 1.4, 1.3, 1.1 in that order. Restore the pre-baseline backup ([EAB runbook, section 9](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/database-baseline.md#9-rollback)). |
| Epic 2 | Revert 2.4, 2.3, 2.2, 2.1. #469 and #471 change data; each has a restore-based rollback. |
| Epic 3 | Old AI tables stay until #477. Until then the migration is re-runnable and reversible. |
| Whole adoption | Reset to the `MonoRepo` tag and restore the pre-adoption backup. |
| Packages | Publish a fixed version on `next`; do not unpublish. Apps pin exact versions, so a bad release does nothing until a pin moves. |

## 9. Exit criteria

The program is done when all of these hold.

- [ ] All 8 epics and 43 child issues are closed ([#457](https://github.com/marinoscar/kvox/issues/457) to [#506](https://github.com/marinoscar/kvox/issues/506), except optional [#485](https://github.com/marinoscar/kvox/issues/485)).
- [ ] `apps/api/src` holds no copy of a platform slice. Only registrations, bindings and `kvox/` configs remain.
- [ ] `apps/api/test/conformance.spec.ts` runs the platform suites green, with skips only where a reason is written.
- [ ] `npm run db:drift` passes with no allowlist. The API runs as an ordinary role; Doctor `db.rls_role` passes.
- [ ] `apps/api/src/{transcription,transcripts,search,notes,graph,ask}` are gone. `grep -rn "@marinoscar/platform-" packages/kvox-api/src packages/kvox-web/src` is empty.
- [ ] `@marinoscar/kvox-{contract,db,api,web}` publish to npm on `next` with provenance.
- [ ] `openapi.json` is unchanged, the job-type snapshot passes, and the visual suite passes with no new baselines.
- [ ] The bare-host job is green on PostgreSQL with pgvector and on PGlite, with `@marinoscar/platform-api` not installed.
- [ ] `docs/guides/kvox-desktop.md` exists and every package README links to it.
- [ ] A production smoke passes: a multi-part upload over 100 MiB, transcription, transcode on a node, a generated note, a notification by email, in-app and push, a verified backup.

## 10. References

EAB documents:

- [ADOPTING-THE-PLATFORM.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/ADOPTING-THE-PLATFORM.md)
- [PACKAGES.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/PACKAGES.md)
- [EXTENDING.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/EXTENDING.md)
- [SLICES.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/SLICES.md)
- [specs/platform-packages.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/specs/platform-packages.md)
- [SECURITY-ARCHITECTURE.md, section 18 (RLS)](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/SECURITY-ARCHITECTURE.md#18-tenant-isolation-rls)
- [runbooks/database-baseline.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/database-baseline.md)
- [runbooks/release-platform-packages.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/release-platform-packages.md)
- [runbooks/platform-drift-report.md](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/platform-drift-report.md)

kvox documents:

- [Settings UI](settings-ui.md), [Job queue](job-queue.md), [Worker nodes](worker-nodes.md)
- [Database backup](database-backup.md), [Database restore](database-restore.md)
- [Notes](notes.md), [Transcription](transcription.md), [Search](search.md), [Ontology](ontology.md)
- [Onboarding](onboarding.md), [User data deletion](user-data-deletion.md)
