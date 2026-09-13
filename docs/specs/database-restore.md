# Database Restore

> Epic #254, Phase 7 (**#284** the cluster admin connection and the pre-flight
> gates; **#285** the scratch-database restore, the atomic swap and rollback;
> **#286** the HTTP endpoints; **#287** the administrator's dialog and the page
> it lives on — all four merged). Phases 6 and 7 of epic #254 are complete.
> Implemented in
> `apps/api/src/db-backup/admin-connection.util.ts`,
> `apps/api/src/db-backup/restore-preflight.service.ts`,
> `apps/api/src/db-backup/database-restore.service.ts`,
> `apps/api/src/db-backup/migration-state.util.ts`,
> `apps/api/src/db-backup/tasks/db-backup-schedule.task.ts`,
> `apps/api/src/db-backup/db-backup.controller.ts`,
> `apps/api/src/db-backup/db-backup-admin.service.ts`,
> `apps/api/src/db-backup/dto/db-backup-restore.dto.ts` and
> `apps/api/src/db-backup/db-backup.module.ts`, over the `restore*` columns
> `apps/api/prisma/schema.prisma` already declares on `DatabaseBackupRun` (see
> `docs/specs/database-backup.md` §1.1 — **neither issue adds a migration**);
> and, on the operator-facing side, in
> `apps/web/src/pages/Admin/DbBackupPage.tsx`,
> `apps/web/src/components/admin/DbBackupRestoreDialog.tsx`,
> `apps/web/src/components/admin/DbBackupConfigPanel.tsx`,
> `apps/web/src/pages/Admin/dbBackupTable.tsx`,
> `apps/web/src/hooks/useDbBackup.ts` and
> `apps/web/src/services/dbBackup.ts`.
>
> **Be honest about what exists.** §1–§7 are the pre-flight: the *knowing*. §8
> is the restore itself: the *doing*. §9 is the way in: two HTTP routes, their
> typed confirmation, and the six response `mode`s they publish. §10 is the
> operator interface: the dialog that drives those two routes, and the page it
> lives on. All four are merged and tested — an operator can reach a restore
> from `curl`, the CLI, or a screen, and the last of those carries the same
> safety machinery as the first two rather than a thinner copy of it.
>
> The backup half — the model, the streaming `pg_dump` engine, retention, the
> schedule and the admin API — is `docs/specs/database-backup.md`. The
> operator-facing procedure is `docs/runbooks/database-restore.md`. Neither is
> restated here.

## Why a restore needs a pre-flight at all

A restore either works or it destroys the production database, and it is
irreversible from the moment the swap begins. What makes that tolerable is
that **almost everything which can go wrong is knowable before anything is
created**: whether the role may create a database, whether the binaries can
read the archive, whether the schema matches the running code, whether there
is room on disk. None of those questions needs a single byte to be written to
find out.

So the pre-flight is a separate, side-effect-free operation, and the rule is
absolute:

> **No pre-flight path may create, drop or rename anything.**

It is an acceptance criterion with its own test — the four mutating helpers are
spied on, and every statement the fake cluster receives is matched against
`/CREATE DATABASE|DROP DATABASE|ALTER DATABASE|pg_terminate_backend/` — because
an operator asks "can I restore this?" precisely when they have *not* decided
to. A question that leaves a half-created database behind is a question nobody
can afford to ask.

## 1. The cluster admin connection

`admin-connection.util.ts` opens a short-lived `pg.Client` to the **maintenance
database** (`postgres`), for one unit of work, closed in a `finally`.

### 1.1 Why it is outside the Prisma pool

Two structural reasons. Neither is a preference:

1. **Those pooled connections are exactly what must be gone before a rename can
   succeed.** `ALTER DATABASE ... RENAME TO` fails while *any* session is
   connected to the database being renamed, and Prisma holds a pool of exactly
   those sessions open for the process's lifetime. A restore that borrowed a
   Prisma connection would be holding open the one thing it first has to get
   rid of.
2. **A database cannot be renamed from a session connected to it.** Prisma is
   bound to one database, by URL, at startup — the application's, which is the
   one a restore renames away. There is no Prisma API that points it elsewhere,
   so the DDL has to be issued from a session attached to a *different*
   database.

`pg-version.util.ts` already carries the `pg` dependency and says the same
thing where it introduces it; this file is the second, larger use of the same
seam.

### 1.2 The maintenance database, and the case people forget

`postgres` by default — it exists on every cluster `initdb` has created, and it
is what `createdb`, `dropdb` and `psql -l` attach to for this exact reason.

**When the application's own database is called `postgres`, the connection
falls back to `template1`.** A deployment with `POSTGRES_DB=postgres` is
ordinary (several hosted images default to it), and attaching to it would put
the admin session *inside* the database the swap has to rename — the one
arrangement that cannot work.

The maintenance database is a **parameter, not a new environment variable**,
following the precedent `PG_DUMP_COMMAND` set: the deployments needing
something other than `postgres` are rare enough that a caller-supplied value is
the right seam, and an unused variable in `.env.example` is a knob nobody
maintains.

### 1.3 The connection is always closed

`withAdminConnection(config, fn)` ends the session in a `finally` on **every**
exit path: return, throw, and — via an optional wall-clock bound — a callback
that never settles. A leaked session to the cluster is what makes the later
rename fail, and it fails at the worst possible moment: after the archive has
been replayed and the application has been stopped.

A failing `end()` never masks the failure that caused it. A close error on top
of a refused password would send an operator to entirely the wrong runbook.

### 1.4 `statement_timeout` is deliberately 0

Not "left at the default" — **set** to zero, explicitly, on every admin session,
so no server-side default (a managed provider's, a `postgresql.conf`, an
`ALTER ROLE ... SET`) can apply to this one.

A timeout firing part-way through `CREATE DATABASE` or `ALTER DATABASE ...
RENAME` does not undo the statement. It cancels the *client's wait* for it, and
what the caller then holds is **ambiguity** — a rename that may or may not have
happened, on the database the application is about to be pointed at. There is
no safe automated response to that. An unbounded wait is the better failure: it
is visible, a human can interrupt it, and the cluster's state stays knowable.

The bound that *does* exist is a wall-clock one on the whole callback,
defaulting to **off**. Pre-flight passes 15 seconds because every query it
issues is a trivial catalog read and it runs inside an HTTP request; #285's
swap passes none.

### 1.5 Identifiers: rejected, never escaped

**DDL cannot use bind parameters.** `CREATE DATABASE $1` is a syntax error — the
parameter machinery works on values, and a database name is a name — so every
identifier reaching a statement is interpolated, and `quoteIdentifier` is the
only thing between a stored string and arbitrary SQL.

It **rejects** anything outside `^[A-Za-z_][A-Za-z0-9_$]*$` (and anything over
63 bytes) rather than escaping it. The standard escape — doubling an embedded
`"` — is correct as far as it goes, but it *accepts every name*, and the
statement's safety then depends on that implementation being right about every
case forever: embedded NULs, invalid UTF-8, a 64-byte name the server silently
truncates into something else. An allowlist has the opposite failure mode. The
worst it can do is refuse a legal name, loudly, in a code path somebody is
watching. Every name this subsystem uses is the configured database name or one
derived from it, so the allowlist costs nothing real.

### 1.6 Name builders trim the base, never the tail

`<live>_restore_<timestamp>` and `<live>_old_<timestamp>`, both UTC, both using
the same `compactTimestamp` the storage keys use.

**PostgreSQL does not reject an over-long identifier — it truncates it**, to 63
bytes, with a notice nobody reads. So for a database whose name is already near
the limit, `<63-char name>_restore_20260907T120000Z` and the same name with
tomorrow's timestamp truncate to the **same physical name**: two restores
silently sharing one scratch database, the second finding the first's
half-restored contents. Trimming the *base* keeps the disambiguating part,
which is the only part that disambiguates. There is a test with a maximally
long database name asserting the suffix survives, the result is ≤ 63 bytes, and
two timestamps still produce two names.

### 1.7 What is exported, and who may call it

| Operation | Reads or mutates | Called by pre-flight? |
|---|---|---|
| `probeCreateDatabasePrivilege` | read | yes |
| `probePgExtensionAvailable` | read | yes |
| `readDatabaseSizeBytes` | read | yes |
| `readDataDirectory` | read | yes |
| `countDistinctClientAddresses` | read | yes |
| `databaseExists` | read | no — #285, before `CREATE DATABASE` |
| `createDatabase` | **mutates** | **never** |
| `dropDatabase` | **mutates** | **never** |
| `terminateConnections` | **mutates** | **never** |
| `renameDatabase` | **mutates** | **never** |

The mutating four live here, beside the reads, because they share the
connection contract and the identifier rules — not because pre-flight has any
use for them.

## 2. The gates

Seven, evaluated in one round and **all seven reported**, including the ones
that passed. #287's dialog renders the whole list (§10.2): an operator about to
replace their production database is entitled to see what was checked, and a
gate that returns nothing when it is happy leaves no way to tell "checked,
fine" from "never ran".

| Gate | Kind | On failure |
|---|---|---|
| `pg_client_version` — client major vs server major | capability | **blocks**, non-overridably |
| `admin_connection` — maintenance database reachable | capability | → `guided` |
| `createdb_privilege` — **probed, never assumed** | capability | → `guided` |
| `extensions` — every installed extension is available | capability | → `guided` |
| `disk_space` — free ≥ ~1× database (+1× when retaining) | disk | **downgrades**, never refuses |
| `replicas` — distinct client addresses | replicas | **warning only** |
| `schema_compatibility` — archive vs live migration | overridable | **blocks** unless overridden |

Each verdict is `pass`, `warning` or `block` and carries its own `action` item,
because a `guided` outcome routinely has two or three findings with different
remedies and flattening them into one string is how an operator fixes the first
and is surprised by the second.

### 2.1 `CREATEDB` is probed, never assumed

`SELECT (rolsuper OR rolcreatedb) FROM pg_roles WHERE rolname = current_user`.
Superuser implies the privilege without the attribute being set, and
`current_user` rather than the configured user name because `SET ROLE`, a
connection pooler or a `DATABASE_URL` override can all make the session's role
something other than what the environment says.

Managed PostgreSQL withholds `CREATEDB` from application roles as a matter of
course. Assuming it means discovering the truth at the moment a restore starts
— after the operator has committed to it, during an incident.

### 2.2 The version gate is the one capability gate that blocks

Every other capability failure has a manual answer: a superuser can create the
database the API's role may not. But the guided block's `pg_restore` is still a
`pg_restore`, and a client older than the server refuses to read the archive
whoever runs it. The fix is an image rebuild
(`docs/runbooks/postgres-client-version.md`), not a command to paste, so it
blocks — and it is **not overridable**, because overriding it produces a
restore that fails on the first byte having already stopped the application.

`unknown` proceeds, exactly as it does for a backup. An unparseable version
banner is not evidence that a restore would fail, and it must never be the
reason a recovery did not happen.

### 2.3 The extensions gate reads two catalogs

`pg_extension` in the **live database** (through Prisma — it is a per-database
catalog, and the admin session is attached to the maintenance database) says
what the archive will try to `CREATE EXTENSION`. `pg_available_extensions` on
the **cluster** says what the server's filesystem can offer.

In the ordinary case an archive is dumped and restored inside one cluster and
this passes. It earns its place the day the target is a *new* server,
provisioned from a different image, where `pgcrypto` or `postgis` is simply not
installed — `pg_restore --exit-on-error` would stop on that line, having
already created a scratch database.

### 2.4 A short disk downgrades; it never refuses

`restoreRollbackMode: retain_database` keeps the displaced database on disk. It
costs a second full copy and buys a rollback measured in **seconds** (one
`ALTER DATABASE ... RENAME`). When there is not room, pre-flight downgrades the
**effective** mode to `pre_restore_dump` — the safety backup #285 takes
immediately before swapping — and **reports the downgrade**.

An administrator mid-incident must never be left with no path forward. What the
downgrade costs is reported in those terms: *the recovery guarantee changes
from seconds to hours*, because rolling back now means restoring an archive
rather than renaming a database. That is a decision they can act on. "Not
enough disk, refused" is not.

Two related rules:

- **An invisible data directory is a warning, never a false block.** `SHOW
  data_directory` needs superuser or `pg_read_all_settings`, which a managed
  platform will not grant; and even when the path is readable it usually
  belongs to a *host this container has never seen*, because
  `infra/compose/base.compose.yml` declares no `db` service. Refusing a
  recovery on the strength of a `statfs` against somebody else's filesystem
  would be indefensible.
- **When the numbers are unreadable, the configured mode stands.** Downgrading
  on a guess would silently remove a rollback guarantee the operator asked for.

The requirement is deliberately approximate — one copy for the scratch replay,
plus one for the displaced database when retained. A restored database is
usually a little *smaller* than the original (no bloat, fresh indexes), and
WAL, sort files and index builds all want space this does not model. The number
exists to catch "there is nowhere near enough", and it never blocks.

### 2.5 The replica count is a heuristic, so it only warns

`COUNT(DISTINCT client_addr)` on the live database approximates "more than one
API instance is connected", and #285's swap assumes exactly one — the
maintenance flag is per-process, so a second replica keeps serving traffic,
gets terminated mid-request by the swap, and then talks to a database that has
been renamed out from under it. Worth telling an operator.

Not worth blocking on. The count also rises for a bastion host, a `psql`
window, a metrics exporter or a migration runner, and it *undercounts* every
replica behind one NAT. Refusing a legitimate recovery because somebody left a
query window open would be the wrong failure.

### 2.6 The schema gate blocks in **both** directions

The archive's recorded `migration_name` (written best-effort by #281 on every
run row) against the live latest applied migration. One query, in
`migration-state.util.ts`, used by **both** the backup engine and this gate —
two copies with different `rolled_back_at` handling would make the comparison
meaningless in either direction.

- `archive_older` is the obvious mismatch: the restored database lacks columns
  the running code selects, and the first request after the swap fails.
- `archive_newer` is the **dangerous** one, because it looks harmless. The
  archive has columns the code does not know about — fine, until the deployment
  that produced it also removed or renamed something, or changed a constraint
  the old code violates. And the migration runner will consider the schema up
  to date and apply nothing, so nobody is ever told.

Both block. A restore across a schema boundary is a decision, and it has to be
made by a person, once, deliberately — by re-sending with the override, which
accepts the restore-then-`migrate deploy` path.

An archive with **no** recorded migration is a `warning`, not a block: #281
records it best-effort, and refusing to restore an archive whose audit read
failed would make a best-effort field load-bearing after the fact.

## 3. Three outcomes, and all three are normal

**`ok`** — proceed. Warnings may still be attached; the dialog renders them.

**`guided`** — a capability gate failed, so the response carries a
ready-to-paste, fully parameterised **command block** and a runbook link
*instead of an error*.

> This is a **designed-in path, not a fallback**. Managed PostgreSQL routinely
> denies `CREATEDB`, and an operator on such a platform must still be able to
> restore — with a superuser, by hand, from the same archive. A 4xx here would
> tell them their platform is unsupported when it is not, in the middle of an
> incident.

**`blocked`** — something would make the restore fail or silently corrupt the
deployment. Only the schema gate is overridable; the block carries
`overridable` and the name of the parameter that unblocks it, so the API and
this service cannot disagree about what unblocks what.

### 3.1 Precedence

Non-overridable block → `guided` → overridable block.

`guided` outranking the schema block is deliberate. A `blocked` result tells
the operator to re-send with the override; if the automated path could not run
anyway (no `CREATEDB`), that instruction sends them round a loop. The guided
instructions carry the schema mismatch as an extra step instead, and the schema
gate's own verdict is still in `gates` for the dialog to render.

The version block outranks everything, because nothing else matters if the
binaries cannot read the archive.

### 3.2 The override unblocks exactly one gate

`overrideSchemaMismatch` clears the schema gate and **nothing else**. No amount
of accepting makes a role without `CREATEDB` able to create a database, and an
override that silenced everything would turn the one deliberate escape hatch in
this subsystem into a way to skip all of it. There is an explicit negative test
for each direction.

## 4. The guided command block is the deliverable

On the `guided` path the command block **is** the answer, so it must be
complete, correctly parameterised and paste-ready: real host, real port, real
user, real database names, real run id, real archive filename. A block with
`<your-host>` in it is not instructions — it is homework, handed to somebody
whose application is down, and every substitution they make by hand is a chance
to point a `RENAME` at the wrong database. **It is asserted by string in the
tests** for exactly that reason.

Two values are deliberately *not* interpolated, and neither is a placeholder in
the "fill this in" sense:

- **The password.** Printing it would put a live database credential into an
  HTTP response, a browser's memory, a screenshot and quite possibly a support
  ticket. The block exports it from the environment the operator already has.
- **The signed download URL.** It does not exist yet: it is minted, with a
  five-minute expiry, by the command on the line above it.

The block ends with the way back — the two renames that undo the swap while the
displaced database still exists — and a pointer to the runbook. When the schema
also mismatches it gains a migration step; when it does not, it does not.

Nothing in it hard-codes an application, product or repository name: every
name is derived from the deployment's own configuration.

## 5. What pre-flight deliberately does **not** check

**The archive's bytes.** Proving an archive readable means streaming the whole
object out of storage through `pg_restore --list` — the object is the size of
the database, so that is gigabytes and minutes to hours. An HTTP request cannot
wait on it, and a pre-flight that sometimes takes an hour is a pre-flight
nobody runs. It is the **first phase of #285's asynchronous restore run**, where
there is a row to record progress on and a heartbeat to prove it is alive.
There is a comment in the service saying so, so nobody adds it here.

**Whether the derived names are free.** The timestamp in a scratch name is
generated when the name is built, so a pre-flight check would prove nothing
about the name #285 builds later. `databaseExists` is exported for #285 to use
at the point it matters.

**The run's status, the caller's permission, and the 404.** #286's endpoint
owns those, exactly as `getDownloadUrl`'s `completed`-only refusal lives in the
admin service. This service answers a question about a row it is given.

## 6. Wiring

`DatabaseRestorePreflightService` is a **provider in `DbBackupModule`, not
exported, and bound to no controller**: #286 owns the restore endpoints, and a
service reachable over HTTP before the route that authorizes it exists is a
surface nobody has reviewed.

It needs no new module import. `SettingsModule` already supplies
`SystemSettingsService` (it reads `restoreRollbackMode`), `PrismaModule` is
`@Global()`, and the cluster work goes through a `pg.Client` outside the pool.
It notably does **not** take `StorageProvidersModule`: pre-flight never touches
the archive's bytes.

`RESTORE_PREFLIGHT_SEAM` and `RESTORE_ADMIN_CLIENT_FACTORY` are optional tokens
left **unbound**, the same discipline `DB_BACKUP_ENGINE`, `DB_BACKUP_TIMERS`,
`JOB_CLOCK` and `JOB_RANDOM` follow. The application always probes a real
cluster; only a test constructing the service directly can substitute one. A
stubbed cluster connection in production would report a clean pre-flight
against nothing at all, which is the single most dangerous lie this subsystem
could tell.

**No migration.** The `restore*` columns were declared by #281.

## 7. Rejected alternatives (the pre-flight)

**Assuming `CREATEDB`.** The natural shortcut: the application connects as an
owner, so of course it can create a database. It cannot, on any managed
PostgreSQL, and the discovery happens at the moment a restore starts — after
the operator committed to it, during an incident. Probing costs one catalog
read and turns a mid-restore failure into a pre-flight verdict with
instructions attached.

**Reusing the Prisma pool for the admin work.** There is already a database
connection; opening another looks like duplication. Those pooled connections
are precisely what must be gone before the rename can succeed, and Prisma
cannot be pointed at another database anyway — the swap would be issued from a
session attached to the database being renamed, which Postgres refuses. See
§1.1.

**A non-zero `statement_timeout` on the admin session.** The defensive-looking
choice, and it buys ambiguity rather than safety: a cancelled `CREATE DATABASE`
or `ALTER DATABASE ... RENAME` still may have happened, on the database the
application is about to be pointed at, and there is no safe automated response
to "maybe". See §1.4.

**Refusing on a short disk.** The conservative-looking choice, and it is the
one that leaves an administrator mid-incident with no path forward. The
downgrade to `pre_restore_dump` is a smaller loss, honestly reported: the
recovery guarantee changes from seconds to hours. See §2.4.

**Blocking on the replica heuristic.** `COUNT(DISTINCT client_addr)` cannot
tell an API replica from a `psql` window, and collapses every replica behind
one NAT into a single address. Blocking on it would refuse legitimate restores
for reasons the operator cannot even see, while still missing the case it
exists for. See §2.5.

**Truncating identifiers from the tail** (or letting the server do it). Silent,
and it makes two restores of a near-63-character database share one physical
scratch database. Trimming the base keeps the only part that disambiguates. See
§1.6.

**Escaping identifiers instead of rejecting them.** Accepts every name and then
depends on being right about every case forever. An allowlist's worst failure
is refusing a legal name, loudly. See §1.5.

**Verifying the archive during pre-flight.** It is the check people most expect
to be here, and it requires downloading multiple gigabytes inside an HTTP
request. It belongs to #285's first phase. See §5.

**A `guided` result as a 4xx.** It reads like a failure — the automated restore
cannot run — and answering it as an error would tell an operator on managed
PostgreSQL that their platform is unsupported. It is a normal outcome carrying
a different set of instructions. See §3.

## 8. The restore itself (#285)

`DatabaseRestoreService`. One property shapes every decision in it:

> **The application serves normally throughout the entire restore, and the only
> destructive window is two catalog updates long.**

```
1. Download the archive to a seekable temp file; re-verify checksum and TOC.
2. (pre_restore_dump mode) take a fresh safety backup.
3. CREATE DATABASE <live>_restore_<ts>
4. pg_restore -j N into it   ← the app is FULLY UP for this entire phase
5. Verify the restored database.
6. Swap, in seconds.
```

Steps 1–5 take as long as they take — on any database worth backing up, hours —
and the application is up for all of them. **A failure at any point before the
rename leaves the live database completely untouched and drops the scratch
database.**

### 8.0 It is a queue job (`db.restore.run`, #353, epic #345)

`startRestore` runs the gates and **enqueues**; a worker calls
`executeRestoreJob`. Until #353 it ended in `void this.executeRestore(...)` — a
promise nothing owned, running for hours, absent from `GET /api/admin/jobs`,
holding no worker slot and bounded by no timeout. As a job it has a row with a
duration and a `lastError`, a ceiling of six hours, and — the number that
matters — **`maxAttempts: 1`**. `attempts` is charged at claim time, so a
restore whose executor dies has already spent its only attempt and the reaper
permanently *fails* the row rather than requeueing it. A requeued restore would
replay a restore that may already have succeeded, which is the worst outcome
available in this subsystem.

**It is server-only by derivation and permanently so.** It carries neither
`nodeResultSchema` nor `persistNodeResult`, so `serverOnlyTypes()` contains it
and nothing has to enforce anything. The reason is in the handler's header: it
renames the live database, terminates pooled connections, needs `CREATEDB`, runs
an admin connection on the `postgres` maintenance database, and ends by exiting
the process. None of that is work a remote machine may do.

**Concurrency is three guards, and the dedup index replaces neither of the
others.** A restore job's dedup key folds in its *subject*, so the index refuses
a second restore of the *same* archive and permits one of a *different* archive
— which is the catastrophe. So: the process-local `activeRestoreRunId` flag
closes the double-click race around the pre-flight (it is the only guard that is
not a read followed by a write); a type-wide query for a `pending`/`running`
`db.restore.run` closes the case the flag cannot see, including a restore queued
by a previous process or a second replica, and is the only guard that refuses a
different archive; the index closes the same-archive race between replicas
atomically. The single-replica prerequisite still stands.

⚠ **A `pending` restore job nothing ever claims blocks later restores**, by
design — the durable guard is type-wide. That is the honest cost of refusing
concurrent restores across processes; an operator clears it by deleting the job
from `GET /api/admin/jobs`.

### 8.1 Why `pg_restore --clean` against the live database is rejected outright

It is the obvious implementation, and the reason it is refused is written into
the service as a comment so that it is not proposed again.

`--clean` emits a `DROP` for every object in the archive before recreating it.
Those objects include `database_backup_runs` — **the table tracking the
restore's own progress** — and `system_settings`, and `users`. When it fails
midway (an extension the server does not have, a client older than the server, a
network blip at 40 GB) what is left is a live database with half its tables
dropped: an application that cannot boot, no admin UI to look at, no catalog to
say what happened, and no way back except another restore of the archive that
just failed.

The destructive window is not the swap. It is **the whole restore**.

And a restore *is* slow, for a reason no amount of tuning removes: a `pg_dump`
archive stores `CREATE INDEX`, not index data, so **every index in the database
is rebuilt from scratch on the way in**. That single fact is what makes "replay
somewhere else, then rename" not merely safer but the only sane shape — a window
measured in hours must not be a window in which the application is broken.

### 8.2 The archive is downloaded to a file, and re-verified

**Downloaded, not streamed.** `pg_restore -j N` *seeks*: parallel restore hands
different table-data members to different workers, which means jumping around
the archive, which a pipe cannot do — `pg_restore` rejects `-j` with a stdin
source outright. Streaming the object straight into `pg_restore` would forfeit
**all** parallelism on the phase that dominates the runtime, to save a temp file
on a host that is about to hold a second copy of the whole database anyway.

The file carries `JOB_TEMP_PREFIX` — the application's janitor-swept prefix from
`apps/api/src/jobs/job-temp.ts` — so a SIGKILL between the download and the
delete cannot leak it forever. That import reaches into the job queue on
purpose, and it is the one case where copying the prefix would be wrong:
`db-backup-storage.ts` deliberately duplicated `job-temp.ts`'s slugifier because
it only needed the same *shape*; this needs the same *value*, because a file
whose prefix merely resembles the janitor's is a file the janitor never sweeps.

**The file is deleted before the swap, not after it**, because the process does
not come back from the swap. The `finally` is the safety net for the failure
paths.

**Re-verification is against the bytes as they are now.** #281 already proved
the object was a readable archive whose checksum matched — *at upload time*,
possibly months ago. This proves it still is, which catches bit-rot, a storage
lifecycle rule that moved the object to a tier that returned something else, a
truncated download, and a proxy that ended a transfer early. Trusting the stored
checksum is trusting a measurement of a file nobody has looked at since, and the
moment you would find out it was wrong is after the swap.

Both checks run, because they catch different things: the checksum proves the
bytes are unchanged and cannot tell you they are a valid archive; the table of
contents proves `pg_restore` can read them and there is something in there to
restore, and cannot tell you they are the *right* bytes. A failure raises
`DatabaseRestoreArchiveError` **before `CREATE DATABASE`**, so a corrupt archive
costs a download and nothing else.

### 8.3 The safety backup, and why it is awaited

Taken only in **`pre_restore_dump`** mode — the *effective* mode the pre-flight
computed, which disk pressure may have downgraded to (§2.4). Under
`retain_database` the way back is the displaced database itself, and a full dump
as well would add hours to duplicate a guarantee the restore already has.

It goes through `DatabaseBackupRunnerService.startBackup`, not through a second
claim path, so the single-active-run index stays a guarantee. That method is
**detached by contract** — it returns the moment the row is claimed, with
`pg_dump` still streaming — so the restore polls the row until it settles.
Swapping while that dump was in flight would rename the database out from under
it and leave a truncated "safety" archive: a way back that does not work,
discovered at the only moment it is ever used.

A safety backup that does not complete **abandons the restore**, before anything
has been created.

### 8.4 Verification of the restored database

`--exit-on-error` proves no statement failed. It cannot prove the archive
contained statements worth running — the same gap
`DatabaseBackupVerificationError` closes on the other side of the round trip.
Two checks, deliberately cheap:

- **At least one ordinary table** outside the system schemas. Zero means the
  replay produced an empty database.
- **A non-empty `_prisma_migrations`.** A database with tables but no migration
  ledger is not one this application can boot against, and it is what a restore
  of somebody else's archive looks like.

It deliberately does **not** re-read "the newest applied migration".
`migration-state.util.ts` is emphatic that exactly one query answers that
question, because the pre-flight's schema gate compares its two callers'
answers; a third reader would be a third chance for the rule to drift. The
archive's migration is already on the run row and was already gated.

### 8.5 The swap

```ts
await writeRestoreState(runId, { restoreStatus: 'swapping' });
const catalog = await exportCatalog(runId, { /* post-swap audit values already applied */ });

await maintenance.setInMemoryOverride({ enabled: true, message, allowAdmins: false });

await withAdminConnection(pg, async (client) => {
  await prisma.$disconnect().catch(() => {});
  await terminateConnections(client, pg.database);

  await renameDatabase(client, pg.database, oldDb);
  try {
    await renameDatabase(client, scratchDb, pg.database);
  } catch (err) {
    // The only genuinely dangerous moment in the design.
    await renameDatabase(client, oldDb, pg.database).catch(logCritical);
    throw err;
  }

  await reinsertCatalog(pg, catalog);   // ← the settled `jobs` row goes first
});

await announceRestoreCompleted(...);   // awaited; §8.5.1
exitProcess(0);                        // rebuild the connection pool
```

#### 8.5.1 ⚠ The job settles itself, as part of the carry

`process()` **never returns on this path** — the process exits inside it — so
the worker's terminal write never runs. Left alone that produces a `jobs` row
stuck `running` with a live lease, which the restarted API's reaper finds and,
under `maxAttempts: 1`, marks **`failed`**: a successful restore recorded as a
failure. A job row that lies is not an acceptable price for a job row that
exists.

The terminal write therefore **rides with the catalog carry**, and that is the
only place it can correctly go. After the renames, Prisma's live database name
resolves to the *promoted* database, whose `jobs` table is the archive's; a
`succeeded` written before the swap lands in the database about to be renamed
away and dropped — and worse, if the second rename then failed and the original
were put back, the row would claim a restore succeeded that did not. Written as
part of `reinsertCatalog`, it lands **if and only if both renames succeeded**,
into the database that survives, immediately before the exit.

`CARRY_JOB_SQL` writes the shape `JobTerminalService.completeSucceeded` would
have written: `succeeded`, `finished_at` = the swap instant, `scheduled_for`,
`lease_expires_at` and `claimed_by_node_id` cleared, `executor` and `last_error`
preserved. It goes **first** in the carry, ahead of the backup records, because
it is the one carried value a *machine* acts on rather than a human reading it.
It is an upsert rather than an insert because a `pre_restore` archive contains
this very row as `running`, and rolling that dump back replays it.

The residue, stated honestly: `reinsertCatalog` never throws, so a carry that
fails leaves the promoted database with no settled row — and if that archive was
a `pre_restore` dump containing the row as `running`, the reaper will fail it
after the restart. That case already logs `CRITICAL` and is in the runbook; it
is the same failure mode that loses the backup catalog, and the fix is the same
one.

**Between the two renames there is no database under the live name at all.**
That is why traffic must already be stopped before the first rename, and why the
maintenance window is opened with **`allowAdmins: false`**:

- The **persisted** maintenance flag lives *inside* the database being renamed,
  so during those seconds it is unreadable. `MaintenanceModeService` has an
  **in-memory override layer for exactly this caller** and says so in its own
  header (`apps/api/src/common/maintenance/maintenance-mode.service.ts`); the
  restore swap is the only thing in the repository that sets it.
- `allowAdmins: true` would be actively wrong here rather than merely generous.
  An admin request during the window does not get "access to a degraded system";
  it gets a connection attempt against a database that momentarily does not
  exist.

**The window is not closed on the success path.** `process.exit(0)` is the
release: closing it first would open a gap in which the process served requests
through a connection pool it is about to tear down.

`prisma.$disconnect()` before `terminateConnections` is a courtesy that makes
the termination smaller and quieter; the termination is the part that is not
optional, because a rename fails while *any* session is attached — a pooler, a
metrics exporter, an open `psql` window, a replica that should not be running.

### 8.6 The inner recovery — the one genuinely dangerous moment

If the second rename fails, the original is renamed back. That `catch` is the
single most important one in this subsystem and it has its own tests, in both
the unit suite and the real-Postgres suite.

What it cannot do is guarantee success. `DatabaseRestoreSwapError` carries
`originalRestored`, and the two cases are handled differently:

| `originalRestored` | State | What the service does |
|---|---|---|
| `true` | The deployment is on the database it started on; the restore simply did not happen. | Closes the maintenance window (there is a working database to serve from, and a window nothing will ever close is an outage of its own), records the failure, **does not exit** — a recovered swap must not turn a contained failure into an outage. |
| `false` | There is no database under the live name. | **Leaves the window open** — an orderly 503 beats five hundred stack traces against a database that is not there — logs CRITICAL with both names, and leaves the process up so its logs survive. A human finishes or undoes the swap by hand (runbook §5.2). |

**The scratch database is kept when the swap failed**, and dropped for every
failure before it. By that point it is a complete, verified restore that cost
hours to build, and the failure was a rename — something an operator retries by
hand in seconds. Dropping it would turn a recoverable five-second problem into
another multi-hour replay, unattended.

### 8.7 Catalog carry-over

The restored database contains `database_backup_runs` **as of backup time**.
Swap it in naively and this restore's own record, every backup taken since the
archive was made, and the `pre_restore` safety dump taken ten minutes ago all
cease to exist — including the row that says where the way back is stored.

So the rows are exported **before** the rename and re-inserted **after** it. Four
rules, each closing a specific failure:

1. **This run's post-swap audit values are applied during the export**, not
   written to the live row. Writing "restore completed" into the database this
   restore is about to rename away would put the record of the operation in the
   one database nobody will ever open again.
2. **The two user FKs go through a subselect.** `created_by_id` and
   `restored_by_id` reference `users(id)`, and the promoted database's `users`
   table is the *archive's* — an administrator created after the backup does not
   exist in it. A plain value raises a foreign-key violation that aborts the
   **whole** carry-over, losing every backup record to preserve one attribution.
   `(SELECT id FROM users WHERE id = $n)` yields NULL instead, which is exactly
   what the column already means for a scheduled run and what `onDelete:
   SetNull` already declares for an actor who goes away.
3. **`ON CONFLICT (id) DO UPDATE`, never `DO NOTHING`.** Most ids *already
   exist* in the promoted database with stale contents, so `DO NOTHING` would
   silently keep the stale copy — including a `restore_status` from an older
   restore — and the carry-over would appear to work while changing nothing.
4. **The self-FK is a second pass.** `pre_restore_backup_id` points at another
   row in the same table; set during the insert it can reference a row that is
   not there yet. Applied afterwards, every referent is present. It goes through
   a subselect too, for the same reason as rule 2.

The rows go in through a session attached to the **live name** — a second
connection, because the outer one is attached to the maintenance database
precisely so it could do the renaming.

**`reinsertCatalog` never throws**, and that is a safety property rather than
laziness. By the time it runs both renames have succeeded and the swap is
irreversible; a throw would travel to the failure handler, which would try to
drop a scratch database that no longer exists under that name and write a
`failed` status into a database that no longer holds that row — and it would
tempt a future change to "roll the swap back", which at that point would mean
discarding a database the deployment is already serving from. Losing the backup
catalog is bad. Undoing a successful restore to avoid losing it would be worse.
The failure logs CRITICAL and names what has to be done by hand.

### 8.8 Migration roll-forward, and the exit

**`_prisma_migrations` also comes from the archive**, so after the swap the
restored database is at the *archive's* migration. That is precisely what the
`schema_compatibility` gate detects and what `prisma migrate deploy` fixes. **It
is documented and not run automatically:** a migration is a schema change
against data an operator has just decided to trust, and running it unattended
inside a restore would make one irreversible act into two.

**The restore ends in `process.exit(0)`.** The connection pool is bound to a
database that has just been renamed out from under it, and every pooled session
was terminated to allow that rename. There is no API that rebuilds a Prisma pool
in place, and a process holding stale sessions to a database that no longer
exists under that name cannot be trusted to serve. Exiting hands the problem to
the supervisor, which is the one component that can solve it. It is behind
`DatabaseRestoreSeam.exitProcess` so the suite can assert it without killing the
Jest worker.

This makes the two operator prerequisites hard requirements rather than advice:

- **A restart policy** (`restart: unless-stopped`, or a Kubernetes Deployment).
  Without a supervisor that restarts it, a **successful** restore leaves the
  application down.
- **A single API replica.** The maintenance flag is per-process, so any other
  replica keeps serving traffic, gets terminated mid-request, and then talks to
  a renamed database.

Both are pre-flight warnings (§2.5) and runbook prerequisites (§7 of
`docs/runbooks/database-restore.md`), and the service's own header points at
them. Neither can be enforced from code.

### 8.9 Rollback, and why the two modes are not comparable

`DatabaseRestoreService.rollback` returns a discriminated result rather than a
boolean, because the honest answer has three cases and the two successful ones
differ by three orders of magnitude:

| Outcome | When | Cost |
|---|---|---|
| `renamed` | The retained `<live>_old_<ts>` still exists. | **Seconds.** Two renames. This is the entire justification for paying roughly double the PostgreSQL volume during the retention window. |
| `restore_started` | It is gone, but a completed `pre_restore` backup exists. | **Hours.** It delegates back into `startRestore` against that archive, gates and all. |
| `unavailable` | Neither. | Nothing. Reported honestly — nothing failed, the rollback window simply closed. |

The rename path is the swap **with the names exchanged**: the bad restore is
parked under a fresh `<live>_restore_<ts>` and the retained original is
promoted. It reuses `renameSwap`, so the inner recovery exists in exactly one
place; writing it twice would mean the most dangerous `catch` in the repository
had two implementations, one of which would eventually be wrong. It **never
drops the database it parks** — that is the restore being undone, and an
operator who rolled back at 3am may still want to look at it.

**The rollback carries the catalog over too.** The retained database's
`database_backup_runs` is as of the moment *before* the restore, so without a
carry-over the rollback would delete every backup record created since —
including the `pre_restore` dump's, which under some configurations is the only
remaining way back from the thing being undone. It marks this run
`restore_status: 'rolled_back'`, which cost no migration: the column is a plain
string for exactly this reason.

**The delegated restore overrides the schema gate.** The `pre_restore` dump was
taken from the schema this code was running moments before the restore, so the
live migration it would be compared against is the *archive's* — the gate would
block on a mismatch that exists only because the thing being undone happened.
That block would be spurious, and it would fire at the exact moment an operator
needs the way back.

**The rollback's exit is delayed** by a few hundred milliseconds, unlike the
restore's. A restore's swap runs detached and the request that started it was
answered hours earlier; a rollback is fast enough that its HTTP caller is still
holding the connection, and exiting mid-response would show an operator a
network error for an operation that succeeded.

### 8.10 Dropping a retained database, and why it is row-driven

`DatabaseRestoreService.dropExpiredOldDatabases` drops `<live>_old_<ts>`
databases whose `oldDatabaseRetentionHours` window has passed. It runs as a
**third duty in `DatabaseBackupScheduleTask`'s existing ten-minute tick**, not
as a `@Cron` of its own: the window is measured in hours so a ten-minute poll is
already an order of magnitude finer than it needs to be, a second timer would be
a second unsynchronised deleter of databases (the same argument `DbBackupModule`
already makes for retention), and that handler already owns the pattern the
sweep needs — one `now` for the whole tick, one policy read, one swallowing
`catch` per duty. It goes **last**, because it is pure housekeeping and a backup
that is due must not wait behind a `DROP DATABASE` blocked by a session somebody
left open.

**It is row-driven, not name-driven, and that is a deliberate refusal.** Sweeping
`pg_database` for anything matching the `<live>_old_` prefix would be
self-healing and would also drop databases this application never created —
specifically the one an operator makes by hand following #284's guided command
block, which uses exactly that name and which the runbook tells them to keep
until they have verified the restore. An unattended cron that deletes a full
copy of a production database nobody in this system recorded creating is not a
trade worth making for tidiness.

The cost is honest and is in the runbook: if the catalog carry-over failed, the
row naming the displaced database is gone and nothing will ever drop it by
itself.

Two more rules: `swappedAt` and not `restoredAt` is the clock (an in-flight
restore has a `restoreOldDb` and a NULL `swappedAt`, and `NULL < cutoff` is never
true, so an in-flight restore can never be swept), and a **semantic guard**
refuses to drop a name equal to the live or maintenance database.
`quoteIdentifier` makes the statement safe to *send*; this makes it safe to
*mean*, so a hand-edited row cannot have a cron drop the database the
application is serving from.

### 8.11 Progress, and the audit trail

`restore_status` moves `restoring` → `verifying` → `swapping` →
`completed`/`failed` (plus `rolled_back`), and #286's `GET /runs/:id` polls it.
`restoring` covers everything from the download to the last byte `pg_restore`
writes, because splitting it further would imply a progress signal this design
does not have: a `pg_restore` in flight reports nothing a caller could poll, and
finer states that all mean "still restoring" would be dishonest precision. Every
progress write **swallows its own failure** — abandoning a two-hour replay
because one status UPDATE failed would be a self-inflicted outage.

Four `audit_events` rows, and **where each one lands matters**:

| Action | Written | Lands in |
|---|---|---|
| `db_restore:start` | at the beginning | the pre-swap database (survives in `<live>_old_<ts>`) |
| `db_restore:swap` | immediately before the renames | the pre-swap database |
| `db_restore:complete` | after the renames, through the carry-over | **the promoted database**, with the whole timeline in `meta` |
| `db_restore:failed` | on any failure before the swap settles | the live database, which was never renamed |

The split is unavoidable — the first two are written while the pre-swap database
*is* the live database — which is exactly why the completion row carries the
whole timeline rather than a delta: the promoted database must hold one complete
record of the operation without needing the displaced one. `db_restore:failed`
is not in the issue's list of three and earns its place anyway: a restore that
failed is the one an operator greps for, and without it the only trace in that
table is a `db_restore:start` with nothing after it, indistinguishable from a
restore that is still running.

### 8.12 Wiring

`DatabaseRestoreService` is a **provider in `DbBackupModule`, not exported, and
bound to no controller** — the same discipline the pre-flight follows, for a
stronger reason: a service that can replace the production database must not be
reachable over HTTP before the route that authorizes it has been reviewed. #286
owns that route.

The one new module import is **`MaintenanceModule`**, and it is not optional: it
is where the in-memory override lives, and without it the swap would have no way
to hold traffic back at the only moment it must. `MaintenanceModule` is not
`@Global()` (unlike `PrismaModule`), it exports `MaintenanceModeService`
explicitly, and the dependency direction stays acyclic — maintenance depends on
settings and JWT, and on nothing in `db-backup`.

`DATABASE_RESTORE_SEAM` joins `DB_BACKUP_ENGINE`, `DB_BACKUP_TIMERS`,
`RESTORE_PREFLIGHT_SEAM` and `RESTORE_ADMIN_CLIENT_FACTORY` as an **optional
token deliberately left unbound**, and it is the most important member of that
list: it carries `exitProcess`, and a bound stub in production would leave a
process serving requests through a connection pool pointed at a database that
has been renamed away.

**The pre-flight runs inside `startRestore`**, not only in #286's endpoint. The
duplication is deliberate: the gates are the difference between "a restore that
fails" and "a restore that destroys a database", and a service that trusted its
caller to have run them would be one refactor — or one new caller, such as this
file's own rollback path — away from a restore with no gates at all. The cost is
a handful of catalog reads.

**A second concurrent restore is refused by a process-local guard**, and it is
honestly labelled as one. There is no database constraint that could express
"one restore at a time", because a restore's state lives on the row of the
*backup* it replays and two restores are two different rows. The real exclusion
is the single-replica prerequisite; the guard is for the case where that
prerequisite is met and an operator double-clicks.

**No migration.** The `restore*` columns were declared by #281.

### 8.13 Rejected alternatives (the restore)

**In-place `pg_restore --clean`.** The obvious implementation. It drops every
object in the archive — including the table tracking the restore's own progress
— and a failure midway leaves a live database with half its tables gone, no UI,
no catalog and no way back. The destructive window becomes the whole restore.
See §8.1.

**Streaming the archive into `pg_restore` instead of downloading it.** It looks
like the same discipline the backup engine applies to `pg_dump`, and it is not:
`pg_restore -j` needs to seek, a pipe cannot, and `pg_restore` refuses the
combination. Streaming would forfeit all parallelism on the phase that dominates
the runtime — to save a temp file on a host that is about to hold a second copy
of the whole database. See §8.2.

**Trusting the backup-time checksum.** It was a true measurement of the object
*when it was written*. Between then and now the archive has sat in storage
through lifecycle transitions, and the download itself can truncate. The
re-verification costs one hash of bytes that are being written to disk anyway,
and the alternative is finding out after the swap. See §8.2.

**Skipping the catalog carry-over.** The restored database has a
`database_backup_runs` table, so it looks like nothing is lost. What is lost is
every backup taken since the archive — including the `pre_restore` dump that is
the way back from the restore that is happening right now. See §8.7.

**Writing the restore's "completed" audit fields to the live row before the
swap.** The natural place to record success, and it records it in the one
database nobody will ever open again. The values are applied during the export
instead. See §8.7.

**Not exiting after the swap.** The process would keep serving from a connection
pool bound to a database that has been renamed away, with every pooled session
already terminated. There is no API that repoints a Prisma pool. The exit is
what makes a restart policy a prerequisite rather than a nicety. See §8.8.

**Running `prisma migrate deploy` automatically after the swap.** Tempting,
because the schema gate has already identified the mismatch and the command is
known. It would make one irreversible act into two, unattended, against data an
operator has only just decided to trust. It is documented as a step instead. See
§8.8.

**A name-prefix sweep for retained databases.** Self-healing, and it would drop
databases this application never created — including the `<live>_old_<ts>` an
operator makes by hand following the guided command block, which the runbook
tells them to keep. Row-driven has the better failure mode: a leak, which is
loud, rather than a deletion, which is not. See §8.10.

**A `@Cron` of its own for that sweep.** A second unsynchronised deleter of
databases in a subsystem that already decided once not to have one, for a window
measured in hours. See §8.10.

**Dropping the scratch database when the swap fails.** It is the same cleanup
every earlier phase performs, and here it would discard a complete, verified
restore that took hours, because a rename failed. See §8.6.

**Letting `reinsertCatalog` throw.** It would reach a failure handler that
assumes the swap did not happen, and it would invite a future "roll the swap
back" that discards a database the deployment is already serving from. See §8.7.

## 9. The endpoints (#286)

Two routes on the controller `docs/specs/database-backup.md` already describes,
and one property that is true of nothing else in this application:

> **A mis-fired or retried request here is an outage, not a duplicate row.**

Every other write in this API, sent twice, costs at worst a wasted row — a
second backup is refused by the single-active index, a second job is a second
job. A second restore replaces the production database. Everything below follows
from that sentence.

```
POST /api/admin/db-backup/runs/{id}/restore    { "confirmation": "RESTORE",
                                                 "overrideSchemaCheck"?: boolean }
POST /api/admin/db-backup/runs/{id}/rollback   { "confirmation": "ROLLBACK" }
```

### 9.1 The permission is `db_backup:restore`, and deliberately not `db_backup:write`

Scheduling backups and replacing the production database are **not the same
authority**. A deployment must be able to grant the first to somebody it does
not trust with the second — the operator who configures the nightly dump, the
on-call engineer who takes an ad-hoc backup before a deploy — and that is the
entire reason `prisma/seed-data.ts` seeds a third permission.

Folding these two routes under `db_backup:write` would spend it, and would do so
*invisibly*: every existing holder of `db_backup:write` would silently acquire
the ability to replace the database. The split is asserted twice, in ways that
catch different mistakes — as decorator metadata (a route that had drifted to
`db_backup:write` would still refuse a viewer and pass every request-level test)
and by driving both routes as an **Admin holding only `db_backup:write`** and
expecting `403`.

Both are additionally gated on the Admin role, matching every other admin
controller: the role admits, the permission is what the guard checks.

### 9.2 The typed confirmation literal is the safety feature

The body must carry `"confirmation": "RESTORE"` — the exact string, uppercase,
matched literally. A missing, empty, misspelt or lower-case value is a **`400`
that has started nothing**: no pre-flight, no run lookup, no download, no row.
The literal is a Zod literal on the DTO, so the global validation pipe refuses
the request before the handler body executes; the test for it asserts not only
the status but that **the restore service was never called**.

The rollback route requires a **different word**, `ROLLBACK`, so that a body
copied from one route to the other is refused rather than silently accepted. In
`pre_restore_dump` mode a rollback *is* a multi-hour restore, so confusing the
two is not a harmless mistake.

`overrideSchemaCheck` is optional and defaults to `false`, so an ordinary
restore body is exactly `{"confirmation":"RESTORE"}` — nobody has to send a flag
in order *not* to override something.

### 9.3 It returns as soon as the cheap gates have run

A restore rebuilds every index in the database from the archive (§8.1), so it
takes hours, while every reverse proxy in front of this process has a response
timeout measured in seconds. The response therefore lands the moment the
pre-flight has decided, and the restore continues detached. The caller polls
`GET runs/{id}` and watches `restoreStatus`: `restoring` → `verifying` →
`swapping` → `completed`/`failed`.

That promise is what makes #286 the issue that **publishes the `restore*`
columns** on the run DTO. They were declared by #281 and left unpublished
through #283 and #285 on the stated grounds that eight always-`null` fields are
a contract a client cannot distinguish from "this build has no restore". An
endpoint that tells its caller to watch `restoreStatus` cannot leave
`restoreStatus` out of the polling response.

Expect the poll to see `swapping` and then a connection error, and to read
`completed` only after the supervisor has restarted the process. That is
success, not failure (§8.8).

### 9.4 Three normal outcomes per route, keyed by `mode` — and `mode` is the answer

Both routes answer **`200` on all six normal outcomes**, and the discriminator
is the `mode` field. This is the contract `CancelBackupResultDto` already
states for its `outcome`, forced by the same fact: the honest answer has more
than one shape and a status code cannot carry the difference.

**Restore.**

| `mode` | What happened | Body carries |
|---|---|---|
| `running` | Gates passed; the restore is under way in the background. | `runId`, `scratchDatabase`, `oldDatabase`, `preflight` |
| `guided` | A capability gate failed. **Nothing was started.** | `runId`, `guidance { reason, commands, runbook }`, `preflight` |
| `blocked` | The schema gate refused. **Nothing was started.** | `runId`, `block { gateId, message, overridable, overrideParameter }`, `preflight` |

**Rollback.**

| `mode` | What happened | Cost |
|---|---|---|
| `renamed` | `retain_database`: the retained pre-swap database was renamed back. | **Seconds** |
| `restore_started` | `pre_restore_dump`: delegated into the restore path against the safety archive, **with the schema check overridden**. | **Hours** |
| `unavailable` | The retained database is gone and no pre-restore backup exists. | — |

`preflight` carries the whole verdict — every gate that ran, *including the ones
that passed*, plus the rollback plan, both migration names and the size
readings — because an operator about to replace their production database is
entitled to see what was checked, not only what failed. `guidance` and `block`
are hoisted next to the `mode` that selects them rather than repeated inside
`preflight`, so a client narrows once and a multi-line command block is never
sent twice in one body.

### 9.5 `guided` must not be an error status

This is the single most important decision in the pair. A `guided` result means
a **capability** gate failed — nearly always `CREATEDB`, which managed
PostgreSQL routinely denies — and the body carries a complete, paste-ready
command block plus a runbook path so the same restore can be performed by hand
with a superuser.

A `4xx` would tell an operator, **in the middle of an incident**, that their
platform is unsupported. It is not: it is a platform this design planned for
(§3, §4). The block is asserted to be *complete* — real host, real port, real
user, real database names, real run id, and no `<placeholder>` anywhere —
because a command block with a placeholder in it is not a deliverable, it is
homework.

`blocked` is likewise a `200`: the caller's next move is to re-send with
`overrideSchemaCheck: true`, which is an answer rather than a failure.

### 9.6 The override unblocks exactly one gate

`overrideSchemaCheck` clears the **schema compatibility** gate and nothing else.
The distinction is not a policy choice:

* A schema mismatch is a **judgement**. "This archive predates two migrations; I
  accept that and will run `prisma migrate deploy` afterwards" is a sentence an
  operator is entitled to say.
* A capability failure is a **statement of fact**. No amount of accepting makes
  a role without `CREATEDB` able to create a database. An override that silenced
  it would not enable a restore; it would start one that dies at
  `CREATE DATABASE`, having already downloaded the whole archive.

There is an explicit **negative** test: a request carrying
`overrideSchemaCheck: true` against a cluster whose role lacks `CREATEDB` still
answers `guided`, and the assertion confirms the flag *was* forwarded rather
than the request having been ignored.

The request field's name is not invented by the DTO. `restore-preflight.service
.ts` exports `RESTORE_SCHEMA_OVERRIDE_FIELD` and emits it as
`block.overrideParameter`, whose whole purpose is to tell a client which field
to set; the DTO ties its schema to that constant at compile time and again at
run time in its spec. Publishing the service's *internal* option name
(`overrideSchemaMismatch`) would have handed an operator a parameter the
endpoint rejects — the most frustrating possible failure, where the server has
said exactly what to do and refuses when you do it.

### 9.7 The 409, and where its payload has to live

A second restore while one is in flight is a **`409`** carrying the id of the
run that is already running at **`details.activeRunId`** — the same envelope
rule §2 of `docs/specs/database-backup.md` states for `POST runs`, and for the
same reason: `HttpExceptionFilter` rebuilds every error body from a fixed key
allowlist (`message` and `details` off the payload, `code` derived from the
status), so a field written at the *top level* of a thrown payload is silently
dropped and never reaches the client.

And `exception.getResponse()` returns the payload **before** the filter has
touched it, so a unit assertion on it proves nothing about the wire — it would
pass identically with the filter deleted *and* with the field in the position
that does not survive. It is therefore asserted through the real router and the
real filter, together with the negative half: nothing survives at the top level.

Note what this 409 is *not*. It is a **result** from the restore service, not an
exception (§8.12), and it is process-local: a restore's state lives on the row
of the backup it replays, so no database constraint could arbitrate two restores
of two different archives. The real exclusion is the single-replica
prerequisite; this is the in-process half of it.

### 9.8 The error mapping lives in the controller

`DatabaseBackupAdminService`'s two restore methods throw **domain** errors —
`DatabaseRestoreRunNotFoundError` and `DatabaseRestoreNotAllowedError` — and the
controller maps them: **not-found → 404, not-allowed → 400**, with the
`already_running` result → 409. This is a deliberate inconsistency with the
other eight routes on that controller, whose service raises
`NotFoundException` itself:

* **The restore path is reached from more than the HTTP layer.** A rollback in
  `pre_restore_dump` mode re-enters `startRestore` from inside a running
  restore, where the request that began everything was answered hours ago. A
  framework exception raised there is an HTTP object travelling a code path with
  nothing to send it to.
* **It keeps every status-code decision for these two routes in one screen**,
  next to the OpenAPI annotations that publish them. For the one surface where a
  mis-fired request is an outage, "which answers are errors and which are
  normal" is worth being able to read at a glance.

`not-allowed` covers two cases, neither of which is a defect in the request's
*shape*: restoring a run that is not `completed` (only a completed run has a
whole archive that was read back and proved readable — the same rule
`getDownloadUrl` enforces, and it matters more here, because a bad restore costs
hours and a safety dump before the archive is found unreadable), and rolling
back a run that was never restored. The second is a `400` rather than an
`unavailable`: `unavailable` means "the way back expired", which is a fact about
a restore that *happened*.

### 9.9 Route ordering

Both are `runs/:id/…` routes on a controller whose every literal route must be
declared above every parameterised one — Nest matches in declaration order, not
by specificity, and the failure it produces has no boot error and no log line.
They sit inside the parameterised block, deepest first, alongside
`runs/:id/download` and `runs/:id/cancel` and above `runs/:id`.

### 9.10 Rejected alternatives (the endpoints)

**A boolean `confirm: true`.** The obvious shape, and the reason the literal
exists. A boolean is reproduced by a browser or proxy replaying a POST it
believes idempotent, by a `curl` line copied out of a runbook or a chat, by a
client library retrying on a socket timeout — which is exactly when a restore is
in flight and answering slowly — and by a double-click on a button whose first
response has not arrived. In all four the body is identical to the deliberate
one and the server cannot tell them apart. `{"confirmation":"RESTORE"}` can
still be replayed *deliberately*, which is the point: a replay of that body is a
decision somebody made.

**Blocking until the restore completes.** It would make the response
unambiguous, and it would be an HTTP request measured in hours. Every proxy in
the stack would give up long before it finished, on exactly the databases worth
restoring, and the operator's retry would meet the 409 while the first restore —
which nobody is now watching — carried on. The same argument `POST runs` makes
for backups, only more so.

**Treating `guided` as an error.** A `4xx` would tell an operator on managed
PostgreSQL that their platform is unsupported, mid-incident, when the body they
were sent is a complete working alternative. See §9.5.

**A single override flag covering every gate.** One `force: true` would be
simpler to document and would turn the one deliberate escape hatch in this
subsystem into a way to skip all of it. A capability gate is a statement of
fact, not a policy to override: silencing it starts a restore that fails at
`CREATE DATABASE` after downloading the whole archive. See §9.6.

**Distinct status codes per outcome (`202` for `running`, `409` for `blocked`).**
`202` is genuinely the right shape for `running` — but `guided` and `blocked`
started nothing, so answering `202` for them would be a lie, and answering
`4xx` reopens §9.5. One status, one discriminator, documented: read `mode`.

**Putting the mapping in the service.** See §9.8.

## 10. The operator interface (#287)

`DbBackupPage.tsx` (the route and its row actions), `DbBackupRestoreDialog.tsx`
(the confirmation), `DbBackupConfigPanel.tsx` (the policy form),
`dbBackupTable.tsx` (the run history's column contract) and
`hooks/useDbBackup.ts` / `services/dbBackup.ts` (the fetch and predicate
layer). This is a design spec, not a walkthrough — the screens themselves are
ordinary MUI. What is worth writing down is the same property §9 opens with,
carried one layer further out:

> **A mis-fired click here is an outage, not a duplicate row.**

The API refuses to be a source of ambiguity (§9.2). Everything below is the
interface making sure a click that reaches the API was never ambiguous in the
first place.

### 10.1 One dialog serves both restore and rollback

`DbBackupRestoreDialog` takes an `intent` of `'restore'` or `'rollback'`
rather than existing as two components. A restore and a rollback need exactly
the same three things — a plain statement of the consequence, an
acknowledgement of it, and a typed confirmation literal — and both answer with
a `mode` that has to be rendered rather than collapsed into "it worked"
(§9.4). Two components would be two copies of that machinery, and **the
second copy is where the acknowledgement quietly stops gating the button** —
a bug that costs nothing to introduce and nothing to miss in review, because
the working copy still passes every test. `intent` selects the copy that is
shown and the literal that is required; nothing else forks.

### 10.2 Consent is gated on what exists at the moment it is asked for

The issue asked for the confirm control to stay disabled until the pre-flight
verdicts had been seen. There is no dry-run endpoint to make that literally
true: `POST runs/{id}/restore` runs the gates itself (§9.3), deliberately, so
that no caller can reach a restore with no gates by forgetting to run them
first. The verdicts therefore arrive **on the response**, not before it — on
all three restore outcomes, `running` included (§9.4) — which means a control
gated on "the verdicts have been seen" cannot exist before the request that
produces them has already been sent once.

So the dialog implements the issue's intent at the two points where verdicts
actually exist to gate on:

1. **The first confirm** is gated on the *consequences*, not the gates: an
   explicit acknowledgement whose label states plainly that the application
   will restart, plus the typed literal. That is the only information that
   exists before the request is sent, and it is the information that decides
   whether the restore is *wanted* — the gates decide only whether it is
   *possible*, and that answer does not exist yet.
2. **Every confirm after that** — in practice the schema override offered
   after a `blocked` outcome — is gated on the verdicts, now on screen,
   through a *second* acknowledgement that names the mismatch specifically,
   **and** on the literal being typed again. The field is cleared the moment
   the block arrives, so the override — a different, more dangerous request
   than the one that was refused — cannot inherit the consent given to the
   request that failed.

Every gate is rendered whatever its verdict, passes included: an operator
about to replace a production database is entitled to see what was *checked*,
not only what objected (§2), and each carries its own action item so a
`guided` outcome's two or three findings do not collapse into one string with
one remedy.

### 10.3 The typed literal exists so the button cannot fire by accident

The confirm buttons stay disabled until the typed field matches the API's own
literal exactly — `RESTORE` or `ROLLBACK`, uppercase, no fuzzing (§9.2, §9.10)
— in addition to the acknowledgement checkbox. The literal buys the interface
nothing the checkbox does not already buy in terms of information; what it
buys is that **a stray click cannot fire it**. A checkbox is reproduced by a
drag, a double-click, a keyboard mis-navigation; retyping a whole word is not.
The dialog also resets both fields to nothing on every open — keyed on the
dialog opening, the run's id, and the intent — so a second, different archive
never inherits a literal typed for the first, and resets them again across the
override for the same reason. A mis-fired restore is an outage (§9), so the
control asks for the one input that a slip of the mouse cannot produce.

### 10.4 `guided` is rendered as an answer, not a failure

A capability gate failing — almost always a role without `CREATEDB`, which
managed PostgreSQL routinely denies (§2.1) — is a `200` carrying a complete,
paste-ready command block (§4) and a runbook path. The dialog renders that
outcome at `info` severity, never `error` or `warning`, and its own copy says
so in words: *nothing has been started and nothing has changed.* Rendering it
in the error palette would tell an operator, in the middle of an incident,
that their platform is unsupported — at the exact moment the screen is
handing them the working alternative. The likely reaction to a red banner is
retrying or filing a bug, and both are worse than reading the block, so
nothing about this outcome earns red.

The command block itself is copy-affordanced and independently selectable —
selectable even when the copy button's `navigator.clipboard` call fails, which
is a real failure mode handled the same way `NodeCredentialRevealDialog`
handles it — rather than a raw block of text an operator has to select by hand
during an incident.

### 10.5 The runbook is rendered as a path, not a link

`guidance.runbook` comes back from the API as a repository-relative path
(`docs/runbooks/…`), and the dialog renders it as monospace text, never as an
`<a href>`. Turning it into a link would require inventing a host and a
branch — nothing in a deployment's configuration says what either is — and
that is the same discipline the command block itself is held to: §4 requires
every name in it to be derived from the deployment's own configuration, never
invented, because nothing in this template may hard-code a repository name. A
link that resolves against the wrong host, or 404s because the repository is
private, is a worse failure than a plain path handed to an operator who is, at
that moment, already standing in the checkout it names.

### 10.6 Preconditions are disabled controls, carrying their reason

Every row action reads a predicate from `services/dbBackup.ts` —
`isBackupDownloadable`, `isBackupRestorable`, `isBackupCancelable`,
`isBackupDeletable`, `isRollbackAvailable` — that mirrors the precondition the
corresponding endpoint enforces (§9.8), and a failed predicate disables the
control rather than removing it. This is not a rule invented for this page: it
is the one `UserList` states and `JobsPage`, `WorkersPage` and
`BroadcastsPage` already follow, for the same reason everywhere it is stated —
**the action set must not change shape from row to row**, or an operator
comparing notes with a colleague concludes a feature is missing rather than
that a precondition is unmet or a permission is absent. The tests assert
`aria-disabled` on the control, not its absence, because those are different
claims and only one of them is true here.

`stale` is the sharpest case. Nobody knows how a stale run ended — it stopped
heartbeating and the sweep released its slot (`database-backup.md` §12) — so
its archive may be truncated, and the row is deliberately neither downloadable
nor restorable. That is the exact case where a UI that "helpfully" allowed it
would hand an operator a corrupt restore in the middle of an incident.

### 10.7 The mid-swap outage is rendered as the expected sequence

This is the one page in the application that deliberately takes the API down
(§8.5, §8.8). The observable sequence at the end of a successful restore is:

1. requests fail with **no response at all** — the process has exited;
2. then `503` carrying the maintenance marker — something is listening again,
   and the window is still open;
3. then success.

Step 2 is handled centrally and needs nothing from this page: `services/api.ts`
recognises the marker on the one error path every request shares, and
`MaintenanceGate` swaps the subtree for the maintenance screen, whose "Try
again" clears the block and remounts. Step 1 is what `DbBackupPage` has to get
right on its own, because a transport failure with *no response at all* is, on
the wire, indistinguishable from a backend that is actually broken.

The page tracks whether a restart is *expected* — set the moment a restore's
response comes back `running`, or a run in the visible list is mid-restore —
and while that flag is set, an unreachable API renders at `info` severity:
*"This is the expected last step, not a failure."* The flag is **sticky
across the outage on purpose**, cleared only by the first successful read that
shows nothing in flight, never merely by the API answering again: the restore
keeps the application serving normally for hours before the swap (§8), so an
ordinary successful read partway through that window proves nothing about
whether the restart has already happened. Showing "Failed to load backup
runs" at the exact moment an operator is watching their own database being
replaced would be the one thing capable of making them doubt a screen that is
working exactly as designed.

### 10.8 The rollback-mode downgrade is surfaced before the decision it changes

The dialog reads the rollback plan from the pre-flight response, not from the
saved policy, because the two can differ: a short disk downgrades the
*effective* mode even when `retain_database` is configured (§2.4). When the
plan is downgraded the dialog renders a dedicated warning — that rolling back
will now take hours, not seconds — rather than folding the fact into the
general gate list. It is called out on its own because it is the single fact
on the whole screen most likely to change the decision an operator is
mid-way through making: the difference between a rollback that is a rename and
one that is a multi-hour restore is exactly the number an operator needs
before pressing the button, not after.

### 10.9 Byte fields are strings end to end

`sizeBytes` and `bytesWritten` arrive from the API as decimal strings, because
they back `BigInt` columns and the API itself never lets one reach the wire as
a JSON number (`database-backup.md` §13.6). Nothing on this page widens either
back to a JavaScript `number` and stores the result: the formatter that turns
a byte count into a label takes the string and parses it only to choose a unit
and round a display value, and the value held in state and re-rendered stays
the string the API sent. A `Number()` cast would silently lose precision above
2^53 bytes — a magnitude this application will not produce today, but the
column is `int8` precisely so that ceiling is never revisited, and a display
layer that reintroduced it would quietly undo the reason the column is a
`BigInt` in the first place. A run still writing shows its live
`bytesWritten` rather than a final `sizeBytes` of `'0'`, which is the only
honest number to print while a dump is streaming — `sizeBytes` is not set
until the archive is closed.

### 10.10 What the policy form deliberately leaves out

The config panel edits every field of the stored policy except two:
`storageProvider` and `runStaleMinutes`.

`storageProvider` must either equal the deployment's active provider or be
left empty, meaning "whatever is active" — a free-text field over it is a way
to break tonight's backup with a typo and no offsetting benefit, since there
is nothing useful an operator can set it *to* other than the value it already
resolves to. `runStaleMinutes` is the sweep threshold that decides when an
unheard-from run is called `stale` (`database-backup.md` §12) — an internal
timing constant, not a policy an operator has a standing view on.

Both remain editable, deliberately, through Admin → General → Advanced
(JSON) — the escape hatch that surface exists for. Leaving them off this form
is not the same as making them unreachable; it is refusing to give a typo the
same production-breaking blast radius as a labelled input.

### 10.11 A visible side effect: six baselines moved

Flipping the `Database Backup` card in `adminSections.tsx` from `disabled`
(a "Coming soon" chip, no `CardActionArea`) to routed reflows two things that
have nothing to do with backups. MUI equalises row height across a card grid
to the tallest card in the row, and the chip was what made the disabled card
the tallest; removing it changes every card's rendered height in that row.
And `NavigationRail` skips any card carrying no `path` or `disabled: true`, so
a card invisible to the rail until now claims a row in it. Both are real
layout changes with no bug behind them, so six pixel baselines — across
`admin-hub.spec.ts`, `console-rail.spec.ts` and `hub-search.spec.ts` in
`tests/visual/` — moved and were regenerated alongside this issue.

### 10.12 Rejected alternatives (the operator interface)

**A single confirm button.** The obvious shape once an acknowledgement
checkbox already exists on screen — why also ask for a typed word? Because the
destructive action here deserves the same friction the API itself imposes
(§9.2, §9.10): a checkbox is reproduced by a mis-click in a way that retyping
a whole word is not.

**Hiding the pre-flight warnings until something fails.** It reads as more
reassuring collapsed — a clean screen until there is a problem to report. But
the warnings — the replica count, the disk-downgrade notice, the schema
comparison — are exactly what an operator needs *before* deciding, not after
they have already committed (§2, §9.4). Collapsing them would answer the
question nobody is asking ("is something broken?") instead of the one that
matters ("what will happen if I press this?").

**Treating `guided` as an error.** Rejected at the API layer first (§3, §9.5)
and rejected again here for the identical reason: an operator on managed
PostgreSQL is not on an unsupported platform, and a red banner would say
otherwise at the worst possible moment to say it.

**Treating the mid-swap outage as a generic transport error.** The
straightforward implementation — any failed fetch renders "Failed to load" —
and the one moment on this entire page where that message would do the most
damage: exactly when an operator is watching their own database midway
through being replaced. See §10.7.

**A separate rollback dialog.** Restore and rollback share the entire safety
machinery — the acknowledgement, the typed literal, the outcome rendering. A
second component is where that machinery eventually drifts: the day somebody
fixes a bug in one copy and not the other is the day the acknowledgement
stops gating the button in exactly one of the two places that needed it most.
See §10.1.

## 11. Verification

| Claim | Covered by |
|---|---|
| The connection is closed on the success path, the throw path, and when the callback never resolves | `src/db-backup/admin-connection.util.spec.ts` |
| A failing `end()` does not mask the failure that caused it; a failed `connect()` still closes | `src/db-backup/admin-connection.util.spec.ts` |
| `statement_timeout` is set to 0 on every session; the callback bound is off by default | `src/db-backup/admin-connection.util.spec.ts` |
| The maintenance database falls back to `template1` when the application's is `postgres`; a `DATABASE_URL` override still wins; the password arrives decoded | `src/db-backup/admin-connection.util.spec.ts` |
| `quoteIdentifier` **rejects** quotes, terminators, spaces, newlines, NULs, non-ASCII, a leading digit, an empty string and a 64-byte name | `src/db-backup/admin-connection.util.spec.ts` |
| A maximally long database name still yields a legal, unique scratch name whose suffix survived, ≤ 63 bytes | `src/db-backup/admin-connection.util.spec.ts` |
| Every cluster read parses what the driver actually returns (`int8` as text, a missing row, an unreadable `data_directory`) | `src/db-backup/admin-connection.util.spec.ts` |
| Every mutation goes through the allowlist and refuses an identifier outside it **before** issuing anything | `src/db-backup/admin-connection.util.spec.ts` |
| Each gate independently produces the documented outcome | `src/db-backup/restore-preflight.service.spec.ts` |
| `CREATEDB` denied yields `guided` with a command block that is complete, correctly parameterised and paste-ready — **asserted by string** | `src/db-backup/restore-preflight.service.spec.ts` |
| The block never prints the password, contains no placeholder to invent, and gains the migration step only on a mismatch | `src/db-backup/restore-preflight.service.spec.ts` |
| A schema mismatch blocks in **both** directions; the override unblocks that gate and **never** a capability gate or the version pair | `src/db-backup/restore-preflight.service.spec.ts` |
| A short disk in `retain_database` downgrades to `pre_restore_dump` and reports it; an unreadable data directory warns and leaves the configured mode alone | `src/db-backup/restore-preflight.service.spec.ts` |
| The replica heuristic warns and never blocks | `src/db-backup/restore-preflight.service.spec.ts` |
| **No pre-flight path creates, drops or renames anything**, on every outcome — asserted with spies *and* against the SQL the cluster received | `src/db-backup/restore-preflight.service.spec.ts` |
| All reads happen in one session; an unreachable cluster is a verdict, not a throw; the archive is never fetched | `src/db-backup/restore-preflight.service.spec.ts` |
| A failure injected at **each** phase before the rename leaves the live database untouched and drops the scratch database — asserted against the SQL the cluster received, not only with spies | `src/db-backup/database-restore.service.spec.ts` |
| **A failed second rename renames the original back**; the window is closed when it worked and left **open** when it did not; the scratch database is kept | `src/db-backup/database-restore.service.spec.ts` |
| The catalog carry-over preserves this run's record and every newer backup, applies the post-swap audit values, resolves user FKs through a subselect and the self-FK in a second pass | `src/db-backup/database-restore.service.spec.ts` |
| A failed carry-over never undoes a successful swap | `src/db-backup/database-restore.service.spec.ts` |
| Maintenance mode is opened in memory with **`allowAdmins: false`** and released by the exit rather than before it | `src/db-backup/database-restore.service.spec.ts` |
| Checksum and TOC are re-verified against the **downloaded** bytes; a corrupt archive fails before anything is created | `src/db-backup/database-restore.service.spec.ts` |
| The temp file carries the janitor-swept prefix and is removed on success **and** failure | `src/db-backup/database-restore.service.spec.ts` |
| `process.exit` is behind an injectable seam | `src/db-backup/database-restore.service.spec.ts` |
| Rollback: `renamed` in retain mode, `restore_started` (schema check overridden) in dump mode, `unavailable` when neither exists | `src/db-backup/database-restore.service.spec.ts` |
| The retained-database sweep is row-driven, refuses the live and maintenance databases, and survives one database that will not drop | `src/db-backup/database-restore.service.spec.ts` |
| The sweep runs last in the schedule tick, on the tick's own clock, and its failure costs neither other duty | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| **Against a real cluster**: create/rename/rename-back/drop; a rename onto a taken name is refused; the inner recovery restores the original; `withAdminConnection` leaves no session behind; a subselect FK yields NULL instead of aborting; the self-FK needs the second pass | `src/db-backup/database-restore.db.spec.ts` |
| A missing, empty, lower-case, misspelt, boolean or wrong-word `confirmation` is a **400 that never reaches the restore service** — asserted with a spy on every case, on both routes | `test/db-backup/db-backup-restore.integration.spec.ts` |
| All three restore `mode`s come back with the documented shape; `guided` arrives with a **200** and a command block containing the real host, port, user, both database names and the run id, and **no placeholder** | `test/db-backup/db-backup-restore.integration.spec.ts` |
| `overrideSchemaCheck` unblocks the schema gate (and the flag reaches the service as `overrideSchemaMismatch`), and **cannot** unblock a capability gate — the negative asserts the flag *was* forwarded | `test/db-backup/db-backup-restore.integration.spec.ts` |
| A second concurrent restore is a **409 whose `details.activeRunId` survives the real exception filter**, with nothing left at the top level | `test/db-backup/db-backup-restore.integration.spec.ts` |
| Rollback returns `renamed` in retain mode; `restore_started` in dump mode, **driving the restore with the schema check overridden**; `unavailable` past the retention window as a **200, not a 500** | `test/db-backup/db-backup-restore.integration.spec.ts` |
| Both routes require **`db_backup:restore`** and not `db_backup:write` — asserted as decorator metadata *and* by driving both as an Admin holding only `db_backup:write` (403), with a positive control | `test/db-backup/db-backup-restore.integration.spec.ts` |
| A run that does not exist is a 404 with the id under `details`; a run that is not `completed` is a 400; a run that was never restored cannot be rolled back | `test/db-backup/db-backup-restore.integration.spec.ts` |
| Each typed result maps to exactly one `mode`; `guidance`/`block` are hoisted and not duplicated inside `preflight`; a gate's internal field cannot leak | `src/db-backup/dto/db-backup-restore.dto.spec.ts` |
| `GET runs/{id}` publishes `restoreStatus` and the other restore columns, narrows an unrecognised stored value to `null`, and the DTO's status list agrees with the service's | `src/db-backup/dto/db-backup-restore.dto.spec.ts` |
| The admin service forwards the row, the actor and the override; refuses a non-`completed` run and a never-restored run **without reaching the engine**; raises typed errors rather than framework exceptions | `src/db-backup/db-backup-admin.service.spec.ts` |

### 11.1 The limits

Be honest about them.

**The pre-flight suite talks to no real PostgreSQL.** The seam stands in for the
cluster, so what is proved is that the service asks the right questions and
reports the answers correctly — not that `pg_available_extensions` behaves as
assumed on every provider, nor that `SHOW data_directory` fails in exactly the
way the disk gate expects. The identifier rules are proved against the
*documented* 63-byte limit, not against a server.

**The restore suite drives the whole sequence against a fake cluster**, which is
the only way to test something that takes hours and ends in `process.exit`.
`database-restore.db.spec.ts` closes the gap that matters most — it proves
against a real server that a rename onto a taken name is refused (the
precondition that makes the inner recovery meaningful), that the recovery
sequence works, that no session is left behind, and that a subselect FK degrades
to NULL. What is still *not* proved anywhere is an end-to-end restore of a real
archive into a real database: that needs `pg_dump`, `pg_restore`, gigabytes and
a spare cluster, and it is what a staging rehearsal is for. The runbook says so.

And the whole point of the pre-flight is that it is a prediction. A clean `ok`
means every question that could be asked cheaply was asked and answered well; it
does not mean the restore will succeed. That is what the `pre_restore` backup
and the retained database are for.
