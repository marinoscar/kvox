# Runbook: Baseline the Database Onto the Platform Migration History

Use this once per database, when KVox first adopts `@marinoscar/platform-db` (#463, part of epic #462). It records the platform migrations `0001` to `0014` as already applied, because KVox's own directories hold identical bytes. It then lets `prisma migrate deploy` apply `0015` to `0037`.

It is a one-off operator action. Never run it from `kvox deploy update`.

Source of truth for every claim below:

- `node_modules/@marinoscar/platform-db/README.md`, "Upgrade notes" (steps B1 to B6) and "Troubleshooting" (the refusal codes).
- `apps/api/prisma/platform.lock` (the mapping, the deviations, `rawSqlIndexes`, `appMigrations`).
- `docs/platform-adoption/local-exceptions.md` (what each deviation is and which issue removes it).
- `docs/runbooks/database-restore.md` and `docs/runbooks/maintenance-mode.md` (the two procedures this one leans on).

This is KVox's version of the EnterpriseAppBase baseline procedure. KVox adds three things: the `--through 14` cut, 22 app-only migrations, and three declared deviations.

## 1. What the baseline does

KVox's first 14 migration directories are byte-identical to platform `0001` to `0014`. Directories `20260914120000_add_storage_part_size_and_managed_by` to `20260927050000_ai_token_limits_follow_model` (22 of them) are KVox's own. Platform `0015` to `0037` (23 migrations) are not in KVox yet.

`platform db baseline --through 14` runs six steps.

| Step | What it does | Writes anything? |
|---|---|---|
| B1 map | Matches each platform migration to a KVox directory by identical bytes (`sha256`). Reports unmatched migrations and app-only directories. | No |
| B2 ledger | Every mapped directory must be a finished row of `_prisma_migrations` with the file's checksum. | No |
| B3 diff | Replays platform `0001` to `0014` in a throwaway shadow database and diffs it against the live database. A statement listed in a `deviations[].expectDiff` entry of `platform.lock` is allowed. Any other statement blocks. | No |
| B4 indexes and RLS | Asserts every raw-SQL index (the platform's up to `0014`, plus the lock's `rawSqlIndexes`) in `pg_indexes`, by name and definition. | No |
| B5 act | `--apply` only. Installs the 23 missing migrations as byte copies, resolves any mapped migration the ledger lacks, writes `platform.lock` last. | Files, and ledger rows only if a mapped one was missing |
| B6 verify | `prisma migrate status`, `platform db check` and the ledger comparison. | No |

Facts that follow from the code, and that the older notes get wrong:

- The 23 installed directories sort **after** KVox's 22. A migration above `--through` is placed at the end by the `db:sync` naming rule.
- On a database KVox has always run, all 14 mapped directories are already in the ledger. So `--apply` resolves nothing there. It installs files and writes the lock. The database itself changes only when `prisma:migrate` runs.
- The B3 diff compares **platform history to `0014`** with the live database. It prints every KVox domain object and the four deviation columns. That is expected. Section 5 explains how to declare them.

## 2. Before you start

- Work in the feature worktree for #463. The rehearsal commits the installed directories and `platform.lock`.
- You need a recent production backup (section 3) and a scratch Postgres server you may break. The role needs to create databases (the shadow database), or pass `--shadow-database-url`.
- `CREATE EXTENSION vector` and `pg_trgm` need a superuser, or a trusted-extension setup. KVox still runs as `postgres` until #471, so this holds today. Do not move to a non-superuser role before #471. The `pg_restore` into the scratch database, a fresh `prisma:migrate` and `prisma migrate dev` (shadow database) all create these extensions.
- Every `db:baseline` command below carries `--allow-rls`. Platform `0025` to `0029` enable row-level security and sit above `--through 14`, so the tool refuses with `RLS_OPT_IN_REQUIRED` without it. The flag is your statement that the application role is `NOSUPERUSER NOBYPASSRLS`. KVox runs as superuser, so the policies are inert (section 9). Passing the flag is deliberate. Record that in the PR.
- **Check `POSTGRES_*` twice** before any `--apply`. `scripts/platform-env.js` builds `DATABASE_URL` from them and `--apply` writes to whatever they name.
- No secrets belong in the lock or in a report. The report prints SQL only.

## 3. Rehearse on a restored copy

1. Take the newest production backup. Download it as in `docs/runbooks/database-restore.md` section 4.1, or use any recent `pg_dump -Fc` archive.
2. Restore it into a scratch database.

   ```bash
   createdb -h <scratch-host> -U postgres kvox_rehearsal
   pg_restore -h <scratch-host> -U postgres -d kvox_rehearsal --no-owner --no-acl <latest-backup>.dump
   ```

3. Point the shell at it. Check both values.

   ```bash
   export POSTGRES_HOST=<scratch-host> POSTGRES_DB=kvox_rehearsal
   echo "$POSTGRES_HOST $POSTGRES_DB"
   ```

4. Run the dry run from `apps/api` and save the report.

   ```bash
   cd apps/api
   npm run db:baseline -- --through 14 --allow-rls | tee ~/baseline-dry-run-1.txt
   ```

A dry run writes nothing and runs no `prisma migrate resolve`.

### 3.1 Expected report numbers

First dry run, before any deviation is declared:

| Report line | Expected |
|---|---|
| `B1 map` | `14 matched, 23 unmatched, 22 app-only` |
| Matched lines | 14 lines, each ending `[sha256]` |
| Unmatched lines | 23 lines ending `(no local directory)`, `platform:0015_...` to `platform:0037_...` |
| App-only lines | 22 lines, `20260914120000_...` to `20260927050000_...` |
| `B2 ledger` | `managed by Prisma Migrate; 0 problem(s)` |
| `B3 diff` | `<N> blocking, 0 declared` |
| `B4 raw-SQL indexes` | `0 problem(s)` |
| `B4 row-level security` | `0 problem(s)` |
| `B5 act` | `0 to resolve, 23 to install only` |
| Last line | `REFUSED: ... DIFF_BLOCKING` |

Any `[normalised]` or `[map]` match is a surprise. Read its note before going on. Fewer than 14 `[sha256]` matches means a KVox directory was edited or renamed. Restore it from Git.

The `DIFF_BLOCKING` list holds two kinds of statement:

- (a) KVox domain objects: tables, enums, foreign keys, indexes and `CREATE EXTENSION` from the 22 app-only migrations.
- (b) The four deviation columns: `storage_objects.managed_by`, `storage_objects.part_size`, `allowed_emails.reminder_count`, `allowed_emails.last_reminder_at`.

## 4. Raw-SQL indexes in the lock

B4 asserts the lock's `rawSqlIndexes`. Prisma's diff cannot see a partial or expression index, so B3 never catches a missing one. Every KVox partial or expression index must be listed, with `definition` copied exactly from the migrated database:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = '<name>';
```

The list: `transcript_speakers_transcript_id_label_key`, `kg_items_live_statement_uniq_idx`, `kg_proposals_note_draft_uniq_idx`, `kg_proposals_note_extracting_uniq_idx`, `kg_proposals_owner_import_extracting_uniq_idx`, `kg_relations_speaker_link_uniq_idx`, `ask_messages_one_running_turn_uniq_idx`. The platform's own (`jobs_*`, `database_backup_runs_active_uniq_idx`) need no lock entry. Trigram, HNSW, GiST and generated-column indexes are intentional drift too (`AGENTS.md`, "Invariants that are easy to break"). Never turn one into `@@unique` or `@@index`.

## 5. Fixing differences: declare the deviations

A blocking statement has three possible fixes: a forward migration, a declared deviation, or a lower `--through`. For KVox the answer is a declared deviation, and only for these.

`scripts/baseline-deviations.mjs` does the declaring. It reads the `BLOCKING:` lines of a saved report and checks that each one names a table or type created or altered by one of the 22 app-only migrations. It exits 1 on any statement that does not. It prints three `deviations` entries for `platform.lock`.

```bash
node scripts/baseline-deviations.mjs ~/baseline-dry-run-1.txt
```

| Deviation id | Statements | Removed by |
|---|---|---|
| `kvox:storage-managed-by-part-size` | the two `ALTER TABLE "storage_objects" ADD COLUMN` statements | #469 |
| `kvox:allowlist-reminders` | the two `ALTER TABLE "allowed_emails" ADD COLUMN` statements | #465 |
| `kvox:domain-schema` | every other statement. Reason: "KVox domain tables created by app-only migrations; not a change to a platform table" | stays as a record (see `local-exceptions.md`) |

Rules:

- **Never paste the list by hand.** The script proves each statement comes from an app-only migration.
- **A statement that touches a platform table and is not one of the four deviation columns is a real difference.** Stop. Report it in #463. Do not declare it. The script refuses it by design.
- Paste the three entries into `apps/api/prisma/platform.lock`, then re-run the dry run until it ends with:

  `dry run clean: re-run with --apply to write the lock and resolve`

  At that point `B3 diff` reads `0 blocking, <M> declared`. Record `<M>` in section 12.

Statements are matched after normalisation. A deviation whose statement the diff no longer prints produces a `note:` telling you to remove it. Keep that note in mind when #465 and #469 land.

## 6. Apply on the rehearsal copy

Check `POSTGRES_HOST` and `POSTGRES_DB` again, then run the sequence.

```bash
cd apps/api
npm run db:baseline -- --through 14 --allow-rls --apply     # installs 23 directories, writes platform.lock, B6 verify
npm run db:baseline -- --through 14 --allow-rls             # must end "nothing to do"
npm run prisma:migrate                                      # applies the 23 installed migrations, 0015 to 0037
npm run prisma:seed
npm run db:check:database
```

Run the "nothing to do" check **before** `prisma:migrate`. Afterwards the live database holds platform `0015` to `0037`, so a `--through 14` diff would block on every new platform table. If you want a post-migrate check, use `--through 37` and read the result as new information, not as a gate.

Expected:

- `--apply` ends with `baseline applied and verified`.
- The `B1 map` of the second run reads `37 matched, 0 unmatched, 22 app-only`.
- `prisma:migrate` reports 23 migrations applied.
- `db:check` and `db:check:database` exit 0.

Copy the 23 new `prisma/migrations/<timestamp>_<slug>/` directories and the written `platform.lock` into the worktree. They are byte copies. Run `npm run db:check` there. Commit them with the PR. Never edit or rename them, comments included: the lock hashes the raw bytes.

Then prove the placement on an empty database:

```bash
POSTGRES_DB=kvox_fresh npm run prisma:migrate
POSTGRES_DB=kvox_fresh npm run prisma:seed
POSTGRES_DB=kvox_fresh npm run db:drift:kvox
```

This builds the whole history from nothing: the 14 platform directories, KVox's 22, then the 23 installed ones. Drop the rehearsal and fresh databases when the PR is merged.

## 7. The production window

Run this once, at the end of epic #462, when the whole release train (1.1 to 1.4) is ready. The window stays open from step 1 to step 11.

Platform `0024_split_system_org_roles` changes who holds `contributor` and `viewer`. Until #465 ships, non-admin users on a migrated database lose domain permissions. That is why there is no production deploy between the stages of the train.

1. **Open the maintenance window** (`docs/runbooks/maintenance-mode.md`). Keep it open until step 11.
2. **Take a fresh backup.** Wait for it to finish. Confirm it is listed, and note its id. This backup is the rollback.
3. **Check `POSTGRES_*`.** They must name production. Read them twice.
4. **Dry run on production** and save the report.

   ```bash
   docker compose exec api npm run db:baseline -- --through 14 --allow-rls | tee ~/baseline-dry-run-prod.txt
   ```

   The committed `platform.lock` and the 23 installed directories are already in the image, so the numbers differ from the rehearsal. Expected: `37 matched, 0 unmatched, 22 app-only`, `0 blocking, <M> declared` with the same `<M>` as section 12, zero index and RLS problems, `0 to resolve, 0 to install only`, and the last line `nothing to do`. Compare line by line with the rehearsal record. Any difference means production is not the database you rehearsed: stop, and do not apply.
5. **Apply.** The lock is already committed, so the tool refuses without `--force-remap` (`LOCK_NOT_EMPTY`).

   ```bash
   docker compose exec api npm run db:baseline -- --through 14 --allow-rls --apply --force-remap
   ```

   On production this resolves nothing and rewrites an identical lock. Its value is the B6 verification. Confirm `git diff` shows no change to `platform.lock` if the container's tree is a checkout; otherwise confirm the output ends `baseline applied and verified`.
6. **Migrate.** `docker compose exec api npm run prisma:migrate` applies 23 migrations.
7. **Seed.** `docker compose exec api npm run prisma:seed`.
8. **Check.** `docker compose exec api npm run db:check:database`.
9. **Deploy the 1.1 to 1.4 train** in order with `kvox deploy update`. Its migrate step finds nothing pending. Its seed step is idempotent.
10. **Verify** with the smoke test and a login as an admin and as a contributor.
11. **Close the window.**

The tooling must exist in the production image: the `platform` command from `@marinoscar/platform-db`, `scripts/platform-env.js`, `prisma/` and `prisma.config.ts`. Confirm that during the rehearsal on the built image, not for the first time in the window.

## 8. A failed migration row

`LEDGER_FAILED_ROW` means `_prisma_migrations` has a row that never finished or was rolled back, with no later successful row. Everything else in the report is untrustworthy until it is resolved.

1. Read the row: `SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;`
2. Inspect the schema and decide: did the migration take effect fully, or not at all?
3. Resolve it with `npm run prisma -- migrate resolve --rolled-back <dir>` or `--applied <dir>`.
4. Re-run the dry run.

If the schema is half changed, restore the backup instead (section 9).

## 9. Rollback

- **Before `--apply`**: nothing needs undoing. A dry run writes nothing.
- **A rehearsal**: drop the scratch database.
- **After `--apply` on production**:
  1. Keep the window open. Stop the API.
  2. Restore the backup taken in step 2 of section 7. Use `docs/runbooks/database-restore.md` (section 8 if the API can serve, otherwise section 4).
  3. Revert the PR that carries the baseline. The revert restores `schema.prisma`, removes the installed directories and removes `platform.lock`.
  4. Redeploy the previous release and close the window.

A restore is the only clean way back once `prisma:migrate` has applied `0015` to `0037`. Do not write down-migrations.

## 10. Row-level security

Platform `0025_org_scoped_rls` forces row-level security on `storage_objects` and other tables. While the application connects as a superuser, the policies are inert: a superuser ignores every policy.

- Do not change `POSTGRES_USER` to a non-superuser role before #471.
- `--allow-rls` records your statement that you know this. It does not make the role safe.
- KVox domain tables keep plain foreign keys to `storage_objects(id)`. That is valid in single-org mode. A composite `(object_id, org_id)` key is only needed if KVox goes multi-org. See `docs/platform-adoption/local-exceptions.md`.

## 11. Refusal codes

| Code | Fix |
|---|---|
| `RLS_OPT_IN_REQUIRED` | Add `--allow-rls` after reading section 10 |
| `LEDGER_FAILED_ROW` | Section 8 |
| `LEDGER_ROW_MISSING`, `LEDGER_CHECKSUM_MISMATCH` | A KVox directory was edited or never applied. Restore it from Git, or lower `--through` |
| `DIFF_BLOCKING` | Section 5. A platform-table statement outside the four columns is a real difference: stop |
| `INDEX_MISSING`, `INDEX_DEFINITION_DIFFERS` | The lock's `definition` is not what `pg_indexes` prints, or the index is gone. Fix the lock entry from `pg_indexes`. If the index is gone, add a forward migration |
| `LOCK_NOT_EMPTY` | `--force-remap`, after reading the dry run |
| `PLACEMENT_IMPOSSIBLE`, `MAP_INVALID` | Do not rename an applied directory. Read the message and ask in #463 |
| `RESOLVE_FAILED` | Read Prisma's message. `P3008` means the directory is already recorded. No lock was written; fix and re-run |
| `permission denied to create database` | The role cannot create the shadow database. Pass `--shadow-database-url <empty database>` |
| `P3005` on `migrate deploy` | The database was never managed by Prisma Migrate. Not expected for KVox |

## 12. Rehearsal record

Filled in during #463. The production dry run in section 7 is compared with it.

| Item | Value |
|---|---|
| Date and operator | `<<REHEARSAL-DATE>>` |
| Backup used | `<<REHEARSAL-BACKUP>>` |
| `@marinoscar/platform-db` version | `<<REHEARSAL-VERSION>>` |
| First dry run (before deviations) | see below |
| Dry run after declaring deviations | see below |
| `--apply` | see below |
| `prisma:migrate` | see below |
| Second dry run (`nothing to do`) | see below |
| Fresh database proof (`db:drift:kvox`) | see below |

```text
<<REHEARSAL-REPORT>>
```

## 13. Related

- `docs/platform-adoption/local-exceptions.md`: every deviation and shim, and the issue that removes it.
- `docs/platform-adoption/README.md`: the adoption program.
- `.claude/skills/platform-migration/SKILL.md`: the day-to-day schema workflow after the baseline.
- `docs/DEVELOPMENT.md`, "Making Database Changes".
- `docs/runbooks/database-restore.md`, `docs/runbooks/maintenance-mode.md`.
