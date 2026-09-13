# Database Backup

> Epic #254, Phase 6 (#280 the `pg_*` process wrappers, the client/server
> version guard and the schedule translation; #281 the `DatabaseBackupRun`
> model, the single-active-run index, the streaming `pg_dump` engine and this
> document; #282 the scheduler, the retention rules and the staleness sweep;
> **#283** the admin API).
> Implemented in
> `apps/api/prisma/schema.prisma` (the `DatabaseBackupRun` model and its two
> enums),
> `apps/api/prisma/migrations/20260907120000_add_database_backup_runs/migration.sql`,
> `apps/api/src/db-backup/pg-dump.util.ts`,
> `apps/api/src/db-backup/pg-restore.util.ts`,
> `apps/api/src/db-backup/pg-version.util.ts`,
> `apps/api/src/db-backup/schedule.util.ts`,
> `apps/api/src/db-backup/db-backup-storage.ts`,
> `apps/api/src/db-backup/db-backup.errors.ts`,
> `apps/api/src/db-backup/db-backup-runner.service.ts`,
> `apps/api/src/db-backup/db-backup-retention.service.ts`,
> `apps/api/src/db-backup/tasks/db-backup-schedule.task.ts`,
> `apps/api/src/db-backup/db-backup.module.ts`,
> `apps/api/src/db-backup/db-backup.controller.ts`,
> `apps/api/src/db-backup/db-backup-admin.service.ts` and
> `apps/api/src/db-backup/dto/`.
>
> **On what is merged today.** §1–§3 describe the table and the guard that
> makes "one backup at a time" true. §4–§8 describe the engine: the claim, the
> streaming contract, verification, the heartbeat, failure ordering and
> cancellation. §9 describes the storage-provider constraint. §10–§12 describe
> the caller #282 added: the scheduler and its boundary rule, retention's two
> clocks, and the staleness sweep. §13 describes the admin API #283 added.
> §14 lists the rejected alternatives, §15 the verification.
>
> **Restore is Phase 7, and it has a document of its own:**
> [`database-restore.md`](database-restore.md). #284 landed the pre-flight gates
> and the cluster admin connection; #285 landed the scratch-database replay, the
> swap and rollback, which write the `restore*` columns already declared on the
> model (§1) and still deliberately unpublished by the admin API's run DTO
> (§13). **What is still missing is the way in** — #286 adds the endpoints and
> #287 the dialog, so today nothing over HTTP can start a restore.
> Everything else is in place — with `databaseBackup.enabled` turned on, a
> deployment takes and prunes backups with no human in the loop (#282 onward),
> and an administrator can inspect, trigger, cancel, download and delete them
> by hand (#283, §13).

## Why this *is* a queue job, and what had to change first

This epic ships a job queue (`docs/specs/job-queue.md`) and a worker fleet
(`docs/specs/worker-nodes.md`), and a database backup is obviously
"background work". For most of epic #254 it was still **not** a queue job,
and the reason was not taste — putting it on the queue as it stood would have
corrupted backups. Epic #345 (#346, #347, #351, #352) is the epic that fixed
the queue rather than working around it, and the backup moved onto it once
each of the three arguments below stopped being true. Read the three as they
stood — the starting position — and then read what closed each one, because
the fix is only convincing if the failure it prevents is still visible.

1. **`jobs.stuckThresholdMinutes` defaults to 30 minutes.** A dump of a real
   production database routinely runs longer than that. `JobStuckResetTask`
   would find a `running` job whose lease had expired, conclude its executor
   had died, and **reset it to `pending`** — while `pg_dump` was still
   streaming. The next claim starts a **second `pg_dump`**, writing to the
   same derived storage key as the first, and two processes interleave their
   output into one object. The archive that results restores nothing, and
   nothing reports an error: both runs can exit 0.

   **Answered by #346's per-type execution profiles.** `db.backup.run`
   declares `maxRuntimeMs: 6h`, and the claim's lease is *derived* from that
   ceiling (`resolveJobLeaseMs` = ceiling + grace) rather than declared beside
   it — so a lease shorter than the permitted runtime is unrepresentable
   rather than merely avoided. The 30-minute threshold itself did not change;
   what changed is that it is no longer the number this job type's lease is
   measured against.
2. **The in-process worker has no lease-renewal path.** `JobWorker` claimed
   with a lease and never extended it, which made point 1 not a rare race but
   *unconditional* for any job outliving the threshold — a remote node
   renewed through `POST …/renew`, and the in-process worker a
   single-container deployment actually runs did not.

   **Answered by #347.** The worker now renews for the whole of `process()`
   through `JobLeaseService`, the same service the node plane renews through,
   on a ticker derived from the lease itself (lease ÷ 3, so two consecutive
   renewal failures still cost nothing). The reaper's aged-claim signal was
   narrowed to match: age is judged only for a `running` row that carries no
   lease at all, so a job that keeps renewing is never reset by how long it
   has run (`docs/ARCHITECTURE.md` §12.3). A fourth reaper signal —
   an implausibly *far-out* lease, judged against the longest lease any
   registered handler could legitimately ask for — replaces the coverage the
   narrowed age clause gave up; see `docs/specs/job-queue.md` §7.1 for that
   signal and the trade-off it accepts.
3. **A job has an attempt budget and automatic retry.** Re-running a failed
   multi-gigabyte dump burns hours of I/O on a database that is probably
   already unwell, unattended, at whatever hour the first attempt died. The
   correct retry for a backup is *the next scheduled one*, not a queue-driven
   second attempt minutes later.

   **Answered by the same execution profile's `maxAttempts: 1`.** The policy
   did not change — a backup was never meant to auto-retry — what changed is
   that `JobStuckService`'s give-up phase and the ordinary terminal path both
   now *enforce* it per type, instead of it holding only by the accident of
   there being no queue to disagree.

None of this made `database_backup_runs` into a `jobs` row, and it was never
going to: the two tables answer different questions and have independent
lifetimes (§1.1, and the schema's own comment above `DatabaseBackupRun`). What
changed is narrower and load-bearing anyway — `database_backup_runs.job_id`
links a run to the `db.backup.run` job that is now driving it, so the row
still carries its own heartbeat, its own staleness policy
(`databaseBackup.runStaleMinutes`, defaulting to 120 rather than
`jobs.stuckThresholdMinutes`'s 30) and its own terminal states, but the
job's lease is now what the staleness sweep asks about when the run has no
heartbeat of its own — see §16.6 for why a node-executed run cannot write one
at all.

The dump's lifetime **is** the job's lifetime now, and that is safe precisely
because each of the three objections above names a specific mechanism that
closed it rather than a general assurance that the queue "should be fine". A
handler that calls `startBackup()` and returns immediately — leaving the
dump's lifetime independent of the job's — was considered and rejected: it
would buy a dashboard row and nothing else, none of the reaper safety, none of
the per-type retry budget, and none of the path to running on a worker node
that §16 depends on. §16 covers the rest of the design that followed once the
migration was safe, including running the dump on a worker node and the
per-job credential it needs to do that.

## 1. The model

One row per attempt, `database_backup_runs`. The interesting groups:

| Group | Columns | Note |
|---|---|---|
| State | `status`, `trigger`, `started_at`, `finished_at`, `last_heartbeat_at` | `status` is `pending \| running \| completed \| failed \| stale`; `trigger` is `manual \| scheduled \| pre_restore` |
| Size | `bytes_written`, `size_bytes` | **BigInt.** `bytes_written` is live progress rewritten by the heartbeat; `size_bytes` is the final size written once, at completion |
| Storage | `storage_provider`, `storage_key`, `bucket`, `format`, `checksum_sha256` | The whole triple is recorded rather than derived on read: a bucket rename or a provider swap must not make an old archive unlocatable |
| Audit | `db_version`, `app_version`, `migration_name` | All best-effort; none may fail a backup |
| Proof | `verified_at` | Set only after the **uploaded object** passed `pg_restore --list` |
| Restore (Phase 7) | `restore_status`, `restore_error`, `restored_at`, `restored_by_id`, `restore_scratch_db`, `restore_old_db`, `swapped_at`, `pre_restore_backup_id` | Written by #285's `DatabaseRestoreService`; not published by the run DTO until #286 |

`bytes_written` and `size_bytes` are `BigInt` because a dump crossing 2 GiB is
ordinary and a signed 32-bit column overflows at 2147483647 — the failure
would land on the largest backups, which is exactly the deployments this
feature exists for. The cost is real and belongs to #283: a Prisma `BigInt`
field is the JS `bigint` primitive, which `JSON.stringify` refuses outright,
so the response DTO must convert both explicitly. (`JobStatsRollup
.sumDurationMs` decided the same question the other way, and its own comment
says why: it is a running average, not a byte count that must stay exact.)

### 1.1 Why the restore audit lives on the backup's own row

There is no `database_restore_runs` table, and there should not be. **A
restore is always defined in terms of exactly one backup:** there is no
restore without an archive, no archive is restored twice concurrently, and
every question anyone asks about a restore — which dump was this, how big was
it, what schema was it on — is answered by the backup's own columns. A
separate table would buy a join on a strict 1:1 relationship and would let the
two rows disagree about which archive was replayed.

The cost is honest: a backup restored twice (a restore that failed, then was
retried) overwrites the first attempt's audit fields. That is the right trade —
the interesting record is the state of the *last* restore, and the full
history of attempts is in `audit_events`.

`pre_restore_backup_id` is a **self-FK**: before a restore swaps a database
away, #285 takes a `pre_restore` backup, and this column points the restore at
the safety net it took. `onDelete: SetNull`, so pruning that safety backup by
retention never deletes the restore record that referenced it.

## 2. The single-active-run guard is in the database

```sql
CREATE UNIQUE INDEX "database_backup_runs_active_uniq_idx"
  ON "database_backup_runs" ((true)) WHERE "status" IN ('pending','running');
```

`DatabaseBackupRunnerService.startBackup` **inserts optimistically** and turns
the loser's Prisma `P2002` into a typed `DatabaseBackupAlreadyRunningError`
carrying the winner's run id, which #283 will render as a 409. There is
deliberately no `findFirst({ where: { status: 'running' } })` anywhere in that
path.

**Rejected: a pre-flight check.** It is check-then-act, and it is racy exactly
when it matters — a scheduled tick on replica A and an administrator's click
on replica B, in the same second. Both would see no active run, both would
insert, and two `pg_dump` processes would stream into two objects while the
settings say one backup a night. Only the database can make "is one already
active" atomic with the insert that would violate it. This is the same
argument, and the same shape, as `jobs_active_dedup_uniq_idx`.

**Prisma cannot express this index.** The schema language has no syntax for a
partial index *or* an expression index, so it exists only in the migration,
written by hand, and `prisma migrate dev`/`diff` will want to drop it on the
next diff. That drift is intentional and permanent; both the migration and the
`DatabaseBackupRun` model carry the warning. `db-backup-active-index.db.spec.ts`
proves against a real Postgres that it is applied and that it arbitrates.

**What it admits, precisely — and the tightening that happened (issue #351,
epic #345).** The ORIGINAL index (`20260907120000_add_database_backup_runs`)
keyed on the `status` COLUMN, filtered to two values. That permits at most one
`pending` row *and*, independently, at most one `running` row *at the same
time* — two active runs, not one — because a `pending` row and a `running` row
carry different key values and so never collide with each other. That ceiling
was harmless only as long as the runner claimed directly as `running` and
never wrote `pending`.

#351 removed that precondition: the backup became a queue job
(`db.backup.run`), and `POST /api/admin/db-backup/runs` now enqueues the job
and creates the run row as `pending` *before* any worker has claimed it — the
row has to exist at enqueue time so the endpoint can return a run id and `GET
/runs/{id}` keeps working, and `pending` is more honest than the old behaviour
of reporting `running` before anything was. The moment `pending` rows became
real, the column-keyed index stopped meaning "at most one active run" and
started meaning "at most two".

`prisma/migrations/20260907140000_add_backup_run_job_link/migration.sql`
(landed alongside the `database_backup_runs.job_id` FK described in §1) drops
and recreates the index keyed on the constant expression `(true)` instead of
`status`, still filtered to the same two statuses. Every row matching the
predicate — `pending` or `running`, it no longer matters which — now indexes
to the identical key, so Postgres enforces "at most one active row, full
stop" across both statuses combined. This is exactly the tightening this
section always said a future path needing both states populated at once would
require: "tighten this index to a constant expression — never relax the guard
into application code." A `completed`, `failed` or `stale` row still never
matches the predicate and is never constrained by this index.

## 3. Indexes

`[created_at DESC]` and `[started_at DESC]` are the admin list's two orderings
("when was it requested" and "when did it actually run" are different
questions for anything that waited). `[status]` backs the stale sweep and the
active-run lookup. `[status, created_at DESC]` is the retention query — the
completed runs, newest first, keep N — which neither single-column index
answers without a sort.

## 4. The claim is awaited; the dump is detached

`startBackup` awaits the INSERT and returns a real run, then lets the dump
continue in the background. It has to: a multi-gigabyte dump takes tens of
minutes and every reverse proxy between a browser and this process has a
response timeout measured in seconds. A synchronous `POST /backups` would 504
on exactly the databases worth backing up, the operator would retry, and the
retry would be refused by the index while the first dump — now unwatched —
carried on.

**The detached promise carries a terminal `.catch()`.** Without one, an
*expected* failure becomes an unhandled promise rejection, and an unhandled
rejection terminates the Node process by default. A failed backup must not be
able to take the API down with it.

The client/server version check runs inside that detached body, **before a
single byte is dumped**. `pg_dump` refuses to dump a server newer than itself;
checked first, that becomes a run whose `lastError` says "rebuild the image
with `postgresql<N>-client`" and points at
`docs/runbooks/postgres-client-version.md`. Checked never, it becomes an
opaque non-zero exit after a partial object has already been written. It runs
after the claim rather than before it so that a blocked deployment gets a
**visible failed run** in the admin list every night instead of an exception
swallowed by a cron with no row to point at. An *unreadable* version pair
warns and proceeds — see `pg-version.util.ts` for why that asymmetry is
deliberate.

## 5. The streaming contract

```ts
const hash = createHash('sha256');
let bytes = 0n;
const meter = new Transform({
  transform(c, _e, cb) { hash.update(c); bytes += BigInt(c.length); cb(null, c); },
});

dump.done.catch(err => meter.destroy(err));   // a dead dump must tear the upload down
dump.stdout.pipe(meter);
await Promise.all([provider.upload(key, meter, opts), dump.done]);
```

The archive is **never materialised**. There is no buffer, no temp file and no
second read: the checksum and the byte count are produced by the same single
pass the upload is already making. Buffering "just to hash it first" would put
an entire production database in the API process's heap.

**`Promise.all` on both halves is load-bearing, not belt-and-braces.** The two
failure modes are independent and each is invisible to the other side:

- A dump that dies mid-stream simply **ends** its stdout. The upload sees a
  clean EOF and reports a perfectly successful upload of a **truncated
  archive**. Only `dump.done`'s exit code distinguishes that from a complete
  dump — which is why `pg-dump.util.ts` calls it "the authority on success".
- A dump can exit non-zero **after** its last byte landed (a failure during
  cleanup), and an upload can fail after the dump finished cleanly.

Two cross-teardowns close the remaining leaks. A dead dump destroys the
metering stream, or the provider waits forever on bytes that will never come;
a dead upload SIGKILLs the dump, or `pg_dump` keeps reading a whole database
for an archive nobody is storing. Both streams also carry no-op `error`
listeners, because a Node stream that emits `error` with nothing listening
throws it as an **uncaught exception** — and both are destroyed on purpose in
these paths.

## 6. Verification reads the stored object back

Before a run is `completed`, the **uploaded object** is streamed out of
storage and through `pg_restore --list`; an empty table of contents fails the
run and the object is deleted.

The backup-time hash proves the bytes we *sent*. This proves the bytes that
*arrived* are a readable archive — which catches a truncated upload, a
zero-byte object, and a dump that ran against the wrong (empty) database, none
of which any exit code or byte count can see. `pg_restore --list` opens no
database connection at all, which is what makes it usable here.

The cost is one extra read of the object, and it buys the property that makes
the whole feature worth having: a run marked `completed` is a run whose
archive has been proven restorable-shaped at least once.

## 7. The heartbeat

Every ~20 seconds, one indexed UPDATE writes `last_heartbeat_at` and the live
`bytes_written`. It is the liveness signal this table has **instead of** a job
lease, and it doubles as the progress an operator watches move.

Twenty seconds is bounded on both sides by things that already exist:
`runStaleMinutes` can be set as low as 1, so the interval must sit comfortably
inside the smallest stale window; and each beat is one UPDATE by primary key,
so a tighter interval would be affordable but pointless for a number a human
reads. It is a **constant, not an environment variable** — no operator setting
would be a better answer than "well inside the smallest stale window", and a
knob whose only wrong settings are silent is a knob worth not having.

A heartbeat write that fails is **swallowed**. A connection recycled, a brief
failover, a lock wait — none of those is evidence that a dump streaming
perfectly well should be abandoned, and aborting a two-hour backup over one
progress UPDATE would be a self-inflicted outage. A *sustained* failure is not
silent either: the heartbeat stops advancing, which is precisely what #282's
stale sweep looks for. The timer is cleared in a `finally`, on every path: a
heartbeat outliving its run would keep writing to a settled row forever, which
is the exact signal that sweep trusts.

## 8. Failure ordering, and cancellation

On failure the partial object is deleted **first**, then the row is marked
`failed`. In that order, always: the row is the only index of what exists in
the bucket, so a run marked `failed` while its object is still there is an
orphan nothing will ever look for, billed forever. Deleting first means the
worst case is the opposite — an object already gone while the row still says
`running` — which the stale sweep resolves.

The delete is best-effort and **never masks the original error**. Why the
backup failed is what the operator needs; "and the cleanup also failed" is a
log line.

**There is no automatic retry.** The next scheduled run is the retry.

`cancel(runId)` works through a **process-local abort map**: only the process
that spawned the child can signal it. It kills the child and destroys the
metering stream, which tears the upload down, which fails the `Promise.all`,
which reaches the **ordinary** failure path — same delete, same mark, same
heartbeat cleanup. Cancellation is deliberately not a second teardown
mechanism; a bespoke "cancelled" cleanup would be a second chance to leave a
half-written object in the bucket.

When this process holds no handle — the run belongs to another replica, or it
already settled — `cancel` returns `{ outcome: 'not_running_here' }` rather
than pretending. Reporting success there would tell an operator their dump had
stopped while it is still streaming.

## 9. The storage destination

The runner injects `STORAGE_PROVIDER` directly and reads `getBucket()`. It
imports `StorageProvidersModule`, **not** `StorageModule` — the same choice
`JobsModule` and `NodesModule` made, and for the same reason plus one of its
own: routing a backup through `ObjectsService` would give every archive a
user-facing `storage_objects` row an administrator could delete by hand,
outside the retention policy that is supposed to own its lifetime.

**The server chooses the key.** No caller supplies any part of it:

```
database-backups/<slug>/<YYYY>/<MM>/<slug>-<YYYYMMDDTHHMMSSZ>-<runId>.dump
```

`database-backups/` is a fixed, descriptive prefix — what these objects are,
not whose — and it is what a bucket lifecycle rule or an IAM policy targets.
`<slug>` is `APP_NAME` slugified, because **nothing in this repository may
hard-code an application, product or repository name** and because two
applications built from this template must be able to share one bucket without
colliding (the same argument `jobs/job-temp.ts` makes for its temp-file
prefix). `<YYYY>/<MM>` keeps the prefix listable by month, which the retention
sweep pays for otherwise. The compact UTC timestamp sorts lexicographically in
time order. The run id makes the key collision-free rather than merely
unlikely.

`databaseBackup.storageProvider` must be **empty (meaning "whatever is
active") or exactly the active provider's id**; anything else is a 400. This
template binds one provider, so the field cannot select anything today — but
it is the field a fork that grows a second provider will use, and today it is
what catches an operator who set it to `gcs` and believed their backups were
going to Google Cloud Storage. The rule lives in one helper called from **both**
sides: #283's config write (so a wrong value is rejected as it is typed) and
the runner itself (so a wrong value that predates the check cannot quietly
redirect tonight's backup).

Multi-provider backup destinations are **out of scope**. A fork that wants one
adds a provider registry and reads this field to select from it; nothing here
has to change shape for that, which is why the column exists now.

## 10. Scheduling

A single `@Cron` provider, `DatabaseBackupScheduleTask`, ticking **every ten
minutes**. Each tick does three things, in this order:

1. **Queue the housekeeping sweep** — `db.backup.sweep`, which releases stale
   runs (§12) and then prunes by retention (§11).
2. **Fire a due backup**, if one is due — which is itself an enqueue of
   `db.backup.run` (§4).
3. **Queue the retained-database drop** — `db.restore.old-db-drop`, for a
   `<live>_old_<ts>` database a restore displaced.

⚠ **Only duty 2 still decides anything in this tick.** #353 (epic #345) moved
duties 1 and 3 out of the cron body and onto handlers — see
`docs/specs/job-queue.md` §7.10 for the rule and its exemptions. The tick now
reads the policy, evaluates the boundary, and queues; it deletes nothing, drops
nothing and reports nothing.

The order still matters, and one property of it genuinely weakened. The sweep
is what frees the single-active-run slot, so it is queued first and a worker may
well have released the slot by the time the fire runs — but that is no longer
guaranteed *within the tick*, and a tick that finds a zombie may still log
"already running" and stand down. **The backup is delayed, never lost, and by at
most ten minutes**: the anti-double-fire rule (§10.2) is stateless and
recomputed from the boundary every tick, which is the same property that
recovers a window missed by a process that was down. Duty 3 goes last because
nothing waits on it, exactly as it did when it ran inline.

### 10.1 Why a ten-minute poll rather than the operator's own cron

A backup scheduled for 02:00 starts somewhere in `[02:00, 02:10)`. Registering
a timer on the operator's expression instead would be exact, and would have to
be re-registered every time an administrator edited the schedule — and a
missed tick (a deploy at 01:59, a restart, a paused container) would skip the
night with nothing left behind to notice it. A coarse poll plus the boundary
rule below **recovers** a missed window instead of losing it, which is the
property that matters for something that runs once a day.

### 10.2 The anti-double-fire rule

```
boundary = previousFireBoundary(expr, now, timezone)
latest   = the run with the greatest started_at
fire only if latest.started_at < boundary
```

The question is *"has a run already started since the moment this schedule last
came due?"*, and the answer is computed from the settings and the table and
from nothing else. That buys three properties at once:

- **Exactly one run per boundary.** Six ticks fall inside a one-hour window;
  five of them find a run at or after the boundary and stand down.
- **A late tick still fires.** Down from 01:55 to 02:40, the 02:40 tick
  computes the same 02:00 boundary, sees no run since it, and takes the backup
  forty minutes late instead of not at all.
- **Restarts are free.** There is no in-memory "last fired" to lose and no
  column to keep current, so a fresh process reaches the same verdict as the
  one it replaced.

**Every trigger counts.** A `manual` backup taken at 02:05 satisfies the 02:00
boundary and the scheduler stands down. The schedule's promise is *"a backup
exists for this window"*, not *"a backup with the `scheduled` label exists"*,
and taking a second full dump of the same database five minutes after an
administrator took one is pure I/O for no additional safety.

### 10.3 The timezone is passed explicitly

`previousFireBoundary(expr, now, policy.timezone)` — never a two-argument call.
Omitting the zone evaluates the operator's "02:00" in the **server's** zone,
which in a container is UTC and is not what an operator in Denver typed. The
symptom would be a backup running at the wrong hour with nothing reporting a
problem.

A zone this runtime does not know throws `InvalidTimezoneError` — #280 made it
a throw rather than a `null` precisely so this layer can tell it apart from
"nothing due" — and the scheduler **stands down**. Firing in UTC instead would
put a nightly dump in the middle of the working day, and because the boundary
would then be wrong the "already fired" check would be wrong with it.

**It logs once.** Standing down happens on every tick — 144 a day — and the
zone is evaluated *before* the due check, so an unlatched log would bury its
own diagnosis under 144 identical copies daily. The latch is keyed on the
offending value, so correcting the setting (or breaking it differently) logs
again, and a zone that starts working clears the latch so a later regression is
loud.

### 10.4 DST is handled by the boundary, not by the scheduler

The scheduler contains no timezone arithmetic of its own; §10.2 is correct
across transitions because `previousFireBoundary` walks civil days in the
configured zone (see `schedule.util.ts`). In practice, for a 02:00 daily
schedule in `America/New_York`:

| Transition | What happens |
|---|---|
| **Spring forward** — 02:00 does not exist | The boundary is the instant the clock jumped to (03:00 EDT). The backup runs an hour late rather than the night being silently skipped |
| **Fall back** — 01:30 happens twice | The boundary is the **first** pass. The second pass finds a run that already covers it and stands down, so an ambiguous time does not mean two full dumps an hour apart |

### 10.5 `databaseBackup.enabled` gates only the firing

The sweep runs whatever the setting says. A run orphaned *before* an
administrator switched scheduled backups off still holds the single active
slot, and leaving it there would make every later **manual** backup fail with
"already running" for a schedule nobody is using. The setting is a statement
about taking backups automatically, not about cleaning up after ones that were
already taken.

### 10.6 `DB_BACKUP_SCHEDULE_ENABLED`, and never the worker mode

The single most important line in the task is the one that is **not** there:
there is no `if (workerMode === 'off') return`. This tick itself is not queue
work — it decides a backup is due and **enqueues** `db.backup.run` (see "Why
this *is* a queue job, and what had to change first"); a worker takes the
dump. `JOBS_WORKER_MODE=off` says "this process executes no queued jobs" — it
does not say "this deployment's database does not need backing up". A pure
control plane in front of an external node fleet is still the only process
with a database connection at all, so gating the schedule on its willingness
to run jobs would mean that deployment silently never even *queues* a backup.
The honest cost of that split is stated in the task's own header: with
`JOBS_WORKER_MODE=off` this tick still queues backups that nothing executes —
only `system` and `all` modes claim `db.backup.run`.

So the only switch is `DB_BACKUP_SCHEDULE_ENABLED`, bare and unprefixed like
`JOBS_REAPER_ENABLED` and `NODE_STALE_OFFLINE_ENABLED`, defaulting to on, with
only the literal `false` turning it off. It exists for the one legitimate case:
several API replicas sharing one database where an operator wants exactly one
of them scheduling. Running it everywhere is safe anyway — the active index
makes the second claim a no-op and the sweep re-asserts its own predicate — the
switch just saves the duplicated queries.

Fail-open is the only defensible direction here, and more sharply than for the
other two crons: a deployment whose backups silently stopped because of a typo
in an env file is **indistinguishable** from one that is being backed up, right
up until somebody needs a restore.

## 11. Retention: two clocks

`DatabaseBackupRetentionService` prunes by two different rules, over two
different populations.

| Population | Rule | Setting |
|---|---|---|
| `completed` runs whose trigger is **not** `pre_restore` | Keep the newest N; delete the rest, **oldest first** | `databaseBackup.retentionCount` |
| `completed` runs whose trigger **is** `pre_restore` | Delete once older than the bound | `databaseBackup.oldDatabaseRetentionHours` |

**Why count for ordinary runs.** A count is what an operator actually reasons
about ("I want a week of nightlies"), and it is the only rule that survives a
schedule change: switch `frequency` from daily to weekly under an age rule and
the same number of days now keeps one backup instead of seven.

**Why age for `pre_restore` runs, and why they are invisible to the count
rule.** #285 takes a `pre_restore` backup immediately before it swaps a
restored database into place, and under
`restoreRollbackMode: 'drop_database'` — where the displaced database is not
kept — **that dump is the only way back** from a restore that has just
happened. A count rule knows nothing about that: with `retentionCount: 7` on a
deployment that took seven nightlies after a restore, it would evict the
rollback silently, on an ordinary Tuesday, and the operator would find out at
the exact moment they needed it.

So `pre_restore` runs are excluded from the count rule in **both** directions:
they are not deleted by it, and they do not consume one of its N slots either.
A retention count of 7 means seven *nightly* backups, not six plus whatever a
restore left behind. (A rule that merely refused to delete them would still
have counted them — that is the failure the "does not consume one of the N
slots" test exists to catch.)

Their bound is `oldDatabaseRetentionHours`, **reused deliberately**: that is
already the setting answering "how long does the way back from a restore stay
available", because under `retain_database` it is how long the displaced
database survives before being dropped. The `pre_restore` dump is the same
promise expressed in the other rollback mode, so the two must expire together —
an operator who sets "keep the rollback for 48 hours" means 48 hours whichever
mode they are in.

**Oldest-first deletion.** The candidate query has to return newest-first —
that is what makes `skip: retentionCount` mean "the keepers" — so the loop
reverses it. Deleting in query order would eat the archive from the recent end
whenever a prune broke half way through; oldest-first means an interrupted
prune still leaves the newest N-ish intact, which is the property retention
exists to provide.

**`failed` and `stale` rows are never pruned here.** Their objects are already
gone (the runner deletes a partial object before marking a run failed; the
sweep deletes a stale one), so there is no storage to reclaim — and the row is
the only record that a backup did *not* happen that night. Deleting it under a
rule whose job is "keep N good backups" would erase precisely what an operator
needs to notice that the good backups stopped. Ageing out failure history is a
different rule (the shape `jobs.history.retentionDays` already has) and belongs
beside this one rather than inside it.

### 11.1 Deletion is object first, then row

Always, and the opposite order looks equally reasonable until its failure is
named:

- **Row first, then object.** A crash or a refused delete between the two
  leaves a multi-gigabyte object with nothing anywhere pointing at it. Nothing
  will ever try again, because the only index of what exists in the bucket is
  the table this just deleted from. Billed forever, and invisible.
- **Object first, then row.** The same crash leaves a *row* whose object is
  already gone: visible in the admin list, costing nothing, and deleted by the
  next prune — re-deleting an absent key is a no-op on every provider this
  interface targets.

One failure is permanent and silent, the other transient and loud. So a failed
object delete **keeps the row**; giving up on it would convert the second
failure into the first.

### 11.2 Pruning is queued only after a successful backup, and never throws

Since #353 the runner does not prune — it **enqueues `db.backup.sweep`**, whose
handler prunes on a worker slot. Every ordering constraint below survives the
move unchanged (a job cannot be claimed before the write it was enqueued after
has committed), and the enqueue sits in exactly the position the call used to:

- **After verification**, because retention deletes older archives and this one
  is only a replacement for them once `pg_restore --list` has proven it
  readable. Pruning first would let a run that is about to fail verification
  delete the last known-good backup on its way out.
- **After the `completed` write**, not before it. The count rule keeps the
  newest N `completed` runs, so a prune that ran while this row still said
  `running` would not count it and would evict one *more* old backup than
  retention asked for — a deployment set to keep 7 drifting to 6.
- **Only on success.** There is no prune in the failure path. A failed backup
  is exactly when the old archives matter most.

The fourth constraint used to be defended by a nested `try`: the call sat inside
the `try` whose `catch` deletes the object and marks the run failed, so an
exception escaping retention would have deleted the archive the run had just
proven good. That is now **structural** — the prune happens in a different job,
on a different worker slot, after this job has settled, and no code path
connects it to the backup's failure handler. The `try` stays anyway, because the
*enqueue* is still a database write inside that same `try`. A missed prune costs
storage; a thrown one would cost the backup.

## 12. The staleness sweep

A backup whose executing process disappears leaves a `running` row with a
stopped heartbeat, and that row holds the single active slot forever. The sweep
is what resolves it.

Candidates are `running` rows matching either arm:

1. `last_heartbeat_at < now - runStaleMinutes` — it was beating and stopped.
2. `last_heartbeat_at IS NULL AND started_at < now - runStaleMinutes` — **the
   zombie that never beat**, a process that died between the claim and its
   first progress write. `NULL < cutoff` is `NULL` in SQL and never true, so
   arm 1 cannot see it and without arm 2 the row holds the slot forever. Same
   two-armed defence the queue's lease reaper and the fleet sweep use.

`pending` is deliberately not swept: the runner never writes it (the claim and
the start are one act), so there is nothing to sweep today. A future path that
*does* insert a `pending` row must extend this predicate, or that row holds the
slot with no heartbeat that could ever age it out.

### 12.1 The transition is a conditional `updateMany`, and the row is the guard

```sql
UPDATE ... SET status = 'stale' WHERE id = $1 AND status = 'running'
```

The read and the write are not atomic, and the interesting case is the run that
**finished in between** — a dump whose heartbeat was starved by a lock wait and
that then completed normally two seconds later. `count === 0` means exactly
that, and it must not be stomped: overwriting a `completed` row with `stale`
would discard a verified backup's record *and* the object cleanup below would
then delete the archive it points at.

Because the `where` re-asserts everything it cares about, the statement is also
idempotent across replicas: two API processes sweeping at the same moment
produce one winner and one no-op. There is no advisory lock and no leader
election, for the same reason `JobStuckResetTask` records.

### 12.2 The row transitions first; object cleanup follows

If the delete went first and the process died before the row was transitioned,
the row would still say `running`, still hold the active slot, and still point
at an object that no longer exists. With the row first, a failed delete leaves
a **visible** `stale` row naming an orphaned object an operator can find —
rather than an invisible, billable one nothing points at. The cleanup is
best-effort and never fails the sweep: the slot is already free, which is the
part that had to happen.

### 12.3 `stale` is terminal, and nothing re-queues it

`stale` is distinct from `failed` on purpose: nothing *observed* these runs
fail. The process holding them disappeared, and an operator reading the list
needs to tell "the dump errored" from "the container went away mid-dump".

Nothing restarts one automatically. Re-running a multi-gigabyte dump that just
OOM-killed its own process burns hours of I/O on a database that is probably
already unwell, unattended, at whatever hour the first attempt died. **The
retry for a backup is the next scheduled run** — the same answer `db.backup.run`'s
own `maxAttempts: 1` gives on the job side (see "Why this *is* a queue job, and
what had to change first", above).

## 13. The admin API

Eight routes, one controller (`db-backup.controller.ts`), one service
(`db-backup-admin.service.ts`), mounted at `admin/db-backup`. Two more routes
live on that same controller and are **not** described here — `runs/{id}/restore`
and `runs/{id}/rollback`, which replace the production database and are
documented in full in `docs/specs/database-restore.md` §9. The controller
does nothing but bind, document and authorize; every decision about what a
request *means* lives in the service, and every decision about what a backup
*is* stays in the runner (§4–§9) and the scheduler/retention/sweep (§10–§12).
Deliberately, this layer reimplements none of those: `POST runs` calls
`DatabaseBackupRunnerService.startBackup` and nothing else, `nextRunAt` is the
same `nextFireAt` the scheduler projects with, and `PUT config` writes through
`SystemSettingsService.patchSettings` — a second copy of any of the three
would give the API and the engine two opinions about one question.

### 13.1 Two permissions, split on read versus write — and a third withheld

`db_backup:read` gates the config read, the run list, the single-run get and
the download; `db_backup:write` gates the config write, the manual trigger,
cancel and delete. Both are additionally gated on the Admin role, matching
`job-admin.controller.ts` and `nodes-admin.controller.ts`: the role admits,
the permission is what the guard checks.

`db_backup:restore` gates **none of the eight routes above**, and that is
deliberate rather than an oversight. It belongs to Phase 7's restore pair
(#286), which renames the live database and restarts the process. It is kept
separate from `db_backup:write` precisely so it *can* be withheld: an
administrator trusted to schedule and take backups is not automatically
trusted to overwrite the running database with one. Folding restore under
`write` would spend the one permission whose entire purpose is to be granted
on its own — and would do so invisibly, since every existing holder of
`db_backup:write` would acquire it. See `docs/specs/database-restore.md` §9.1,
which drives both restore routes as a caller holding only `db_backup:write`
and expects `403`.

The download sits on the *read* side despite being the most powerful thing on
the controller — the URL it returns is a credential-free capability over a
complete copy of the database. It is still a read (it changes nothing), and
`db_backup:read` is seeded Admin-only, which is what makes that acceptable.

### 13.2 `nextRunAt` is computed, and never written

`GET config` publishes a `nextRunAt` that is not a column and is not derived
from one — it is `nextFireAt` (§10, `schedule.util.ts`) run fresh on every
read, the same pure function the scheduler itself uses to decide what is due.
The reason is the same one that motivates most of this document: a bad
schedule should fail at the moment someone can still do something about it,
not in a cron tick nobody is watching. Publishing the actual next-fire instant
lets an administrator confirm a schedule means what they think it means
immediately, instead of waiting a day (or a month, for a monthly schedule) to
find out it fires at the wrong hour.

It is a bounded day-by-day walk over **civil dates** in the configured zone,
converting each candidate to UTC independently — the same reason §10.4 gives
for why the scheduler itself contains no timezone arithmetic: "the same local
time tomorrow" is not a fixed number of milliseconds across a DST boundary, it
is 23 or 25 hours, and a projection that added `86_400_000`ms would drift by
an hour twice a year and stay drifted.

It is `null` in two different situations, and a client should say "not
scheduled" for both rather than guessing which: `enabled` is `false`, or the
stored `timezone` is one this runtime cannot resolve. The second case is the
one worth dwelling on. `PUT config` refuses an unresolvable timezone at write
time (§13.4), so a stored value that fails to project can only predate that
check — a seed, a restored settings blob, a hand-edited row. A naive read path
would 500 on it, and the 500 would land on exactly the screen an administrator
needs in order to *fix* the timezone. So the read path degrades: a projection
failure becomes `null` plus a logged warning, never an exception, precisely so
the repair tool stays reachable. The write path keeps the throw — see §13.4 —
because refusing a bad value at save time is what makes the read path's
graceful `null` a rare case instead of the common one.

### 13.3 `PUT config` delegates to `SystemSettingsService.patchSettings`

There is exactly one writer of the `system_settings` row in this application,
and this route is not a second one. `patchSettings` owns the merge, the
unknown-key preservation, and the row's version counter; a Prisma update
issued from here instead would be a second writer racing that owner over the
same JSONB column, with no way for either to know about the other's unmodeled
keys. `MaintenanceModeService.setMaintenance` makes the identical argument for
the identical reason.

The response is not assembled from the patch that was just applied — it is
produced by calling `getConfig()` again, a **re-read**. `patchSettings` merges
and may normalise, so the stored row is the thing every other reader will see;
publishing this service's own idea of the merge would be a second projection
of the same question. Going back through `getConfig` also means the write's
response and a subsequent read's response are the *same* object by
construction, so a client can apply one to state it holds for the other
without wondering whether the two agree.

### 13.4 The timezone check ignores `enabled`, on purpose

`updateConfig` validates the timezone by *performing* the real projection —
`nextFireAt` against the patched policy — and discarding the result; it is
called for the throw. Validating through the real seam rather than against a
hand-kept list of IANA names means the runtime's own timezone data is the
authority on what it can schedule against, and a timezone that saves is by
construction a timezone that schedules.

The check runs **whether or not `enabled` is true**, and this is not the
obvious choice — `computeNextRunAt` (the read path, §13.2) short-circuits to
`null` for a disabled schedule, and an implementation that reused that
short-circuit for validation would only ever check a timezone while backups
were already on. That is backwards for the ordinary order of events: an
administrator configures the schedule — hour, frequency, timezone — *before*
switching it on, often on the same screen where they are still deciding
whether to enable it at all. A validator gated on `enabled` would accept a bad
zone during exactly that step, save it cleanly, and the failure would surface
weeks later, the first night someone flips the switch — separated from its
cause by however long that took. This was caught by a test during
implementation, not by inspection (`refuses an unknown timezone EVEN WHILE
BACKUPS ARE DISABLED`, `db-backup-admin.service.spec.ts`), and it is the
reason `updateConfig` calls `nextFireAt` itself rather than routing through
`computeNextRunAt`.

### 13.5 Machine-readable error data lives under `details`, and nowhere else

`common/filters/http-exception.filter.ts` rebuilds every error body from a
**fixed key allowlist** — it reads `message` and `details` off the thrown
payload, *derives* `code` from the status (discarding any the exception
supplied), and adds `statusCode`, `timestamp` and `path` itself. A field
placed at the top level of a thrown payload is therefore silently dropped and
never reaches the client.

This matters most for `POST runs`' `409`, whose entire value to the caller is
the id of the run already in flight: `{ activeRunId }` at the top level
vanishes; `{ details: { activeRunId } }` survives. Every thrown payload in
this controller's service follows the same shape — `message` plus `details`,
nothing else — for that reason.

**This is a live gotcha in this codebase, stated as a rule:** `exception
.getResponse()` returns the payload *before* the filter has touched it, so a
test that asserts against `getResponse()` proves nothing about what actually
reaches the client — it would pass unchanged even if a field were moved to the
top level and silently started being dropped. Assertions have to go through
the real filter. `test/db-backup/db-backup-admin.integration.spec.ts` drives
every route through the real Nest router and the real
`HttpExceptionFilter` rather than calling the service directly, for exactly
this reason.

### 13.6 `sizeBytes`/`bytesWritten` go through one `toRunDto`, always

`bytesWritten` and `sizeBytes` are `BigInt` columns (§1), and `JSON.stringify`
does not coerce a `bigint` — it throws `TypeError: Do not know how to
serialize a BigInt`, at send time, inside the framework's serializer, after
the query ran and the status code was already chosen. A handler that returns
a raw Prisma row from this table is a handler that throws on its way out the
door.

The failure is invisible to an ordinary unit test that object-compares its
result: `expect(run.sizeBytes).toBe(12n)` is true, `toEqual` on the whole row
is true, and nothing in that assertion path ever serialises anything. The
defect shows up only when a real response is turned into bytes — which is why
`toRunDto` (`dto/db-backup-run.dto.ts`) is the one function every path
returning a run goes through (the list, the single get, the manual trigger),
converting both BigInts with `.toString()` — exact at any magnitude, unlike
`Number()`, which starts rounding above 2^53 — and publishing them as decimal
strings rather than JSON numbers. And it is why this spec's own integration
tests `JSON.stringify` a real response carrying genuinely large values instead
of trusting an object comparison: `db-backup-admin.integration.spec.ts`'s
"BigInt columns reach the client as exact decimal strings" suite exists
specifically to catch what a `toEqual`-based test cannot.

### 13.7 Deletion is object-then-row, and best-effort on the object

`DELETE runs/:id` deletes the archive from storage first and the row second —
the same order §11.1 gives for retention, and for the same reason: the row is
the only index of what exists in the bucket, so deleting it first and then
failing the object delete leaves a multi-gigabyte orphan nothing will ever
look for again, billed forever. In this order the worst case is the opposite
and it is harmless — an object already gone while the row remains, visible
and re-prunable.

The object delete is **best-effort**, reported as `objectDeleted`. `false`
means storage had nothing to remove or refused to remove it; the row is
deleted regardless. Failing the whole request over an already-missing object
would strand an administrator with a row they cannot delete for a reason that
is not theirs to fix.

A `pending` or `running` row is **refused** with a 400, not deleted. That row
holds the single-active-run slot and its bytes are still being written;
deleting it would not stop the dump, which would carry on streaming into a key
whose row is now gone — an orphan created *on purpose*, with the active slot
freed so a second dump could start beside the first. The route directs the
caller to cancel first, which settles the run through the ordinary failure
path (§8) and deletes the partial object as a side effect.

### 13.8 `download` returns a signed URL, not a proxied stream

`GET runs/:id/download` returns a short-lived pre-signed URL from
`StorageProvider.getSignedDownloadUrl`, the same method `ObjectsService
.getDownloadUrl` already uses for ordinary user files — this is the same
answer at a larger scale, not a new one. Streaming the archive back through
this process as the response body was rejected on more than taste: the
archive is, by definition, the size of the whole database, and a multi-GB
response would sit inside Nginx buffering, proxy read timeouts and
load-balancer idle limits that are configured for ordinary requests, not a
transfer that can run for hours; it would also occupy an application worker
for the duration, degrading the API for every other caller while one
administrator downloads one backup.

Refused with a `400` unless the run is `completed`: a running run's object is
half-written, and a failed or stale run's partial object was already deleted
by the failure path (§8) — either URL would sign a key that produces a file
that is not a restorable archive, or does not exist at all. The URL expires in
`BACKUP_DOWNLOAD_URL_EXPIRY_SECONDS` (five minutes) because it is a
credential-free capability over a complete copy of the database — the window
in which a leaked link (browser history, a chat message, a proxy log) is still
usable. That expiry is checked when the download *starts*, not throughout the
transfer, so a slow multi-gigabyte fetch that began inside the window
completes however long it takes.

### 13.9 `cancel` reports honestly when it holds no handle

Cancellation works through a **process-local** child-process handle (§8): only
the API replica that spawned the `pg_dump` can signal it. When the replica
serving the request is not that one — the run belongs to another replica, or
it settled in the moment before the request landed — `cancel` returns `{
outcome: 'not_running_here' }` rather than reporting success.

That answer is a **`200`**, not a `409` or a `503`, and deliberately so:
nothing about the request was wrong. The run exists, the caller is permitted
to cancel it, and the server understood and acted on exactly what it could act
on. What is true is that *this process* holds no handle, and the operator's
correct next step is not to retry — retrying would hit the same replica or a
different one with the same absence of a handle — it is to wait for the
staleness sweep (§12) to release the slot once the run's heartbeat stops, or
to reach whichever replica does hold it. A `409` would suggest a conflict to
resolve; a `503` would suggest the server is unwell. Neither is true, so
neither is used — the response's `outcome` and `detail` carry the honest
answer instead of forcing it through a status code that does not fit it.

### 13.10 Route declaration order

Nest matches routes in **declaration order**, not by specificity. Every
literal route (`config`, `runs`) is declared above every parameterised one
(`runs/:id`, `runs/:id/download`, `runs/:id/cancel`), and within the
parameterised block the deepest paths come first, matching the rule
`job-admin.controller.ts` and `nodes-admin.controller.ts` both already state.

Today, transposing any two methods in this file would not actually break
anything — the literals here sit one segment past the prefix (`config`) or one
(`runs`), while every parameterised route is two or three segments
(`runs/:id`, `runs/:id/download`), so nothing currently collides. That is a
property of the *current* route table, not a rule to lean on, and it is
exactly the reasoning that produces the bug the next time somebody adds
`@Get(':id')` at the prefix root, or a `runs/:id/:x` route that would silently
swallow `runs/latest`. The rule that survives is "every literal above every
parameterised route," full stop — not "every literal that would currently
shadow something." `db-backup-admin.integration.spec.ts`'s "literal routes
resolve before the parameterised ones" suite drives `GET config`, `POST runs`
and `GET runs` through the real router and asserts each resolved as its own
handler, so re-ordering these methods fails a test rather than surfacing as a
production incident the day someone adds a colliding route.

## 13.1 Notifying somebody a backup failed

Both give-up paths raise `db_backup.backup_failed` to whoever holds
`db_backup:read`, after the terminal row has committed and outside any
transaction: the runner's own `markFailed` with `outcome: 'failed'`, and the
stale sweep with `outcome: 'stale'`. The two are the same message about the
same missing recovery point and differ only in that field, because an operator
chases them in completely different places — a dump's stderr, versus a host
that disappeared. A completed **restore** raises `db_backup.restore_completed`,
which is `mandatory` and is `await`ed before the swap's `process.exit(0)`; that
ordering is load-bearing and is argued in
[`browser-notifications.md` §10.3](browser-notifications.md#103-the-two-orderings-that-are-easy-to-break).

## 14. Rejected alternatives

**Run the backup as a queue job.** See the section at the top. Two concurrent
`pg_dump` processes writing one key, and no error.

**Buffer the archive and upload it afterwards.** Simpler code, and it makes
`Content-Length` available. It also puts the entire database in the API
process's heap (or on a container filesystem that may not have room), and it
fails on precisely the deployments that need a backup most. Every property in
§5 exists to avoid this.

**Write the dump to a temp file, then upload the file.** Bounded memory, but
unbounded *disk*: the container needs as much free space as the database, the
file survives a SIGKILL (the failure `job-temp.ts`'s janitor exists for), and
the archive is then read twice. It buys nothing the streaming path does not
already have.

**Await only the upload.** The tempting simplification, and the one that
silently stores truncated archives forever — see §5.

**Verify with the checksum alone.** It proves the bytes we sent were hashed
correctly and says nothing about what the bucket holds. A zero-byte object has
a perfectly good checksum of nothing.

**Verify by restoring into a scratch database.** The strongest possible
check, and it is what #285 does deliberately, on demand. As a step in every
nightly backup it would need a second database, the privileges to create one,
and roughly the runtime of the dump again — turning a two-hour backup into a
four-hour one on the deployments least able to afford it.

**A `findFirst` guard instead of the index.** Check-then-act; see §2.

**An in-process mutex instead of the index.** Correct on one replica and
worthless on two, which is the only configuration where the race is likely.

**A separate `database_restore_runs` table.** A join on a strict 1:1
relationship, and two rows that can disagree; see §1.1.

**`DB_BACKUP_HEARTBEAT_MS` as an environment variable.** See §7 — the only
settings a fork could choose are silently wrong ones.

**Cancel by marking the row `cancelled`.** A status the runner would then have
to poll for, on a path whose whole point is that it is streaming. And it could
not stop the child: only the process holding the handle can. The abort map is
honest about that; a status column would not be.

**A `lastRunAt` column (or settings field) stamped after each fire.** The
obvious alternative to §10.2's boundary comparison, and strictly worse in three
ways. It **drifts**: the value written is when the run actually started, so a
fire ten minutes late moves the next comparison ten minutes later and a "daily"
backup walks forward through the day. It **needs a write of its own**, which
can fail after the backup started, producing a second fire on the next tick —
two `pg_dump`s for one night, arbitrated only by the active index. And it
**cannot be recomputed**: if it is ever wrong (a restored settings blob, a
hand-edited row, a clock jump) nothing can repair it, whereas a boundary is
derived fresh from the schedule every ten minutes.

**"Did we fire in the last N minutes?"** It answers a question nobody asked.
Two ticks in one window both see "no run in the last 10 minutes" after a run
that started 11 minutes ago, and a weekly schedule would need N to be a week —
at which point a manual backup on Tuesday suppresses Sunday's scheduled one.

**A `@Cron` registered on the operator's own expression.** Exact, and it has to
be re-registered on every settings edit — and a missed tick skips the night
entirely with nothing left behind to notice it. See §10.1.

**Auto-requeueing a stale run.** Restarting a multi-gigabyte dump that just
OOM-killed its own process, unattended, at whatever hour the first attempt
died, on a database that is probably already unwell. The next scheduled run is
the retry; see §12.3.

**Pruning before verification, or regardless of the outcome.** Before means a
run that is about to fail `pg_restore --list` gets to delete the last
known-good backup on its way out. Regardless means a failed backup deletes an
old one — at exactly the moment old archives matter most. See §11.2.

**Deleting the row before the object.** An orphaned multi-gigabyte object that
nothing points at, billed forever and invisible, versus an orphaned row that is
visible, free and re-prunable. See §11.1 and §12.2.

**Gating the scheduler on `JOBS_WORKER_MODE`.** The scheduling *tick* is not
itself queue work — it decides a backup is due and enqueues `db.backup.run` —
and the deployment that sets `off` — a control plane in front of a worker
fleet — is the one whose API is the only component with a database
connection. Gating it on the willingness to run jobs would mean that
deployment silently never even queues a backup. See §10.6.

**A `preRestoreRetentionHours` settings field.** One number, at the cost of
`systemDatabaseBackupSchema`, the defaults, the PATCH schema, the response DTO,
the admin UI and the settings-parity spec — to express a duration this
deployment has already expressed once, with a real risk that the two end up
meaning different things on the same page. See §11.

**A retention cron of its own.** A second, unsynchronised deleter of archives
running with no new backup to justify what it removes. Retention is a
consequence of a backup succeeding, so it runs where that is known.

**Blocking `POST runs` until the dump finishes.** The synchronous shape a REST
client would expect by default, and unworkable for the same reason a
synchronous handler cannot exist anywhere else in this subsystem: a
multi-gigabyte dump routinely outlives any reverse-proxy timeout, so the
request would 504 on exactly the databases worth backing up, the caller would
retry, and the retry would be refused by the active index while the first
dump — now unwatched by anyone — carried on regardless. See §4 for the
identical argument at the engine layer.

**A top-level `activeRunId` on the `409`.** The obvious way to hand the
caller the id of the run already in flight, and silently stripped by
`HttpExceptionFilter`, which rebuilds every error body from `message` and
`details` only. A caller would see "a backup is already running" with no way
to find out which. See §13.5.

**Row-then-object deletion.** Delete the database row first, then the storage
object. A crash or a refused delete between the two leaves a multi-gigabyte
object that nothing anywhere points at — the row was the only index of what
exists in the bucket, and it is now gone. See §13.7 and §11.1 for the same
argument made twice, once here and once for retention.

**Proxying the archive through the API.** Streaming the object back as the
`download` response body instead of returning a signed URL. It puts a
response the size of the whole database through the application server and
every reverse proxy in front of it — none of them configured for a transfer
that can run for hours — and occupies a worker for its entire duration,
degrading the API for every other caller while one archive downloads. See
§13.8.

**Trusting object-comparison tests for the `BigInt` columns.** `expect(run
.sizeBytes).toBe(12n)` and a `toEqual` on the whole row both pass while the
real endpoint throws `TypeError: Do not know how to serialize a BigInt` on an
actual request — the assertion path never serialises anything, so it proves
nothing about the wire. See §13.6.

## 15. Verification

### 15.1 #281: the model, the guard and the engine

| Claim | Covered by |
|---|---|
| The index is applied, is UNIQUE, and carries the documented predicate | `src/db-backup/db-backup-active-index.db.spec.ts` (real Postgres) |
| Two concurrent active inserts from two independent clients: exactly one succeeds, and the loser's error is `P2002` | `src/db-backup/db-backup-active-index.db.spec.ts` — ten deterministic rounds, not sampling |
| The slot frees as soon as the holder settles; settled runs are unconstrained | `src/db-backup/db-backup-active-index.db.spec.ts` |
| A `P2002` becomes `DatabaseBackupAlreadyRunningError` carrying the active id, and the lookup happens **only after** the insert failed | `src/db-backup/db-backup-runner.service.spec.ts` — asserted on call order, which is what makes "no pre-check" testable |
| An unrelated unique violation stays loud | `src/db-backup/db-backup-runner.service.spec.ts` |
| The provider receives a `Readable`, never a buffer, string or array, and no `contentLength` | `src/db-backup/db-backup-runner.service.spec.ts` |
| The archive is never materialised: in-flight bytes stay under 8 MiB while 64 MiB streams, and process memory (heap **and** external) does not grow by the archive's size | `src/db-backup/db-backup-runner.service.spec.ts` |
| Checksum and byte count are one pass and match an independently computed sha256; the stored object is read exactly once | `src/db-backup/db-backup-runner.service.spec.ts` |
| A dump that dies mid-stream fails the run **even though the upload resolved** | `src/db-backup/db-backup-runner.service.spec.ts` |
| An upload that dies fails the run **even though the dump exited 0**, and the dump is SIGKILLed | `src/db-backup/db-backup-runner.service.spec.ts` |
| A run is not `completed` until the uploaded object passes `pg_restore --list`; an empty TOC fails it and deletes the object | `src/db-backup/db-backup-runner.service.spec.ts` |
| The heartbeat advances `bytes_written` mid-dump without touching `size_bytes`; a write failure does not abort the run; the timer is cleared on both terminal paths | `src/db-backup/db-backup-runner.service.spec.ts` |
| The default timer seam beats on a real interval and stops when cleared | `src/db-backup/db-backup-runner.service.spec.ts` (Jest fake timers) |
| Failure deletes the partial object **before** marking the row failed, and a failed delete does not mask the original error | `src/db-backup/db-backup-runner.service.spec.ts` — asserted on call order |
| A failed run keeps how far it got, and nothing retries | `src/db-backup/db-backup-runner.service.spec.ts` |
| A blocked version pair fails the run before any dump or upload, with the runbook message; an unreadable pair proceeds | `src/db-backup/db-backup-runner.service.spec.ts` |
| Cancel routes through the ordinary failure path; cancelling a run this process does not hold reports `not_running_here` | `src/db-backup/db-backup-runner.service.spec.ts` |
| A `storageProvider` naming a non-active provider is rejected before any row exists; empty means "active"; the same helper serves #283 | `src/db-backup/db-backup-runner.service.spec.ts` and `src/db-backup/db-backup-storage.spec.ts` |
| The key is server-chosen, prefixed, month-partitioned, time-sortable, run-id-unique, UTC, and derives its name component from `APP_NAME` | `src/db-backup/db-backup-storage.spec.ts` |
| The audit trio is recorded on completed **and** failed runs, and an audit read failure never fails a backup | `src/db-backup/db-backup-runner.service.spec.ts` |


### 15.2 #282: scheduling, retention and the sweep

| Claim | Covered by |
|---|---|
| Exactly one run per boundary; a second tick inside the window stands down | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| A **late** tick still fires — a missed window is recovered, not lost | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| A **restart** changes nothing: a fresh task instance over the same table reaches the same verdict | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` — the argument against a `lastRunAt` column, as an assertion |
| A `manual` run covers the window; a row that never started does not | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| The **configured** zone is honoured, not the server's | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` — 03:00 UTC on 15 June is 23:00 on the 14th in New York |
| **DST both directions**: a spring-forward 02:00 that does not exist still runs once; an autumn 01:30 fires on the first pass and not the second | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| An unknown timezone stands the scheduler down, logs **once**, logs again for a different bad value, and clears its latch when the zone works | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| A run whose heartbeat went stale is released and the slot freed; a zombie with a null heartbeat is aged by `started_at` | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| A run that finished in the race is **not stomped** — the `count === 0` path, including that its object is never deleted | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| The sweep transitions the **row first** and cleans the object second; a failed delete still counts the release | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` — asserted on a shared call log |
| `stale` is terminal: nothing re-queues it | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| The sweep runs first, in the same tick as the fire | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| `databaseBackup.enabled: false` stops the firing but **not** the sweep | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| `AlreadyRunning` is logged at **debug**; any other claim failure stays loud | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| `DB_BACKUP_SCHEDULE_ENABLED=false` stops the cron; an unset switch fails open; **the job worker mode does not affect it** | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` — including that the task never reads `jobs.workerMode` |
| The overlap guard skips an overlapping tick and is released even when the tick throws; the handler never rejects | `src/db-backup/tasks/db-backup-schedule.task.spec.ts` |
| Count retention keeps the newest N and deletes **oldest first** | `src/db-backup/db-backup-retention.service.spec.ts` |
| `pre_restore` runs are neither deleted by the count rule **nor counted by it** | `src/db-backup/db-backup-retention.service.spec.ts` |
| Age retention handles `pre_restore` runs on `oldDatabaseRetentionHours`, and never ages out an ordinary run | `src/db-backup/db-backup-retention.service.spec.ts` |
| `failed` and `stale` rows are never pruned | `src/db-backup/db-backup-retention.service.spec.ts` |
| Deletion is **object then row**, and a failed object delete **keeps the row** | `src/db-backup/db-backup-retention.service.spec.ts` — asserted on a shared call log |
| A row delete that failed after its object was removed self-heals on the next prune | `src/db-backup/db-backup-retention.service.spec.ts` |
| Retention never throws, and reports what it managed when one rule fails | `src/db-backup/db-backup-retention.service.spec.ts` |
| Pruning happens **after** verification **and after** the `completed` write, never on a failure, and never turns a verified backup into a failed run | `src/db-backup/db-backup-runner.service.spec.ts` |

### 15.3 #283: the admin API

| Claim | Covered by |
|---|---|
| Literal routes (`config`, `runs`) resolve before parameterised ones (`runs/:id`, ...) through the real router | `test/db-backup/db-backup-admin.integration.spec.ts` |
| A run's `bytesWritten`/`sizeBytes` reach the client as exact decimal strings — asserted on the serialised body, not on an object comparison — for the single get, the list, **and** the manual trigger | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `POST runs` returns promptly with a real run id, then answers a concurrent caller with a `409` carrying `details.activeRunId` | `test/db-backup/db-backup-admin.integration.spec.ts` |
| A `storageProvider` naming a provider this deployment lacks is a clean `400`, both from `POST runs` and from `PUT config` | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `GET config` projects `nextRunAt` when enabled, is `null` when disabled, and reports the run holding the active slot | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `PUT config` accepts a partial body and writes through the settings service; an unknown timezone is refused with a `400` **at save time**, before anything is written; the global validation pipe still enforces the settings schema itself | `test/db-backup/db-backup-admin.integration.spec.ts` |
| The timezone check runs **even while `enabled` is false** — the case a validator gated on `enabled` would miss | `src/db-backup/db-backup-admin.service.spec.ts` — the test that caught the bug during implementation; see §13.4 |
| `GET runs/:id/download` returns a bounded-expiry signed URL for a completed run, and `404`s for a run that does not exist | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `DELETE runs/:id` deletes the object before the row, and reports `objectDeleted: false` (while still deleting the row) for an object that is already gone | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `POST runs/:id/cancel` reports `signalled` when this process holds the handle, reports `not_running_here` honestly when it does not, and `400`s a run that already settled | `test/db-backup/db-backup-admin.integration.spec.ts` |
| `db_backup:read` gates the reads, `db_backup:write` gates the five writes, and **`db_backup:restore` is spent on none of these eight routes** (it gates the restore pair — `docs/specs/database-restore.md` §9.1) | `test/db-backup/db-backup-admin.integration.spec.ts` — the permission-split suite, including the explicit "never spends `db_backup:restore`" assertion |
| An unauthenticated caller is refused on every route | `test/db-backup/db-backup-admin.integration.spec.ts` |

### 15.4 The limits of all three

Be honest about them. Nothing here runs a real `pg_dump` against a real
database — the engine seam stands in for both, so what is proved is that this
service treats a dump's stream and its exit code correctly, not that
`pg_dump`'s argv is right (which `pg-dump.util.spec.ts` asserts separately, at
the layer that owns it). The real-Postgres suite proves the index and nothing
about the engine. And no test asserts an end-to-end restore of a backup this
engine produced; that is #285's to prove, with a real archive.

#282 adds two limits of its own. The scheduler's boundary arithmetic is
exercised through `schedule.util.ts`, which has its own suite and its own
IANA data — so what these tests prove is that the task **asks the right
question with the right zone**, not that the runtime's timezone database is
correct. And neither retention nor the sweep is driven against real Postgres:
the `where` clauses are emulated, so an `orderBy`/`skip` that Prisma would
reject at runtime would pass here. The queries are the ones the declared
indexes exist for (`[status, createdAt DESC]` and `[startedAt DESC]`), which is
the check that would have caught a shape the table cannot answer.

#283's admin-API suite runs against the real Nest router and the real
`HttpExceptionFilter` (§13.5), which is what makes its `409`/`400` assertions
mean something — but it still runs against the same mocked engine seam as
#281 and #282: no test here spawns a real `pg_dump` either, so what these
tests prove is that the HTTP surface reports the engine's state honestly, not
that the engine itself is correct. That question is answered by §15.1 and
§15.2.

## 16. Running the dump on a worker node (#352, epic #345)

`db.backup.run` is **node-eligible**: a worker node can take the dump, so the
bytes go from the database to object storage without transiting the API
server. Everything in §5 and §6 still holds — what changes is *who* runs
`pg_dump`, and nothing else.

### 16.1 Three gates, and the type is offered only when all three agree

Node eligibility is *structural* (the handler carries `nodeResultSchema` +
`persistNodeResult`, and `deriveOutputKey` so the archive lands where the rest
of this subsystem looks for it). Whether a node is ever **offered** the type is
a runtime intersection performed in `NodesService.nodeEligibleTypes`:

| Gate | Question | Default |
| --- | --- | --- |
| `nodes.jobSecretBrokerEnabled` | May the broker issue a credential **at all**? | off |
| `databaseBackup.nodeOffloadEnabled` | May **this workload** leave the server? | off |
| `PgJobRoleBroker.usable()` | *Can* it mint here, right now? | probed, cached ~60s |

The two settings are deliberately **not** one switch. "These machines may hold
a short-lived credential" and "the whole database may be dumped somewhere
other than the API server" are different decisions, and a deployment can
reasonably want the first without the second. The `usable()` gate is capability
rather than policy: without it a node claims the job, asks for its credential,
gets a `503` and defers — burning a claim and a lease cycle **every poll** on a
deployment that simply cannot mint roles (managed PostgreSQL denying
`CREATEROLE` is the ordinary case; see
[`docs/runbooks/node-job-secrets.md`](../runbooks/node-job-secrets.md)).

With any gate closed the type is withheld from the claim and the in-process
worker takes the backup — exactly the behaviour that existed before node
offload, **including under `JOBS_WORKER_MODE=system`**. That last part is not
free, and it is worth knowing why:

`system` mode used to mean "everything `JobHandlerRegistry.serverOnlyTypes()`
says no node can run", which was a *static* property of a handler's members.
Once eligibility acquired runtime gates that stopped being the same question:
`db.backup.run` is structurally node-eligible (so it left `serverOnlyTypes()`
for every deployment, permanently) while all three gates above ship off (so no
node may claim it). Read separately, the two answers left a **hole** —
neither executor claimed the type, and the deployment simply stopped taking
backups. The fix is that `system` mode now reads the **complement of
`NodeOffloadService.offeredTypes()`**, the very set the node plane is offered,
so the two executors partition the queue by construction. See
[`job-queue.md`](job-queue.md) and the service's own header.
`JOBS_SYSTEM_MODE_EXTRA_TYPES` still exists, unchanged, for deliberately
running a type the fleet *is* allowed to run — it is no longer load-bearing
for anything's survival.

### 16.2 The node never chooses where the archive goes

`deriveOutputKey` re-reads the run by `job_id` (a `@unique` column) and returns
the key the row already records. That is what makes it **idempotent**: a node
asks for its upload target again after a timed-out transfer or a restarted
process, and must get the same key, or a retry writes a second archive that no
row points at. The node reports the key back in its result, and
`persistNodeResult` **refuses anything else** — a result naming a different key
is either a confused executor or an attempt to point this deployment's restore
path at bytes of somebody else's choosing, and neither is corrected by
trusting it.

The first `deriveOutputKey` call also moves the run from `pending` to
`running`, because on this path it is the only moment the server learns a
remote executor has begun.

### 16.3 Verification stays on the server, and is not negotiable

`persistNodeResult` downloads the **stored object** and reads its table of
contents before writing anything. The node's `sha256` is recorded as *the
node's claim* about the bytes it streamed; `verified_at` is set only because
this server read the archive back out of the bucket. §6 already settled that
verification means "what the bucket holds", and a node attesting to its own
upload is the machine with the least reason to be trusted vouching for the one
fact this subsystem rests on. The cost is one download per backup — the same
one the server path already pays.

Both executors then write through **one private `completeRun`**, so a run's
stored state cannot depend on which machine produced it.

### 16.4 `bytes` is a decimal string, and that is load-bearing

`bytes_written`/`size_bytes` are `BigInt` because a dump past 2 GiB is
ordinary. JSON has no integers, so a size sent as a JSON **number** is exact
only below 2^53 — the corruption would land on exactly the largest backups,
i.e. the deployments node offload exists for. The result contract
(`apps/api/src/jobs/contracts/db-backup-run.contract.ts`) therefore carries it
as `^\d{1,20}$` and the handler converts once with `BigInt()`, mirroring what
`toRunDto` already does on the way out.

### 16.5 The node holds no credential it can persist

The connection is brokered per job (#349/#350), bounded by the job's own lease,
and revoked when the job settles. On the node it lives in **one local
constant**: it never reaches `node-config.ts`, never reaches the state
directory, and never reaches a log line —
`apps/cli/src/node/executors/db-backup-run.test.ts` asserts all three,
including a static check that the executor imports no config writer at all.

### 16.6 A node-executed run has no heartbeat, so the sweep asks the lease

A node cannot write `last_heartbeat_at`: it has no database access, which is
the whole premise of the node plane. The stale sweep (§12) therefore skips a
candidate whose `jobs` row is still `running` with a live lease — the liveness
signal the executor is already maintaining (#347) — and gives up on it the
moment that lease is gone. Without this, a healthy node-run backup would be
marked `stale` after `runStaleMinutes`, **its archive deleted mid-upload**, and
its result then refused.

REJECTED: a second heartbeat endpoint for nodes to poke the run row. Two
liveness clocks for one fact disagree, and the day one of them fails the other
says everything is fine.

### 16.7 What the node needs, and what `doctor` says about it

`pg_dump` is a **required** capability for the type (`capabilities.ts`), so a
node without it never declares `db.backup.run` — which matters more here than
for any other type, because `maxAttempts: 1` means a failed claim is a backup
that simply did not happen. `psql` is **degradable**: it is used only for two
best-effort provenance reads (`db_version`, `migration_name`), and without it
the backup is taken, uploaded and verified with two `null` columns.

`appctl node doctor` reports both the client version and — with
`--db-host host[:port]` — a TCP probe of the database, **as warnings, never
failures**. A node that cannot reach the database must simply not declare the
type; failing `doctor` would tell every node in a fleet that it is broken
because it is not the one taking backups. There is deliberately no tunnelling:
see [`worker-nodes.md`](worker-nodes.md) — a node needs a real network route,
which for most deployments means sitting inside the same private network.

