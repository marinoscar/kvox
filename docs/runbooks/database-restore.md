# Runbook: Restore the Database From a Backup

**Read this assuming the application is down.** That is when it is read, so
nothing below requires the admin UI, a browser session, or the API being able
to serve a request. Every step has a form you can run from a shell with `psql`
and the PostgreSQL client tools.

Source of truth for every claim below:

- `apps/api/src/db-backup/restore-preflight.service.ts` — the seven gates, the
  three outcomes, and the command block the `guided` outcome produces.
- `apps/api/src/db-backup/database-restore.service.ts` — the automated restore:
  the scratch-database replay, the swap, the catalog carry-over and rollback.
- `apps/api/src/db-backup/admin-connection.util.ts` — the maintenance
  connection, the identifier rules and the scratch/old name builders.
- `apps/api/src/db-backup/pg-restore.util.ts` — the `pg_restore` flags, and why
  `--exit-on-error` is load-bearing.
- `apps/api/src/db-backup/db-backup-admin.service.ts` — the backup list and the
  five-minute signed download URL.
- `docs/specs/database-restore.md` — the design, and the rejected alternatives.
- `docs/specs/database-backup.md` — where the archives come from.

**Which procedure you want.**

- **The API is serving.** The application can perform the restore itself, and
  roll it back. That is **section 8**, and it is the path to prefer: it takes
  the safety backup, verifies the archive, replays into a scratch database while
  the application stays up, and swaps in seconds. #286 adds the endpoints that
  start it and #287 the dialog; until they land it is reachable only from code.
- **The API is not serving, or the pre-flight came back `guided`.** Section 4 is
  the procedure, by hand, from a shell. It is the same sequence, with you
  issuing the statements.

Sections 1-3 (what to know first, what the pre-flight tells you, disk space)
apply to both. So do the two prerequisites in **section 7** — get those wrong
and a *successful* restore leaves the application down.

---

## 1. Before you start

- **Know which archive you want.** Every backup is a `database_backup_runs` row
  with a `migration_name` on it — the schema that archive contains. Restoring
  an archive from a different migration than the running code expects is a
  decision, not an accident; see section 6.
- **Know the two prerequisites in section 7.** They are about the deployment,
  not the restore, and they have to be true *before* you start. Getting them
  wrong turns a successful restore into an outage.
- **Have a way back.** Until the swap is done and verified, the way back is the
  displaced database. After it is dropped, the way back is the `pre_restore`
  archive — measured in hours, not seconds.
- **Do not delete anything until you have verified the restore.** Not the
  scratch database, not the displaced one, not the archive.

## 2. What the pre-flight tells you

The pre-flight is side-effect free: it creates nothing, drops nothing, renames
nothing. Run it as often as you like.

It reports **seven gates**, each with a verdict and, when there is something to
do, an action:

| Gate | What it means when it is unhappy |
| --- | --- |
| PostgreSQL client version | The `pg_restore` in the API image is older than the server. **Nothing can restore until the image is rebuilt** — see `postgres-client-version.md`. |
| Cluster admin connection | The API cannot open a session on the `postgres` maintenance database. It cannot automate a restore; you still can. |
| `CREATE DATABASE` privilege | The application's role may not create databases. **Normal on managed PostgreSQL.** You still can, with a superuser. |
| Required extensions | The server does not offer an extension the database uses. `pg_restore` would stop on that line. Install the package on the server. |
| Free disk space | There is not room for a full copy (twice over, if the displaced database is being kept). **Never a refusal** — see section 3. |
| Connected clients | More than one client address is attached. Usually a second API replica, sometimes just a `psql` window. **A hint, not a verdict.** |
| Schema compatibility | The archive's migration and the live one differ, in either direction. **Blocks** until you accept it — see section 6. |

And **one of three outcomes**:

- **`ok`** — go ahead.
- **`guided`** — the application cannot do it, so it hands you a complete,
  paste-ready command block for doing it yourself. **This is a normal outcome,
  not an error.** Managed PostgreSQL denies `CREATEDB` as a matter of course.
- **`blocked`** — something would break. Only the schema gate can be
  overridden.

### 2.1 Running it without the UI

Once #286 lands, the pre-flight is an endpoint on the admin API and the CLI
reaches it with:

```bash
appctl api POST /api/admin/db-backup/runs/<run id>/restore/preflight
```

**If the API is not serving**, you cannot run it — and you do not need it. The
gates only tell you what section 4 would tell you anyway; go straight there and
read the errors as they happen. The two facts worth checking by hand first:

```bash
# Can this role create a database?
psql --host=<db host> --port=<db port> --username=<db user> --dbname=postgres \
  -c "SELECT rolsuper OR rolcreatedb AS can_create FROM pg_roles WHERE rolname = current_user;"

# Is the client new enough for the server?
pg_restore --version
psql --host=<db host> --port=<db port> --username=<db user> --dbname=postgres \
  -c 'SHOW server_version_num;'
```

The client major must be **greater than or equal to** the server major
(`server_version_num / 10000`). Older will not work at all.

## 3. Disk space, and the downgrade

A restore needs roughly **one full copy** of the database for the scratch
replay, and **a second** if the displaced database is being kept.

`databaseBackup.restoreRollbackMode` says which you asked for:

- `retain_database` — the displaced database is kept, renamed to
  `<database>_old_<timestamp>`, and deleted later by
  `oldDatabaseRetentionHours`. Rolling back is **one rename: seconds**.
- `drop_database` — it is not kept. Rolling back means restoring the
  `pre_restore` archive: **hours**.

**When disk is short, the pre-flight downgrades `retain_database` and tells
you.** It does not refuse. An administrator mid-incident must never be left
without a path forward, and what the downgrade costs you is a real, statable
thing: the recovery guarantee changes from seconds to hours. If you would
rather keep the fast rollback, free disk on the database server and run the
pre-flight again.

If the pre-flight says free space **could not be checked**, that is expected —
the database is usually on a host the API container cannot see the disks of.
Check by hand:

```bash
# On the database host:
df -h "$(psql --username=<db user> --dbname=postgres -tAc 'SHOW data_directory')"
```

## 4. The manual restore (the `guided` path, end to end)

This is the procedure the `guided` command block automates the parameters of.
Run it **as a role that may create databases** — a superuser, or any role
holding `CREATEDB`. On managed PostgreSQL this is usually the provider's admin
user, not the application's.

Throughout: `<live>` is the application's database (`POSTGRES_DB`), `<scratch>`
is `<live>_restore_<UTC timestamp>` and `<old>` is `<live>_old_<UTC timestamp>`.
Use the exact names the pre-flight printed when you have them.

### 4.0 Credentials

```bash
export PGPASSWORD='<the POSTGRES_PASSWORD this deployment uses>'
```

The application never prints this — putting a live database credential in an
HTTP response would leave it in a browser's memory, a screenshot, and probably
a support ticket.

### 4.1 Get the archive

With the API serving:

```bash
appctl api GET /api/admin/db-backup/runs/<run id>/download
curl -fSL -o /tmp/<archive>.dump "<the URL that command printed>"
```

The URL expires in **five minutes** and is a complete copy of the database to
anyone holding it. Treat it as a credential.

**With the API down**, fetch the object directly from the bucket. The run row
records `bucket` and `storage_key` precisely so the archive stays findable when
nothing else works:

```bash
aws s3 cp "s3://<bucket>/<storage key>" /tmp/<archive>.dump
```

If you cannot reach the database to read those columns either, backup keys are
laid out as
`database-backups/<app slug>/<YYYY>/<MM>/<app slug>-<UTC timestamp>-<run id>.dump`,
which lists in time order:

```bash
aws s3 ls "s3://<bucket>/database-backups/" --recursive | tail -20
```

### 4.2 Sanity-check the archive before you touch anything

```bash
pg_restore --list /tmp/<archive>.dump | head -20
```

An archive whose table of contents is **empty** would restore an empty
database. The backup engine already verifies this at upload time, but a file
that travelled through a laptop is worth re-checking.

### 4.3 Create the scratch database and replay into it

Nothing here touches the live database.

```bash
createdb --host=<db host> --port=<db port> --username=<admin role> <scratch>

pg_restore --host=<db host> --port=<db port> --username=<admin role> \
  --dbname=<scratch> \
  --no-owner --no-acl --exit-on-error --jobs=4 \
  /tmp/<archive>.dump
```

**`--exit-on-error` is load-bearing.** Without it `pg_restore` logs each
failure, carries on, and **exits 0** — so a database missing half its tables is
indistinguishable from a good one, and you would swap it into place believing
it worked.

`--no-owner --no-acl` mirror how the archive was dumped: it carries no
ownership, and the restore must not try to reapply any. Without them a restore
onto a fresh machine fails on the first `ALTER ... OWNER TO` naming a role that
does not exist there — which is exactly the restore that matters.

Then look at what you have before you commit to it:

```bash
psql --host=<db host> --username=<admin role> --dbname=<scratch> \
  -c "SELECT count(*) FROM users;" \
  -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;"
```

### 4.4 Stop the application

**Everything below renames databases out from under any process still
connected**, and a rename fails while a session is open. Stop every API
instance, not just one — see section 7.

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml stop api
```

### 4.5 Swap

Three statements, from the **maintenance** database (`postgres`) — a database
cannot be renamed from a session connected to it:

```bash
psql --host=<db host> --port=<db port> --username=<admin role> --dbname=postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '<live>' AND pid <> pg_backend_pid();" \
  -c 'ALTER DATABASE "<live>" RENAME TO "<old>";' \
  -c 'ALTER DATABASE "<scratch>" RENAME TO "<live>";'
```

The `pg_terminate_backend` is not optional: the rename fails while anything is
connected, including a pooler, a metrics exporter, or an API replica you
thought was stopped.

Each rename is a catalog update — it either happens or it does not. If the
second one fails, you are in the state described in section 5.2.

### 4.6 Migrate, if the schemas differed

Only when the pre-flight reported a schema mismatch (or you know the archive
predates the running code):

```bash
cd apps/api && npm run prisma:migrate
```

### 4.7 Start, and verify

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml start api
curl -fsS http://localhost:3535/api/health/ready
```

Then log in and look at real data. **Do not delete the displaced database until
you have.**

### 4.8 Clean up, later

```sql
-- Only after you are satisfied. This is the fast way back until it is gone.
DROP DATABASE "<old>";
```

## 5. When it goes wrong

### 5.1 `pg_restore` failed part way

Nothing has happened to the live database — the scratch database is a separate
database and the swap has not run. Drop the scratch and start again:

```sql
DROP DATABASE IF EXISTS "<scratch>";
```

Common causes, in order of likelihood: an extension the server does not have
(the pre-flight's extensions gate), a client older than the server, and a
truncated download (`pg_restore --list` in step 4.2 catches it).

### 5.2 The swap half-completed

The live database was renamed to `<old>` and the second rename failed. **There
is now no database called `<live>`,** and the application will not start.

```bash
# Look at what exists:
psql --host=<db host> --username=<admin role> --dbname=postgres -c '\l'
```

Then either finish the swap (`ALTER DATABASE "<scratch>" RENAME TO "<live>";`)
or undo it (`ALTER DATABASE "<old>" RENAME TO "<live>";`). Undoing is always
safe: `<old>` is the original database, untouched.

**If the automated restore was the one that got here**, it already tried to undo
it for you, and the log line says which of the two states you are in:

- *"The original database was renamed back into place"* — nothing is wrong with
  the deployment any more. The application is on the database it started on and
  the process is still running; the restore's row says `failed` with the reason.
  **The scratch database is deliberately left in place**: it is a complete,
  verified restore that cost hours, and the failure was a rename you can retry
  by hand in seconds. Find out what held the rename off (section 5.4), then
  either finish the swap by hand or start the restore again.
- *"CRITICAL: ... THERE IS NOW NO DATABASE NAMED `<live>`"* — the recovery
  rename failed too. **Nothing has been deleted** — the log line names both
  databases — and the process is deliberately still running, in a maintenance
  window it will not close, so callers get a 503 instead of connection errors.
  Fix it with the two statements above; the application recovers as soon as
  there is a database under the live name again (restart it to be sure).

### 5.3 The restore was wrong (bad archive, wrong point in time)

While `<old>` still exists — **seconds**:

```sql
ALTER DATABASE "<live>" RENAME TO "<scratch>";
ALTER DATABASE "<old>"  RENAME TO "<live>";
```

Once `<old>` has been dropped, the way back is the `pre_restore` archive, and
you are running section 4 again from the top — **hours**. This is exactly the
difference the disk downgrade in section 3 warns you about.

### 5.4 "database is being accessed by other users"

Something is still connected. Re-run the `pg_terminate_backend` statement, and
check for the things that reconnect on their own: a second API replica, a
worker, a pooler (PgBouncer will reopen server connections immediately), a
metrics exporter, an open `psql`.

### 5.5 The restore succeeded but the backup list is empty (or stale)

Look for **"CRITICAL: the restore succeeded but its backup catalog could not be
carried into ..."** in the log. The restore itself is fine — the data is the
archive's, the application is serving — but `database_backup_runs` is now the
copy that was inside the archive, so any backup taken after that archive, and
the record of this restore, are missing.

- **The archives themselves are untouched** in object storage. Nothing was lost
  that a backup is for.
- **The displaced database has to be dropped by hand**, because the row that
  named it is gone and the retention sweep only ever drops databases it has a
  row for (section 9.3). Find it and drop it once you are satisfied:

```bash
psql --host=<db host> --username=<admin role> --dbname=postgres \
  -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE '%_old_%';"
```

- **Take a backup now.** It re-establishes a current row and a current archive.

### 5.6 The restore finished and the application never came back

The swap ends in `process.exit(0)` on purpose — see section 7.1. If nothing
restarted the process, that is the missing restart policy, not a failed restore:
the database under `<live>` is the restored one and it is correct. Start the
service, then fix the restart policy before restoring again.

## 6. Restoring across a schema boundary

The pre-flight **blocks** when the archive's migration and the live one differ,
in **either** direction, and only a human can clear it.

- **Archive older than live.** The restored database lacks columns the running
  code selects. Run the migrations after the swap (step 4.6) — that is the
  supported path.
- **Archive newer than live.** This looks harmless and is the more dangerous
  one: the running code has never seen that schema, and the migration runner
  will consider it up to date and apply nothing, so nothing tells you. Deploy
  the matching application version *first* wherever possible.

To proceed deliberately, re-send the pre-flight (and, from #285, the restore)
with the override. It clears **that gate and nothing else** — it does not, and
cannot, grant a role `CREATEDB` or make an old client read a new server.

## 7. Two prerequisites for the automated restore (#285)

Both are about the deployment, both have to be true *in advance*, and both turn
a successful restore into an outage when they are not.

### 7.1 A restart policy

The automated swap ends in **`process.exit(0)`**. That is deliberate: a process
whose database was renamed out from under it holds a connection pool pointing
at a database that no longer exists under that name, and cannot be trusted to
keep serving. Exiting hands the problem to the supervisor.

**Without a supervisor that restarts it, a *successful* restore leaves the
application down.** `infra/compose/prod.compose.yml` already sets this on the
API service, with a comment saying why; a deployment that composes its own
services needs the equivalent:

```yaml
services:
  api:
    restart: unless-stopped
```

or, on Kubernetes, a Deployment (whose default `restartPolicy: Always` does the
same thing) rather than a bare Pod or a Job.

Verify before you restore:

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' <api container>
# want: unless-stopped  (or always)
```

### 7.2 A single API replica

**The maintenance flag is per-process.** The instance performing the restore
puts *itself* into maintenance; every other replica keeps serving traffic,
gets its database connections terminated mid-request by the swap, and then
finds itself talking to a database that has been renamed.

Scale to one before restoring:

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d --scale api=1
# Kubernetes:
kubectl scale deployment/<api deployment> --replicas=1
```

The pre-flight's `replicas` gate *warns* when it sees more than one client
address, but it cannot enforce this: it counts a bastion host and a `psql`
window too, and it cannot see two replicas behind one NAT at all. It is a hint.
You are the check.

## 8. The automated restore

What the application does for you when the pre-flight came back `ok`. **The
application serves normally throughout steps 1-5**, however long they take; the
only window in which it is unavailable is the swap, and that is seconds.

| # | Phase | `restore_status` | Roughly how long |
| --- | --- | --- | --- |
| 1 | Download the archive; re-verify its checksum and table of contents | `restoring` | minutes |
| 2 | Take a `pre_restore` safety backup (**only** in `pre_restore_dump` mode) | `restoring` | as long as a backup |
| 3 | `CREATE DATABASE <live>_restore_<ts>` | `restoring` | instant |
| 4 | `pg_restore -j 4` into it | `restoring` | **hours** — every index is rebuilt |
| 5 | Verify the restored database has tables and a migration ledger | `verifying` | seconds |
| 6 | Maintenance window, two renames, catalog carry-over, `exit(0)` | `swapping` | **seconds** |
| — | Done | `completed` / `failed` | |

### 8.1 Before you press it

- **Satisfy section 7.** A restart policy and a single replica. The swap exits
  the process on purpose, and nothing else will bring it back.
- **Know which mode you are in** (section 3). `retain_database` keeps the
  displaced database and buys a rollback measured in *seconds*;
  `pre_restore_dump` takes a full safety dump instead and buys one measured in
  *hours*. The pre-flight reports the **effective** mode, which disk pressure
  may have downgraded.
- **Expect it to take hours** and to look like nothing is happening. It is
  rebuilding every index in the database. Watch `restore_status`, not the clock.

### 8.2 While it runs

Poll the run (`GET /api/admin/db-backup/runs/<run id>` once #286 lands) or read
the row:

```bash
psql --host=<db host> --username=<db user> --dbname=<live> -c \
  "SELECT restore_status, restore_error, restore_scratch_db, restore_old_db, swapped_at
   FROM database_backup_runs WHERE id = '<run id>';"
```

**Anything up to and including `verifying` is harmless if it fails.** A failure
in those phases leaves the live database completely untouched, drops the scratch
database, records `failed` with the reason, and the application never stops
serving. The archive in storage is not modified by any of this.

There is deliberately **no cancel button** for a restore in those phases — the
only thing it would stop is work on a scratch database nothing depends on, and a
"cancel" that an operator could press during the swap would be a way to
interrupt the two renames. If you must stop one, stopping the process is safe up
until `swapping`: the scratch database is left behind for you to drop, and the
row is settled by nothing (it stays `restoring`, which is honest — the process
executing it went away).

### 8.3 After it finishes

The process **exits and is restarted by the supervisor**. Then:

1. `curl -fsS http://localhost:3535/api/health/ready`
2. Log in and look at real data.
3. **If the pre-flight reported a schema mismatch, run the migrations now.** The
   restored database is at the *archive's* migration; the application is not
   going to do this for you, deliberately.

   ```bash
   cd apps/api && npm run prisma:migrate
   ```
4. **Do not delete anything until you have looked.** Under `retain_database` the
   displaced database is your way back until
   `databaseBackup.oldDatabaseRetentionHours` passes.

The audit trail is split across two databases and that is expected: the
`db_restore:start` and `db_restore:swap` rows were written while the *old*
database was still live, so they are in `<live>_old_<ts>`. The
`db_restore:complete` row is in the database you are now running on, and its
`meta` carries the whole timeline.

## 9. Rolling a restore back

### 9.1 `retain_database` — seconds

The displaced database is still there, so the rollback is two renames: the
restored database is parked under a fresh `<live>_restore_<ts>` and the original
is promoted back. The process exits afterwards, exactly as the restore does, and
the supervisor restarts it.

By hand, the same thing:

```sql
ALTER DATABASE "<live>" RENAME TO "<a fresh scratch name>";
ALTER DATABASE "<old>"  RENAME TO "<live>";
```

The parked database is **never dropped automatically** — it is the restore you
just undid, and you may want to look at it. Drop it yourself when you are done.

### 9.2 `pre_restore_dump` — hours

There is no database to rename. The rollback restores the `pre_restore` archive,
which means running the whole of section 8 again against a different backup —
**and it is a full restore, with a full restore's cost**. The schema check is
overridden for it automatically, and that is correct rather than a shortcut:
that dump came from the schema the code was running moments before the restore,
so the gate would block on a mismatch that exists *only because* the thing you
are undoing happened.

### 9.3 When neither exists

Past `oldDatabaseRetentionHours` the displaced database has been dropped, and if
there was no `pre_restore` backup there is nothing left to roll back to. That is
reported as **unavailable rather than as a failure**, because nothing went wrong
just now — the rollback window closed. Restoring any other archive from here is
a new restore, not a rollback.

The sweep that drops those databases runs inside the backup scheduler's
ten-minute tick and only ever drops a database **this application recorded
displacing**. A `<live>_old_<ts>` you created by hand following section 4 is
never touched — which also means it is never cleaned up. Drop it yourself.

## 10. Related

- `docs/specs/database-restore.md` — why the admin connection is outside the
  Prisma pool, why `guided` is a normal outcome, and what was rejected.
- `docs/specs/database-backup.md` — where archives come from, and the retention
  rules that decide how long they last.
- `docs/runbooks/postgres-client-version.md` — fixing a client/server major
  mismatch.
- `docs/runbooks/maintenance-mode.md` — opening and closing a window by hand,
  and recovering from one that locked you out.
