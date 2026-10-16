# Runbook: Migrate AI keys and AI settings to the platform AI slice

**Audience:** the operator of a deployment that upgrades from the app's own AI
layer (per-user keys in `user_ai_credentials`, the model allow-list inside the `ai`
system setting) to the platform AI slice (`user_ai_keys`, `ai_models`, the
platform `ai` namespace).
**Applies to:** issues #474 and #477 (epic #472). Run it **once per deployment**.

> **Order matters, and the last step cannot be undone.** The release that
> deletes the old AI code (issue #477) also **drops the table
> `user_ai_credentials`** (`DROP TABLE "user_ai_credentials";`, run by
> `prisma:migrate`). The keys are only migrated by the **previous build's**
> command, so:
>
> 1. On the build that still has the key import (the one from issue #474, before
>    #477), run this command with `--dry-run`, then `--apply`, and confirm
>    section 4's report shows no undecryptable and no failed key.
> 2. Only then upgrade to the #477 build.
>
> After the upgrade the keys table does not exist, so the only way to bring a key
> back is to restore the database backup from step 1 of the procedure.

Source of truth for every claim below:

- `apps/api/src/ai-port/migrate/ai-legacy-migrate.ts` — the command, the
  snapshot and the restore (this build).
- `apps/api/src/ai-port/migrate/ai-legacy-plan.ts` and
  `legacy-model-knowledge.ts` — the pure planner and the frozen copy of the model
  knowledge it resolves against: stored `ai` value to platform value and
  `ai_models` rows.
- `apps/api/test/ai/ai-legacy-migrate.db.spec.ts` — every behaviour described here
  that this build still has, run against a real Postgres.
- The previous build (#474) additionally had `legacy-cipher.ts` (the read-only
  copy of the old cipher) and called `UserAiKeysService.importKey` from
  `@marinoscar/platform-api/ai` for each key. Both are gone from this build with
  the table they read.

This is an operator command, not a queue job: no request or schedule starts it, so
the job-queue rule does not apply to it. It lives under `apps/api/src/` so the
production image runs it from `dist/` without `ts-node`.

---

## 1. What it changes, and what it never touches

| Step | This build (#477) | The previous build (#474) |
|---|---|---|
| Keys | **Looks only.** Prints that there is nothing to migrate when `user_ai_credentials` does not exist or is empty. When the table still exists and holds rows, `--dry-run` reports it as a problem (exit 1) and `--apply` refuses before writing anything. | Read `user_ai_credentials` (decrypted with the old cipher, purpose `ai-key`) and wrote `user_ai_keys` through `importKey`, one `audit_events` row per key (`ai:user-key:import`, `source` = the app slug), one `ai.keys.recheck` job per provider (deduplicated) |
| Models | the stored `ai.providers.openai.allowedModels` -> one enabled `ai_models` row per entry, marked `admin_override`; plus `text-embedding-3-small` (search and the graph need it even when it was never in the list) | same |
| Settings | the raw `ai` value of the `global` `system_settings` row -> the same `ai` value in the platform shape, one `audit_events` row (`system_settings:ai-legacy-migrate`) | same |

The settings rewrite sets `ai.enabled`, `ai.keyPolicy = 'byok'`,
`ai.providers.openai = { enabled, baseUrl? }` and `ai.defaultModel`, and removes
`ai.provider`, `ai.providers.openai.allowedModels` and
`ai.providers.openai.defaultModel`. A base URL equal to the OpenAI default is not
carried over. `taskModels`, `graphEnabled`, the token and timeout limits and every
other namespace of the row keep their stored values.

The command **never** modifies or deletes `user_ai_credentials`. The table is
dropped by the #477 migration, not by this command.

Not migrated:

- **`lastUsedAt`.** The platform keeps no such field.
- **The key label** (`work`, `personal`). The platform key row has no label.
- **Usage history.** The old layer kept no usage ledger.
- **Organization keys.** This deployment has a single organization and no
  organization key.

Imported keys are stored **unverified**. `ai.keys.recheck` verifies each one and
computes the models it can reach. A key the vendor rejects (revoked, expired) shows
as unverified or failed on that user's AI keys page; that is expected and is the
platform telling the user, not a migration fault.

## 2. Before you start

1. Decide which build you are on.
   - **Still on the #474 build** (the table exists): follow sections 2 to 6 on
     that build, including the key import and its flags (`--allow-undecryptable`,
     section 4). That is the supported path for any deployment with keys.
   - **Already on the #477 build** (the table is gone): only the settings and
     models steps remain, and they are safe to run. Keys cannot be recovered by
     this command; restore the backup taken before the upgrade if you need them.
2. `SECRETS_ENCRYPTION_KEY` is set in the environment the key import runs in, to
   the **same value** the old keys were written under. Both the old and the
   platform cipher derive from it. If it was rotated since a key was saved, that
   key cannot be read (section 7). This build needs no encryption key.
3. The database has the platform AI tables (`user_ai_keys`, `ai_models`): they come
   with the platform baseline migrations.
4. Pick where the snapshot goes. The default is the working directory of the
   container. Put it on a volume that survives the container if you want the
   fast rollback (section 6), for example `--snapshot /var/backups/ai-legacy.json`.

## 3. Procedure

Run the commands inside the API container. The npm script is
`ai:migrate-legacy`; everything after `--` is passed to the command.

```bash
cd infra/compose
docker compose -f base.compose.yml -f prod.compose.yml exec api npm run ai:migrate-legacy -- --dry-run
```

1. **Take a database backup.** Use the admin backup action
   ([`docs/specs/database-backup.md`](../specs/database-backup.md)) or your own
   `pg_dump`, and confirm the archive exists. This is the rollback of last resort
   and, once the #477 migration has run, the **only** way back for a key
   (section 6). Restoring it is [`database-restore.md`](database-restore.md).
2. **Run the dry run.** `--dry-run` is the default. It writes nothing: no row, no
   file, no job. It prints the report (section 4). In a dry run `upserted` is what
   an apply would do, not what happened (and, on the #474 build, so is
   `imported`).
3. **Read the report.**
   - On the #474 build, `undecryptable` must be `0`, or you must have decided to
     accept those users re-entering their key (section 7). The exit code is
     non-zero until you pass `--allow-undecryptable`.
   - On the #477 build, the `keys` line must read `nothing to migrate`. If it
     reports rows left in `user_ai_credentials` (this build was started before
     `prisma:migrate` ran), stop: run the previous build's command first.
   - `models.allowed` is the number of entries in the stored allow-list; `upserted`
     is that plus the embedding model when it was not listed.
   - `settings.defaultModel` and `settings.taskModels` are the values the platform
     will route on. They should match what the admin AI page showed before.
   - On the #474 build, warnings of the form
     `replacing the platform key of userId=... provider=...` mean a user already has
     a platform key with a different last-four hint. The apply replaces it with the
     legacy key (section 5).
4. **Apply.** Optionally keep the maintenance window short with
   [maintenance mode](maintenance-mode.md); it is not required, because the settings
   write is guarded on the row version (section 7).

   ```bash
   docker compose -f base.compose.yml -f prod.compose.yml exec api \
     npm run ai:migrate-legacy -- --apply --snapshot /var/backups/ai-legacy.json
   ```

   The command writes the snapshot **first** and refuses to continue when it
   cannot (or when the file already exists; it never overwrites an earlier
   snapshot). It then writes the models and the settings in one transaction (on
   the #474 build it imports the keys before that). The report is also written
   beside the snapshot (`ai-legacy.report.json`).
5. **Check the report** against the dry run. `models.enabled` is the number of
   enabled OpenAI rows. On the #474 build, `keys.target` counts the platform key
   rows that carry an import audit row from this migration; after a clean first
   run it equals `imported`.
6. **Run it again** (optional, proves idempotence). The second run leaves the
   settings row alone (its version does not move) and creates only a missing
   embedding row. It never re-enables a model an administrator turned off, and
   never resets `keyPolicy`. On the #474 build it also reports every decryptable
   key as `alreadyImported` and `imported=0`.
7. **Upgrade to the #477 build** (only when you were on the #474 build). The
   release migration drops `user_ai_credentials`. From here a key lives only in
   `user_ai_keys`.
8. **Wait for the key rechecks to settle.** Open the admin Jobs page and filter by
   type `ai.keys.recheck`: one job per provider, deduplicated. Wait until it is
   `succeeded` (it verifies every imported key at the vendor, one round trip each).
9. **Generate one note per test account.** For each of a few users who had a key,
   sign in and generate a note with the same model they used before. The key must
   be the same and the model must be the one in the report. A user whose key the
   vendor now rejects sees it as unverified; they re-enter it on `/settings/ai`.

## 4. The report

This build:

```
APPLIED
keys: nothing to migrate (they live in user_ai_keys)
models: allowed=5 upserted=6 enabled=6
settings: enabled=true providerEnabled=true defaultModel=gpt-5.4-mini taskModels=graph.agent,graph.extract
```

The #474 build printed a key line instead, for example
`keys: source=6 imported=4 alreadyImported=0 undecryptable=2 failed=0 target=4`:

| Field | Meaning |
|---|---|
| `keys.source` | rows in `user_ai_credentials` |
| `keys.imported` | keys handed to `importKey` (planned, in a dry run) |
| `keys.alreadyImported` | the platform already holds a key for that user and provider with the same hint, so nothing was written |
| `keys.undecryptable` | the stored ciphertext could not be opened (wrong `SECRETS_ENCRYPTION_KEY`, or a corrupt row); the row's id, user id and provider are logged, never the ciphertext |
| `keys.failed` | `importKey` threw for the row; the log names the row id, provider and error class and code |
| `keys.target` | platform key rows with an import audit row from this migration |

| Field | Meaning |
|---|---|
| `models.allowed` | entries still present in the stored allow-list (zero on a rerun: they were removed) |
| `models.upserted` | rows written (a rerun writes only a missing embedding row) |
| `models.enabled` | enabled OpenAI rows in `ai_models` |
| `settings.*` | the migrated `enabled`, `providers.openai.enabled`, `defaultModel` and the `taskModels` keys |

**Exit code.** `0` when there is no problem to report; `1` and a `PROBLEM:` line
per cause otherwise. On this build the one problem is a dry run that finds rows left
in `user_ai_credentials`. On the #474 build the exit code was `0` only when
`source = imported + alreadyImported + undecryptable` (which also means
`failed = 0`) and `undecryptable = 0`, or when `--allow-undecryptable` was given. A
usage error exits `2`.

**No secret is ever printed or written.** The snapshot, the report file, the log
and the error output hold ids, providers, hints and counts only. The database spec
greps all of them for the seeded keys and ciphertexts.

## 5. Re-running, and the replace warning

The command is safe to rerun: a settings value that no longer holds a legacy key is
not rewritten, and an `ai_models` row an administrator changed since is not
touched.

On the #474 build, `importKey` **replaces** a platform key the user already stored
for that provider, and a key whose platform copy has the same hint is skipped. So
do not rerun the apply there after users have started entering keys on the platform
side: a key whose hint differs from the legacy one would be overwritten by the
legacy key. The warning in section 3 shows which users it would affect. If you must
rerun after cutover, run `--dry-run` first and read every warning.

## 6. Rollback

1. **Settings and models, from the snapshot** (fast):

   ```bash
   docker compose -f base.compose.yml -f prod.compose.yml exec api \
     npm run ai:migrate-legacy -- --restore /var/backups/ai-legacy.json
   ```

   `--restore --dry-run` prints what it would do and writes nothing. The restore:
   - writes the snapshot's `ai` value back into the settings row (version bumped,
     audited as `system_settings:ai-legacy-restore`);
   - puts back the `ai_models` rows the snapshot listed (enabled flag, name,
     capabilities, numbers) and sets `enabled = false` on the OpenAI rows it did
     not list. Disabled rows stay; nothing is deleted;
   - **leaves every `user_ai_keys` row in place.** A key is a real platform key
     now: the user may have replaced or tested it since, and the snapshot holds
     hints, never secrets, so a deletion could not be undone. (A snapshot written
     by the #474 build, version 1, also lists imported keys; this build ignores
     them and says so.) The #474 build's restore deleted the keys it had imported;
     that behaviour is gone with the key import.
2. **Keys, or everything, once the #477 migration has run:** restore the database
   backup from step 1 of the procedure ([`database-restore.md`](database-restore.md)).
   There is no other way to bring `user_ai_credentials` back, and reverting the
   application image alone does not: the table is dropped by `prisma:migrate`.
   Before the #477 migration has run, reverting the application to the previous
   build brings the old behaviour back without any data step.

Delete the snapshot and the report when you no longer need them. They hold no key,
but they name users and hints.

## 7. Troubleshooting

| Symptom | Cause and action |
|---|---|
| `Refusing to --apply: the snapshot ... could not be written` | The path is not writable, its parent is a file, or the file already exists. Nothing was changed. Choose another `--snapshot` path. |
| `Refusing to --apply: N row(s) remain in user_ai_credentials and this build cannot import them` | This build cannot import keys and the upgrade drops that table. Run the previous (#474) build's command first, then upgrade. Nothing was changed. |
| `The system settings row changed while the migration ran (version mismatch)` | An administrator saved system settings between the command's read and its write. Nothing was written for settings or models (their transaction rolled back). Run it again. |
| `undecryptable credential id=... userId=... provider=...` (#474 build) | `SECRETS_ENCRYPTION_KEY` differs from the value those keys were saved under (a rotation or a restore from another environment), or the row is corrupt. Fix the variable if it is wrong and rerun. If the old key is gone for good, pass `--allow-undecryptable` and tell those users to enter their key again on `/settings/ai`. Never guess at a ciphertext; see [`rotate-secrets-encryption-key.md`](rotate-secrets-encryption-key.md). |
| `keys: import failed for credential id=... provider=...` (#474 build) | `importKey` rejected the row (the error class and code are logged). The rest of the keys were imported. Fix the cause and rerun; imported keys are skipped. |
| `models: N allowedModels entr(y/ies) were not valid and were skipped` | A stored entry failed the legacy normaliser (empty id, wrong type). Its position is logged. It is skipped; add the model on the admin AI models page if it was meant to be permitted. |
| `settings: the global row holds no ai value` | The settings row has never stored an AI policy. Only the embedding row is migrated. |
| A user's migrated key shows as unverified | The recheck job has not run yet, or the vendor rejected the key. Wait for `ai.keys.recheck`; if it stays unverified the key is no longer valid and the user enters a new one on `/settings/ai`. |
| A user says their key is gone after the upgrade | The key was not migrated before `user_ai_credentials` was dropped. The user enters it again on `/settings/ai`, or the operator restores the pre-upgrade backup (section 6). |

## 8. After the migration

- The platform key table is encrypted under its own purpose, `ai_user_key`, by the
  same `SECRETS_ENCRYPTION_KEY`. A key rotation covers `user_ai_keys` and
  `credentials`; the rotation runbook
  ([`rotate-secrets-encryption-key.md`](rotate-secrets-encryption-key.md)) lists
  both.
- `user_ai_credentials`, the old AI code and the key import are gone. This command
  stays, for settings and models only, until every deployment has run it; the
  register is [`docs/platform-adoption/local-exceptions.md`](../platform-adoption/local-exceptions.md).
