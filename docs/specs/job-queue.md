# The Background Job Queue

> Epic #254, Phase 0–1 (#255 the `Job` / `JobStatsRollup` schema and
> `buildDedupKey`, #259 the handler contract, registry, worked example and
> this document, #260 enqueue with index-backed dedup and the atomic
> `SKIP LOCKED` claim, #261 the terminal state machine, #262 the in-process
> worker pool and worker modes, #263 queue hygiene, #264 the admin API,
> #265 insights and ETA).
> Implemented in
> `apps/api/prisma/schema.prisma` (the `Job` and `JobStatsRollup` models),
> `apps/api/src/jobs/job-keys.ts`,
> `apps/api/src/jobs/job-handler.interface.ts`,
> `apps/api/src/jobs/job-handler.registry.ts`,
> `apps/api/src/jobs/job-type-labels.ts`,
> `apps/api/src/jobs/jobs.service.ts`,
> `apps/api/src/jobs/job-claim.service.ts`,
> `apps/api/src/jobs/job-terminal.service.ts`,
> `apps/api/src/jobs/backoff.util.ts`,
> `apps/api/src/jobs/rate-limit.error.ts`,
> `apps/api/src/jobs/provider-throttle.service.ts`,
> `apps/api/src/jobs/job-clock.ts`,
> `apps/api/src/jobs/job.worker.ts`,
> `apps/api/src/jobs/events/job-settled.event.ts`,
> `apps/api/src/jobs/job-stuck.service.ts`,
> `apps/api/src/jobs/job-temp.ts`,
> `apps/api/src/jobs/tasks/`,
> `apps/api/src/jobs/job-admin.service.ts`,
> `apps/api/src/jobs/job-insights.service.ts`,
> `apps/api/src/jobs/job-counts.util.ts`,
> `apps/api/src/jobs/job-admin.controller.ts`,
> `apps/api/src/jobs/dto/`,
> `apps/api/src/jobs/jobs.module.ts` and
> `apps/api/src/jobs/handlers/`.
>
> **On what is merged today.** Sections 1–3 describe what #259 shipped: the
> contract, the registry, the labels map, the example handler and the module.
> Section 4 describes what #260 shipped: enqueue with index-backed dedup, and
> the atomic `SKIP LOCKED` claim. Section 5 describes what #261 shipped: the
> single terminal chokepoint, the two budgets, the backoff, the throttle gate
> and the settled event. Section 6 describes what #262 shipped: the in-process
> worker pool, the three worker modes, and per-job timeouts. Section 7
> describes what #263 shipped: the lease reaper, the nightly history purge
> with its lifetime rollup, and the temp-file janitor. Section 8 describes what
> #264 shipped: the admin API — the stats roll-up, the filtered list, and the
> four repair actions. Section 9 describes what #265 shipped: the insights and
> ETA endpoint, and the lifetime-rollup reset beside it.
>
> **The queue can be reasoned about as of #265.** §8 answers "what is the queue
> doing right now"; §9 answers "how long will this take, and is it getting
> faster or slower" — and it does so *without becoming a writer*, which is the
> single property that makes an analytical endpoint safe to point at a table a
> worker pool is claiming from. See §9.1.
>
> **The queue is operable as of #264.** It is also the first point at which
> this module has an HTTP surface at all: everything through §7 is machinery
> that no request can reach. Every primitive that surface needs was extracted
> downwards before it existed (§7.3), so §8 adds routes and a cache and
> reimplements nothing.
>
> **The queue maintains itself as of #263.** It is also the first point at
> which this repository ships a job type that does real work rather than
> demonstrating the contract: `job.history.purge` (§7.5) is the queue's own
> housekeeping, wired exactly the way a fork wires its own handlers.
>
> **The queue polls as of #262.** #260 and #261 added the three halves of
> moving a row through the table — enqueue, claim, settle — and no timer;
> #262 adds the timer. The lifecycle constraint §1.3 places on the worker is
> now satisfied rather than merely required, and it is verified by
> `src/jobs/job.worker.bootstrap.spec.ts`.
>
> **Epic #345 extends three of the phases above rather than adding new ones.**
> §5.10 (per-type execution profiles, #346), §6.9–6.10 (in-process lease
> renewal and the reaper's fourth signal, #347) and §7.10 (every long-running
> activity is a queue job, #353) are additions to Sections 5–7, made so that a
> database backup — until then explicitly excluded, in
> `docs/specs/database-backup.md`'s former "Why this is not a queue job" — could
> safely become `db.backup.run`. See that document's "Why this *is* a queue
> job, and what had to change first" for the case each addition answers.

## Why this shape, and not the obvious one

Before this epic, a fork of this template that needed background work had
exactly one place to put it: another `@Cron` task next to
`auth/tasks/token-cleanup.task.ts`,
`device-auth/tasks/device-code-cleanup.task.ts` and
`storage/tasks/storage-cleanup.task.ts`. Those three are the honest baseline,
and they are the argument for the queue:

1. **They cannot retry.** A cron that throws has failed until its next tick,
   with no record that it failed, no attempt count, and no backoff.
2. **They cannot be observed.** There is no row anywhere saying a run
   happened, how long it took, or what its error was.
3. **They already assume a single API replica.** There is no leader election
   in this repository, so a second replica runs every cron a second time.
4. **They cannot be moved off the API process.** Anything expensive competes
   with request handling on the same event loop.

The queue is a `jobs` table, claimed atomically with `FOR UPDATE SKIP LOCKED`
by an in-process worker and — later in the epic — by remote worker nodes, so
the *same handler code* runs in either place with no branching. Three
deliberate non-choices shape it:

- **No Redis, no BullMQ.** This template already requires PostgreSQL;
  requiring a second datastore on a template's default path is a real
  adoption cost for every fork, paid whether or not the fork uses the queue.
- **No second process entrypoint by default.** The worker runs in the API
  process. The remote node fleet is optional and additive.
- **No application-specific job type.** The template ships example handlers
  and the extension recipe; a fork brings the real work.

Everything below follows from one requirement: **a fork adds a job type with
one class and no queue wiring** — no migration, no enum, no `switch`, and the
type appears in the admin dashboard on its own.

## 1. The handler contract

`apps/api/src/jobs/job-handler.interface.ts` is the entire public surface of
the queue for a feature author:

```ts
export interface JobHandler {
  readonly type: string;
  process(job: Job): Promise<void>;

  /** Present only on node-eligible handlers. */
  readonly nodeResultSchema?: z.ZodType;
  persistNodeResult?(job: Job, result: unknown): Promise<void>;
}
```

Two required members. That is not minimalism for its own sake — it is the
measure of the promise. Every member added here is a member every future
handler in every fork has to satisfy, and the worker's whole knowledge of a
job type is "look up `type`, call `process`". A contract the worker does not
read is a contract that should not be in this interface.

`Job` is the generated Prisma type. `type` is a plain `String` column on that
table, not an enum, precisely so that adding a handler costs zero migrations —
see the `Job` model's own header comment in `schema.prisma` — and so a row can
outlive the handler that produced it.

### 1.1 `process` throws to fail; it does not return a result

The nearest precedent in this repository is
`storage/processing/object-processor.interface.ts`, whose `process` returns
`Promise<ObjectProcessorResult>` — a `{ success, metadata?, error? }` object.
The job handler contract deliberately does **not** copy that, and the
difference is not stylistic:

| | Object processor | Job handler |
|---|---|---|
| How many run per unit of work | Several, in priority order, over one upload | Exactly one — the handler **is** the job |
| What a failure must not do | Abort the other processors | — |
| Where the outcome goes | Aggregated into the object's metadata | `Job.status`, `Job.attempts`, `Job.lastError` |

A processor needs to report a per-processor outcome because something
aggregates it. A job has nothing to aggregate: it completed or it did not, and
"did not" has to reach the retry machinery.

Throwing is also the *default* behaviour of every async call a handler makes —
a rejected promise, a Prisma error, a fetch timeout. So "throw to fail" means
a handler that writes **no error handling at all** already fails correctly,
and swallowing an error becomes the visible, deliberate act (a `try/catch`
that does not rethrow) rather than the accidental one. A result object gets
this exactly backwards: the handler that forgets to check an inner promise
returns `{ success: true }` for work that never happened, and the queue
records a green job that did nothing.

The thrown error's message is what lands in `Job.lastError` and what a human
reads in the admin job list.

**At-least-once, never exactly-once.** A handler can run twice: a retry after
a partial failure, or a lease that expired because the executing process was
killed mid-run and another worker legitimately reclaimed the row. Handlers
should be idempotent wherever the underlying operation allows it. This is a
property of any lease-based queue, not a defect to be designed away — the
alternative is a job that is never retried after a process dies, which is
strictly worse.

### 1.2 Explicit self-registration, not decorator discovery

`apps/api/src/jobs/job-handler.registry.ts` holds a `Map<string, JobHandler>`
and offers four methods: `register`, `get`, `types`, `serverOnlyTypes`. A
handler puts itself in it, from its own `OnModuleInit`:

```ts
onModuleInit(): void {
  this.registry.register(this);
}
```

**Rejected: `@JobHandler('type')` + `DiscoveryService`.** Nest can enumerate
providers by decorator metadata at boot, which would let a handler register
merely by existing — no lifecycle hook, no injected registry, one less line
per handler. Three reasons it is the wrong trade here:

- **It still needs a registry underneath.** Discovery does not replace the
  map; it replaces the `register` call with a metadata scan and keeps
  everything else. The saving is one line per handler, against a mechanism
  every reader of the codebase now has to know about.
- **It is harder to trace.** "Why is this type running?" has a grep-able
  answer today: one `register(this)` line, in the file that implements the
  type. Under discovery the answer is "a decorator you cannot see from here
  matched a scan at boot" — and a handler that failed to register looks
  identical to one that was never written.
- **It would be a third mechanism for a job this repo already does twice.**
  `NOTIFICATION_CHANNEL_SENDERS` is an explicit factory array
  (`notifications.module.ts`), and the storage object processors are explicit
  `OBJECT_PROCESSOR` providers. `notifications.module.ts` states the same
  objection in its own words — *"a channel added by an import side effect is a
  channel that appears in production without appearing in a diff"* — and it
  applies unchanged to a job type that begins executing work because a file
  was added to a directory.

**Duplicate `type`: warn and overwrite, last registration wins.** Also a
choice, and the two alternatives are both worse:

- *Throw* would turn a duplicate into a boot failure for the whole
  application. But a fork shadowing a framework handler with its own
  implementation of the same type is doing something legitimate — it is how
  you replace framework behaviour without editing framework code — and a
  template should not forbid it.
- *First-one-wins* would make which handler executes depend on
  module-resolution order, the exact invisible coupling explicit registration
  exists to avoid, and it would silently discard the handler the author most
  likely meant to win.

So the last registration wins and the collision is logged at `warn` — visible
either way, whether it was an intended override or two features that
copy-pasted the same `type` string.

### 1.3 The lifecycle constraint this places on the worker

**The worker must start from `onApplicationBootstrap`, not `onModuleInit`.**

This is a direct consequence of §1.2 and is recorded here because the issue
that builds the worker is not the issue that can discover the bug. §6.2 is the
other side of it: `JobWorker` satisfies this, and a test drives the race. Nest runs
every `onModuleInit` hook in one phase, in module-resolution order, and only
then runs every `onApplicationBootstrap` hook. A worker polling from
`onModuleInit` would therefore race the registrations it depends on: whether
`get(type)` finds a handler would come down to which module Nest happened to
initialise first.

And the failure is not a retryable blip. A claimed job whose type has no
registered handler is an *unknown job type* — a **permanent** failure for a
perfectly good job that would have run correctly one second later. Starting at
`onApplicationBootstrap` turns the ordering from luck into a guarantee: every
handler has registered before the first claim query runs.

## 2. Node eligibility is derived, never declared

Later in the epic (Phase 3, #267–#271), a job can be computed on a remote
worker node: the node claims work through a control plane, computes with **no
database access at all**, and posts a result back for the server to validate
and persist. Not every type can work that way — a handler that reads three
tables mid-computation, streams a file out of object storage, or writes as it
goes is server-only by nature.

The system's single source of truth for that distinction is **the presence of
the two optional members**:

| Handler carries | Meaning |
|---|---|
| Both `nodeResultSchema` **and** `persistNodeResult` | Node-eligible |
| Neither | Server-only (the default) |
| Exactly one of the two | **Server-only** |

`JobHandlerRegistry.serverOnlyTypes()` is that derivation, and it is what the
later `system` worker mode (`JOBS_WORKER_MODE=all|system|off`) reads: "claim
only the types a node could never run". There is no second list of
server-only types to maintain, and adding a node-eligible handler does not
require editing anything outside that handler.

**Why exactly one member is server-only rather than a half-eligible case.** A
schema with no persist function describes a payload nobody can store; a
persist function with no schema would have to trust an unvalidated body posted
by a remote machine. Neither is a state the node plane can act on safely, so
both collapse to the safe answer. Treating "exactly one" as a *configuration
error* — throwing at registration — was considered and rejected for the same
reason `register` overwrites rather than throws: a half-written handler should
not be able to prevent an application from booting, and the safe interpretation
costs nothing.

**Rejected: a `readonly nodeEligible: boolean` flag.** It is the obvious
design and it is wrong for one specific reason: *a flag can disagree with the
members it describes.* `nodeEligible: true` on a handler with no
`persistNodeResult` is a job dispatched to a remote machine whose result the
server then cannot store — and the failure surfaces at runtime, on a node, in
production, rather than in review. Deriving the answer from the members makes
that state **unrepresentable**: there is nothing to set inconsistently,
because there is nothing to set. This is the same argument
`notification-events.ts` makes when it derives the `NotificationChannel` type
from the channels array rather than declaring both ("so the two cannot
disagree").

### 2.1 `persistNodeResult` does the persist half and nothing else

A hard rule, not a style preference. The split is:

```
node   →  compute the result            (no DB, no app secrets, no tables)
server →  validate against nodeResultSchema, then persistNodeResult writes it
```

`persistNodeResult` must **not** recompute the work, re-download the input,
call the provider again, or "fix up" a result it dislikes. The moment it does
any of those, the node's computation stops being the source of the result: the
server is doing the work twice, the node's answer is decorative, and the
entire reason for the node plane — expensive work off the API server — is
gone. If a result cannot be persisted without redoing the work, the type is
not node-eligible; drop both members and let it run server-side.

The `result: unknown` parameter type is deliberate, and it is the same trade
`notify()`'s `data: unknown` makes: the value arrives from off-machine and is
untrusted by construction, so `nodeResultSchema` is the only thing that may
narrow it. It is a trust boundary, not a convenience.

## 3. Display labels, and why they are not on the interface

`apps/api/src/jobs/job-type-labels.ts` maps a machine `type` to a human
phrase for the admin dashboard, with `jobTypeLabel(type)` falling back to the
raw type string.

**Rejected: a required `readonly label: string` on `JobHandler`.** It would
guarantee every type has a label — and it would enlarge the contract for a
presentation concern the worker never reads. The contract's smallness is what
epic #254 is actually selling; §1 is not worth spending on a display string.

**The fallback is load-bearing, not defensive.** This map is structurally
incomplete at all times: a fork's handlers are types this repository has never
heard of, which is the whole promise. A lookup returning `undefined` would
render a blank dashboard cell for exactly the types a fork cares most about.
Falling back to the type string makes an unlabelled type merely less pretty
(`my-feature.do-the-thing`) rather than invisible, so adding a label stays
optional polish. A second reason: a `jobs` row can name a type no handler
registers any more — rows outlive handlers — and the dashboard still has to
render that historical row.

## 4. Enqueue, dedup, and the atomic claim

`apps/api/src/jobs/jobs.service.ts` writes rows into `jobs`;
`apps/api/src/jobs/job-claim.service.ts` takes them out. They are two
services rather than one because they have different callers — every feature
enqueues, only a worker or the node control plane claims — and different
failure modes.

### 4.1 Enqueue: the database decides dedup, not a prior `SELECT`

`enqueue()` inserts **optimistically** and treats the resulting unique
violation as "a duplicate is already in flight". There is no pre-flight
"is there already an active job with this key?" query anywhere in the enqueue
path, and adding one would be a regression rather than an optimisation:

```
INSERT  →  P2002 on jobs_active_dedup_uniq_idx  →  re-read the ACTIVE row  →  return it
```

**Rejected: `findFirst`-then-`create`.** It is a check-then-act race, and it
is racy *exactly when dedup matters*. Two concurrent enqueues both run the
`findFirst`, both see no active duplicate, and both insert — which is
precisely the outcome a dedup key exists to prevent. Under real load (a
webhook redelivered while the first delivery is still being handled, two
replicas reacting to the same event, a user double-clicking) that window is
not a rare edge case, it is the normal case. Only the database can make "is
there already an active job with this key" atomic with the insert that would
violate it. The `Job` model's own block comment in `schema.prisma` records
the same rejection from the schema side; this is the enqueue-path half of
that argument.

What makes it atomic is `jobs_active_dedup_uniq_idx` — a partial UNIQUE index
on `dedup_key` filtered to `status IN ('pending','running') AND dedup_key IS
NOT NULL`, hand-written in
`prisma/migrations/20260906120000_add_jobs/migration.sql` because Prisma's
`@@index` DSL cannot express a `WHERE` clause. The key's *format* is defined
once, in `buildDedupKey()` (`src/jobs/job-keys.ts`); the index has no opinion
on how the string was built, only that it is unique among still-active jobs.

**The caller cannot tell which happened, and that is the point.** `enqueue`
returns either the row it just inserted or the active row that beat it to the
key, with no flag distinguishing them: the postcondition is "a job for this
work is queued", and that is true either way. One consequence worth stating
plainly, because it looks like a bug the first time it is noticed: when dedup
collapses a call, the returned row's `reason`, `priority`, `payload` and
`scheduledFor` are the **first** caller's. That is the definition of dedup,
not an oversight — the work is already queued, and a second request to do the
same work is not a reason to reconfigure the job that is about to do it (or,
worse, to mutate a row a worker may already have claimed). A caller that
genuinely needs its own row wants `skipDedup: true`.

### 4.2 `skipDedup` is free, because Postgres treats every NULL as distinct

`skipDedup: true` does not disable a code path, take a different branch
through the index, or need a second insert strategy. It leaves `dedup_key`
NULL — and a NULL is never equal to another NULL for uniqueness purposes, so
any number of NULL-keyed rows coexist under the same unique index. There is
no "dedup off" mode, only a key that no other row can collide with. The
index's predicate spells `dedup_key IS NOT NULL` out explicitly so this is
documented as relied upon rather than incidental.

The mirror-image property: because the index is filtered to
`pending`/`running`, a job reaching `succeeded` or `failed` **drops out of the
predicate and frees its key**. Re-triggering the same logical work an hour
later is allowed; only work that is still in flight is collapsed. Dedup never
permanently blocks a job on its own history.

### 4.3 Two failure modes the conflict path has to get right

**A P2002 from any other constraint must propagate.** `isActiveDedupConflict()`
attributes the violation to *this* index specifically — by the constraint
fields, by the index name in the driver's original message, or by `meta.target`
on the classic query engine — and anything it does not positively recognise is
rethrown untouched. Treating every P2002 as "already queued" would make
`enqueue` return some unrelated row for a genuine constraint bug, which is the
exact class of error that must stay loud. Two metadata shapes are inspected
rather than one so that switching adapters degrades to "the P2002 propagates",
never to "an unrelated conflict is silently swallowed".

**The re-read can lose its own race.** Between the INSERT failing and the
SELECT running, the job that held the key can reach `succeeded` or `failed`,
leave the index's predicate, and free the key — leaving no active row to
return. Nothing is wrong; the world moved on between two statements. Three
answers were available:

- *Widen the re-read to any status and return the settled row.* **Rejected.**
  The caller asked for work to be QUEUED, and handing back a job that already
  finished reports success for work that will never run — the worst possible
  answer, and unrecoverable by the caller, which cannot tell that row apart
  from one about to execute.
- *Throw the P2002.* **Rejected.** The condition it describes ("a duplicate is
  in flight") is no longer true by the time it would be reported.
- *Insert again.* **Chosen.** The key is free now, so the retry normally
  succeeds outright; if it collides again, the next iteration's re-read finds
  whichever job took the key.

The retry is **bounded** (three attempts). An unbounded loop would be correct
in theory and a livelock in practice: a pathologically hot key whose jobs
settle within microseconds could spin a request thread indefinitely. Three
covers the real race — which needs a conflicting job to finish inside the few
milliseconds between a failed insert and a re-read — and turns the
pathological case into a visible error rather than a hang.

### 4.4 The claim is one statement

```sql
UPDATE jobs SET
  status = 'running', started_at = now(), scheduled_for = NULL,
  attempts = attempts + 1,
  claimed_by_node_id = $nodeId::uuid, executor = $executor,
  lease_expires_at = now() + ($leaseMs * interval '1 millisecond')
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'pending'
    AND (scheduled_for IS NULL OR scheduled_for <= now())
    AND type = ANY($types::text[])
  ORDER BY priority ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
RETURNING …
```

The inner `SELECT` picks eligible rows and locks them, skipping any row
another transaction already holds; the outer `UPDATE` marks exactly those rows
`running` and hands them back. There is no window between "I chose this row"
and "I own this row" in which a second claimer can choose it too, because
there is no gap between the two — they are the same statement, in the same
implicit transaction.

`ClaimOptions` is `{ nodeId, executor, eligibleTypes, limit, leaseMs }`, and
this method is **shared verbatim** by both claimers in this epic: the
in-process worker (#262) and the node control plane (#268). That is why the
options carry `nodeId` and `executor` rather than the service knowing which
side it is on — a second copy of this query, specialised per caller, is
exactly how the two would drift apart on the one statement that must not
drift.

**Rejected: `SELECT … FOR UPDATE` then a separate `UPDATE`.** Two statements,
two round trips, a wider window in which the claiming process can die between
them, and no gain whatsoever — the second statement re-finds rows the first
already identified. `SKIP LOCKED` plus `RETURNING` collapses both into one.

**Rejected: an advisory lock around the claim.** It works, and it serialises
every claimer in the fleet through a single lock: with N workers, N-1 wait to
run a query that takes microseconds. `SKIP LOCKED` is *the* primitive for
"give me a row nobody else is working on" — it never blocks, it steps over
contended rows.

**Rejected: an in-process mutex** — which is what the source application this
design was extracted from actually started with. It serialises claims WITHIN
one process and is completely blind outside it, so it works perfectly on a
laptop, works perfectly with one replica, and double-claims the moment a
second replica is scheduled or a remote node joins. **This is the bug this
design exists to avoid:** a correctness property that holds right up until the
first time the system is scaled.

**Two short circuits, before any round trip.** An empty `eligibleTypes` or a
`limit <= 0` returns `[]` without querying. Both are ordinary states rather
than misconfigurations — a `system`-mode worker with no server-only handlers
registered has the first, a pool with every slot busy has the second — and the
query would correctly return nothing in both cases (`type = ANY('{}')` matches
nothing, `LIMIT 0` returns nothing). This is purely about not paying for a
database round trip on every poll tick to be told what is already known.

**`ORDER BY` selects *which* rows, not the order they come back in.** The
ordering lives in the inner `SELECT`, where it decides what the claim takes:
most urgent first (`priority` ASC — see the `Job` model comment), oldest first
within a priority. SQL gives `UPDATE … RETURNING` no ordering guarantee at
all, so the returned array is a **set, not a sequence**. Nothing in this epic
needs it sorted — a worker dispatches each claimed job independently — and
"fixing" it would mean wrapping the statement to obtain an outer `ORDER BY`,
trading the single-statement atomicity the whole design rests on for an
ordering nobody wants.

### 4.5 `attempts` is charged at CLAIM time — it means "attempts started"

`attempts = attempts + 1` is in the claim statement, not in any failure path,
and this is a correctness decision rather than a convenience.

A job can take the whole process down with it: an OOM kill, a hard crash, a
container the orchestrator terminates mid-run. **None of those reach a failure
handler** — there is no handler left to reach. So if `attempts` were charged
when a job *fails*, such a job would be requeued with its budget untouched,
claimed again, kill the process again, and crash-loop the container for as
long as anyone let it. The retry budget would be unreachable by exactly the
failures it most needs to bound.

Charging at claim makes the counter mean "attempts **started**", which is the
only thing observable from outside a process that may not survive. It is what
lets the lease reaper (#263) find a job whose lease expired with its budget
spent and mark it permanently `failed` — bounding a poison pill to N crashes
instead of infinity.

The cost is honest and small: a job whose worker was killed for reasons of its
own (a deploy, a node drain) is charged an attempt it did not deserve. A retry
budget losing one of N on a redeploy is a far better failure than an unbounded
crash loop.

Two consequences that live elsewhere, recorded here so neither is
rediscovered as a bug:

- **The rate-limit deferral path (#261) explicitly UN-CHARGES this
  increment.** A provider throttling us is not an attempt at the work, and a
  job merely waiting its turn must not exhaust a budget meant for a job that
  keeps failing. That is also why `rateLimitHits` is a separate counter — §5,
  and the `Job` model's block comment, argue the same point from the schema
  side.
- **`attempts` is already 1 by the time a handler's `process()` runs.** Code
  reading it inside a handler is reading the count *including* the current
  attempt, never excluding it.

### 4.6 `RETURNING` aliases every column to its camelCase Prisma field

The table is snake_case; the generated `Job` type is camelCase. Aliasing every
column (`created_at AS "createdAt"`, and so on for all 22) means the rows
Postgres hands back **are** `Job` values — no mapping function between the
query and its callers, and therefore no mapping function to forget a field in.
`claim()` returns `Job[]` with no cast-and-hope in between.

The alias list is *derived* from `JOB_CLAIM_COLUMNS`, a map typed
`Record<keyof Job, string>`, rather than typed out inline. That is what turns
a schema change into a **compile error**: adding a column to `Job` fails to
compile until the map covers it, and renaming one fails to compile on the
stale key. Written out by hand instead, the same rename would produce a row
missing a field — silently `undefined` at every call site, surfacing as a
null-ish value somewhere downstream rather than at the line that caused it.
`test/jobs/job-model-fields.spec.ts` locks the same pairing down from the test
side, comparing the map's key set against the generated
`Prisma.JobScalarFieldEnum`.

The list is built with `Prisma.raw`, because a column list is SQL *structure*
and structure cannot be parameterised. It is safe for a reason that has
nothing to do with trusting a caller: the only input is a module-level
constant evaluated once at import time, with no path from any request,
argument or environment variable to that string. Every genuine value in the
claim — node id, executor, lease, type list, limit — goes through a real bound
placeholder.

### 4.7 `recordProvider` never throws

`recordProvider(jobId, providerKey, modelVersion)` writes the two audit
columns and swallows any failure with a `warn`. Those columns are written once
near completion and read by nobody — not the claim query, not any scheduling
decision (the `Job` model says as much). Letting a failed annotation propagate
would fail a job whose real work already succeeded, turning a missing note
into a retry of work that does not need retrying. The commonest failure is
entirely benign: queue hygiene (#263) purged the row before the audit write
ran.

### 4.8 What proving this required

The concurrency guarantee is a claim about **Postgres**, so it is asserted
against a real one. A mocked `$queryRaw` returns whatever a test told it to,
so "two claimers never receive the same row" asserted against a mock proves
only the mock's arrangement — not `SKIP LOCKED`, not row locks, not the fact
that the claim is a single statement. The `*.db.spec.ts` suites therefore run
the **real services** over two independent `PrismaClient` instances, each with
its own connection pool, which is as close to two API replicas as one process
gets. See the Verification table below for the mapping from claim to test.

## 5. The terminal state machine

Once a job stops running, **exactly one component decides what happens to the
row**: `apps/api/src/jobs/job-terminal.service.ts`. It has two entry points —
`completeSucceeded(job)` and `completeFailed(job, error, opts?)` — and both
executors funnel through them: the in-process worker (#262) after its handler
returns or throws, and the node control plane (#268) when a remote node posts
its result back.

Supporting it are three small pieces: `backoff.util.ts` (one pure function),
`rate-limit.error.ts` (the failure-kind discrimination), and
`provider-throttle.service.ts` (a cooperative per-provider cooldown). The
event it emits is `events/job-settled.event.ts`.

### 5.1 One chokepoint, because two executors must not drift

**Rejected: letting each executor write its own terminal state.** It is the
obvious shape — the worker knows it just failed, so it writes `failed` — and
it is the drift this service exists to prevent. Two call sites means two
answers to each of: does a 429 charge an attempt? does a give-up clear the
lease? does the settled event fire on a retry? what is the backoff curve?
Every answer would start identical and diverge on the first fix applied to one
side, and **the divergence would be silent**. Nothing fails loudly when the
node path forgets to un-charge an attempt; a long backfill just quietly starts
failing permanently on rate limits while the same work run in-process
succeeds. One chokepoint makes "the two executors agree" a property of the
code rather than of two people's diligence — the same argument §4.4 makes for
sharing one claim statement, applied to the other end of the row's life.

`completeSucceeded` and `completeFailed` return a `JobSettleOutcome`
(`succeeded` | `failed` | `retry-scheduled` | `rate-limit-deferred` |
`write-failed`) so a worker can log what happened without reverse-engineering
it from the row it did not write.

### 5.2 Three ways in, one classification order

There are two genuinely different kinds of failure, and the whole section
depends on telling them apart:

- A **bug** — a null dereference, a malformed payload, a permission error —
  should burn through a small attempt budget quickly and land in `failed`
  where a human sees it.
- A **provider rate limit** is not a failure of the work at all. Nothing is
  wrong with the job, the payload or the code; we simply asked too often. It
  should back off for *minutes*, and it must not consume the attempt budget.

A handler that inspected the response itself says so by throwing
`RateLimitError` (optionally carrying `retryAfterMs`). A handler that did not
wrap its SDK gets `classifyRateLimit(err)`, which reads a status from
`err.status ?? err.statusCode ?? err.response?.status ?? err.$metadata
?.httpStatusCode`, treats **429 and 503/529-style overload** as rate limits,
and additionally matches the AWS throttle error *names* (`ThrottlingException`,
`TooManyRequestsException`, `SlowDown`, `RequestThrottled`,
`ProvisionedThroughputExceededException`, …) that arrive with a **400** status
— a status-only reading of those is "client error, fail permanently", which is
exactly wrong.

**A remote node is the third way in, and it is why `opts` exists.** A node
cannot throw a typed error across HTTP — an exception does not survive a JSON
response body — so it reports the same *conclusion* as flags,
`{ rateLimited: true, retryAfterMs }`, and gets **identical** treatment, down
to tripping this server's throttle gate. That identity is asserted directly:
the write payload produced by a node's flags and by a thrown `RateLimitError`
are compared field for field.

The order is fixed:

1. a thrown `RateLimitError` — the most specific signal there is;
2. `classifyRateLimit(error)` — ahead of the caller's flags because it reads
   the actual error, while a flag is a *claim* about it;
3. the caller's `opts.rateLimited`;
4. otherwise, an ordinary failure.

*Whether* it is a rate limit follows that order; *how long* to wait is taken
from the first source that actually named a delay, so a node forwarding a
provider's `Retry-After` is believed even when the error shape it also
forwarded carried none.

`classifyRateLimit` is **total and never throws**. It is called from inside a
failure path on a value that is `unknown` by construction, and every property
it reads could be a getter; an exception raised while classifying a failure
would escape the failure handler itself, losing the retry, the deferral and
the `lastError`. Anything it does not positively recognise is simply "not a
rate limit", which costs at most one attempt.

`parseRetryAfterMs` accepts both RFC 9110 forms — integer delta-seconds and an
HTTP-date — and returns `null` for absent, empty, unparseable, negative, or
already-past input. **`null` means "no opinion", never zero**: a provider that
said nothing must not be read as a provider that said "retry immediately".

### 5.3 Two budgets, deliberately separate

`attempts` (budget `JOBS_MAX_ATTEMPTS`, default 3 **unless the type declares
its own** — §5.10) bounds **bugs**. `rateLimitHits` (budget
`JOBS_RATELIMIT_MAX_HITS`, default 10, deployment-wide only — a profile does
not touch it) bounds **waiting**. Each has its own backoff constants — seconds
for a retry, minutes for a cooldown — and each gives up independently.

**Rejected: one combined counter.** A long backfill against a rate-limited
provider would exhaust it during the first minute of throttling and fail
permanently for a transient reason that was never its fault. Two failure modes
with different causes, different timescales and different correct responses
need two budgets. The `Job` model's block comment in `schema.prisma` records
the same decision from the schema side.

The two branches are therefore:

- **Rate-limited.** Trip the throttle gate, increment `rateLimitHits`, set
  `rateLimitedAt`, compute the delay into `scheduledFor`, un-charge the
  attempt (§5.4), and return the row to `pending`. Give up — terminal
  `failed` — only once `rateLimitHits` exceeds *its own* budget; at ten
  deferrals against a 15-minute ceiling the job has been waiting well over an
  hour, and something is wrong that waiting will not fix.
- **Ordinary.** Retry while `attempts < resolveMaxAttempts(config, handler)`
  (§5.10 — the type's own budget if it declared one, else
  `JOBS_MAX_ATTEMPTS`), setting `scheduledFor` from the backoff; otherwise
  terminal `failed`. `<` is the correct comparison because `job.attempts`
  already includes the attempt that just failed (§4.5), so a budget of 3
  retries after attempts 1 and 2 and fails on 3 — and a type declaring
  `maxAttempts: 1` fails on its first.

Every branch releases the claim (`claimedByNodeId`) and the lease
(`leaseExpiresAt`), and every branch records the error message in `lastError`
(truncated at 2000 characters — some SDKs embed a whole response body in a
message, and the admin job list renders this string).

**`executor` is deliberately never cleared.** `succeeded` and `failed` are
terminal, so there is no stale ownership to null out, and *which side ran the
job* is exactly the kind of thing worth still knowing later. `lastError` is
likewise left alone on success: on a job that succeeded on its third attempt,
the message from attempt two is the only surviving explanation of why it took
three.

### 5.4 The un-charge is an absolute value, not a decrement

§4.5 fixed that `attempts` is charged at **claim** time and means "attempts
started". That is right for failures and wrong for deferrals, so the
rate-limit branch explicitly gives the attempt back — the net effect of
claim-then-defer is zero. It is not merely "declining to add one"; the
increment has already been written to the row.

It is written as **`attempts: job.attempts - 1`, an absolute value**, clamped
at zero.

**Rejected: `{ decrement: 1 }`.** It is not idempotent, and this write can
genuinely run twice: `safeTerminalUpdate` retries once (§5.7), and its first
call can have committed before the connection dropped on the way back. An
absolute value applied twice still lands on `job.attempts - 1`. A relative
decrement applied twice subtracts two, silently **granting the job an extra
attempt it never earned**, and repeated across a long throttled backfill it
would drive `attempts` negative and make the budget unreachable — a bug that
would surface months later as "why did this job retry eleven times".

### 5.5 Equal-jitter exponential backoff, with an injectable RNG

`computeBackoffMs` is one pure function used by both deferral paths; they
differ only in the constants they pass.

```
exp   = min(maxMs, baseMs * 2^(attempt - 1))
delay = max(retryAfterMs ?? 0, exp / 2 + rand() * exp / 2)
```

**Jitter is not a rounding detail; it is the point.** Without it, every job
deferred by one provider outage retries in the same millisecond: they are
deferred by the same formula within the same second, so they land on the same
`scheduledFor`, all become eligible at the same instant, and hit the provider
together — reproducing exactly the burst that got us throttled. Pure
exponential backoff keeps them synchronised forever, because the same input
produces the same delay: the herd stays a herd at 2s, 4s, 8s, only sparser.

Equal jitter rather than the alternatives: **full jitter** (`rand() * exp`)
spreads widest but its lower bound is zero, so a job can retry essentially
immediately after being deferred for a reason that has not gone away — half
the point of backing off is the waiting. **Decorrelated jitter** needs the
previous delay as state, and ours is recomputed from a counter on a row that a
different process may pick up, so there is nowhere to carry it without adding
a column.

`retryAfterMs` is a **floor, not an override**: a provider asking for an hour
is obeyed past our own ceiling, and a provider asking for one second does not
undo six consecutive failures' worth of backoff. Taking the max is the only
combination that violates neither constraint.

The RNG is a parameter (`rand`, defaulting to `Math.random`) so tests assert an
**exact** delay. A range assertion on a jittered delay is nearly worthless: it
passes for a correct implementation *and* for one that ignores `attempt`
entirely, which is the bug most worth catching.

### 5.6 The cooperative per-provider throttle gate

At concurrency > 1, one 429 teaches exactly one worker slot that the provider
is throttling us. The other slots know nothing, so they each go and discover
it independently — sending more requests to a provider that has just asked for
quiet, and burning each of those jobs' rate-limit budget to learn a fact the
first slot already knew.

`ProviderThrottleService` shares the discovery. `trip(jobType, delayMs)` sets
a cooldown on the job type's **provider key**; `acquire(jobType)` waits out
whatever remains of it before the provider call; `recordSuccess(jobType)`
clears it, because a success is direct evidence the limit has lifted and is
strictly more recent information than the trip. A trip **extends but never
shortens** — a sibling's short backoff must not cut a provider's long one.

`resolveKey(jobType)` returns `null` for a type with no external provider,
which makes the gate a **zero-cost no-op**: no wait, no timer, nothing to act
on. That is the default and the common case, and this framework ships no job
type that talks to an external provider, so out of the box the gate does
nothing at all. A fork declares its own mapping beside the registration that
makes the handler exist:

```ts
onModuleInit() {
  this.registry.register(this);
  this.throttle.registerProviderKey(this.type, 'acme-vision');
}
```

**Several job types should share one key when they share one quota** — that is
the entire reason the key is not just the job type. Three handlers hitting one
vendor account are one bucket, and mapping all three to `'acme-vision'` is
what makes a 429 on any of them back off the other two; two handlers hitting
two vendors must *not* share a key, or one vendor's outage stalls work that had
nothing to do with it.

Two bounds keep the gate from becoming a liability. It is **in-memory and
best-effort**, not a distributed limiter: a second replica has its own gate.
That is acceptable because the gate is an optimisation, while the thing that
actually keeps a throttled job from failing is the durable deferral in the row
— and `scheduledFor` *is* shared state, invisible to every replica's claim
query, not just this one's. **Rejected: a database- or Redis-backed shared
gate**, which would put a network round trip in front of every job, for every
provider, on every tick — permanently, to improve behaviour during an outage —
and would add a datastore this template deliberately does not require (§"Why
this shape"). And `acquire` is **capped at `JOBS_RATELIMIT_MAX_MS`**: a worker
slot is scarce, and an unbounded wait would let one provider's long cooldown
pin every slot in the pool, starving jobs that have nothing to do with it. Past
the cap the job proceeds and, if the provider is still throttling, takes the
durable deferral instead — a long wait belongs in the row, where it costs
nothing, not in a slot.

The gate is tripped **before** the terminal write, on both the thrown and the
node-reported paths: sibling slots are calling that provider right now, and
the provider does not care which machine a request came from.

### 5.7 `safeTerminalUpdate` logs and swallows — and that is the feature

The terminal write is retried **once**, after a short unref'd sleep, and then
logged at `error` and swallowed.

Every caller is a worker finishing a job and about to free its slot. If a
database blip could throw out of here, that exception would propagate into the
worker's slot accounting and either crash the worker or leave the slot
accounted for but never released. **A slot lost that way is lost for the life
of the process**, and losing all of them reduces the queue's throughput to zero
with nothing in the logs but one stack trace from an hour ago.

So the worst case is deliberately bounded and recoverable: the slot is freed,
and the row is left `running` with an expiring lease — precisely the state the
lease reaper (#263) exists to find and requeue. The job is delayed by one lease
interval; nothing is lost and nothing wedges.

One retry, not zero and not many. Zero would fail the whole terminal write on
a single recycled connection, which is common enough to be worth covering.
Many, with waits between them, would hold the worker slot open for the duration
of an outage — the exact resource this method is protecting. The 250ms pause is
short for the same reason: it is covering a blip, not an outage.

When both writes fail, the outcome is `write-failed` and **no settled event is
emitted** — the row does not say what the event would claim.

### 5.8 `job.settled` fires only when the job is genuinely over

`JobSettledEvent` is emitted through `EventEmitter2` (registered globally in
`app.module.ts`) from the terminal branches only: `succeeded`, or a give-up on
either budget. **A retry emits nothing. A deferral emits nothing.** It is
always emitted *after* the write, so the database already agrees with the
event, and it carries the row the write returned.

**Rejected: emitting on every state change** (`job.running`, `job.retried`,
`job.deferred`, …). It looks more useful and is strictly less useful, because
it moves work into every subscriber: a listener that wants to know "did this
finish" would have to re-derive the answer from `status`, `attempts`,
`rateLimitHits`, `scheduledFor` and the attempt budget — that is, to
re-implement this service's decision from outside, against config it does not
read. Every subscriber would carry a copy of the retry logic, and each copy
would be somewhere for the two to disagree. Emitting only at the terminal
branches is what lets a subscriber treat the event as what it says: this job
is done, here is how it ended. One event rather than a
`job.succeeded`/`job.failed` pair, because the carried `status` already says
which.

The emit is wrapped in `try/catch`. `EventEmitter2` dispatches
**synchronously**, so an unguarded listener exception would throw out of
`completeSucceeded` into a worker that has already written a correct terminal
row — the worker would be handling an "error" for a job that finished
perfectly. A listener is a bystander and must not be able to affect the row or
the slot. It can still *block* one, so a listener should queue a job (there is
a queue right here) rather than do real work.

### 5.9 Configuration, and the two injection seams

Six settings, read through `ConfigService` from `config/configuration.ts` like
everything else in this app, bare and unprefixed, and documented in
`infra/compose/.env.example`:

| Variable | Default | What it bounds |
|---|---|---|
| `JOBS_MAX_ATTEMPTS` | 3 | Attempts before a job is permanently `failed` |
| `JOBS_RETRY_BASE_MS` | 2000 | First retry delay, doubling per attempt |
| `JOBS_RETRY_MAX_MS` | 60000 | Ceiling on the retry exponential |
| `JOBS_RATELIMIT_MAX_HITS` | 10 | Deferrals before a rate-limited job gives up |
| `JOBS_RATELIMIT_BASE_MS` | 30000 | First deferral delay, doubling per hit |
| `JOBS_RATELIMIT_MAX_MS` | 900000 | Ceiling on the deferral exponential, and on how long `acquire` may hold a slot |

Each is read with a defensive fallback to the same default, because these
services are also constructed directly in unit tests: a missing key must
degrade to the shipped behaviour rather than to `NaN`, which would silently
produce `new Date(NaN)` and an unwritable `scheduledFor`.

`JOB_CLOCK` and `JOB_RANDOM` are **optional DI tokens that nothing provides**.
Both services fall back to the real clock and `Math.random`, so an application
always runs on real time and real jitter and a fork cannot fill the seam by
accident; only a test constructing a service directly can substitute either.
They exist because the alternative is tests that prove nothing — a range
assertion that passes for an off-by-a-factor-of-sixty bug, or a gate test that
either sleeps for thirty real seconds per case or shrinks the cooldown until it
is testing something other than the shipped behaviour.

### 5.10 Per-type execution profiles (#346, epic #345)

Until #346 every job in the queue shared the same two deployment-wide numbers:
`JOBS_JOB_TIMEOUT_MS` and `JOBS_MAX_ATTEMPTS`. That is right for jobs that
resemble each other and wrong the moment one does not — a six-second
thumbnail and a six-hour database dump cannot share a timeout, and a type that
must never be auto-retried cannot share a budget with one that should retry
three times. `JobHandler.profile` (`job-execution-profile.ts`) is the escape
hatch: an **optional** `{ maxRuntimeMs, maxAttempts }` a handler declares for
its own type. Omitting it — the normal answer — runs exactly the code path
that existed before profiles did.

**Exactly two numbers, and there will only ever be two.** A profile may not
declare a lease length or a renewal interval, because both are values that can
*disagree* with `maxRuntimeMs`, and the disagreement is silent, remote and
intermittent:

- **The lease is derived**, as `maxRuntimeMs + LEASE_GRACE_MS` (or an
  unbounded lease when `maxRuntimeMs: 0`, mirroring `JOBS_JOB_TIMEOUT_MS=0`),
  by the same `resolveJobLeaseMs` the deployment-wide timeout already goes
  through (§6.5) — the profile is a parameter to that one function, not a
  second derivation beside it. A lease *shorter* than the declared runtime
  ceiling would be a job that reaps itself into duplicate execution the
  moment it legitimately runs long; deriving it makes that state
  unrepresentable rather than merely avoided.
- **The renewal interval is derived**, as the lease divided by three and
  clamped to `[5s, 60s]` (`resolveRenewIntervalMs`, §6.9) — three so a
  renewer may miss two consecutive intervals (a GC pause, a dropped request)
  and still hold the job. An interval at or above the lease would be a
  renewal that always arrives after the deadline it was meant to extend.

This is the same argument §2 makes against a `nodeEligible: boolean` flag,
applied to durations instead of capabilities: a second, independently-settable
number that must always agree with the first is a promise a struct cannot
keep, so the struct does not offer it. REJECTED for the same reason: a
`retryBackoffMs`, a `priority`, a `concurrencyLimit` on the profile — each is a
real thing somebody will want, and each can disagree with the other two.

`resolveJobProfile(handler)` is the single validation point every consumer
goes through — the lease, the timeout, and the attempt budget all ask it,
rather than each holding its own opinion about a half-valid profile.
`maxRuntimeMs` must be finite and `>= 0` (`0` is the legitimate "no ceiling"),
`maxAttempts` finite and `>= 1` (a budget of `0` would describe a job that may
never be claimed, which is not a retry policy — it is a silent way to delete
work). An unusable profile is dropped **whole**, not field by field, and
warned about once per type: honouring a mistyped attempt budget while
inventing a runtime ceiling nobody chose is a stranger state than falling back
to the deployment defaults entirely.

**`resolveMaxAttempts(config, handler)` is read by *both* give-up paths, and
it has to be.** `JobTerminalService` decides retry-or-fail for a job that
reported back (§5.3); `JobStuckService` decides requeue-or-fail for a job
whose executor died without reporting anything (§7.2). If only the first knew
about per-type budgets, a `maxAttempts: 1` job the terminal path correctly
refused to retry would be found by the reaper, judged against the global `3`,
and **requeued** — resurrecting the exact automatic retry the profile exists
to forbid, on the one path nobody was watching for it.

`db.backup.run` is the worked example: `maxRuntimeMs: 6h`, `maxAttempts: 1`.
See `docs/specs/database-backup.md`'s "Why this *is* a queue job" section for
the backup-specific case each number answers.

## 6. The in-process worker and worker modes

This is the first thing in the epic that **runs on its own**. Everything
before it moves a row when something calls it; `apps/api/src/jobs/job.worker.ts`
is the thing that calls.

It writes **nothing** to the `jobs` table itself. Every row it touches goes in
through `JobClaimService.claim` (§4.4) and out through
`JobTerminalService.completeSucceeded` / `completeFailed` (§5.1). That is not
tidiness: the node control plane (#268) reaches the same two methods from the
other side, and two executors can only agree about a finished job by running
the same code.

### 6.1 N independent slot loops, not one loop claiming a batch

The pool is `JOBS_WORKER_CONCURRENCY` **independent** loops. Each one claims
**one** job, runs it, and goes round again; on an empty queue it sleeps
`JOBS_POLL_MS` and asks again. A slot that just finished a job does **not**
sleep — otherwise throughput would be capped at one job per slot per poll
interval however deep the backlog is.

The obvious alternative is one loop that claims `limit: N` and `Promise.all`s
the results. **Rejected**, because that is a *batch barrier*: the loop cannot
claim again until its **slowest** member finishes, so with mixed durations —
which is every real queue — effective concurrency collapses toward 1. Nine
hundred-millisecond jobs batched with one ten-minute job means eight idle
slots for ten minutes while the queue backs up behind them.

Independent loops have no barrier. A slow job stalls exactly one slot, which
is the honest cost of running it, and the other N-1 keep claiming. The price
is N concurrent single-row claims instead of one N-row claim, and that price
is nothing: `FOR UPDATE SKIP LOCKED` is built for exactly this access pattern
and never blocks — two loops racing for one row produce one winner and one
empty result, with no waiting on either side (§4.4).

### 6.2 It starts from `onApplicationBootstrap`

The constraint §1.3 states from the registry's side, satisfied here. Handlers
self-register from their own `onModuleInit`; Nest runs every `onModuleInit`
hook in one phase and only afterwards every `onApplicationBootstrap` hook, so
starting in the later phase is what makes "every handler has registered before
the first claim" a guarantee rather than a function of module-resolution
order.

The failure it prevents is not a retryable blip: a claimed job whose type has
no registered handler is failed **permanently** (§6.6), so losing this race
destroys a perfectly good job for a reason that had gone away one second
later. It is a real production bug in the application this design was
extracted from, and it is why the constraint is written down in three places —
`job-handler.registry.ts` (the file that creates the hazard), `job.worker.ts`
(the file that must respect it), and here.

`src/jobs/job.worker.bootstrap.spec.ts` proves it behaviourally rather than by
asserting the hook is spelled right: a handler that stalls 40ms inside its own
`onModuleInit` before registering is nonetheless present in the **first**
claim's `eligibleTypes`.

### 6.3 Three modes, re-read on every claim, failing open

`JOBS_WORKER_MODE` decides which types this process is willing to claim:

| Mode | Claims | When |
|---|---|---|
| `all` | Every registered type | The default, and the single-box posture: there is nowhere else for the work to run |
| `system` | Only the types **no node may claim here, right now** (the complement of what the node plane is offered — §6.4), plus the extras below | The recommended posture once worker nodes exist — the API server stops competing with the fleet for the expensive jobs the fleet was added to take |
| `off` | Nothing | A pure control plane: still enqueues, still serves the queue API, executes nothing |

Two decisions inside that table are worth stating on their own.

**An unrecognised value warns once and behaves as `all`.** Failing closed is
the safe-looking answer and it is the worse one: `JOBS_WORKER_MODE=sytem` in
one env file would silently stop **all** background processing, and the
symptom arrives hours later as "jobs stopped running" with nothing obviously
broken. Running the default loudly is the recoverable failure; stopping every
job in the deployment is not. The warning is latched at **module** level
because the mode is re-read on every claim — without the latch a typo would
emit several warnings a second, forever, burying the one line an operator
needs.

**Eligible types are resolved per claim, not captured at bootstrap.** `all`
and `off` answer from memory (a `Map` walk and a `ConfigService` lookup);
`system` additionally reads one settings row and, for a type carrying a
credential broker, a probe the broker itself caches for ~60s — all of it next
to a claim query that was going to run anyway. Capturing once would make
`system` mode depend on registration order — a handler whose module resolved
after the worker's would simply be missing from a list computed once — which
is the same class of invisible coupling explicit self-registration exists to
avoid (§1.2). It would also make the mode deaf to the runtime gates §6.4
describes, which is precisely the bug that section records.

### 6.4 `system` mode is the node plane's complement — and `JOBS_SYSTEM_MODE_EXTRA_TYPES`

`system` mode's base list is the **complement of
`NodeOffloadService.offeredTypes()`**: every registered type that no node may
claim *in this deployment, right now*. One function answers the question and
the two executors read it in opposite directions, so they partition the queue
by construction.

**It used to be `JobHandlerRegistry.serverOnlyTypes()`, and that was a hole.**
`serverOnlyTypes()` answers a *static* question — does this handler carry the
two node members? — which was the same question only while node eligibility
was purely structural. Epic #345's `db.backup.run` broke that: it is
structurally node-eligible (so it left `serverOnlyTypes()` for every
deployment, forever) while the three runtime gates that decide whether a node
may actually claim it all ship **off**. Read separately, the two derivations
disagreed, and on a `system`-mode deployment **neither executor claimed the
type**: the fleet was not allowed to, and the server no longer thought it had
to. For a backup that means a deployment that silently stops taking them,
recovered only by an operator noticing an alert and editing an environment
variable. Deriving one list from the other makes that hole unrepresentable —
the same argument `resolveJobLeaseMs` makes about a lease and its renewal
interval, applied to eligibility.

The extras remain, and they are now for exactly one thing: deliberately
running a type the fleet **is** allowed to run, because its node fleet is
small, paused, or does not run that type. They are no longer needed to keep
anything running at all. Overlap with the fleet is **safe rather than
tolerated** — `SKIP LOCKED` means a server and a node racing for one row
produce one winner and one empty result, never a double claim (§4.4).

An entry no handler in this process registers is **dropped with a warning**
rather than passed through, once per type. Claiming a type with no handler is
not a harmless no-op: the claim succeeds, the lookup fails, and the job is
destroyed permanently. Declining to claim is a far better answer to a typo.

### 6.5 Per-job timeouts, and the `Promise.race` trap

`JOBS_JOB_TIMEOUT_MS` (default 600000; `0` disables) bounds how long one job
may hold a slot. A timeout is an ordinary failure: it goes through
`completeFailed` like any other, so the job retries or fails on its normal
attempts budget, and `Job.lastError` carries a greppable `JobTimeoutError`
message.

**The work is not cancelled, because JavaScript cannot cancel it.** There is
no way to stop a promise that is mid-`await`. So the timeout frees the
**slot** — which is the scarce resource — and leaves the abandoned work to
settle whenever it settles. Handlers should be idempotent anyway (§1.1's
at-least-once contract already requires it), and the row is fully accounted
for the moment the timeout fires.

That leaves one trap, and it is the reason `withTimeout` is not a bare
`Promise.race`:

> A naive `Promise.race([work, timeout])` attaches nothing of its own to
> `work` once the race is decided. A work promise that **rejects after losing
> the race** is therefore a rejected promise with no handler — an
> `unhandledRejection`, which in Node's default posture terminates the
> process. A per-job timeout that kills the API server on the next slow
> provider call is worse than no timeout at all.

So the reactions are attached unconditionally, before the race can be decided,
and stay attached forever; settling an already-settled promise is a harmless
no-op. `src/jobs/job.worker.spec.ts` asserts this directly by listening for
`unhandledRejection` and rejecting the abandoned work after the timeout has
already failed the job.

**The claim lease is derived from the timeout**, as `timeout + 60s` (or one
hour when timeouts are disabled), rather than configured separately. Two
independent knobs whose only requirement is `lease > timeout` are two knobs an
operator can set into a state where the lease reaper (#263) requeues jobs that
are running perfectly well — duplicate work that looks like a queue bug and is
really a typo. Deriving it makes that state unrepresentable.

### 6.6 A claimed job whose type has no handler

Failed **terminally**, immediately, with the claim and lease released — not
retried. A retry would re-enter this same process, find the same registry, and
reach the same conclusion two minutes later having burnt the attempt budget to
learn nothing. The type is gone, misspelled, or was claimed by a mode that
should not have claimed it, and all three need a human rather than another
attempt.

It is still `JobTerminalService` that writes the row. `completeFailed` gained
`CompleteFailedOptions.permanent`, a flag **into** the chokepoint rather than a
licence for the worker to write its own terminal row — §5.1's argument applies
to this route exactly as it does to the others, and the node control plane
(#268) will use the same flag for a node reporting an input it can never
accept. `permanent` short-circuits **ahead of** the rate-limit classification
(§5.2): an unrunnable job that happens to throw a 429-shaped error must not be
deferred for fifteen minutes before failing anyway.

### 6.7 Shutdown

`onModuleDestroy` stops claiming immediately, aborts every sleeping slot, and
then waits — **briefly** — for jobs still in flight.

Every timer the worker creates lives in one `Set` and is `unref`'d, for the
reason `job-clock.ts` gives for its own: a pending timer must never hold a
shutting-down process open. But `unref` alone is not enough here, which is why
these timers are not behind `JobClock.sleep` — that sleep has no handle, so a
slot parked in a five-second poll could only be woken by waiting it out.
Clearing the set wakes every slot at once, each sees the stop flag, and
`onModuleDestroy` returns in milliseconds instead of up to a full poll
interval.

The wait for in-flight work is **bounded** (five seconds). `onModuleDestroy`
runs while an orchestrator is already counting down to SIGKILL, and a slot
running a ten-minute job cannot be hurried; waiting for it would turn a
graceful shutdown into a hard kill. Past the grace the job is simply left: its
row stays `running` with a lease that will expire, which is precisely the
state the lease reaper (#263) exists to find and requeue. Nothing is lost, and
one job is delayed — the same bounded-and-recoverable trade `safeTerminalUpdate`
makes in §5.7.

### 6.8 Configuration

Five more settings, in the same `jobs` block as §5.9's six and documented the
same way in `infra/compose/.env.example`:

| Variable | Default | What it bounds |
|---|---|---|
| `JOBS_WORKER_CONCURRENCY` | 2 | Slot loops, fixed at startup. `0` starts no pool |
| `JOBS_POLL_MS` | 5000 | How long an **empty** queue waits before asking again |
| `JOBS_WORKER_MODE` | `all` | Which types this process claims (§6.3) |
| `JOBS_JOB_TIMEOUT_MS` | 600000 | How long one job may hold a slot; `0` disables |
| `JOBS_SYSTEM_MODE_EXTRA_TYPES` | *(empty)* | Extra types `system` mode claims **in addition** to its complement (§6.4) |

`JOBS_WORKER_MODE` is stored as a plain string and validated by the worker on
every claim rather than parsed in `configuration.ts`, because validating it
there would have to choose between throwing at boot (the fail-closed outcome
§6.3 rejects) and silently rewriting the value — the same fallback, further
away from the log line that explains it.

`JobWorker` is provided by `JobsModule` and deliberately **not exported**.
Nothing should reach it: it has no method a feature module wants, and a module
that could inject it could stop the pool.

### 6.9 In-process lease renewal, and what it cannot distinguish (#347, epic #345)

A claim writes `lease_expires_at` once. Until #347 nothing in the in-process
worker ever wrote it again — `NodesService.renewLease` was the queue's only
renewer, reachable only over HTTP by a remote node — so every handler that ran
longer than `jobs.stuckThresholdMinutes` (default 30) was reaped mid-run and
started a **second time**, concurrently, with nothing in the logs. (This is
not hypothetical: it is exactly what made a database backup unsafe to queue —
see `docs/specs/database-backup.md`'s "Why this *is* a queue job" section,
argument 2.) `JobLeaseService.renew`/`renewUntil` is the fix, and it is one
service reached by **both** executors — the node control plane calls it over
HTTP via `POST …/renew`; `JobWorker.startLeaseRenewal` calls it directly, on a
self-rescheduling `setTimeout` (never a bare `setInterval`, which could stack
overlapping renewals if the database is briefly slow) ticking every
`resolveRenewIntervalMs(leaseMs)` for as long as `process()` runs, on the
*same* lease the claim took (`resolveJobLeaseMs` over the *same* resolved
profile — a renewal derived from anything else could hand a six-hour type a
ten-minute extension).

**The guard is a `WHERE` clause on the write itself, never a read-then-write.**
`heldLeaseWhere(jobId, nodeId)` demands the row still be `running`, its lease
not yet expired, and — when a caller passes one — held by that specific node;
`updateMany` makes the check and the write one statement, so a count of zero
is the only honest answer to "did the state move between my read and my
write". A renewal that finds the row no longer its own **stops renewing and
logs at `error`**, naming the job: the work itself is not cancelled (§6.5
already spends a paragraph on why JavaScript cannot cancel a promise
mid-`await`), but a worker that has lost the row must not keep re-forging the
queue's view of it. This does not introduce a hazard — the queue has always
been at-least-once (§4.5) — it makes a pre-existing one **visible**: before
#347 two executors on one row happened silently every time a job outran the
threshold.

**⚠ What the guard cannot distinguish, stated plainly (#361): two SERVER
processes.** `nodeId` in `heldLeaseWhere` is deliberately three-valued — a
node id (only that node may renew), `null` (only a row claimed by no node —
i.e. the in-process worker's own claim — may be renewed), or `undefined` (no
ownership constraint, for a fork's own executor). But if replica A's job is
reaped and replica B claims it, **both** see `claimedByNodeId: null` and a
live lease, so A's next renewal succeeds and silently extends **B's** lease.
Closing that would need a per-claim token column on `jobs` — a schema change
deliberately out of scope for #347. It is still strictly better than the
status quo it replaced (where A never renewed at all and B was guaranteed to
be reaped too regardless), and the queue's at-least-once contract already
covers the remaining outcome: at worst, one job's lease is extended by two
processes that both believe they hold it, which is a duplicate-execution risk
the queue already tolerates everywhere else, not a new one this closes badly.
See `job-lease.service.ts`'s own header for the full argument.

**A renewal failure is not treated as a lost lease.** The renewal interval is
one third of the lease by construction, so two consecutive database blips
between ticks cost nothing; only a lease that has *actually* expired stops the
ticker.

### 6.10 The reaper's fourth signal exists because renewal narrowed the third

Narrowing the reaper's age-based signal to leaseless rows only (§7.1) is what
makes a renewing job safe at any age — but it would also silently stop
catching an implausible lease (a bug in a fork's own claim path, a clock jump,
a hostile write) that the old, unconditional age check caught by accident.
`resolveLeaseHorizonMs` (`job-execution-profile.ts`) is the replacement: the
longest lease *any registered handler could legitimately ask for*, plus one
grace, computed fresh on every sweep rather than cached. §7.1 covers the
signal itself and the trade-off stated honestly there.

## 7. Queue hygiene — the lease reaper, the history purge, the janitor

Three things degrade on their own once the queue is real, and none of them is
visible from inside a single job's lifecycle:

1. A job whose executor **died** stays `running` forever. Its slot is never
   reclaimed, its dedup key is held forever, and — once remote nodes exist — a
   laptop closing its lid mid-job is the *normal* case rather than an edge one.
2. Terminal rows **accumulate without bound**. `jobs` is both a work list and
   the only record of throughput, and only the first of those two goes stale.
3. A worker SIGKILLed mid-download **leaves temp files behind**. No `finally`
   block, no exit hook and no shutdown handler runs when the kernel removes a
   process.

#263 adds one component per problem: `JobStuckService` plus
`tasks/job-stuck-reset.task.ts`, `handlers/job-history-purge.handler.ts` plus
`tasks/job-history-purge.task.ts`, and `tasks/temp-file-janitor.task.ts`.

### 7.1 Four recovery signals, and why each one is load-bearing

> Three signals through #262; #347 (epic #345) re-cut them around lease
> renewal and added the fourth. "Time" stopped being the only thing that
> distinguishes a healthy long-running job from a dead one, because a live
> executor now **renews** its lease on a schedule (§6.9) — a healthy job
> proves it is alive by evidence it produces while it works, not merely by how
> long it has been at it.

`stuckRunningWhere(threshold, now, leaseHorizon)` is the queue's definition of
"abandoned", and it is four OR'd clauses over `status = 'running'`:

```ts
{ status: 'running', OR: [
    { leaseExpiresAt: null, startedAt: { lt: threshold } },                  // aged, unleased
    { leaseExpiresAt: null, startedAt: null, createdAt: { lt: threshold } }, // zombie
    { leaseExpiresAt: { lt: now } },                                        // dead owner
    { leaseExpiresAt: { gt: leaseHorizon } },                               // implausible lease
]}
```

- **Aged and unleased.** A properly stamped claim, running longer than any job
  of any type should, that carries **no lease at all** — a fork's own claim
  path, a hand-inserted row, a row claimed before leases existed. **Age is now
  consulted only where there is no lease to consult instead** — this is the
  narrowing #347 made, and it is what makes a renewing job of any age safe:
  a live `pg_dump` still streaming six hours in is never reaped by how long it
  has run, only by whether it is still proving itself alive.
- **Zombie.** `running` with no `startedAt` and no lease at all. It looks
  impossible, because the claim writes `started_at = now()` in the same
  statement that writes `status = 'running'` (§4.4), and it is exactly what a
  partially applied write or an external control plane leaves behind. Neither
  the aged clause (`NULL < threshold` is `NULL`, never true) nor the dead-owner
  clause below can see it, so **without this clause such a row is stuck
  forever** and holds its dedup key with it. `createdAt` is the substitute
  age, and it is always present.
- **Dead owner.** The fastest and most precise signal, and the only one that
  does not wait out the threshold: whoever claimed the row promised to settle
  or renew it before this instant and did not. It covers a killed API replica
  and a vanished worker node *identically*, because a lease says nothing about
  where the executor was.
- **Implausible lease.** A lease further out than the longest lease **any
  registered handler could legitimately ask for**, plus one grace
  (`resolveLeaseHorizonMs`, §6.10). This signal exists **only because the
  first one was narrowed** — before #347, the unconditional aged-claim clause
  caught a corrupt or absurdly far-future `lease_expires_at` for free, as a
  side effect of ignoring leases entirely. Narrowing that clause to unleased
  rows fixed the bug (reaping jobs that were running perfectly well) and would
  have silently reopened this one (a lease pushed absurdly far out — a clock
  jump, a bug in a fork's own claim path, a hostile write — matching *no*
  signal and holding its dedup key forever) without a replacement. The
  deployment-wide lease is always folded into the maximum, even with an empty
  registry, because a `JOBS_WORKER_MODE=off` control plane may register no
  handlers at all and must still reap for its fleet.

  **⚠ The residual risk, stated honestly rather than hidden.** This horizon
  *moves with the process reading it*. A deployment that removes a job type
  (or lowers its `maxRuntimeMs`, or lowers `JOBS_JOB_TIMEOUT_MS`) **shortens**
  the horizon, and an in-flight row of that type still carrying the older,
  longer lease may be reaped on the very next sweep. That is correct rather
  than merely acceptable — no process in that deployment can run such a row to
  completion any more, so requeueing it is the only outcome that is not "stuck
  until a human notices" — but it is a real behaviour change following a
  config edit, not a hypothetical one, and it is why the horizon is computed
  fresh per sweep rather than cached.

The two instants (`threshold`, `now`) are deliberately different from each
other, and the horizon is a third. `threshold` asks "older than usual"; `now`
asks "past its deadline, this instant"; `leaseHorizon` asks "further out than
anything legitimate could be". Collapsing the first two would either reap
live jobs (using `now` for the age) or leave every expired lease sitting for
another full threshold (using `threshold` for the deadline). All three are
parameters rather than clock reads inside the function, so one sweep judges
every row against one consistent set of instants.

### 7.2 Two phases: requeue what has budget, fail what does not

`resetStuck(olderThanMinutes?)` returns `{ reset, failed }` and does two
different things to two disjoint sets of rows:

- **Rows at or over `JOBS_MAX_ATTEMPTS` are marked `failed`**, one at a time.
  One at a time, and not one `updateMany`, because the message written to
  `lastError` names *that job's own* attempt count — the number that
  distinguishes an unlucky job from a poison pill — and a bulk update can only
  write one string for every row it touches. The phase is bounded by how many
  jobs exhausted their budget unattended, which in a healthy deployment is a
  handful.
- **Rows still under budget go back to `pending`** with the claim, the lease
  and the executor released, in one `updateMany`. `executor` *is* cleared here,
  unlike on the terminal path (§5): the row is about to be claimed again,
  possibly by the other side entirely, and a stale `"node"` on a job the server
  is about to run is a lie rather than history.

**The give-up phase is what bounds a poison pill to N crashes instead of an
infinite loop, and it only works because `attempts` is charged at CLAIM time**
(§4.5). A job that reliably kills its executor — an OOM, a segfault in a native
dependency, a library calling `process.exit()` — never reaches
`JobTerminalService`, so nothing on the terminal path can ever count it. If the
reaper simply requeued, the sequence would be *claim → executor dies → reaped →
claim → …* forever, at one crash per threshold, with the container restarting
underneath. The claim-time increment survives the death of the process, which
is the only reason the reaper can say "this has had its budget" with evidence.
Charge `attempts` on failure instead and this phase becomes unimplementable —
these two decisions are one decision seen from two ends.

Neither phase touches `attempts`. The attempt genuinely happened: the executor
started the work and died doing it.

### 7.3 The primitives are extracted, so a control plane can reap

`getStuckThresholdMinutes()`, `stuckRunningWhere()` and `resetStuck()` live in
`JobStuckService` rather than in the admin jobs service that will also expose
them. That is not tidiness; it is a deployment:

    JOBS_WORKER_MODE=off  +  an external node fleet

is an API server acting as a **pure control plane** — it claims nothing and
runs nothing, and every job executes on a machine it does not own. It is also,
by a wide margin, the deployment where dead leases are most likely, because a
fleet member's disappearance is routine. If reaping could only reach these
primitives through the admin service, reaping would be coupled to the admin
surface being mounted, and the deployment that needs it most would be the one
least likely to have it. So the dependency points one way permanently: the
reaper task, and later the admin endpoint, depend on this service; the service
depends on Prisma, config and settings.

The threshold is read through `SystemSettingsService.getJobsPolicy()` — a
narrow accessor in the style of `getNotificationsPolicy()` /
`getMaintenancePolicy()`: it projects one column, and it **does not create the
row** the way `getSettings()` would. A cron tick materialising a settings row
as a side effect is a write nobody asked for on a path with no caller to report
it to. A failed read degrades to `DEFAULT_SYSTEM_SETTINGS.jobs`, because a
settings blip is not a reason to stop reaping.

### 7.4 The reaper honours `JOBS_REAPER_ENABLED` and never the worker mode

The most important line in `job-stuck-reset.task.ts` is the one that is not
there: no `if (mode === 'off') return`. Reaping is a **control-plane duty**,
not a worker duty. `JOBS_WORKER_MODE=off` says "this process executes no jobs";
it does not say "this deployment has no jobs", and the leases that expire in
that deployment belong to remote nodes, which have no database access and
cannot reap themselves. Gating the reaper on this process's willingness to run
work would leave the fleet's abandoned rows to nobody.

The one switch is `JOBS_REAPER_ENABLED`, defaulting to on, for the one
legitimate case: several API replicas sharing a database where an operator
wants exactly one of them sweeping. Running it everywhere is safe anyway —
every phase re-asserts "still stuck" in its own `where`, so two reapers racing
produce one winner and one no-op — the switch merely saves the duplicated
queries. Only the literal `false` disables it, so a typo fails **open**, the
same direction §6.3 argues for the worker mode.

The tick is every ten minutes: tighter would re-ask a question whose answer
changes on a scale of tens of minutes, and hourly would let a node that died
just after a tick hold its dedup key for most of an hour.

### 7.5 The purge is a job, not another cron

`job.history.purge` is the first job type in this repository that does real
work, and the queue's own housekeeping is deliberately the first customer of
the queue. The nightly task **enqueues** it; the handler does the deleting on a
worker slot. That indirection was, when #263 shipped, the whole difference from
the three older cleanup crons this repository shipped with — and §7.10 is
where those three (and five more) ended up:

- it is **observable** — a purge that ran is a row with a status, a duration,
  an attempt count and a `lastError`, in the same admin list as everything else;
- it **retries on the queue's own budget**, with backoff, instead of "wait 24
  hours";
- it **runs where the work belongs**, competing for a worker slot rather than
  executing on the scheduler's thread;
- and it is the **dogfood** for the epic's headline promise: one handler class,
  self-registered, no queue wiring, no migration, no enum arm.

It is server-only by carrying neither node member (§2) — the job *is* a
sequence of database statements, so there is nothing for a node without
database access to compute — and global, with no subject, which folds into a
constant dedup key (§4.2) so the active-dedup index alone guarantees at most
one purge in flight. It is enqueued at **priority 100**, which is *low*:
ascending is more urgent (§4.4), every ordinary job takes the column default of
`0`, and housekeeping must never be claimed ahead of user-facing work.

Two guards sit in front of the enqueue and neither is redundant. The
`purgeEnabled` setting is checked by the task so a disabled deployment creates
no row, and **again by the handler**, because a purge row can also arrive from
an admin control or a rerun and the setting is a statement about deleting
history rather than about scheduling it. The "is one already pending or
running?" lookup is not what prevents duplicates — the index does that — it is
what keeps the log honest: without it, a purge that legitimately overran
midnight would produce a "queued" line every night that queued nothing.

### 7.6 Deleting history must not delete history

`jobs` is two things at once: a work list, interesting only while it is recent,
and the only record of **throughput** — how many jobs of each type have ever
run, how many failed, how long they took. A plain `deleteMany` keeps the first
and destroys the second, so all-time counts and average durations would reset
every retention period and the answer to "how many exports have we ever run?"
would depend on when the last purge happened. Worse, the reset is invisible:
the numbers still look like numbers.

`JobStatsRollup` (#255) is the accumulator that survives the delete, and this
handler is its first and only writer. Every row about to be deleted is folded
into per-type deltas first, so lifetime statistics are *rollup + the rows still
in the table* — a quantity the purge is designed never to change. Purging
becomes pure compaction: what is summarised changes, what is true does not.

Duration samples are taken from **succeeded** rows only, matching
`jobs_succeeded_duration_idx` — the partial index the schema builds for exactly
this computation. Folding failures in would make the purged half of the
statistic mean something different from the live half, and the average would
drift on every purge; it is also the less useful number, since a failure's
duration measures how long it took to break. Both counts, by contrast, include
everything: a failure is a job that ran.

**The upserts and the delete are one `$transaction`, per batch.** The two
non-atomic orderings fail differently and both are unacceptable:

- *Delete first, count after* — a crash in between loses the rows **and** their
  contribution. Lifetime totals shrink, and the evidence needed to correct them
  is what was just deleted, so the error is permanent and silent.
- *Count first, delete after* — a crash in between counts the rows **twice**,
  because the next run finds them again, still past the cutoff. Totals inflate,
  and keep inflating on every retry.

Inside the transaction the delete names **the exact ids just counted**, never a
re-run of the `where`: re-running it would delete rows that became terminal
between the select and the delete — rows nothing has counted, which is the
"deleted uncounted" corruption arriving by the back door.

Batches are 5000 rows. That is a lock-duration bound, not a throughput knob:
this job runs on a worker slot in a live application, and a single `DELETE`
over a year of history holds row locks for as long as it takes, with the claim
query other slots run every few seconds waiting behind it. Bounded batches keep
each step short so the queue keeps flowing while the purge runs; the loop is
what makes the total work unbounded while each step stays bounded.

The cutoff has two arms — `finishedAt < cutoff`, or `finishedAt IS NULL AND
createdAt < cutoff` — for the same reason the reaper has a zombie clause, at
the other end of a job's life: `finishedAt` is written by `JobTerminalService`
but not enforced by the database, and `NULL < cutoff` is NULL, so a terminal
row without one would otherwise be unpurgeable forever.

### 7.7 Pending and running rows are never touched, at any age

The `where` filters on terminal status **first** and age second, and that order
is a rule rather than an implementation detail. A `pending` job is work that has
not been done. Its age says something about the *queue* — a backlog, a paused
worker, a `scheduledFor` far in the future, a deployment that was down over the
weekend — and nothing whatsoever about whether the work is still wanted;
deleting it silently cancels it, with no failure, no audit row and no retry.
A `running` row is worse: deleting it orphans an executor that is about to
write a terminal update for a row that no longer exists, and it removes exactly
the rows the reaper exists to reclaim. Age is a retention criterion for
finished work only. An old `pending` row is the reaper's business, or an
operator's — never the purge's.

### 7.8 The temp-file janitor

A handler that downloads, renders or transcodes writes a scratch file, and
deletes it when it is done. A handler whose process is SIGKILLed does not,
because nothing of ours runs when the kernel removes a process. Nothing in the
queue can notice: the reaper reclaims the *row*, and the row is all it knows
about; the bytes on the dead worker's disk are invisible to every query. On a
long-lived host with a small `/tmp` the eventual failure is not "a job failed",
it is every write on the machine failing at once, for a reason that looks
nothing like the job queue.

So the janitor sweeps `os.tmpdir()` on module init and hourly, removing
prefixed entries older than **six hours**. The three decisions worth recording:

- **The prefix is what makes it safe.** `/tmp` is shared with the operating
  system, the package manager and every other process on the box; a sweeper
  that deleted "old files in /tmp" would eventually delete something that
  mattered to someone else. `JOB_TEMP_PREFIX` is derived from `APP_NAME` (this
  template's one rebrand point) rather than written out, which also means two
  applications built from this template on one host get different prefixes and
  neither janitor can touch the other's in-flight files. It falls back to a
  neutral slug rather than an empty string, because an empty prefix makes
  `startsWith` true for every file in the directory — that fallback is a safety
  property, not a nicety. Renaming the application orphans files written under
  the old prefix; they are files in `/tmp` with nothing referring to them, left
  to the operating system's own reaping, and the window is one deploy.
- **Six hours, by mtime.** There is no other signal: an open handle on a file
  this process is writing looks identical, on disk, to a file a dead process
  left behind. `JOBS_JOB_TIMEOUT_MS` defaults to ten minutes and may legitimately
  be raised to hours, so six hours leaves an order of magnitude of headroom
  while bounding wasted disk to a fraction of a day. Deleting a file out from
  under a live handler is a corrupted output and a mysterious failure; keeping a
  stale one costs disk that is reclaimed on the next tick. mtime specifically,
  because a handler that is still writing keeps proving it is alive — atime is
  unreliable under `relatime`/`noatime`, and ctime moves for metadata changes
  that say nothing about progress.
- **Skipped only when the worker mode is `off`** — the opposite gate to the
  reaper's, and for a reason worth stating: a dead *lease* is a shared row in a
  shared database, so any control plane can reap it, but a stale temp *file* is
  on one machine's local disk and only a process that ran a handler could have
  created it. A `JOBS_WORKER_MODE=off` process has nothing of its own in `/tmp`,
  and sweeping anyway would mean a pure control plane deleting prefixed files
  belonging to whichever other process on that host does the work. It reads the
  mode through `parseWorkerMode`, the same parse `JobWorker.mode()` uses, rather
  than injecting the worker: it needs a configuration answer, not the pool.

Errors are swallowed twice over: per file, so one unreadable entry does not
stop the sweep of the hundreds behind it (a file that fails today is retried in
an hour), and per sweep, so an unreadable temp directory produces one warning
rather than an unhandled rejection out of a `@Cron` handler or a failed
bootstrap. The startup sweep matters most of the three schedules: the commonest
way to leak temp files is a process that was killed, and the commonest thing to
happen next is that it is restarted — in a crash loop, which is when files
accumulate fastest.

### 7.9 Configuration

One environment variable and two system settings. The split is the usual one in
this repository: what an operator sets per *process* is an env var; what an
administrator changes at runtime for the *deployment* is a system setting.

| Setting | Where | Default | What it decides |
|---|---|---|---|
| `JOBS_REAPER_ENABLED` | env | `true` | Whether this process reaps abandoned jobs at all (§7.4) |
| `jobs.stuckThresholdMinutes` | system settings | 30 | How long a claimed job may go without progress before it is abandoned |
| `jobs.history.retentionDays` | system settings | 30 | How much terminal history is kept |
| `jobs.history.purgeEnabled` | system settings | `true` | Whether history is purged at all |

The schedules — ten minutes, midnight, hourly, and the janitor's six-hour age
limit — are deliberately **not** configurable. Each is derived from something
that already is: the reaper's interval from the stuck threshold, the janitor's
age limit from the job timeout, and the purge's schedule from the fact that
retention is measured in days. A knob for each would be four more ways to
produce a configuration that contradicts itself, which is the same argument
§6.5 makes for deriving the lease from the timeout rather than configuring it.

### 7.10 All long-running work is a job — the rule, the exemptions, the limit

> #353, epic #345. `apps/api/test/jobs/cron-enqueue-only.spec.ts` is the
> executable form of this section.

§7.5 makes the argument for one job type. Epic #345 decision 1 generalises it:
**every long-running activity in this application is a queue job.** #351 and
#352 moved the database dump; #353 moved the rest — the restore, the backup
subsystem's stale release and retention prune, the retained-database drop, the
stale-upload sweep, the token and device-code cleanups, and both fleet sweeps.
Nine types, eight of them former `@Cron` bodies and one a detached promise.

The shape is always the same, and it is `JobHistoryPurgeTask`'s: **the cron
decides whether work is due and enqueues it; a handler does the work.** A cron
body that still deletes rows itself is the regression, and it is invisible from
inside the file that causes it — the deletion works, nothing crashes, and the
only symptom is that the work is missing from `GET /api/admin/jobs`, occupies no
worker slot, has no timeout, gets no retry, and answers "did it run last night?"
with a log grep.

**What "long-running" means, so this does not read as a loophole.** It means
work with a **duration worth accounting for**: a sweep over a table, a dump, a
network round trip per row, anything that can take minutes or fail in a way
somebody needs to see. It does **not** mean every asynchronous call.
Fire-and-forget notification dispatch — `void this.notifications
.notifyPermissionHolders(...)` and the delivery channels behind it — stays
exactly as it is and is deliberately **not** on the exemption list below,
because it is not an exception to the rule: a queue row per email buys nothing,
the dispatcher already contracts never to reject, and its failures are recorded
as `notification_deliveries` rows rather than lost.

**The exemptions. Three, and adding a fourth means editing this list and the
array in `cron-enqueue-only.spec.ts` in a pull request that argues for it.**

| Cron | Why it must not be a job |
|---|---|
| `jobs/tasks/job-stuck-reset.task.ts` | The lease reaper is **what recovers abandoned jobs**. Recovery that depends on the thing it recovers is not recovery: a queue wedged badly enough to strand a reaper job is exactly the queue that needs reaping. |
| `jobs/tasks/temp-file-janitor.task.ts` | It cleans up after a SIGKILLed worker and sweeps **this process's local disk** (§7.8). A node — or another replica — claiming that job would sweep the wrong filesystem and leave the full one untouched. |
| `nodes/tasks/node-secret-sweep.task.ts` | It destroys the short-lived PostgreSQL roles brokered to worker nodes (#349), and its own header lists three cases the settle-event path structurally cannot cover — the first being "a job settled by the reaper". Making credential revocation depend on the queue means a wedged queue leaks live database credentials for as long as it stays wedged. The reaper's argument, applied to a security control. |

**The honest cost, stated once.** Every converted type is server-only by
derivation (§2), so a `JOBS_WORKER_MODE=system` process still runs all of them
and only `off` does not — and a deployment that executes no jobs at all has
already accepted that its housekeeping happens elsewhere. The kill switches
(`NODE_STALE_OFFLINE_ENABLED`, `NODE_OFFLINE_PRUNE_ENABLED`,
`DB_BACKUP_SCHEDULE_ENABLED`) stayed with the **scheduling** decision, in the
task, and are deliberately not re-asked in the handler: a job that reached a
worker was queued by a process that had already decided to do the work, and
re-asking would let a job queued by one replica be silently dropped by another.

**One behaviour genuinely changed, and it is worth knowing about.** The backup
scheduler's tick used to release stale runs *inline and first*, so a zombie
found at 02:00 freed the single-active-run slot in time for the same tick's
backup to fire. The release is now `db.backup.sweep`, so that tick may still hit
`already_running` and stand down. The backup is **delayed, never lost, and by at
most ten minutes**: the anti-double-fire rule is stateless and recomputed from
the boundary every tick, which is the same property that recovers a window
missed by a process that was down.

**The limit of the test, stated rather than hidden.**
`cron-enqueue-only.spec.ts` reads the *body* of every `@Cron` method and
requires it to queue something and to contain none of the markers of doing work
itself. It does not follow calls into helper methods — a cron calling
`this.fireDueBackup(...)` is trusted, and that method's own spec is what pins
that it only enqueues. It is a tripwire on the shape of a cron body, not a proof
about the whole call graph.

## 8. The admin surface

> #264. `apps/api/src/jobs/job-admin.controller.ts`,
> `apps/api/src/jobs/job-admin.service.ts`, `apps/api/src/jobs/dto/`.

Six routes under `/api/admin/jobs`, and they are the first HTTP surface this
module has ever had — everything through §7 is machinery with no controller.
Two of them read, four repair. (§9 adds two more to the same controller, under
the same permission split and the same declaration-order rule.)

| Route | Permission | What it does |
|---|---|---|
| `GET /api/admin/jobs/stats` | `jobs:read` | Totals, per-status and per-type breakdowns, `scheduled`, `stuckRunning` and the threshold it was counted against |
| `GET /api/admin/jobs` | `jobs:read` | One page of rows, newest first, filterable |
| `POST /api/admin/jobs/retry-failed` | `jobs:write` | Requeues failed jobs, optionally of one type |
| `POST /api/admin/jobs/reset-stuck` | `jobs:write` | Runs the lease reaper (§7) on demand |
| `POST /api/admin/jobs/{id}/retry` | `jobs:write` | Requeues one job |
| `DELETE /api/admin/jobs/{id}` | `jobs:write` | Deletes one job |

Every route is `@Auth({ roles: [ROLES.ADMIN], permissions: [...] })`, and both
permissions are seeded to Admin alone (`prisma/seed-data.ts`). The read/write
split is not decoration: a read of this surface exposes subject ids, provider
keys and the shape of a deployment's workload, and a write can requeue the
entire failed backlog. A later issue that wants to give an operations role
visibility without control has a permission to hand out that does not also hand
out the reset button.

### 8.1 It reimplements nothing — least of all "stuck"

The whole of §7.3 was written so that this section could be short. The admin
service **calls** `stuckRunningWhere()`, `getStuckThresholdMinutes()` and
`resetStuck()`; it does not own a copy of any of them.

That matters most for `stats.stuckRunning`. A dashboard that asked "how many
jobs are stuck?" with its own `where` and a reaper that acts on a different one
are two independent opinions, and they diverge the first time either changes.
The divergence would not even be obvious: the clause an independent
implementation always drops is the second recovery signal — a `running` row
with a NULL `startedAt`, aged by `createdAt` — because it describes a state the
claim statement cannot produce (§7.1). A dashboard missing it reports **0
stuck** for precisely the rows that are stuck forever, which is the worst
possible reading of that tile.

`reset-stuck` likewise delegates to `JobStuckService.resetStuck()` — the same
two-phase give-up/requeue sweep the ten-minute cron runs, reached through the
same method, so the button and the timer cannot drift apart.

The dependency direction is the one §7.3 fixed and this section keeps:
`JobAdminService` depends on `JobStuckService`, never the reverse, and
`JobAdminService` is **not exported** from `JobsModule`. Nothing outside this
module should be able to requeue the backlog.

### 8.2 `reset-stuck` has no default, deliberately

`resetStuckSchema` gives `olderThanMinutes` no `.default(...)`. An empty body
therefore parses to `{}`, and the threshold is resolved by calling
`getStuckThresholdMinutes()` — the `jobs.stuckThresholdMinutes` system setting,
the single read path for that number (§7.9).

A default in the DTO — even one spelled
`DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes` — would be a *second*
place the threshold is decided, and it would win: the parsed value is always
defined, so the settings lookup below it becomes dead code reachable only from
the cron. An operator who moved the setting to 5 minutes would then find the
dashboard button still sweeping at 30, with nothing on screen to explain why.

The parameter still exists for a real case: sweeping tighter than the
configured threshold during an incident without changing a setting the cron
will keep using afterwards. `0` is permitted and means "every running job
matching any recovery signal, at any age" — note that this is **not** the same
as "everything running", because the lease signal is independent of the
threshold.

The response echoes `thresholdMinutes`, so the caller always learns which
number was applied. `GET stats` publishes the same value for the same reason:
`stuckRunning` is a count against a threshold the client cannot otherwise see,
and a UI that hardcoded "(over 30 minutes)" would go on saying 30 after the
setting moved.

### 8.3 The filters, and the two that are more than a column match

`status`, `type`, `subjectType`, `subjectId`, `page` and `pageSize` are exactly
what they look like; `page`/`pageSize` are copied from
`users/dto/user-list-query.dto.ts`, including the 100-row ceiling, so every
paginated list in this API takes the same names. The response is the **flat**
list shape (`{ items, total, page, pageSize, totalPages }`) that `GET /api/users`
and `GET /api/allowlist` already use.

**`scheduled` is a boolean that overrides `status`, not a fifth status.** "In
backoff" is a `pending` row whose `scheduled_for` is still in the future —
which is how §5 records a retry and how the throttle gate records a rate-limit
deferral. Publishing it as `status=scheduled` was rejected: `status` is a
database enum with four values, a filter value that is not one of them cannot
round-trip against a row, and a client would end up with a `status` vocabulary
that differs from the `status` on every row it receives.

Given that it is separate, `scheduled=true` **forces** `status=pending` rather
than intersecting with any `status` sent alongside it. Honouring both — so
`?scheduled=true&status=failed` returns an empty page — is defensible and
useless: the request is a contradiction, and an empty page tells the operator
that no such job *exists*, when the truth is that none *can*.

**`processedWithin` filters on activity, not creation.** It accepts
`4h|24h|7d|30d|all` and matches `COALESCE(finished_at, created_at)`. A plain
`created_at >= …` window would hide the single most interesting row on the
dashboard — a job enqueued two days ago that failed ninety seconds ago — from
the "last 4 hours" view, which is the view an operator opens *while the
incident is happening*. Prisma has no `COALESCE` in a `where`, so it is
expressed as two disjoint arms, `{ finishedAt: { gte } }` OR
`{ finishedAt: null, createdAt: { gte } }`; the second pins `finishedAt` to
null, so no row matches both and no `count` is inflated. `all` is the default
and is a real value rather than an absent parameter, so that "no window" is
visible in the URL and renderable in a dropdown.

**Job payloads are not returned.** A payload is arbitrary JSONB with no size
bound anywhere in the schema, and a hundred of them is a response whose size is
set by whatever a fork's largest handler input happens to be — on an endpoint a
dashboard polls. The fields an operator triages with are all present, and
`subjectType`/`subjectId` exist precisely so that "which thing was this about"
is answerable without the payload. A later per-job detail route can publish it
for one row, where the size is bounded by construction.

`type` is always sent verbatim, with a `typeLabel` alongside it resolved
server-side through `jobTypeLabel()` (§3). The label is not shipped as a map
for the client to join against, because that helper's contract is "an unmapped
type renders as itself, never blank" and a client doing its own lookup can
forget the fallback — rendering an empty cell for exactly the types a fork
cares most about.

### 8.4 The stats cache: ~2 seconds, in-process, deliberately dumb

`stats()` runs four aggregates, and a dashboard polls it. The query rate is
(tabs × replicas ÷ poll interval), and none of those three factors is bounded
by anything this code controls, so the result is cached for **2 seconds**.

The TTL is **shorter than any sensible poll interval**, on purpose. A cache at
or above the poll interval makes the refresh a coin flip — half the polls
return the previous poll's numbers and the page appears to update every other
tick. Two seconds against a poll of five or more means a deliberate refresh
always sees fresh counts, while a burst of tabs arriving together collapses
into one query. It is keyed to nothing and invalidated by nothing, including by
this service's own writes: a retry that appears in the counts instantly and one
that appears two seconds later are indistinguishable to the human who clicked
the button, and an invalidation hook is a thing the next writer forgets. Two
concurrent misses run two queries; sharing an in-flight promise would save one
query per window and add a rejected-promise-poisons-the-cache failure mode that
is strictly worse than the query it saves.

The clock behind the TTL is the injected `JobClock` (§5.9), optional exactly as
it is everywhere else in this module — production provides nothing and gets
`Date.now()`. Without it the expiry test would have to sleep for two real
seconds, which means nobody writes it and the expiry goes unproven.

The shape of the four queries is chosen for the indexes they can use. The two
`groupBy` aggregates — by `status`, and by `type` + `status` — carry **no
`where` at all**, so Postgres can answer both with an index-only scan of
`jobs(status, type, id)`, the covering index §4 added for exactly this pair.
Adding any filter to either would push it onto the heap and turn the cheapest
part of the response into the most expensive. `total` is **summed from the
status breakdown** rather than asked for as a fifth `count()`: a separate count
would be taken at a different instant from the breakdown it heads, so on a busy
queue the headline tile would not equal the sum of the tiles beneath it — the
one arithmetic error a person reading a dashboard always notices and never
forgives. Every status key is zero-filled, because a `GROUP BY` returns no row
for a status nothing is in, and a client rendering `byStatus.failed` would
otherwise show `undefined` exactly when everything is fine.

### 8.5 Retry resets the row completely, and refuses a running job

A retry writes: `status: 'pending'`, `attempts: 0`, `lastError: null`,
`startedAt`/`finishedAt`/`scheduledFor` null, `rateLimitHits: 0`,
`rateLimitedAt` null, and `claimedByNodeId`/`leaseExpiresAt`/`executor`
cleared. One shared object serves both the single-row and the bulk path,
because "retry" must mean the same thing however it was asked for — a bulk
sweep that forgot `leaseExpiresAt` would requeue rows the reaper then
immediately reclaims as stuck, a loop between two subsystems that only appears
under load and only in the path written second.

This is the **one** place in the queue that resets `attempts`. §7.2 explicitly
does not (the give-up phase depends on the count surviving) and the rate-limit
deferral un-charges exactly one attempt rather than clearing them (§5.4).
Leaving it here would mean a job at its budget goes straight back to `failed`
on its next claim, so the button would appear to do nothing. `scheduledFor` is
cleared for the same reason: a retry is an operator overriding the backoff they
can see on the screen. `executor` **is** cleared, as §7.2's requeue phase
clears it and unlike the terminal path which keeps it as history — this row is
going to run again, possibly on the other side, and a stale `executor` on a
pending row is a lie rather than a record.

`dedupKey` is deliberately **not** cleared. See §8.6.

**Both `retry` and `DELETE` answer 400 for a `running` job**, and 404 for one
that does not exist. The refusal is not caution, it is correctness:

- Resetting a running row gives a second worker the same job while the first
  may still be alive on the other end of that claim, and the dedup index cannot
  stop it — the key moves with the row.
- Deleting a running row does not stop its executor. The work carries on, its
  terminal write updates zero rows and is swallowed by `safeTerminalUpdate`
  (§5.7), and the job runs to completion with no record that it existed — while
  its freed dedup key lets a duplicate be enqueued underneath it.

An operator who believes the executor is gone has a correct tool for exactly
that: `reset-stuck`, which checks the lease before it acts.

The guard is a re-read followed by a **conditional** write
(`where: { id, status: { not: 'running' } }`), not a check-then-update by id. A
job that starts running in between is then refused by the write itself rather
than reset under a live executor, and because both paths answer 400 the race is
invisible to the caller.

### 8.6 A retry can collide with the dedup index — that is a 409, not a 500

`jobs_active_dedup_uniq_idx` is unique over `dedup_key` where the row is
`pending` or `running` (§4.1). A `failed` row has dropped out of that predicate,
so its key is free — that is the point of the filter — but moving it **back**
to `pending` re-enters the index, and if another job has taken that key
meanwhile the write is a unique violation.

This is a normal outcome, not a defect: the collision means equivalent work is
already queued or running, which is what the operator was arranging. So:

- A single retry answers **409** with `details.reason = "active_dedup_conflict"`.
- A bulk `retry-failed` **counts** the collision as `skipped` and keeps going.

Clearing `dedupKey` on retry would make every retry succeed, at the cost of
silently permitting a duplicate of work that is already running. Letting the
P2002 escape as a 500 is what happens if nobody thinks about the index at all.

This is also why `retry-failed` is a **loop of single-row updates** rather than
one `updateMany`: a unique violation anywhere in a bulk statement aborts the
entire statement, so one already-queued duplicate would block the retry of
every other failed job in the queue. Each update re-asserts `status: 'failed'`
alongside the id — the same defensive shape §7.2's give-up phase uses — so a
row another admin already moved is a no-op instead of a reset of a job that is
now running happily. The sweep is capped at 500 rows per call and reports
`remaining`, because "how many jobs failed" is not a number this code gets to
bound; it is idempotent, so the honest answer to a larger backlog is "press it
again".

### 8.7 Literal routes are declared before `:id`

Nest matches routes in **declaration order**, not by specificity. The
controller therefore declares `stats`, `retry-failed`, `reset-stuck` and the
list before `:id/retry` and `:id`, with a comment marking the line below which
nothing literal may be added.

Transposing them has no boot-time error and no log line. `POST
/admin/jobs/reset-stuck` would simply be captured as `:id`, and the operator
pressing "reset stuck jobs" would get a 400 about a malformed UUID — or, in a
version where `:id` took a plain string, a 404 for a job whose id is the
literal text `reset-stuck`. `test/jobs/job-admin.integration.spec.ts` drives
that URL through the real router and asserts the **sweep ran**, so a re-order
fails a test rather than an incident.

### 8.8 Errors carry their machine-readable half in `details`

`common/filters/http-exception.filter.ts` rebuilds every error body from a
fixed key allowlist and **derives `code` from the status**, discarding any
`code` an exception supplied. A field added at the top level of a thrown
payload therefore never reaches the client. So the running-job refusal sends
`details: { jobId, status: 'running', reason: 'job_running' }` and the dedup
collision sends `details: { jobId, reason: 'active_dedup_conflict' }`.

## 9. Insights and ETA

> #265. `apps/api/src/jobs/job-insights.service.ts`,
> `apps/api/src/jobs/dto/job-insights.dto.ts`,
> `apps/api/src/jobs/job-counts.util.ts`, and two more routes on the §8
> controller.

§8's `stats` answers *what is the queue doing right now*. It structurally
cannot answer the two questions an operator asks next — **how long will this
take**, and **is it getting faster or slower** — because both need history,
and `stats` deliberately runs no query that carries a `where`.

Two routes answer them:

| Route | Permission | What it does |
|---|---|---|
| `GET /api/admin/jobs/insights?windowDays=` | `jobs:read` | Live counts, duration percentiles over a bounded window, a per-type completion estimate, and all-time totals |
| `POST /api/admin/jobs/insights/reset-history` | `jobs:write` | Clears `JobStatsRollup`; live rows untouched |

`windowDays` defaults to 7 and is capped at 90. Both routes are declared with
the other literals, **above** `:id` — §8.7's rule, which is about the rule and
not about which literals happen to be safe today.

### 9.1 ⚠ Every query is a pure `SELECT`, and that is why this endpoint exists

This is the load-bearing property of the whole section, and it is stated in the
service's file header in the same words.

The endpoint reports on a table a worker pool is actively claiming rows out of.
The claim (§4.4) is an `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`:
it takes `ROW EXCLUSIVE` on `jobs` and holds row locks for the life of its
transaction. Anything here that took a conflicting lock would not merely be
slow — **it would block the queue it is reporting on**, and it would do so
exactly when an operator opens the dashboard, which is exactly when the queue
is already in trouble. A monitoring surface that can stall the thing it
monitors is worse than no monitoring surface.

So every statement is a plain `SELECT` — Prisma `groupBy`, `count`, `findMany`,
and two `$queryRaw`s whose text begins with `SELECT`. A plain `SELECT` takes
`ACCESS SHARE`, which conflicts with nothing but `ACCESS EXCLUSIVE`
(`DROP`/`ALTER TABLE`), and under READ COMMITTED it does not wait behind
`FOR UPDATE` row locks either: it sees the last committed version and moves on.
Insights and a saturated worker pool are mutually invisible.

The rules that keep it that way, for anyone extending the file:

- **No `FOR UPDATE`, `FOR SHARE`, `LOCK TABLE` or advisory lock.** Ever.
- **No write of any kind** — not a counter bump, not a `last_viewed_at` stamp,
  not an upsert into a cache table. `resetHistory()` is the one write in the
  service and it is a separate, separately authorized route.
- **No `$executeRaw`.** Raw SQL is a `$queryRaw` starting with `SELECT`.

Both halves are proved. `src/jobs/job-insights.service.spec.ts` asserts that no
statement the service issues *contains* a lock or a mutating verb — the half a
database cannot prove, since it never sees SQL that was not sent.
`test/jobs/job-insights.db.spec.ts` asserts the other half against real
Postgres: it holds `FOR UPDATE` row locks open on claimed rows in one
transaction and runs the entire computation from a second connection, which
must return complete, correct numbers without waiting.

### 9.2 On demand and in parallel — no snapshot table, no cron, no polling

Eight queries, issued together through one `Promise.all`, all answered from
indexes the schema already has. Nothing is precomputed and nothing is kept.

`Promise.all` is a **correctness** choice before it is a latency one: the live
backlog, the window's percentiles and the lifetime totals must describe very
nearly the same instant, or the ETA is computed from a queue depth that has
already moved — the same argument §8 makes for summing `stats.total` out of its
first aggregate rather than counting it separately.

There is deliberately no cache. §8.4's two-second roll-up exists because a
*dashboard polls* `stats`; insights is opened by a person, so there is nothing
to collapse.

### 9.3 What the four blocks contain

**`live`** — totals by status and a `byType` breakdown, plus three counts an
operator triages with: `scheduled` (pending, with a future `scheduled_for`),
`rateLimited` (`rateLimitHits > 0` and **non-terminal** — a finished job is not
being held up by anything), and `retried` (`attempts > 1`, terminal rows
included, because "how much of this history needed a second go" is the
question).

**`history`** — over **succeeded** jobs inside the window: `samples`, `avgMs`,
`p50Ms` and `p95Ms` via `PERCENTILE_CONT` in raw SQL, plus `throughputPerMin`
computed from the **last hour** rather than from the window (averaging
throughput over a week turns a queue that stopped an hour ago into one that
looks healthy). `overall` and `byType` come from **one scan**, via
`GROUP BY GROUPING SETS ((type), ())`: the grand total's percentiles cannot be
derived from the per-type rows — a percentile is a position in a sorted
distribution — so they have to be their own aggregate, and computing them in
the same scan is what guarantees `overall.samples` equals the sum of
`byType[].samples`. `PERCENTILE_CONT`, not `PERCENTILE_DISC`: the continuous
form interpolates, so a slowing job type moves p95 smoothly instead of jumping
between two observed durations.

`avgMs`, `p50Ms` and `p95Ms` are **nullable, and zero would be a lie**. A type
with no successes in the window has no average; `0` renders as "this job type
is instant" and, worse, is a number the ETA multiplies a backlog by. `samples`
is the field that says whether the other three mean anything.

**`eta`** — per type, `remaining = pending + running` (a running job is still
work the operator is waiting for), times that type's own average, divided by
the configured worker concurrency. Types with nothing outstanding are omitted:
this array is a to-do list.

The average is resolved in three steps and the response **says which one won**:

| `basis` | Where `avgMs` came from | What it means |
|---|---|---|
| `live` | This type's own succeeded jobs in the window | The estimate is a measurement |
| `partial` | The overall average across all types | The estimate is an analogy, and a bad one whenever job types differ in cost |
| `none` | A shipped constant (`FALLBACK_JOB_DURATION_MS`) | The estimate is a placeholder |

Publishing only the milliseconds would make those three indistinguishable on
the wire, and a UI would render all of them with the same confidence. With
`basis` a client can say "about 4 minutes", "roughly 4 minutes, based on other
job types", and "no idea yet" from one field.

The divisor is read through `resolveWorkerConcurrency()`, **exported from
`job.worker.ts`** — the same one read path `JobWorker` itself uses, extracted
for exactly the reason `parseWorkerMode` was (§6.3). An ETA computed against a
different number from the one the pool actually runs stays plausible while
being wrong by a constant factor, which is the kind of error nobody catches by
looking. It is floored at 1 for the divisor and published **raw**, so a client
can see a `concurrency` of 0 and say the queue is not draining at all.

**`lifetime`** — all-time succeeded / failed / total / average per type,
merging `JobStatsRollup` with the live rows:

```
succeeded = rollup.succeededCount + (live succeeded rows)
failed    = rollup.failedCount    + (live failed rows)
avgMs     = (rollup.sumDurationMs + liveSum)
            / (rollup.durationSamples + liveSamples)
```

### 9.4 The lifetime merge cannot double count, and §7.6 is the reason

The merge is only correct because of the invariant the purge establishes: it
folds a batch into the rollup and **deletes that exact batch inside one
`$transaction`**, by the ids it just counted. So at any instant a terminal job
is in exactly one of two places — still a `jobs` row, or an increment inside an
accumulator — never in both and never in neither. Lifetime is therefore a plain
sum of the two halves.

The half that is easy to get wrong is the **denominator**, and the rule is
`foldDeltas`': a duration sample is a **succeeded** row with both timestamps and
a **non-negative** duration. Failures count towards `failedCount` and
contribute nothing to the average (a failure's duration measures how long it
took to break, which is dominated by timeouts); a negative duration — an NTP
step backwards between the claim and the terminal write — drops out of the sum
**and** the sample count together, because counting a sample whose duration was
discarded drags the mean towards zero. The live query repeats that predicate
exactly (`finished_at >= started_at`). If the two ever disagree, a type's
lifetime average changes silently every time a purge runs.

The live **counts** are not queried separately at all: they are read out of the
same unconditional `groupBy(['type','status'])` the `live` block already ran,
so the two blocks of one response cannot report different live totals. And the
merge iterates the **union** of the two key sets — a type purged long ago has a
rollup row and no live rows; a type introduced yesterday has live rows and no
rollup row — because iterating either side alone drops half the deployment's
history in the direction nobody checks, since the number that remains still
looks like a number.

### 9.5 Counts and averages, never lifetime percentiles

`lifetime` publishes no percentiles, and that is a statement about what
survives summarisation rather than a gap.

A rollup row is four accumulators: two counts, a sum and a sample count. Those
are exactly the quantities that can be merged — counts add, and a mean can be
reconstructed from a sum and a denominator. **A percentile cannot.** p95 is a
position in a sorted distribution, and the distribution was deleted. No scheme
of storing "the p95 at purge time" and combining it with a live p95 produces
the p95 of the union; it produces a number that *looks like* one, which is
strictly worse than publishing nothing, because a wrong p95 is indistinguishable
from a right one.

So the honest split is: **`history` is a distribution over a bounded window**,
where the rows still exist to be sorted; **`lifetime` is totals over all time**.
Neither pretends to be the other.

### 9.6 The window is bounded, and the ceiling is a 400 rather than a clamp

`history` scans succeeded jobs whose `finished_at` falls inside the window,
capped at 90 days. Computing a percentile means *sorting* the sample set, so an
unbounded percentile query is one whose cost grows with a table nothing in this
file controls — on an endpoint whose entire justification is that it cannot
hurt the queue.

A larger `windowDays` is **rejected with a 400**, not silently reduced. An
operator who asked for a year and got a quarter, in a response that looks
exactly like the one they asked for, would compare it against last month's
figures and draw a conclusion about a window that was never computed. The bound
lives on the Zod schema, so the global pipe answers before any query runs; the
service clamps as well, because the bound belongs to the query's cost rather
than to one route's validation and a future non-HTTP caller must not escape it.

### 9.7 The `where` clauses are shaped to #255's partial indexes

Two partial indexes exist in `20260906120000_add_jobs/migration.sql` for
precisely these queries, and a partial index is usable only when the query's
predicate **implies** the index's. That makes the exact spelling load-bearing
rather than stylistic:

- `jobs_attempts_gt1_idx ON jobs(attempts) WHERE attempts > 1` — so `retried`
  is `attempts > 1`, not `attempts >= 2` and not `attempts != 1`. All three
  describe the same integers; only the first matches the predicate as written.
- `jobs_succeeded_duration_idx ON jobs(finished_at, started_at, type) WHERE
  status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL`
  — so **both** raw queries repeat all three predicates, even though the NULL
  tests look redundant beside an arithmetic expression that would yield NULL
  anyway. Every column either query touches is *in* that index, so both are
  answerable without visiting the heap and the window filter is a range scan on
  its leading column. Dropping either NULL test turns an index-only scan into a
  sequential scan of the whole table — and the query keeps returning the right
  answer while doing so, which is why nobody notices.

The two `groupBy` aggregates stay unfiltered for §8.4's reason:
`jobs(status, type, id)` covers them, and any `where` pushes them onto the heap.

### 9.8 Durations are cast to `double precision` at the database

`EXTRACT(EPOCH FROM interval)` returns `numeric` on PostgreSQL 14 and later,
and Prisma maps `numeric` to a `Decimal` **object** — so `avg()` and `sum()`
over the uncast expression would serialize into the response body as
`{"s":1,"e":3,…}`. Every count is likewise cast `::int`, because `count(*)` is
`bigint`, which Prisma hands back as a JS `bigint`, which `JSON.stringify`
refuses outright. This is the same trap the schema's `sumDurationMs` comment
warns about: the response would not fail to be *built*, it would fail to be
*sent*.

### 9.9 `reset-history` clears accumulators, never jobs

`POST /api/admin/jobs/insights/reset-history` deletes every `JobStatsRollup`
row and returns `{ reset }` — **rows, not jobs**: one per job type, however
many millions each summarised.

Live rows are untouched. No job is deleted, no job changes state, and every
live-derived number in the insights response — `live`, `history`, `eta`, and
the live half of `lifetime` — is identical afterwards. Lifetime totals simply
restart from the rows still in the table.

It sits on the **write** side of the permission split even though it changes no
job, because what it destroys is unrecoverable by any other means: the evidence
needed to rebuild an accumulator is exactly what the purge deleted. That is
also why it exists at all — a rollup corrupted by a botched migration, or a
staging database seeded with fictional history, has an all-time average that is
wrong forever, and starting the accumulators again is the only available
repair.

## The extension recipe

The operational version of this lives in
`apps/api/src/jobs/handlers/README.md`, which is where a fork's author will
actually look. In summary:

1. **Write the class.** Implement `JobHandler`: a unique `type` string and a
   `process(job)` that throws to fail.
2. **Self-register.** `this.registry.register(this)` in the handler's own
   `onModuleInit()`.
3. **Provide it.** Add the class to the `providers` of the module that owns
   the feature, and `imports: [JobsModule]` for the registry.
4. **Enqueue.** Call `JobsService.enqueue()` at the real trigger, with a
   `payload` of **identifiers**, not copies of data — the job may run minutes
   later, and a row it names should be re-read at run time rather than carried
   inside a payload that can go stale. Jobs of the same type against the same
   subject collapse onto one active row by default; pass `skipDedup: true`
   when several such jobs are legitimately distinct work (§4.1–4.2).

No migration, no enum arm, no queue wiring, and the type appears in the admin
dashboard automatically. Optionally add a display label in
`job-type-labels.ts`; an unmapped type renders as itself (§3).

To make a type node-eligible, add **both** `nodeResultSchema` and
`persistNodeResult` — and nothing else (§2).

The worked examples are `handlers/example-echo.handler.ts` (the smallest thing
a handler can be) and `handlers/job-history-purge.handler.ts` (§7.5), which is
the same four steps applied to work that actually does something: a settings
read, a batched loop, a transaction, and a scheduling task that enqueues it.

## Notifying somebody a job gave up

A job that exhausts its retry budget raises `jobs.job_failed`, addressed to
whoever holds `jobs:read`. Nothing in this document changes for it: the event
is raised by a **listener** on `job.settled`
(`apps/api/src/notifications/ops/job-failure-notifier.ts`), registered on the
notifications side of the seam precisely so `JobsModule` keeps no dependency on
notifications and `JobTerminalService` keeps no outbound side effect. Why a
listener, why the audience is a permission, and why an ordinary retry or
deferral raises nothing are in
[`browser-notifications.md` §10](browser-notifications.md#10-operational-events-an-audience-that-is-a-permission-not-a-user).

## Rejected alternatives

- **Redis / BullMQ.** A second datastore on a template's default path, paid
  for by every fork whether or not it uses the queue. This repository already
  requires PostgreSQL, and `FOR UPDATE SKIP LOCKED` is a correct claim
  primitive.
- **`@JobHandler()` decorator + `DiscoveryService`.** More magic, harder to
  trace, still needs a registry underneath, and a third mechanism for a job
  this repo already does explicitly twice (§1.2).
- **A `nodeEligible: boolean` flag.** Can disagree with the members it
  describes; deriving eligibility makes the wrong state unrepresentable
  (§2).
- **A result object from `process` (`{ success, error }`).** Copies the
  object-processor contract into a place whose failure semantics are
  different, and makes "silently reported success for work that never
  happened" the *default* outcome of forgetting an `await` (§1.1).
- **Throwing on a duplicate `type`.** Turns a legitimate fork-level override
  into a boot failure for the whole application (§1.2).
- **A required `label` on `JobHandler`.** Enlarges the contract every future
  handler must satisfy, for something the worker never reads (§3).
- **`findFirst`-then-`create` dedup.** A check-then-act race that fails
  exactly when dedup matters — two concurrent enqueues both see no duplicate
  and both insert. Superseded by the partial unique index from #255, which
  makes the check atomic with the insert (§4.1).
- **`SELECT … FOR UPDATE` then a separate `UPDATE` to claim.** Two
  statements, a wider window, and no gain — the second re-finds rows the
  first already identified (§4.4).
- **An advisory lock around the claim.** Serialises every claimer in the
  fleet through one lock; `SKIP LOCKED` is exactly the primitive for "give me
  a row nobody else is working on" (§4.4).
- **An in-process mutex around claiming.** What the source application
  started with. Serialises claims within one process only, so it double-claims
  the moment a second replica or a remote node appears — the bug this design
  exists to avoid (§4.4).
- **Charging `attempts` on failure rather than at claim.** A job that kills
  its process never reaches a failure path, so its budget would never be
  charged and it would crash-loop the container forever (§4.5).
- **Letting each executor write its own terminal state.** Two call sites, two
  answers to every retry question, and a divergence nothing reports: the node
  path forgetting to un-charge an attempt shows up only as long backfills
  quietly failing permanently on rate limits (§5.1).
- **One combined counter for attempts and rate-limit hits.** A long backfill
  against a rate-limited provider would exhaust it in the first minute and
  fail permanently for a transient reason that was never its fault (§5.3).
- **Un-charging the claim increment with `{ decrement: 1 }`.** Not idempotent,
  and the terminal write can genuinely run twice — applied twice it grants an
  attempt the job never earned, and over a long throttled backfill drives
  `attempts` negative (§5.4).
- **Emitting an event on every job state change.** Every subscriber would have
  to re-implement "is this actually over" from `status`, `attempts`,
  `rateLimitHits` and the budget config, and each copy is somewhere for the
  two to disagree (§5.8).
- **Full jitter, or no jitter, on the retry backoff.** Without jitter every
  job deferred by one provider outage retries in the same millisecond, herd
  intact; with full jitter a job can retry immediately after being deferred
  (§5.5).
- **A database- or Redis-backed shared throttle gate.** A network round trip
  in front of every job on every tick, permanently, to improve behaviour
  during an outage — and a datastore this template deliberately does not
  require. The durable half is already shared, because `scheduledFor` is
  (§5.6).
- **Throwing out of the terminal write when the database is unavailable.** It
  would propagate into the worker's slot accounting; a slot lost that way is
  lost for the life of the process. Logging and swallowing leaves the row
  `running` for the reaper, which is bounded and recoverable (§5.7).
- **One loop claiming a batch of N instead of N independent loops.** A batch
  barrier: the loop cannot claim again until its slowest member finishes, so
  with mixed job durations effective concurrency collapses toward 1 and N-1
  slots sit idle behind one long job (§6.1).
- **Failing closed on an unrecognised `JOBS_WORKER_MODE`.** A typo in one env
  file would silently stop every background job in the deployment, and the
  symptom arrives hours later as "jobs stopped running". Behaving as the
  default and warning once is the recoverable failure (§6.3).
- **Capturing the eligible types at bootstrap.** Makes `system` mode depend on
  module-resolution order — a handler registering after the worker's module
  resolved is simply missing from a list computed once — which is the same
  invisible coupling explicit self-registration exists to avoid (§6.3).
- **A bare `Promise.race([work, timeout])` for the per-job timeout.** Work
  that rejects after losing the race has no handler left, which is an
  `unhandledRejection` and, in Node's default posture, a dead process: a
  timeout that kills the API server on the next slow provider call (§6.5).
- **A separate `JOBS_LEASE_MS`.** Two knobs whose only requirement is
  `lease > timeout` are two knobs an operator can set into a state where the
  lease reaper requeues jobs that are still running fine. Deriving the lease
  from the timeout makes that unrepresentable (§6.5).
- **Retrying a job whose type has no registered handler.** The retry re-enters
  the same process, finds the same registry and reaches the same conclusion,
  having spent the attempt budget to learn nothing (§6.6).
- **Waiting for in-flight jobs indefinitely on shutdown.** `onModuleDestroy`
  runs against an orchestrator's SIGKILL countdown; a bounded grace plus a
  `running` row for the lease reaper turns a hard kill into one delayed job
  (§6.7).
- **A fixed timeout instead of a lease.** "Anything `running` for more than N
  minutes is dead" cannot distinguish a slow job from a dead one: the only
  evidence it has is elapsed time, so the threshold must be set longer than the
  slowest legitimate job in the deployment — and a job that exceeds it is
  reaped and re-run while it is still working, producing duplicate work. A
  lease is **renewable**, so a long job that is still alive can say so, and its
  expiry is a statement by the executor rather than a guess about it. The aged
  clause survives as one signal of four (§7.1) precisely because it is the
  weak one: it is the fallback for rows whose lease was never written.
- **Requeueing a stuck job unconditionally.** A job that kills its executor —
  an OOM kill is the ordinary way — never reaches the terminal path, so nothing
  counts it there. Requeueing without checking the budget turns that into
  *claim → die → reap → claim → die* forever, at one crash per threshold, with
  the container restarting under it: a crash loop caused by the recovery
  mechanism. The give-up phase bounds it to `JOBS_MAX_ATTEMPTS` crashes, and it
  is only implementable because `attempts` is charged at claim time (§7.2).
- **Deleting history without the rollup.** `jobs` is both a work list and the
  only record of all-time throughput. A plain `deleteMany` resets per-type
  counts and average durations every retention period, invisibly — the numbers
  still look like numbers — so "how many exports have we ever run?" would
  answer differently depending on when the purge last ran (§7.6).
- **Counting the rows and deleting them in two statements.** A crash between
  them either loses rows *and* their contribution (totals shrink, permanently,
  with the evidence deleted) or counts them twice on the next run (totals
  inflate, and keep inflating). One transaction per batch makes both states
  unrepresentable (§7.6).
- **Purging by age alone, including `pending` rows.** A pending job is work
  that has not been done; its age describes the queue, not the job's
  usefulness. Deleting it silently cancels work with no failure, no audit row
  and no retry — and deleting a `running` row orphans an executor that is about
  to settle a row that no longer exists (§7.7).
- **Gating the lease reaper on `JOBS_WORKER_MODE`.** A pure control plane
  (`off`, in front of a node fleet) is the deployment where dead leases are
  most likely and the only component that *can* reap them: the nodes have no
  database access. Gating there leaves the fleet's abandoned rows to nobody
  (§7.4).
- **Making the history purge another `@Cron` that deletes inline.** It would
  reproduce all four weaknesses this document opens with — no retry, no record,
  no observability, and it competes with request handling — for the one job
  type where the queue is already available (§7.5).
- **A hard-coded temp-file prefix.** Two applications built from this template
  on one host would share it, and each janitor would delete the other's
  in-flight scratch files. Deriving it from `APP_NAME` costs nothing and makes
  the collision impossible; an empty prefix (the degenerate case) would make
  the janitor an indiscriminate `/tmp` sweeper, which is why it falls back to a
  neutral slug (§7.8).
- **Configurable schedules for the three hygiene tasks.** Each interval is
  derived from a number that is already configurable — the reaper's from the
  stuck threshold, the janitor's age limit from the job timeout — so a separate
  knob is one more way to configure a contradiction, the same argument
  §6.5 makes for the lease (§7.9).
- **A `scheduled` job status.** "Waiting out a backoff" is a `pending` row
  with a future `scheduled_for`, not a fifth enum value. A filter value that
  no row can ever carry gives a client a `status` vocabulary that differs from
  the `status` on every row it receives; the boolean filter that replaced it
  keeps the two vocabularies identical (§8.3).
- **Intersecting `scheduled=true` with a conflicting `status`.** Answering
  `?scheduled=true&status=failed` with an empty page tells the operator that no
  such job exists, when the truth is that none can. Overriding answers the
  question they meant (§8.3).
- **Filtering the list by `created_at`.** It hides the most interesting row on
  the dashboard — a job enqueued days ago that failed a minute ago — from the
  short windows, which are the windows an operator opens during an incident.
  The filter is on `COALESCE(finished_at, created_at)` instead (§8.3).
- **A default for `reset-stuck`'s `olderThanMinutes`.** It would be a second
  place the stuck threshold is decided, and it would win: the parsed value is
  always defined, so the settings read below it becomes dead code reachable
  only from the cron, and the dashboard button would keep sweeping at 30 after
  an operator moved the setting to 5 (§8.2).
- **Reimplementing "which rows are stuck" in the admin service.** The
  dashboard's number and the rows a reset touches would be two independent
  opinions. The clause an independent implementation drops is always the
  zombie arm — a `running` row with a NULL `started_at` — so the tile would
  read 0 for exactly the rows that are stuck forever (§8.1).
- **`retry-failed` as one `updateMany`.** A dedup collision anywhere in a bulk
  statement aborts all of it, so a single already-queued duplicate would block
  the retry of every other failed job in the queue. The loop of single-row
  updates counts the collision as `skipped` and keeps going (§8.6).
- **Clearing `dedup_key` on retry.** It would make every retry succeed, by
  removing the row from the active-dedup index — silently permitting a
  duplicate of work that is already running (§8.6).
- **Force-resetting or deleting a `running` job.** Neither stops the executor
  that holds the claim. A reset hands a second worker the same job; a delete
  lets the work run to completion with no row to record it, while its freed
  dedup key admits a duplicate underneath it. `reset-stuck` is the correct
  tool, because it checks the lease first (§8.5).
- **Returning job payloads in the list.** Unbounded JSONB times a page size of
  a hundred, on an endpoint a dashboard polls, with the response size set by
  whatever a fork's largest handler input happens to be (§8.3).
- **A stats cache at or above the dashboard's poll interval.** Half the polls
  would return the previous poll's numbers and the page would appear to update
  every other tick. Two seconds is deliberately shorter than any sensible poll
  (§8.4).
- **A cron-refreshed snapshot table for insights.** The obvious "make it
  fast" move — a `job_insights_snapshot` row rewritten on a timer that the
  endpoint then reads — and rejected on four counts, the first fatal on its
  own. (1) It is a **writer on the hot path**: the refresh would write into the
  same table the worker pool claims from, forever, in every deployment
  including the overwhelming majority whose queue nobody is watching — trading
  away §9.1, the single reason the endpoint is safe, to speed up a page nobody
  has open. (2) It answers a question nobody asked: a snapshot is stale by its
  refresh interval, and queue depth is the input that changes fastest, so
  "estimated 4 minutes" would be derived from a backlog that has since halved —
  not a cached answer but a wrong one. (3) `windowDays` makes the answer a
  function of the request, so the cache would need a key space the caller
  supplies, or the parameter would have to go. (4) It is a migration, a table,
  a scheduled task and a staleness rule, for an endpoint a human opens by hand
  a few times a week (§9.2).
- **Storing percentiles in `JobStatsRollup`.** Counts add and a mean can be
  reconstructed from a sum and a denominator; a percentile is a position in a
  sorted distribution, and the distribution was deleted. Combining a stored
  "p95 at purge time" with a live p95 does not produce the p95 of the union —
  it produces a number that looks like one, which is worse than publishing
  nothing, because a wrong p95 is indistinguishable from a right one (§9.5).
- **Unbounded lifetime percentiles.** "p95 over all time" sounds strictly
  better than "p95 over 7 days" and is two bad things at once. After a purge it
  cannot be computed at all — so it would silently mean "since the last purge",
  a window that moves with the retention setting and is stated nowhere — and
  where history *has* been kept it degrades exactly as the deployment grows, on
  an endpoint whose whole justification is that it cannot hurt the queue
  (§9.6).
- **Silently clamping an out-of-range `windowDays`.** The response would look
  exactly like the one that was asked for, over a window that was never
  computed, and the operator would compare it against last month's figures
  (§9.6).
- **Injecting `JobWorker` into the insights service for the ETA divisor.**
  What that service needs is a configuration answer, not the worker pool, and
  anything holding the pool can stop it — the same argument the temp-file
  janitor makes for reading the mode through `parseWorkerMode` (§9.3, §6.3).
- **Making the database backup a job type.** Recorded in epic #254's own
  locked decisions and repeated here because it is the obvious thing to try:
  the stuck-job threshold would reset a 30-minute `pg_dump` and start a
  *second concurrent* one. A dedicated run table with its own heartbeat is
  the correct shape, and it is why `database_backup_runs` is not a `jobs`
  row.

## Verification

What #259 proves, and by what:

| Claim | Covered by |
|---|---|
| The example handler self-registers and appears in `types()` | `job-handler.registry.spec.ts` — boots `JobsModule` through `Test.createTestingModule(...).init()`, so the real `onModuleInit` hook runs |
| `serverOnlyTypes()` includes a neither-member handler and excludes a both-member one | `job-handler.registry.spec.ts` |
| A handler carrying exactly one of the two members is server-only | `job-handler.registry.spec.ts`, both directions (schema-only, persist-only) |
| A duplicate `type` warns and the last registration wins | `job-handler.registry.spec.ts` — asserts the `Logger.warn` call and that `get()` returns the second instance |
| An unmapped type renders as itself | `job-type-labels.spec.ts` |
| The module graph still boots with `JobsModule` registered | `npm run openapi:dump` (preview-mode boot of `AppModule`) plus `npm run openapi:lint` |

What #260 proves, and by what. Everything in the first block runs against a
**real Postgres** (`npm run test:db`, which CI's `smoke` job invokes after
`prisma:migrate`); everything in the second runs without one:

| Claim | Covered by |
|---|---|
| Two claimers racing for one row: exactly one wins, every round | `test/jobs/job-claim.db.spec.ts` — two independent `PrismaClient`s, ten rounds, deterministic |
| Concurrent claimers over a seeded batch get a disjoint partition: no id twice, none lost | `test/jobs/job-claim.db.spec.ts` — an eight-way overlapping burst, then a drain; the union is asserted against what was seeded |
| `ORDER BY priority ASC, created_at ASC` is honoured: a priority-0 job enqueued later is claimed before a priority-100 job enqueued earlier | `test/jobs/job-claim.db.spec.ts` |
| Oldest-first within one priority (asserted as a **set** — see §4.4 on `RETURNING` ordering) | `test/jobs/job-claim.db.spec.ts` |
| A job scheduled for the future is not claimed; the same job is once that time passes | `test/jobs/job-claim.db.spec.ts` |
| `attempts` is 1 immediately after the claim, before any handler runs, and is durable | `test/jobs/job-claim.db.spec.ts` |
| A claimed row carries `running`, `startedAt`, the lease, the executor and the node id | `test/jobs/job-claim.db.spec.ts` |
| Every `RETURNING` alias matches a generated `Job` field | `test/jobs/job-claim.db.spec.ts` (key set of a row Postgres produced) and `test/jobs/job-model-fields.spec.ts` (key set of `JOB_CLAIM_COLUMNS` against `Prisma.JobScalarFieldEnum`) |
| Concurrent `enqueue` of one dedup key yields ONE row and BOTH callers receive it | `test/jobs/jobs-enqueue.db.spec.ts` — two clients head-to-head, plus a ten-way burst |
| `skipDedup: true` yields two rows, both with a NULL key | `test/jobs/jobs-enqueue.db.spec.ts` |
| Dedup collapses onto a `running` job, and a settled job frees its key | `test/jobs/jobs-enqueue.db.spec.ts` |

| Claim | Covered by |
|---|---|
| Both claim short circuits return `[]` **without a round trip** | `src/jobs/job-claim.service.spec.ts` — asserts `$queryRaw` was never called, which a database test cannot see |
| Every runtime value is a bound parameter; none appears in the SQL text | `src/jobs/job-claim.service.spec.ts` — asserts on `Prisma.Sql`'s `values` and `sql` |
| A P2002 on any other constraint propagates; a non-conflict error propagates | `src/jobs/jobs.service.spec.ts` |
| The re-read losing its own race retries rather than returning a settled job | `src/jobs/jobs.service.spec.ts` |
| The retry is bounded and gives up loudly | `src/jobs/jobs.service.spec.ts` |
| `recordProvider` swallows a failed audit write | `src/jobs/jobs.service.spec.ts`, and end to end in `test/jobs/jobs-enqueue.db.spec.ts` |
| Enqueue never pre-checks with `findFirst` before inserting | `src/jobs/jobs.service.spec.ts` |
| `JOB_CLAIM_COLUMNS` covers exactly the generated `Job` field set | `test/jobs/job-model-fields.spec.ts` (the compile-time half is the `Record<keyof Job, string>` type itself) |

What #263 proves, and by what. The split between the two blocks is the point.
The first runs against a **real Postgres** (`npm run test:db`), because both of
its claims are about what the database does: which rows a `where` matches
(a mocked `updateMany` returns whatever the test told it to, so a unit test of
`stuckRunningWhere` can only assert the shape of an object — and the zombie
clause would keep passing that assertion while matching nothing, since
`NULL < threshold` is NULL rather than false), and whether a `$transaction`
rolls back (a mocked `$transaction` rolls nothing back). The second block is
everything a database makes *harder* to test: the `where`'s exact shape, the
per-row give-up message, the settings fallbacks that only happen when a read
throws, and a filesystem sweep.

| Claim | Covered by |
|---|---|
| Each of the three stuck signals reclaims its own row, with the other two unable to fire | `test/jobs/job-stuck-reset.db.spec.ts` — one test per signal, including the `startedAt IS NULL` zombie aged by `createdAt` with a NULL lease |
| A healthy `running` job — young, stamped, holding a live lease — is left alone | `test/jobs/job-stuck-reset.db.spec.ts` |
| `pending`, `succeeded` and `failed` rows are never touched, however old | `test/jobs/job-stuck-reset.db.spec.ts` |
| A row at (or over) the attempt cap becomes `failed`, with its own attempt count in the message, keeping `executor` | `test/jobs/job-stuck-reset.db.spec.ts` |
| A row under the cap returns to `pending` with claim, lease and executor cleared, and `attempts` untouched | `test/jobs/job-stuck-reset.db.spec.ts` |
| A mixed sweep splits between the two phases in one pass, and a second sweep is a no-op | `test/jobs/job-stuck-reset.db.spec.ts` |
| Only terminal rows past the cutoff are deleted; a terminal row with no `finishedAt` is aged by `createdAt` | `test/jobs/job-history-purge.db.spec.ts` |
| A batch failing **mid-transaction** leaves counts and rows consistent: nothing deleted uncounted, nothing counted undeleted | `test/jobs/job-history-purge.db.spec.ts` — the delete is rigged to throw from inside the real transaction, and the rollup is read *through the transaction* first, so the assertion cannot pass vacuously |
| A pre-existing rollup survives a failed batch unchanged, and the retry counts each row exactly once | `test/jobs/job-history-purge.db.spec.ts` |
| Lifetime totals (rollup + live rows) are identical before and after a purge, and after three purges | `test/jobs/job-history-purge.db.spec.ts` |

| Claim | Covered by |
|---|---|
| `stuckRunningWhere` carries all four signals, OR'd, each compared against its own instant (ages against the threshold, an expired lease against `now`, an implausible one against the lease horizon), and no age clause ever matches a leased row | `src/jobs/job-stuck.service.spec.ts`, and against real rows in `test/jobs/job-lease-renewal.db.spec.ts` |
| A continuously renewed job is never requeued at any age; renewal refuses an expired lease, a requeued row and a row a node now holds | `test/jobs/job-lease-renewal.db.spec.ts`, `src/jobs/job-lease.service.spec.ts` |
| The in-process worker renews for the whole of `process()`, on the type's own lease, and its ticker is cancelled by `stop()` | `src/jobs/job.worker.spec.ts` |
| The give-up phase runs one row at a time so each message names that job's attempts; neither phase writes `attempts` | `src/jobs/job-stuck.service.spec.ts` |
| A settings read that throws falls back to the shipped threshold; a missing `jobs.maxAttempts` falls back to 3 rather than `NaN` | `src/jobs/job-stuck.service.spec.ts` |
| The reaper runs under **every** worker mode, including `off`, and stops only for `JOBS_REAPER_ENABLED=false` | `src/jobs/tasks/job-stuck-reset.task.spec.ts` |
| A failed sweep is swallowed rather than rejecting out of the `@Cron` handler | `src/jobs/tasks/job-stuck-reset.task.spec.ts`, and the same for the purge scheduler |
| The purge selects terminal statuses only, and both age arms | `src/jobs/handlers/job-history-purge.handler.spec.ts` |
| Duration samples come from succeeded rows only; a negative duration drops both the sum and the sample | `src/jobs/handlers/job-history-purge.handler.spec.ts` |
| The batch counts and deletes inside one `$transaction`, deleting the exact ids it counted | `src/jobs/handlers/job-history-purge.handler.spec.ts` |
| A disabled purge is a no-op in the handler as well as in the task | `src/jobs/handlers/job-history-purge.handler.spec.ts`, `src/jobs/tasks/job-history-purge.task.spec.ts` |
| The purge is enqueued globally, at priority 100 (low), and skipped when one is already pending or running | `src/jobs/tasks/job-history-purge.task.spec.ts` |
| The janitor removes an aged prefixed file and leaves a fresh one **and** an unrelated one alone | `src/jobs/tasks/temp-file-janitor.task.spec.ts` — a real filesystem in a disposable directory; the unrelated file is aged too, so only the prefix saves it |
| It sweeps on module init, in every mode that runs jobs, and not at all when the mode is `off` | `src/jobs/tasks/temp-file-janitor.task.spec.ts` |
| One entry that cannot be removed does not stop the sweep; an unlistable directory is one warning | `src/jobs/tasks/temp-file-janitor.task.spec.ts` |
| The prefix is derived from `APP_NAME` and is never empty | `src/jobs/job-temp.spec.ts` |
| The module graph still boots with the three tasks and the purge handler wired | `src/jobs/job-handler.registry.spec.ts`, `src/jobs/job.worker.bootstrap.spec.ts`, plus `npm run openapi:dump` |

What #262 proves, and by what. All of it runs **without a database**, for the
same reason #261's does: every claim below is about a decision the worker
makes in memory — which types it claims, what it does with a job whose handler
is missing, whether a slot is freed when a job overruns, whether a slow job
blocks a fast one — and all of them are settled before any SQL exists. The
claim and the terminal service are stubbed, and what is recorded on those
stubs *is* the assertion. The one exception is the lifecycle claim, which is
about Nest's phase ordering and therefore needs a real module graph:

| Claim | Covered by |
|---|---|
| A handler registering **slowly** in its own `onModuleInit` is present in the worker's **first** claim | `src/jobs/job.worker.bootstrap.spec.ts` — a real `Test.createTestingModule(...).init()`, a handler that awaits 40ms before registering, and `eligibleTypes` recorded at claim time |
| The same holds across module boundaries (`example.echo` from `JobsModule`, the slow handler from another) | `src/jobs/job.worker.bootstrap.spec.ts` |
| `JobWorker` implements `onApplicationBootstrap` and **not** `onModuleInit` | `src/jobs/job.worker.spec.ts` — the cheap structural guard against renaming the hook back |
| `all` claims node-eligible types too; `system` claims only server-only ones; `off` claims nothing and starts no pool | `src/jobs/job.worker.spec.ts` |
| An unrecognised mode behaves as `all` and warns **exactly once** across 50 reads and across two worker instances | `src/jobs/job.worker.spec.ts` — the module-level latch, reset per case so the assertion cannot pass vacuously |
| `JOBS_SYSTEM_MODE_EXTRA_TYPES` adds a registered type; an unregistered entry is dropped with one warning per type | `src/jobs/job.worker.spec.ts` |
| `system` mode claims a node-eligible type whose deployment gates are closed, and stops the moment they open — the two executors are an exact partition of the registry | `src/jobs/job.worker.spec.ts`, and end to end over the real module graph in `test/db-backup/db-backup-node-offload.integration.spec.ts` |
| Eligible types are re-resolved per claim: a handler registered *after* the pool started appears in a later claim | `src/jobs/job.worker.spec.ts` |
| A job exceeding its timeout frees the slot promptly and settles through `completeFailed` with a `JobTimeoutError` | `src/jobs/job.worker.spec.ts` |
| The abandoned work rejecting later produces **no** `unhandledRejection` | `src/jobs/job.worker.spec.ts` — an explicit `process.on('unhandledRejection', …)` listener, because this is the part a bare `Promise.race` gets wrong |
| A late *success* does not retroactively mark the timed-out job succeeded | `src/jobs/job.worker.spec.ts` |
| The timeout timer is cleared the moment a job finishes | `src/jobs/job.worker.spec.ts` — asserts the tracked timer set is empty |
| A slow job in one slot does not delay a fast job in another | `src/jobs/job.worker.spec.ts` — the fast job is finished while the slow one is still running, which is exactly what a batch barrier would prevent |
| A busy queue never sleeps between jobs | `src/jobs/job.worker.spec.ts` — three jobs drained with a ten-minute poll interval configured |
| `onModuleDestroy` resolves in milliseconds from a sleeping pool, leaving no timer behind | `src/jobs/job.worker.spec.ts` |
| Shutdown stops claiming immediately, and gives up on a job that outlives the grace | `src/jobs/job.worker.spec.ts` |
| A claim query that throws backs off instead of spinning | `src/jobs/job.worker.spec.ts` |
| A job with no registered handler is failed **permanently** through the chokepoint, with `{ permanent: true }` | `src/jobs/job.worker.spec.ts`, and the terminal behaviour itself in `src/jobs/job-terminal.service.spec.ts` |
| `permanent` beats the rate-limit classification, never schedules a retry, and still emits `job.settled` | `src/jobs/job-terminal.service.spec.ts` |
| The worker goes through the real `ProviderThrottleService.acquire` before processing | `src/jobs/job.worker.spec.ts` — the real gate, a tripped cooldown, and a fake `JobClock` |
| The claim is one row, as `executor: 'server'` with a `null` node id and a lease longer than the timeout | `src/jobs/job.worker.spec.ts` and `src/jobs/job.worker.bootstrap.spec.ts` |
| A missing setting degrades to the shipped default rather than `NaN` (a `setTimeout(NaN)` poll loop spins the event loop flat out) | `src/jobs/job.worker.spec.ts` |

What #261 proves, and by what. All of it runs **without a database**, and
that is a deliberate choice rather than a gap: everything asserted here is a
*decision* — which branch, which counter, which exact `scheduledFor`, whether
an event fired — and every one of those is made in-process before any SQL is
generated. A database test would confirm the row it was told to write, which
is the one thing already guaranteed; what it could not do is make the write
fail on cue, pin the clock so a jittered `scheduledFor` is an exact timestamp
rather than a range, or drive eleven consecutive deferrals without eleven real
waits. So: a fake `JobClock`, a pinned RNG, and a mocked `job.update` whose
recorded payload *is* the assertion.

| Claim | Covered by |
|---|---|
| A rate-limit deferral leaves `attempts` unchanged NET of the claim increment, and increments `rateLimitHits` | `src/jobs/job-terminal.service.spec.ts` — asserts the exact written payload, plus an eight-deferral loop that re-charges the claim each round and ends with `attempts` still 1 |
| The un-charge is written as an ABSOLUTE value, never a relative decrement | `src/jobs/job-terminal.service.spec.ts` — asserts `typeof attempts === 'number'`, and that a forced write-retry sends a byte-identical payload twice |
| A normal failure consumes an attempt; the row is `failed` once the budget is spent | `src/jobs/job-terminal.service.spec.ts` — attempts 1 and 2 retry with growing backoff, attempt 3 fails terminally |
| `Retry-After` parses as integer seconds AND as an HTTP-date; absent or unparseable yields `null` and pure backoff | `src/jobs/rate-limit.error.spec.ts` (ten unparseable forms, both valid forms, a past date) and `src/jobs/job-terminal.service.spec.ts` (both forms end to end, as an exact `scheduledFor`) |
| A provider's `Retry-After` is a floor, not an override | `src/jobs/backoff.util.spec.ts` and `src/jobs/job-terminal.service.spec.ts` |
| A node-reported `{ rateLimited: true }` follows the IDENTICAL path to a thrown `RateLimitError` | `src/jobs/job-terminal.service.spec.ts` — the two write payloads and the two throttle-gate calls are compared field for field |
| `instanceof RateLimitError` survives transpilation | `src/jobs/rate-limit.error.spec.ts` |
| 429/503/529 and the AWS throttle names (including with a 400 status) classify as rate limits; 500/502/400 and a plain `Error` do not | `src/jobs/rate-limit.error.spec.ts` |
| `classifyRateLimit` never throws, even on an exploding getter | `src/jobs/rate-limit.error.spec.ts` |
| Tripping the gate for a provider delays a sibling job of the same provider and does NOT delay an unrelated one | `src/jobs/provider-throttle.service.spec.ts`, and again in `src/jobs/job-terminal.service.spec.ts` against the **real** `ProviderThrottleService` driven by a node-reported 429 |
| A type with no provider key is a zero-cost no-op | `src/jobs/provider-throttle.service.spec.ts` |
| A trip extends a cooldown but never shortens one; a success clears it | `src/jobs/provider-throttle.service.spec.ts` |
| `acquire` genuinely suspends, and is capped at `JOBS_RATELIMIT_MAX_MS` | `src/jobs/provider-throttle.service.spec.ts` — the cap with a fake clock, the suspension with the **real** clock under jest fake timers |
| Backoff doubles per attempt, caps at `maxMs`, and jitters within `[exp/2, exp]` | `src/jobs/backoff.util.spec.ts` — every case pins the RNG, so each is an exact number |
| `job.settled` fires on success and on give-up (both budgets), NEVER on a deferral or an intermediate retry | `src/jobs/job-terminal.service.spec.ts` |
| A THROWING listener does not affect the row or the outcome | `src/jobs/job-terminal.service.spec.ts`, on both terminal branches |
| The event fires AFTER the write, and not at all when the write failed | `src/jobs/job-terminal.service.spec.ts` — call-order assertion |
| A simulated write failure frees the slot and leaves the row `running` | `src/jobs/job-terminal.service.spec.ts` — both writes rejected, `write-failed` returned rather than thrown, on all four branches |
| The terminal write retries exactly once, after 250ms, with an identical payload | `src/jobs/job-terminal.service.spec.ts` |
| `executor` is never cleared, on success or on failure | `src/jobs/job-terminal.service.spec.ts` |
| Missing config degrades to the shipped defaults, not to `NaN` dates | `src/jobs/job-terminal.service.spec.ts`, `src/jobs/provider-throttle.service.spec.ts` |
| The module graph still boots with the new providers wired | `src/jobs/job-handler.registry.spec.ts` — boots `JobsModule` for real, so a missing provider or a broken injection fails here |

Be honest about the limits of #263 too. Nothing here proves the `@Cron`
decorators actually fire — `ScheduleModule` is Nest's, and a test of it would
be a test of Nest — so each task's `handleCron` is called directly and the
schedules themselves are read, not executed. The janitor's six-hour age limit
is exercised with rewritten mtimes rather than by waiting. And the reaper is
proved against rows a test *constructed* in each stuck shape; no test kills a
real worker mid-job, because the states it would produce are exactly the three
that are seeded here.

Be honest about the limits (as of #261): nothing yet exercises a claimed job
being **run** end to end. There is no worker — a claimed row stays `running` with a lease
until #262 arrives, and the terminal path is driven by tests rather than by a
handler. What is proved is that a row can be written exactly once under
concurrency, taken exactly once under concurrency, and settled by exactly one
component that reaches the same conclusion whichever executor calls it.

What #264 proves, and by what. All of it runs **without a database**, and the
division of labour is the same one #261 argued for: every claim below is a
*decision* — which `where` a set of filters produces, which rule wins when two
of them contradict, whether a cached roll-up is still young enough, which
exception a status becomes — and each is made in-process before any SQL is
generated. What a mock uniquely CAN do here is capture the `where` verbatim,
which is exactly what a filter assertion needs; what it cannot do — decide
which rows that `where` matches — is already asked of Postgres one level down,
in `test/jobs/job-stuck-reset.db.spec.ts`, against the predicate §8.1 borrows
rather than copies. The clock is pinned through `JOB_CLOCK` in every case, so
the cache TTL and the two time windows are exact timestamps rather than ranges.

| Claim | Covered by |
|---|---|
| Every filter works alone — `status`, `type`, `subjectType`, `subjectId`, `scheduled`, each `processedWithin` window | `src/jobs/job-admin.service.spec.ts` — one case each, asserting the captured `where` in full |
| The filters combine, all six at once, into one AND-ed `where` | `src/jobs/job-admin.service.spec.ts` |
| `scheduled=true` OVERRIDES a conflicting `status` rather than intersecting with it | `src/jobs/job-admin.service.spec.ts`, and again over the wire in `test/jobs/job-admin.integration.spec.ts` |
| `scheduled=false` is the opt-OUT, not the opt-in (`Boolean('false')` is `true`) | `src/jobs/job-admin.service.spec.ts` |
| `processedWithin` is `COALESCE(finished_at, created_at)` as two DISJOINT arms, so a `count` is not inflated | `src/jobs/job-admin.service.spec.ts` |
| `stats.stuckRunning` uses the reaper's own `stuckRunningWhere`, zombie arm included | `src/jobs/job-admin.service.spec.ts` — compared against `stuckRunningWhere()` itself, not a literal, so the assertion fails if the reaper's predicate changes and this service does not follow |
| The stats cache serves a second caller inside the TTL and does NOT serve one past it | `src/jobs/job-admin.service.spec.ts` — the pinned clock advanced to exactly `STATS_CACHE_TTL_MS`, plus a re-query assertion |
| A settings change to the stuck threshold lands on the next cache miss | `src/jobs/job-admin.service.spec.ts` |
| Both `groupBy` aggregates are unfiltered, so the covering index can serve them, and `total` is summed from the first rather than counted separately | `src/jobs/job-admin.service.spec.ts` |
| Every status key is zero-filled; a `groupBy` row with no `_count` reads as 0, never `NaN` | `src/jobs/job-admin.service.spec.ts` |
| `byType` is labelled through `jobTypeLabel` and ordered busiest-first with an alphabetical tie-break | `src/jobs/job-admin.service.spec.ts` — the tie case is fed in reverse-alphabetical order, as a database is free to return it |
| Retry writes the complete reset, and never touches `dedupKey` | `src/jobs/job-admin.service.spec.ts` — asserts the exact `data` payload on both the single and the bulk path |
| Retry and delete both 400 on a running job and 404 on a missing one | `src/jobs/job-admin.service.spec.ts` and `test/jobs/job-admin.integration.spec.ts` |
| The 400 also wins the RACE: a job that starts running between the read and the write is refused by the conditional write | `src/jobs/job-admin.service.spec.ts`, both routes |
| A dedup collision is a 409 on the single retry and a `skipped` on the bulk sweep — and a P2002 on any OTHER constraint still propagates | `src/jobs/job-admin.service.spec.ts` |
| `retry-failed` scopes by type when given, is idempotent when nothing is failed, and caps the batch while reporting `remaining` | `src/jobs/job-admin.service.spec.ts` |
| `reset-stuck` DELEGATES — it issues no query of its own — and an explicit `0` is honoured rather than falling back to the setting | `src/jobs/job-admin.service.spec.ts` |
| An empty `reset-stuck` body defers to `jobs.stuckThresholdMinutes` | `src/jobs/job-admin.service.spec.ts`, and end to end (as the shipped default, 30) in `test/jobs/job-admin.integration.spec.ts` |
| Literal routes resolve before `:id` | `test/jobs/job-admin.integration.spec.ts` — `POST /api/admin/jobs/reset-stuck` through the real router, asserting the SWEEP RAN rather than merely that the status was not 400 |
| Every route is Admin-only and rejects an anonymous caller and a viewer | `test/jobs/job-admin.integration.spec.ts` — all six routes, both cases |
| The query parameters survive the real `ZodValidationPipe`: bounds, enums and the boolean | `test/jobs/job-admin.integration.spec.ts` |
| The running-job refusal's machine-readable half survives the exception filter's key allowlist | `test/jobs/job-admin.integration.spec.ts` — asserts `details` on the wire |
| Every route carries `x-rbac` and the document still lints | `npm run openapi:dump` + `npm run openapi:lint`, plus `test/openapi/openapi-document.spec.ts` |

Be honest about the limits of #264. No test here asks Postgres whether the
`(status, type, id)` covering index is genuinely chosen for the two `groupBy`
aggregates — that is a planner question, and asserting it would mean pinning an
`EXPLAIN` output that a version upgrade may legitimately change. What is
asserted instead is the property the plan depends on: that neither aggregate
carries a `where`. Likewise no test drives two admins into a real dedup
collision; the P2002 is injected, because Postgres raising it on that index is
already proved by `test/jobs/jobs-enqueue.db.spec.ts`.

What #265 proves, and by what. The split follows the shape of the claims. The
first block runs against a **real Postgres** (`npm run test:db`) because each
of its claims is about what the database does — what `PERCENTILE_CONT`
interpolates, what lock a statement takes, and whether the rollup/live merge
stays conserved when rows genuinely move between the two. The second runs
without one, because a mock is the only thing that can capture a `where`
verbatim, drive all three ETA bases from a fixture that *is* the whole table,
and assert that a statement the service never sent contains nothing dangerous:

| Claim | Covered by |
|---|---|
| The whole computation completes, promptly and correctly, while another connection holds `FOR UPDATE` locks on claimed rows in an open transaction | `test/jobs/job-insights.db.spec.ts` — a second `PrismaClient`, the claim's own `SELECT … FOR UPDATE SKIP LOCKED` shape, insights run from inside the lock's lifetime with an elapsed-time bound so a conflicting lock fails as an assertion rather than as a hang |
| p50 and p95 equal the hand-computed `PERCENTILE_CONT` interpolations on a seeded fixture (p95 = 4800 over 1000…5000 ms, which `PERCENTILE_DISC` would answer 5000) | `test/jobs/job-insights.db.spec.ts` |
| Only jobs inside the window count; failed and untimed rows are excluded from the distribution | `test/jobs/job-insights.db.spec.ts` — the same fixture read at two window sizes |
| `throughputPerMin` counts the last hour, not the window | `test/jobs/job-insights.db.spec.ts` |
| `retried` and `rateLimited` match the partial-index predicates against real rows, terminal rate-limited rows excluded | `test/jobs/job-insights.db.spec.ts` — asserted as deltas, because the suite owns its type prefix and not the table |
| Lifetime totals are **identical** before and after a real purge, and unchanged by a second purge (no double counting) | `test/jobs/job-insights.db.spec.ts` — the real `JobHistoryPurgeHandler` over real rows, with the rollup read back |
| A type whose live rows are all purged still appears in `lifetime` | `test/jobs/job-insights.db.spec.ts` |
| `reset-history` clears the rollup, leaves every job row and every live-derived block byte-identical, and leaves lifetime reporting the survivors alone | `test/jobs/job-insights.db.spec.ts` — foreign rollup rows are captured and restored, because the control is deliberately not scoped by type |
| `basis` is `live` when the type has its own history and `partial` when it falls back to the overall average | `test/jobs/job-insights.db.spec.ts` (both survive unrelated rows) and `src/jobs/job-insights.service.spec.ts` |

| Claim | Covered by |
|---|---|
| Every raw statement begins with `SELECT` and contains no `INSERT`/`UPDATE`/`DELETE`/`FOR UPDATE`/`FOR SHARE`/`LOCK TABLE`/advisory lock | `src/jobs/job-insights.service.spec.ts` — asserted on the SQL text, which is the half a database cannot prove: it never sees a statement that was not sent |
| A read writes nothing at all | `src/jobs/job-insights.service.spec.ts` |
| The window is a bound parameter, not interpolated text | `src/jobs/job-insights.service.spec.ts` — asserts `Prisma.Sql`'s `values` and `sql`, as `job-claim.service.spec.ts` does for the claim |
| `basis` is `none` with no history anywhere | `src/jobs/job-insights.service.spec.ts` — a statement about the *whole table*, which a prefix-scoped database suite cannot own |
| Out-of-range, zero, negative, fractional and non-numeric `windowDays` are 400s; 90 is accepted; a direct service call is clamped | `src/jobs/job-insights.service.spec.ts` and `test/jobs/job-admin.integration.spec.ts` (through the real pipe, asserting no query ran) |
| Both `groupBy` aggregates stay unfiltered, so the covering index can serve them | `src/jobs/job-insights.service.spec.ts` |
| The three live counts carry exactly the predicates the partial indexes are built on | `src/jobs/job-insights.service.spec.ts` — the captured `where`s in full |
| An empty window publishes nulls, not zeroes | `src/jobs/job-insights.service.spec.ts` |
| Running jobs count as remaining; types with nothing outstanding are omitted; the longest wait is first | `src/jobs/job-insights.service.spec.ts` |
| The ETA divides by the configured concurrency, floors the divisor at 1, publishes the raw value, and degrades to the shipped default rather than `NaN` | `src/jobs/job-insights.service.spec.ts` |
| The lifetime merge adds rollup and live without double counting, includes a purged-only type and a rollup-less type, and reports `null` rather than `NaN` for a type that has only failed | `src/jobs/job-insights.service.spec.ts` |
| All eight queries are in flight at once | `src/jobs/job-insights.service.spec.ts` — a peak-concurrency counter, which is what makes `Promise.all` an assertion rather than a comment |
| `resetHistory` deletes every rollup row and touches no job query | `src/jobs/job-insights.service.spec.ts` |
| Both insights routes resolve ahead of `:id`, and both are Admin-only against an anonymous caller and a viewer | `test/jobs/job-admin.integration.spec.ts` — driven through the real router, asserting the COMPUTATION RAN rather than merely that the status was not 400 |
| Both routes carry `x-rbac` and the document still lints | `npm run openapi:dump` + `npm run openapi:lint` |

Be honest about the limits of #265. No test asks Postgres whether the two
partial indexes are genuinely *chosen* — that is a planner question, and
pinning an `EXPLAIN` is pinning a decision a version upgrade may legitimately
change. What is asserted instead is the property the plan depends on: that each
`where` states the index's predicate. `basis: 'none'` is proved only without a
database, because it is a claim about the whole table and the database suite
owns one type prefix. And nothing here proves the endpoint is *fast* on a large
table; what is proved is that it cannot be in anyone else's way while it runs.
