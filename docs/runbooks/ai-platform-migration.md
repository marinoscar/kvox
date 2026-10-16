# Runbook: Migrate AI keys and AI settings to the platform AI slice

**Audience:** the operator of a deployment that upgrades from the app's own AI
layer (per-user keys in `user_ai_credentials`, the model allow-list inside the `ai`
system setting) to the platform AI slice (`user_ai_keys`, `ai_models`, the
platform `ai` namespace).
**Applies to:** issue #474 (epic #472). Run it **once per deployment**, after the
release that mounts the platform AI slice (issue #473) is running, and before the
release that switches the callers over (issue #475).

Source of truth for every claim below:

- `apps/api/src/ai-port/migrate/ai-legacy-migrate.ts` — the command, the
  snapshot and the restore.
- `apps/api/src/ai-port/migrate/ai-legacy-plan.ts` — the pure planner: stored
  `ai` value to platform value and `ai_models` rows.
- `apps/api/src/ai-port/migrate/legacy-cipher.ts` — the read-only copy of the old
  cipher.
- `apps/api/test/ai/ai-legacy-migrate.db.spec.ts` — every behaviour described here,
  run against a real Postgres.
- `UserAiKeysService.importKey` in `@marinoscar/platform-api/ai` — the platform
  call that stores each key.

This is an operator command, not a queue job: no request or schedule starts it, so
the job-queue rule does not apply to it. It lives under `apps/api/src/` so the
production image runs it from `dist/` without `ts-node`.

---

## 1. What it changes, and what it never touches

| Step | Reads | Writes |
|---|---|---|
| Keys | `user_ai_credentials` (decrypted with the old cipher, purpose `ai-key`), `user_ai_keys` | `user_ai_keys` through `importKey`, one `audit_events` row per key (`ai:user-key:import`, `source` = the app slug), one `ai.keys.recheck` job per provider (deduplicated) |
| Models | the stored `ai.providers.openai.allowedModels` | one enabled `ai_models` row per entry, marked `admin_override`; plus `text-embedding-3-small` (search and the graph need it even when it was never in the list) |
| Settings | the raw `ai` value of the `global` `system_settings` row | the same `ai` value in the platform shape, one `audit_events` row (`system_settings:ai-legacy-migrate`) |

The settings rewrite sets `ai.enabled`, `ai.keyPolicy = 'byok'`,
`ai.providers.openai = { enabled, baseUrl? }` and `ai.defaultModel`, and removes
`ai.provider`, `ai.providers.openai.allowedModels` and
`ai.providers.openai.defaultModel`. A base URL equal to the OpenAI default is not
carried over. `taskModels`, `graphEnabled`, the token and timeout limits and every
other namespace of the row keep their stored values.

It **never** modifies or deletes `user_ai_credentials`. The old code path keeps
working on a reverted build, and issue #477 drops the table in a later release.

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

1. The running API is the build that mounts the platform AI slice (#473). `--apply`
   boots the application and asks it for the platform key service; on a build
   without the slice it stops with an explanatory error before writing anything.
2. `SECRETS_ENCRYPTION_KEY` is set in the environment the command runs in, to the
   **same value** the old keys were written under. Both the old and the platform
   cipher derive from it. If it was rotated since a key was saved, that key cannot
   be read (section 7).
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
   (section 6). Restoring it is
   [`database-restore.md`](database-restore.md).
2. **Run the dry run.** `--dry-run` is the default. It writes nothing: no row, no
   file, no job. It prints the report (section 4). In a dry run `imported` and
   `upserted` are what an apply would do, not what happened.
3. **Read the report.**
   - `undecryptable` must be `0`, or you must have decided to accept those users
     re-entering their key (section 7). The exit code is non-zero until you pass
     `--allow-undecryptable`.
   - `models.allowed` is the number of entries in the stored allow-list; `upserted`
     is that plus the embedding model when it was not listed.
   - `settings.defaultModel` and `settings.taskModels` are the values the platform
     will route on. They should match what the admin AI page showed before.
   - Warnings of the form `replacing the platform key of userId=... provider=...`
     mean a user already has a platform key with a different last-four hint. The
     apply replaces it with the legacy key (section 5).
4. **Apply.** Optionally keep the maintenance window short with
   [maintenance mode](maintenance-mode.md); it is not required, because the settings
   write is guarded on the row version (section 7).

   ```bash
   docker compose -f base.compose.yml -f prod.compose.yml exec api \
     npm run ai:migrate-legacy -- --apply --snapshot /var/backups/ai-legacy.json
   ```

   The command writes the snapshot **first** and refuses to continue when it
   cannot (or when the file already exists; it never overwrites an earlier
   snapshot). It then imports the keys, and writes the models and the settings in
   one transaction. The report is also written beside the snapshot
   (`ai-legacy.report.json`). The process starts with the job worker, the lease
   reaper and the schedulers switched off, so it claims no job while it works.
5. **Check the report** against the dry run. `keys.target` counts the platform key
   rows that carry an import audit row from this migration; after a clean first
   run it equals `imported`. `models.enabled` is the number of enabled OpenAI rows.
6. **Run it again** (optional, proves idempotence). The second run reports every
   decryptable key as `alreadyImported` and `imported=0`, leaves the settings row
   alone (its version does not move) and creates only a missing embedding row. It
   never re-enables a model an administrator turned off, and never resets
   `keyPolicy`.
7. **Wait for the key rechecks to settle.** Open the admin Jobs page and filter by
   type `ai.keys.recheck`: one job per provider, deduplicated. Wait until it is
   `succeeded` (it verifies every imported key at the vendor, one round trip each).
8. **Generate one note per test account.** For each of a few users who had a key,
   sign in and generate a note with the same model they used before. The key must
   be the same and the model must be the one in the report. A user whose key the
   vendor now rejects sees it as unverified; they re-enter it.

## 4. The report

```
APPLIED
keys: source=6 imported=4 alreadyImported=0 undecryptable=2 failed=0 target=4
models: allowed=5 upserted=6 enabled=6
settings: enabled=true providerEnabled=true defaultModel=gpt-5.4-mini taskModels=graph.agent,graph.extract
```

| Field | Meaning |
|---|---|
| `keys.source` | rows in `user_ai_credentials` |
| `keys.imported` | keys handed to `importKey` (planned, in a dry run) |
| `keys.alreadyImported` | the platform already holds a key for that user and provider with the same hint, so nothing was written |
| `keys.undecryptable` | the stored ciphertext could not be opened (wrong `SECRETS_ENCRYPTION_KEY`, or a corrupt row); the row's id, user id and provider are logged, never the ciphertext |
| `keys.failed` | `importKey` threw for the row; the log names the row id, provider and error class and code |
| `keys.target` | platform key rows with an import audit row from this migration |
| `models.allowed` | entries still present in the stored allow-list (zero on a rerun: they were removed) |
| `models.upserted` | rows written (a rerun writes only a missing embedding row) |
| `models.enabled` | enabled OpenAI rows in `ai_models` |
| `settings.*` | the migrated `enabled`, `providers.openai.enabled`, `defaultModel` and the `taskModels` keys |

**Exit code.** `0` only when `source = imported + alreadyImported + undecryptable`
(which also means `failed = 0`) and `undecryptable = 0`, or when
`--allow-undecryptable` was given. Anything else exits `1` and prints a `PROBLEM:`
line per cause. A usage error exits `2`.

**No secret is ever printed or written.** A plaintext key exists only between the
old cipher's decrypt and the `importKey` call. The snapshot, the report file, the
log and the error output hold ids, providers, hints and counts only. The database
spec greps all of them for the seeded keys and ciphertexts.

## 5. Re-running, and the replace warning

The command is safe to rerun: a key whose platform copy already has the same hint
is skipped, and a settings value that no longer holds a legacy key is not rewritten.

`importKey` **replaces** a platform key the user already stored for that provider.
So do not rerun the apply after users have started entering keys on the platform
side: a key whose hint differs from the legacy one would be overwritten by the
legacy key. The warning above shows which users it would affect. If you must rerun
after cutover, run `--dry-run` first and read every warning.

## 6. Rollback

1. **From the snapshot** (fast):

   ```bash
   docker compose -f base.compose.yml -f prod.compose.yml exec api \
     npm run ai:migrate-legacy -- --restore /var/backups/ai-legacy.json
   ```

   `--restore --dry-run` prints what it would do and writes nothing. The restore:
   - writes the snapshot's `ai` value back into the settings row (version bumped,
     audited as `system_settings:ai-legacy-restore`);
   - deletes the `user_ai_keys` rows that have an import audit row newer than the
     snapshot. A key that was imported before the snapshot was taken is left alone.
     A platform key that the apply **replaced** is deleted too: the snapshot holds
     hints, never secrets, so it cannot bring that key back and the user enters it
     again;
   - puts back the `ai_models` rows the snapshot listed (enabled flag, name,
     capabilities, numbers) and sets `enabled = false` on the OpenAI rows it did
     not list. Disabled rows stay; nothing is deleted;
   - never touches `user_ai_credentials`.
2. **If the snapshot is lost:** restore the database backup from step 1 of the
   procedure ([`database-restore.md`](database-restore.md)).
3. `user_ai_credentials` and the old settings code are untouched by this issue, so
   reverting the application to the previous build brings the old behaviour back
   without any data step.

Delete the snapshot and the report when you no longer need them. They hold no key,
but they name users and hints.

## 7. Troubleshooting

| Symptom | Cause and action |
|---|---|
| `Refusing to --apply: the snapshot ... could not be written` | The path is not writable, its parent is a file, or the file already exists. Nothing was changed. Choose another `--snapshot` path. |
| `The system settings row changed while the migration ran (version mismatch)` | An administrator saved system settings between the command's read and its write. Nothing was written for settings or models (their transaction rolled back); keys already imported stay and are skipped on the rerun. Run it again. |
| `The platform UserAiKeysService is not part of this build's application graph` | The running build does not mount the platform AI slice (#473). Deploy that release first. Nothing was changed. |
| `undecryptable credential id=... userId=... provider=...` | `SECRETS_ENCRYPTION_KEY` differs from the value those keys were saved under (a rotation or a restore from another environment), or the row is corrupt. Fix the variable if it is wrong and rerun. If the old key is gone for good, pass `--allow-undecryptable` and tell those users to enter their key again on the platform AI keys page. Never guess at a ciphertext; see [`rotate-secrets-encryption-key.md`](rotate-secrets-encryption-key.md). |
| `keys: import failed for credential id=... provider=...` | `importKey` rejected the row (the error class and code are logged). The rest of the keys were imported. Fix the cause and rerun; imported keys are skipped. |
| `models: N allowedModels entr(y/ies) were not valid and were skipped` | A stored entry failed the legacy normaliser (empty id, wrong type). Its position is logged. It is skipped; add the model on the admin AI models page if it was meant to be permitted. |
| `settings: the global row holds no ai value` | The settings row has never stored an AI policy. Only the keys and the embedding row are migrated. |
| A user's migrated key shows as unverified | The recheck job has not run yet, or the vendor rejected the key. Wait for `ai.keys.recheck`; if it stays unverified the key is no longer valid and the user enters a new one. |

## 8. After the migration

- The platform key table is encrypted under its own purpose, `ai_user_key`, by the
  same `SECRETS_ENCRYPTION_KEY`. A key rotation must now cover `user_ai_keys` as well
  as `user_ai_credentials` and `credentials`; the rotation runbook's table lists the
  tables it knew when it was written.
- Issue #477 drops `user_ai_credentials`, the old AI code and this command, after a
  release in which both tables exist.
