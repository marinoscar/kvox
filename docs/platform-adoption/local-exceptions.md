# Local exceptions to the platform

Every place where KVox deviates from `@marinoscar/platform-*` on purpose, and the issue that removes it. Introduced by #463 (epic #462). An exception without a row here is a bug.

## How to use this page

- **A shim in code** carries the comment `// PLATFORM-ADOPTION-SHIM(<issue>)`, where `<issue>` is the issue that removes it. List them all with `grep -rn "PLATFORM-ADOPTION-SHIM" apps/api/src`.
- **A deviation in the database** is an entry under `deviations` in `apps/api/prisma/platform.lock`, plus `DROP COLUMN` entries in `apps/api/prisma/drift-allowlist.json`. Each allowlist entry has `{ statement, reason, removeIn }`.
- **The PR that removes an exception deletes its row here.** It also removes the marker, the lock deviation and the allowlist entries it names.
- A new exception adds a row in the same PR, with an issue that removes it. If no issue exists, file one.

How the baseline treats the deviations: `docs/runbooks/database-baseline.md`.

## Database deviations (declared in `platform.lock`)

| Deviation id | What differs from the platform | Where | Why | Removed by |
|---|---|---|---|---|
| `kvox:storage-managed-by-part-size` | `storage_objects.managed_by TEXT` and `storage_objects.part_size INTEGER` exist. The platform table has neither. | Migration `20260914120000_add_storage_part_size_and_managed_by` | Transcripts, notes and the graph mark objects they own. Uploads record a multipart part size. | #469: `managed_by` moves to `kvox_object_ownership`, `part_size` is dropped |
| `kvox:domain-schema` | KVox domain tables, enums, indexes and extensions that platform `0001` to `0014` do not create. Not a change to a platform table. | The 22 app-only migrations | The baseline diff prints them, and the lock must declare them for `--through 14` to run clean. | Not removed. It is a record for the baseline. #489 (the `kvox-db` package) revisits it |

The `kvox:allowlist-reminders` deviation (two columns on `allowed_emails`) was removed by #465: reminder state moved to the KVox-owned side table `kvox_allowlist_reminders`, which is a KVox table keyed by an allowlist row id with no foreign key, not a change to a platform table, so it is not an exception. Its row, its shim (`LegacyAllowlistReminderStore`), its lock entry and its two allowlist entries are gone.

The extensions `vector` and `pg_trgm` are part of `kvox:domain-schema`. `CREATE EXTENSION vector` needs a superuser. KVox runs as `postgres` until #471 (see "Standing constraints").

## Code shims (`PLATFORM-ADOPTION-SHIM`)

| Shim | Where | What it does | Removed by |
|---|---|---|---|
| `LegacyObjectOwnershipStore` | `apps/api/src/storage/legacy-object-ownership.store.ts`, and the files that read or write `managedBy` and `partSize` | Reads and writes `storage_objects.managed_by` and `part_size` with raw SQL, because the composed Prisma client has neither field. The list filter in `storage/objects/objects.service.ts` uses `id NOT IN (SELECT id FROM storage_objects WHERE managed_by IS NOT NULL)`. | #469 re-points it at `kvox_object_ownership`, then deletes it |
| `IdentityNotifierAdapter` | `apps/api/src/platform/identity/identity-notifier.adapter.ts` (`IDENTITY_NOTIFIER`) | Maps the identity events onto KVox's `NotificationsService`: `roleChanged` to `security.role_changed`, `userWelcomed` to `user.welcome`, `allowlistInvitation` to `allowlist.invitation`. An organization invitation logs and drops (single-org). | #468 changes the binding to the platform's notifications slice |
| `IdentityJobsAdapter` | `apps/api/src/platform/identity/identity-jobs.adapter.ts` (`IDENTITY_JOBS`) | Registers the two identity handlers (`auth.token.cleanup`, `device-auth.code.cleanup`, KVox's type strings) into KVox's `JobHandlerRegistry` and enqueues through KVox's `JobsService`. | #470 changes the binding to the platform's job queue |
| `PatRevoker` | `apps/api/src/user-data/user-data.base.hooks.ts`, provided in `user-data/user-data.module.ts` | Revokes every active personal access token of a user (one `updateMany` stamping `revoked_at`) for account deletion, because the platform's `PatService` has `revokeToken` per token but no revoke-all. | #465 follow-up: the platform's user-data slice replaces it, or `PatService` gains a revoke-all |
| `TranscriptShare` registered actor-only | `apps/api/src/app-registrations/user-owned-models.ts` | Both keys of `transcript_shares` (`userId`, `grantedById`) cascade, and the `user-owned-data` suite refuses an owned model whose actor field cascades. The model is registered with `actorFields: ['userId', 'grantedById']` and purge `delete`, not as owned by the grantee. Deviation from the table in #465. | #485 (transcript shares into grants) |
| `AddEmailDialog` kept | `apps/web/src/components/admin/AddEmailDialog.tsx`, used by `pages/Admin/SetupPage.tsx` | The packaged Users page draws its own copy of the "add to allowlist" dialog but does not export it, and the Setup checklist needs the same control. | The day the package exports its own dialog |
| Default organization (`StorageObject.orgId`) | `apps/api/src/prisma/default-org.ts`, and every `storageObject.create` | The platform column `storage_objects.org_id` is required. The helper resolves `organizations WHERE is_default` once and caches it. | #469, with the storage slice |
| `Job.reason` as a string | `apps/api/src/jobs/jobs.service.ts` | Platform `0034_open_job_reason` turned the Prisma enum into a string. The file types `reason` locally as `'upload' \| 'rerun' \| 'backfill'`. | #468 deletes the file |
| `UserAiCredential` fragment | `apps/api/prisma/fragments/ai-credentials.prisma`, `extend model User { aiCredentials ... }` | KVox keeps its own per-user AI key table, `user_ai_credentials`. The platform stores user AI keys in `user_ai_keys`. | #472 migrates the data and removes the fragment |
| `ai` system namespace declared by KVox | `apps/api/src/ai/ai.system-settings.ts` (`KVOX_AI_SYSTEM_SETTINGS`), registered in `app-registrations/settings.ts`; marked `PLATFORM-ADOPTION-SHIM(3.1)` | The platform declares its own `ai` namespace. KVox registers its own first, with its stored shape (`taskModels`, `graphEnabled`, `maxDocumentBytes`, the string-or-object `allowedModels`), so a PATCH to `ai` keeps its meaning. `merge` is `mergeAiSettings`, moved out of the old settings service. | #473 adopts the platform's `ai` slice and deletes this declaration |
| `user-settings.namespace-changed` re-emitted by an interceptor | `apps/api/src/platform/settings/user-settings-change.interceptor.ts` (global `APP_INTERCEPTOR` in `app.module.ts`) and `platform/settings/user-settings.events.ts` | The platform `UserSettingsService` emits nothing when a namespace changes, and its namespace has no change hook. The interceptor reads the caller's namespaces before `PUT` and `PATCH /api/user-settings`, diffs them against the response and emits the event once per changed namespace. `GraphPreferencesChangeForwarder` turns it into `graph.preferences_changed`, which enqueues `kg.resolve`. A write through any other route (the profile-image upload, the user-data purge) emits nothing, and nothing subscribes to those keys. | The platform grows a namespace change hook or event |
| Profile-image adapter | `apps/api/src/platform/settings/settings-profile-images.adapter.ts` (`SETTINGS_PROFILE_IMAGES`), with the KVox-owned `settings/profile-image/` routes | Gives the settings slice KVox's profile normalisation and its "is this an uploaded avatar of the caller" check (`common/profile-image/profile-image.ts`). The upload, delete and preview routes are still KVox's. | #469 (the storage slice's `ProfileImageModule`) |
| `cron` backup frequency widened without its validation | `apps/api/src/db-backup/schedule.util.ts` (`BackupFrequency`, `BackupScheduleInput.cron`); marked `PLATFORM-ADOPTION-SHIM(#467)` | The platform `databaseBackup` declaration accepts `frequency: 'cron'`, a `cron` expression and `retention`, so the type was widened. **Known behaviour change:** `PUT /api/db-backup/config` now also accepts `frequency: "cron"`, and a `cron` backup does not get the minimum-interval validation the other frequencies get. `PATCH /api/system-settings` has always validated only the declaration's shape. | #467 replaces the file with the platform's `schedule.util` and its validation |
| `transcription` credential purpose registered in the manifest | `apps/api/src/kvox.manifest.ts`, under `[registry:credential-purposes]` | Deviation from #466's file placement. The credential purposes `smtp`, `email_ses` and `push_vapid` are the platform's definitions, registered in `platform/credentials/credential-purposes.manifest.ts`. `transcription` is KVox's own, and the base-domain-boundary test forbids `platform/credentials` importing the transcription folder. | Permanent, until the transcription provider key moves to a packaged store |
| `databaseBackup.storageProvider` default `s3` | `apps/api/src/app-registrations/settings.ts` (`APP_SYSTEM_SETTINGS_DEFAULTS`) | The platform's default is the empty string ("whatever provider is active"). KVox has always defaulted to `s3`, and a row with no `databaseBackup` block reads as the default. Only the default changes. | #467 decides whether the platform default is adopted |
| `Job` columns the platform added (`orgId`, `claimToken`, `traceContext`) | `apps/api/src/jobs/job-claim.service.ts` (`JOB_CLAIM_COLUMNS`), `apps/api/src/jobs/job-admin.service.ts` (`JobUnlistedField`, `JOB_LIST_SELECT`, `JobListItem`) | The claim's `RETURNING` clause maps every `Job` field, so the three new columns are mapped. The admin list omits them, as it omits `payload`, because none is operator-facing. | #468 replaces the jobs module with the platform's |
| `jobs.reason` is TEXT in the restore carry | `apps/api/src/db-backup/database-restore.service.ts` (`CARRY_JOB_SQL`) | The `"JobReason"` enum type no longer exists after platform `0034_open_job_reason`, so the carry statement casts `$6::text`. | #468 |
| Storage-object test fixtures | `apps/api/test/helpers/storage-object.helper.ts`, `apps/api/test/helpers/fake-ownership-store.helper.ts`, and the `jest.mock` of `prisma/default-org` in the mocked-database specs | Real-database fixtures insert through `createStorageObject` (default org, then `managed_by` / `part_size` in SQL). Mocked-database specs answer the legacy store from their own fixture rows. | #469 deletes them with the store |
| Platform columns in model-field tests | `apps/api/test/nodes/worker-node-model-fields.spec.ts` (`lastVitals`, `lastVitalsAt`), `apps/api/test/broadcasts/broadcast-model.db.spec.ts` (`targetOrgId`) | The documented field lists include columns the platform added to `worker_nodes` and `notification_broadcasts`. Marked `PLATFORM-ADOPTION-SHIM(#470)`. | #470 |
| Ask-eval fixture seeder | `apps/api/scripts/ask-eval/seed-graph.ts` | Inserts storage objects with the default organization and stamps `managed_by` with raw SQL. | #469 |
| RLS bypass on dump connections | `apps/api/src/db-backup/pg-dump.util.ts` (`buildPgDumpArgs`, `pgDumpEnv`, `assertRlsBypassCoupled`, used by `spawnPgDump`) and `apps/cli/src/node/pg-dump.ts` (`buildPgDumpArgs`, `pgClientEnv`, `assertRlsBypassCoupled`) | Every `pg_dump` runs with `--enable-row-security` AND `PGOPTIONS=-c app.rls_bypass=on` (server: merged with any existing `PGOPTIONS`; node: replaces the inherited value, which is cleared on purpose). The platform forces RLS on its tables and the minted dump role is NOSUPERUSER; `pg_dump` otherwise sends `SET row_security = off` and fails on every protected table ("query would be affected by row-level security policy"). The two are one mechanism: the flag alone would silently filter the archive to the rows the policies allow, so a dump with one and not the other is refused before it spawns. `app.rls_bypass` is the platform's own system-client setting, scoped to the dump connection: no `BYPASSRLS` on the role, no `ALTER ROLE ... SET`. | Revisit in #471 / #467 |
| Escaped `Unsupported("vector(1536)")` | `apps/api/prisma/fragments/graph.prisma` and `search.prisma`: the three embedding fields (`KgEntity`, `KgItem`, `SearchEmbedding`) | The composer in `@marinoscar/platform-db` `0.1.0-next.5` cannot read the literal `Unsupported("vector(1536)")`. The fragments write the quotes escaped so the composed schema is valid. | The platform release that fixes the composer. Then write the plain literal and re-run `db:compose` |

Any other compile error that a platform model change causes is fixed the same way. Add its row to this table.

## Settings and credentials differences (issue #466)

Not shims: the platform's settings and credentials slices replaced KVox's own, and these are the places the packaged behaviour differs from what KVox ran before. No stored row was rewritten. `APP_SYSTEM_SETTINGS_EXTENSIONS` and `APP_USER_SETTINGS_EXTENSIONS` are empty because every platform declaration is a superset of KVox's stored schema.

| Namespace | Difference |
|---|---|
| `databaseBackup` (system) | Wider: `frequency` also accepts `cron`, and `cron` and `retention` (`count`, `maxAgeDays`) exist. Default `storageProvider` stays `s3` (see the shim table). |
| `notifications` (system) | Wider: adds `channels` (per-channel `enabled` switches). `disabledEvents` stays at most 100 entries on the wire, each key lowercase and at most 64 characters. The platform allows 200 only in the effective value that merges an organization's layer, which this deployment never has. |
| `dataTables` (user) | Wider: adds `savedViews` and an open `extra` bag per table. |
| `notifications` (user) | The channel names are no longer restricted to an enum. |
| `onboarding` (user) | Not the platform's: KVox's own declaration, unchanged. |
| Org-level settings and the user and org credential stores | `/api/org-settings` is mounted (permissions `org_settings:read\|write`), and so are `UserCredentialsModule` and `OrgCredentialsModule`. All are unused in single-organization mode: `org_settings`, `org_credentials` and `user_credentials` stay empty. |
| Port bindings that are no longer shims | `SystemSettingsStoreAdapter` (core's settings-store port, now over the packaged `SystemSettingsService`) and `KvoxUserDefaults` (identity's `USER_DEFAULTS`, now the settings slice's `DEFAULT_USER_SETTINGS`) were shims until #466 and are ordinary host-port bindings now. |
| `SECRETS_ENCRYPTION_KEY` and the cipher | KVox's `common/crypto` cipher and the startup check are deleted. `main.ts` uses core `verifyEncryptionKeyAtStartup`; AI keys use core `encryptSecret` and `decryptSecret` with purpose `'ai-key'`. Compatibility with every existing ciphertext was verified in both directions. |

## Standing constraints

Not shims, but each one limits what you may do until the named issue lands.

| Constraint | Detail | Lifted by |
|---|---|---|
| Plain foreign keys to `storage_objects(id)` | KVox domain tables (transcripts, notes, graph, export files) reference `storage_objects(id)` with a plain key. That is valid in single-org mode. A composite `(object_id, org_id)` key is needed only if KVox ever goes multi-org, because a foreign-key check runs without row-level security. | Only a decision to go multi-org |
| Row-level security is inert | Platform `0025_org_scoped_rls` forces RLS on `storage_objects`. KVox connects as superuser, which ignores every policy. Do not change `POSTGRES_USER` before #471. The baseline needs `--allow-rls` for this reason. | #471 |
| Extensions need a superuser | `CREATE EXTENSION vector` and `pg_trgm` run in migrations, in `prisma migrate dev` shadow databases and in `pg_restore`. | #471 (trusted-extension setup or a migration role) |
| Raw-SQL objects stay in migrations | Partial unique, trigram, HNSW and GiST indexes, generated `tsvector` columns, `tstzrange` columns, CHECK constraints and the evidence triggers exist only in `migration.sql`. Partial and expression indexes are also listed under `rawSqlIndexes` in `platform.lock`. | Permanent |
| One open migration PR | At most one open KVox PR may carry a migration at a time. | Permanent |

## Drift allowlist

`apps/api/prisma/drift-allowlist.json` filters `npm run db:drift:kvox`. It starts with:

- the `DROP COLUMN` statement for the two remaining deviation columns, `storage_objects.managed_by` and `part_size` (`removeIn` #469), and
- the statements Prisma prints for the GIN, GiST and HNSW indexes and the generated `tsvector` columns that its schema cannot declare. Those indexes are permanent, so these entries stay while the index does. Their `removeIn` names the issue that would change that.

`apps/api/test/prisma/drift-allowlist.spec.ts` fails when an entry has no `removeIn`. Never add an entry to hide a real difference on a platform table. Fix the cause.
