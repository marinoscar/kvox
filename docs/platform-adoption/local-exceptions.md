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
| `kvox:allowlist-reminders` | `allowed_emails.reminder_count INTEGER NOT NULL DEFAULT 0` and `allowed_emails.last_reminder_at TIMESTAMPTZ` exist. The platform table has neither. | Migration `20260918120000_add_allowlist_reminder_tracking` | Allowlist reminders (#301) have no platform seam. | #465: moves to `kvox_allowlist_reminders`, then drops the columns |
| `kvox:domain-schema` | KVox domain tables, enums, indexes and extensions that platform `0001` to `0014` do not create. Not a change to a platform table. | The 22 app-only migrations | The baseline diff prints them, and the lock must declare them for `--through 14` to run clean. | Not removed. It is a record for the baseline. #489 (the `kvox-db` package) revisits it |

The extensions `vector` and `pg_trgm` are part of `kvox:domain-schema`. `CREATE EXTENSION vector` needs a superuser. KVox runs as `postgres` until #471 (see "Standing constraints").

## Code shims (`PLATFORM-ADOPTION-SHIM`)

| Shim | Where | What it does | Removed by |
|---|---|---|---|
| `LegacyObjectOwnershipStore` | `apps/api/src/storage/legacy-object-ownership.store.ts`, and the files that read or write `managedBy` and `partSize` | Reads and writes `storage_objects.managed_by` and `part_size` with raw SQL, because the composed Prisma client has neither field. The list filter in `storage/objects/objects.service.ts` uses `id NOT IN (SELECT id FROM storage_objects WHERE managed_by IS NOT NULL)`. | #469 re-points it at `kvox_object_ownership`, then deletes it |
| `LegacyAllowlistReminderStore` | `apps/api/src/allowlist/legacy-allowlist-reminder.store.ts`, used by `allowlist.service.ts` and `dto/allowlist-response.dto.ts` | `get(ids)` and `increment(id, at)` over `allowed_emails.reminder_count` and `last_reminder_at`, with raw SQL | #465 replaces it with `kvox_allowlist_reminders` |
| Default organization (`StorageObject.orgId`) | `apps/api/src/prisma/default-org.ts`, and every `storageObject.create` | The platform column `storage_objects.org_id` is required. The helper resolves `organizations WHERE is_default` once and caches it. | #469, with the storage slice |
| `Job.reason` as a string | `apps/api/src/jobs/jobs.service.ts` | Platform `0034_open_job_reason` turned the Prisma enum into a string. The file types `reason` locally as `'upload' \| 'rerun' \| 'backfill'`. | #468 deletes the file |
| `UserAiCredential` fragment | `apps/api/prisma/fragments/ai-credentials.prisma`, `extend model User { aiCredentials ... }` | KVox keeps its own per-user AI key table, `user_ai_credentials`. The platform stores user AI keys in `user_ai_keys`. | #472 migrates the data and removes the fragment |

Any other compile error that a platform model change causes is fixed the same way. Add its row to this table.

## Standing constraints

Not shims, but each one limits what you may do until the named issue lands.

| Constraint | Detail | Lifted by |
|---|---|---|
| Plain foreign keys to `storage_objects(id)` | KVox domain tables (transcripts, notes, graph, export files) reference `storage_objects(id)` with a plain key. That is valid in single-org mode. A composite `(object_id, org_id)` key is needed only if KVox ever goes multi-org, because a foreign-key check runs without row-level security. | Only a decision to go multi-org |
| Row-level security is inert | Platform `0025_org_scoped_rls` forces RLS on `storage_objects`. KVox connects as superuser, which ignores every policy. Do not change `POSTGRES_USER` before #471. The baseline needs `--allow-rls` for this reason. | #471 |
| Extensions need a superuser | `CREATE EXTENSION vector` and `pg_trgm` run in migrations, in `prisma migrate dev` shadow databases and in `pg_restore`. | #471 (trusted-extension setup or a migration role) |
| Role switch in `0024` | `0024_split_system_org_roles` moves `contributor` and `viewer` onto `memberships.role_id`. Until #465, non-admin users on a migrated database lose domain permissions. There is no production deploy between the stages of the release train. | #465 |
| Raw-SQL objects stay in migrations | Partial unique, trigram, HNSW and GiST indexes, generated `tsvector` columns, `tstzrange` columns, CHECK constraints and the evidence triggers exist only in `migration.sql`. Partial and expression indexes are also listed under `rawSqlIndexes` in `platform.lock`. | Permanent |
| One open migration PR | At most one open KVox PR may carry a migration at a time. | Permanent |

## Drift allowlist

`apps/api/prisma/drift-allowlist.json` filters `npm run db:drift:kvox`. It starts with:

- the `DROP COLUMN` statements for the four deviation columns (`removeIn` #465 and #469), and
- the statements Prisma prints for the GIN, GiST and HNSW indexes and the generated `tsvector` columns that its schema cannot declare. Those indexes are permanent, so these entries stay while the index does. Their `removeIn` names the issue that would change that.

`apps/api/test/prisma/drift-allowlist.spec.ts` fails when an entry has no `removeIn`. Never add an entry to hide a real difference on a platform table. Fix the cause.
