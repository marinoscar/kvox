# Job Handlers

This directory contains job handler implementations for the background job
queue (epic #254). One class per job type; the queue itself never changes.

## Overview

A handler is the code that runs one kind of background job. The queue owns
everything around it — enqueueing and deduplication, claiming with a lease,
attempts and retries, terminal status, the admin dashboard — and knows nothing
about any individual type beyond the string in `Job.type`.

Typical job types a fork adds:

- Send an email or dispatch a notification off the request path
- Generate an export (CSV, PDF, ZIP) a user downloads later
- Call a slow or rate-limited third-party API
- Re-index, re-derive, or backfill a table after a change
- Periodic maintenance: prune expired rows, roll up stats, expire tokens

## Creating a Handler

### 1. Implement the `JobHandler` Interface

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';

import { JobHandler } from '../job-handler.interface';
import { JobHandlerRegistry } from '../job-handler.registry';

@Injectable()
export class MyCustomHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(MyCustomHandler.name);

  // Unique across the process, and PERMANENT once jobs of this type exist:
  // `jobs` rows outlive the handler that produced them.
  readonly type = 'my-feature.do-the-thing';

  constructor(private readonly registry: JobHandlerRegistry) {}

  // 2. Self-register (see below).
  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    // Do the work. THROW TO FAIL — the worker records the error message in
    // `Job.lastError` and retries. Returning normally means done and durable.
    this.logger.log(`Running ${job.id}`);
  }
}
```

Two rules for `process`:

- **Throw to fail.** There is no result object to return. A rejection becomes
  `Job.lastError` plus a retry; a normal return means the work committed. Do
  not `try/catch` and swallow — a job that silently reports success is worse
  than one that retries.
- **Be idempotent where you can.** The queue is at-least-once, never
  exactly-once: a job can run twice after a retry, or after a lease expired
  because the executing process was killed mid-run.

### 2. Self-Register in `OnModuleInit`

Registration is explicit, from the handler's own `onModuleInit()`. There is no
decorator to add and no central list of types to edit — that one
`this.registry.register(this)` line is the entire mechanism, and it is
grep-able when you later ask "why is this type running?".

A duplicate `type` **overwrites** the earlier registration and logs a warning:
the last registration wins, which is how a fork deliberately replaces a
framework handler with its own. If you did not mean to shadow anything, that
warning is telling you two handlers share a `type` string.

### 3. Add It to Your Feature Module

The handler needs to be a provider somewhere so that Nest constructs it and
calls `onModuleInit()`. Put it in the module that owns the feature, and import
`JobsModule` for the registry:

```typescript
import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { MyCustomHandler } from './handlers/my-custom.handler';

@Module({
  imports: [JobsModule],
  providers: [MyCustomHandler],
})
export class MyFeatureModule {}
```

That is the whole wiring change. Nothing in the worker, the claim query, the
enqueue service or the dashboard is touched.

### 4. Enqueue Work

Inject `JobsService` (exported by `JobsModule`, which step 3 already imported)
and enqueue from wherever the trigger lives:

```typescript
await this.jobs.enqueue({
  type: 'my-feature.do-the-thing',
  reason: 'upload',
  subjectType: 'storage_object',
  subjectId: object.id,
  payload: { objectId: object.id },
});
```

`payload` is handler-defined and opaque to the queue (a JSONB column). Keep it
small and keep it to **identifiers**, not copies of data — the job may run
minutes later, and a row it names should be re-read at run time rather than
carried inside the payload where it can go stale.

**Enqueueing the same work twice is safe by default.** A job is deduplicated
on `type` plus subject for as long as an earlier one is still `pending` or
`running`: the second call does not create a second row, it returns the job
already in flight. Both callers get a job, neither gets an error, and the
returned row is the *first* caller's — so its `reason`, `priority` and
`payload` are the ones that job was created with. When several jobs of the
same type against the same subject are legitimately distinct work, opt out
per call:

```typescript
await this.jobs.enqueue({ ...input, skipDedup: true });
```

Two more optional fields worth knowing about:

- `priority` — **ascending is more urgent**, `0` is normal, negative is
  ahead of it.
- `scheduledFor` — the earliest time the job may be claimed. Omit it (the
  default) for "run as soon as a worker is free".

The full reasoning — why the database decides dedup instead of a
`findFirst` pre-check, and why `skipDedup` costs nothing — is
[`docs/specs/job-queue.md`](../../../../../docs/specs/job-queue.md) §4.

### The Type Appears in the Dashboard Automatically

No migration, no enum, no queue wiring. `Job.type` is a plain string column
precisely so a new handler costs zero schema change, and the admin dashboard
lists whatever `JobHandlerRegistry.types()` reports. Add a friendly label for
your type in `../job-type-labels.ts` if you want one — an unmapped type
renders as its raw type string rather than blank, so the label is optional
polish and never a requirement.

## Node Eligibility (Optional)

Some job types can have their expensive part computed on a **remote worker
node** instead of on the API server: the node computes, posts a result back,
and the server writes it down. The node has **no storage credentials** at all,
ever — and no *durable* database access: a type that genuinely needs a real
database connection (`db.backup.run`, for `pg_dump`) may declare a
`nodeSecretBroker` that mints one short-lived, job-scoped credential per job,
held in the node's memory only and revoked when the job settles — see
`../job-secret-broker.ts` and
[`docs/specs/database-backup.md` §16](../../../../../docs/specs/database-backup.md#16-running-the-dump-on-a-worker-node-352-epic-345).
Nothing brokered this way is ever written to disk, to config, or to a log
line; that is the rule this section's opening claim narrows to, not one it
gives up.

**A type is node-eligible if, and only if, its handler carries BOTH optional
members:**

```typescript
readonly nodeResultSchema = z.object({ pages: z.number().int().positive() });

async persistNodeResult(job: Job, result: unknown): Promise<void> {
  const parsed = this.nodeResultSchema.parse(result);
  // PERSIST ONLY — write the value down and nothing else.
}
```

- **Both members** → node-eligible.
- **Neither member** → server-only. This is the default, and where every
  handler starts.
- **Exactly one member** → server-only. A schema with no persist function
  describes a payload nobody can store; a persist function with no schema
  would have to trust an unvalidated body from a remote machine. Both collapse
  to the safe answer rather than being treated as a half-eligible case.

There is no `nodeEligible: boolean` flag anywhere, on purpose: a flag can
disagree with the members it describes, and deriving the answer from them
makes that wrong state unrepresentable. `JobHandlerRegistry.serverOnlyTypes()`
is that derivation; the claim endpoint and the `system` worker mode both read
it, so a type that is not node-eligible is one **no node can ever claim**.

`persistNodeResult` must do **only the persist half** — no recomputation, no
re-downloading the input, no second call to the provider the node used. That
rule is what keeps a node from needing database access; break it and the
server is doing the work twice and the node's answer is decorative. If a
result cannot be persisted without redoing the work, the type is not
node-eligible: drop both members.

### What a node-eligible handler looks like

`example-checksum.handler.ts` is the worked example (#269). It is the same
four steps above plus the two members, and it is worth reading alongside this
section because it is a live implementation rather than a sketch. The shape:

```typescript
@Injectable()
export class ExampleChecksumHandler implements JobHandler, OnModuleInit {
  readonly type = 'example.checksum';

  // (1) The contract, imported from ../contracts/ — see below for why it
  //     lives there rather than inline.
  readonly nodeResultSchema = exampleChecksumResultSchema;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // (2) The SERVER-SIDE path. A node is an option, never a requirement: a
  //     deployment running no nodes must still be able to execute every type
  //     it can enqueue, so `process` does the whole job here.
  async process(job: Job): Promise<void> {
    const object = await resolveStorageObjectInput(this.prisma, job);
    const stream = await this.storage.download(object.storageKey);
    /* …hash the stream… */
    await this.writeChecksum(object, computed, 'server');
  }

  // (3) The NODE path. Parse, then call the SAME write `process` calls.
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed = this.nodeResultSchema.parse(result);
    const object = await resolveStorageObjectInput(this.prisma, job);
    await this.writeChecksum(object, parsed, 'node');
  }
}
```

Three things to copy from it, in order of how much they matter:

1. **One write, two paths.** The compute half differs between `process` and
   `persistNodeResult`; the persist half is a single private method called by
   both. Without that, a job's stored result depends on which executor claimed
   it — a divergence nothing tests by accident, because each path is naturally
   tested on its own.
2. **`persistNodeResult` re-parses.** The interface hands it `result:
   unknown`, so narrowing is required anyway; re-parsing rather than casting
   means a future caller that forgot to validate cannot write an arbitrary
   object into your table through this method.
3. **Resolve inputs through one resolver, never by reading a path inline.**
   `resolveStorageObjectInput` (in `src/storage/storage-job-input.ts`) returns
   a `StorageObject` with a guaranteed non-empty `storageKey`, or throws one of
   three named reasons. Its header records the production failure it exists to
   prevent — a job dying with `ENOENT: no such file or directory, open ''`,
   which named neither the job, nor the subject, nor which of three causes
   applied.

### The data plane: how a node gets and writes bytes

A node holds no storage credentials, so it asks the server for a short-lived
signed URL and then talks to the storage provider **directly** — bytes never
pass through the API:

| Step | Call |
|---|---|
| 1 | `POST /api/nodes/{id}/claim` → `{ job, params }` |
| 2 | `POST /api/nodes/{id}/jobs/{jobId}/download-url` → a signed GET for the job's input object |
| 3 | *(node streams the object and computes)* |
| 4 | `POST /api/nodes/{id}/jobs/{jobId}/upload-url` → a signed PUT **plus the key the server chose** (only if the job writes bytes) |
| 5 | `POST /api/nodes/{id}/jobs/{jobId}/result` → validated against `nodeResultSchema`, then `persistNodeResult` |

Three rules a handler author should know, because they shape what your
`nodeResultSchema` should contain:

- **The server chooses the upload key.** A node-supplied key is refused with a
  `400`. If your handler needs to record where the output went, put the key in
  your result schema — the node reports back the one it was given. By default
  that key is `node-outputs/<jobId>/<uuid>`: fresh every time, attributable to
  the job, and never reused, which is what makes an overwrite impossible.
  Implement `deriveOutputKey` (below) if your artifact needs a *specific*
  location instead.
- **URLs are minted on demand, not at claim time,** and their expiry is
  bounded by the server. A long transfer asks again; it holds the lease, so it
  may.
- **Renew the lease** (`POST …/renew`) during long work. Once the lease
  expires, the download URL, the upload URL and the result submission are all
  refused with `409`, because another executor may already own the job.

### Choosing where the output lands (`deriveOutputKey`, optional)

Most node-eligible types want the default key above: nothing outside the job
ever names the artifact, so a fresh location per mint is strictly better than
a predictable one. Implement `deriveOutputKey(job)` only when the artifact's
location is **part of its contract** — a row records the key, a retention
sweep lists a prefix, a download endpoint reconstructs it:

```ts
async deriveOutputKey(job: Job): Promise<string> {
  const run = await this.prisma.myArtifactRun.findUniqueOrThrow({
    where: { jobId: job.id },          // ⚠ see idempotency, below
  });
  return run.storageKey;
}
```

Three rules, and none of them is optional:

- **This is still the server choosing.** The method runs in the API process,
  in the handler that owns the artifact, with the `Job` row as its only
  argument. Nothing from the node's request reaches it, and a node-supplied
  `key` is still refused with a `400` *before* it is called.
- **⚠ It must be idempotent per job.** A node asks for an upload URL more than
  once as a matter of course — a timed-out transfer, a response lost on the
  way back, a process restarted while holding the lease — and every one of
  those calls must return the **same key**. A derivation that mints something
  new each time (inserting a row, interpolating `randomUUID()` or
  `Date.now()`) produces a second artifact per retry, and the row the rest of
  the system reads then points at bytes the node never finished writing.
  Derive from values already fixed on the job, or re-read the artifact row
  this job already created — a `@unique` `jobId` on that row makes it
  structural rather than a thing you remembered.
- **The key must be a safe storage key** (`^[A-Za-z0-9][A-Za-z0-9/_.-]*$`).
  One that is not is refused server-side with a **500**, and the node gets no
  URL: `..` is not an error at a storage provider, it is a key, and the object
  lands somewhere nobody looks. A 500 rather than a 400 because the fault is
  in the handler, not in anything the node sent.

Note the trade this makes deliberately: a stable key gives up "every mint is a
new key" for your type. That is the point — the overwrite it permits is of
your own artifact, for your own job, and of nothing else.

### Publishing the result contract

Put the Zod schema in `../contracts/` and import it into the handler. It is
served as JSON Schema by `GET /api/nodes/job-types`, so a client can validate a
result **before** posting it, against the server's own definition. See
[`../contracts/README.md`](../contracts/README.md) — including why a shared
`packages/job-contracts` workspace was rejected for this repository.

**⚠ A byte count crosses the wire as a decimal string, never a JSON number, if
it is backed by a `BigInt` column.** JSON has no integer type — a JSON number
is a double, exact only below 2^53 — so a dump or export past that size would
silently lose precision on the way in, on exactly the largest, least
eye-checkable results. `db-backup-run.contract.ts` is the worked example:
`bytes: z.string().regex(/^\d{1,20}$/)`, converted with `BigInt()` **once**, in
the handler, mirroring the same rule the outgoing DTO already applies (`BigInt`
values are stringified because `JSON.stringify` refuses to serialise them at
all). Contrast `example-checksum.contract.ts`, whose `bytes` is a plain
`number` — correctly, because it hashes a stored object bounded by
`Number.MAX_SAFE_INTEGER` in any realistic deployment and writes to a JSONB
column rather than a `BigInt` one. Copy whichever contract matches the column
you are writing.

### An execution profile (`profile`, optional)

Most handlers take the deployment-wide `JOBS_JOB_TIMEOUT_MS`/`JOBS_MAX_ATTEMPTS`
and need nothing else. Declare `readonly profile = { maxRuntimeMs, maxAttempts }`
only when this type is genuinely unlike the rest of the queue:

```ts
readonly profile: JobExecutionProfile = {
  maxRuntimeMs: 6 * 60 * 60 * 1000, // this type may legitimately run for hours
  maxAttempts: 1,                   // …and must never be auto-retried
};
```

**Exactly two numbers, and there will only ever be two.** The claim's lease
and its renewal interval are *derived* from `maxRuntimeMs`
(`resolveJobLeaseMs`/`resolveRenewIntervalMs` in `../job.worker.ts` and
`../job-execution-profile.ts`) rather than declared alongside it — a lease
shorter than the permitted runtime is a job that reaps itself into duplicate
execution, and deriving it makes that state unrepresentable rather than merely
avoided. Do not add a third field. `db-backup-run.handler.ts` is the worked
example (`maxRuntimeMs: 6h`, `maxAttempts: 1` — a multi-gigabyte dump must
never be auto-retried).

### A per-job credential (`nodeSecretBroker`, optional)

A node has no *durable* database access or storage credentials (§8 of
[`docs/specs/worker-nodes.md`](../../../../../docs/specs/worker-nodes.md)), so
almost every node-eligible type needs none. The exception is a type whose work
genuinely requires a live connection to something this deployment guards — a
`pg_dump` needs PostgreSQL — and for that, presence of a `nodeSecretBroker`
member is the declaration, exactly as `nodeResultSchema` + `persistNodeResult`
declare eligibility:

```ts
readonly nodeSecretBroker: JobSecretBroker = pgJobRoleBroker;
```

The broker mints a short-lived, job-scoped credential when a node calls
`POST /api/nodes/:id/jobs/:jobId/secret`, bounded by the job's own lease, and
destroys it again when the job settles or on the sweep that catches what the
settle path cannot. **Nothing it returns may be persisted except the handle**
— `job_node_secrets` has no column that could hold the material itself. See
`../job-secret-broker.ts` for the full contract and
[`docs/specs/database-backup.md` §16](../../../../../docs/specs/database-backup.md#16-running-the-dump-on-a-worker-node-352-epic-345)
for the worked example, including the two separate opt-in settings that gate
whether this ever reaches a node at all.

## Example Handlers

See `example-echo.handler.ts` — a server-only handler that logs its payload
and returns. It is deliberately trivial and side-effect free, and it is a live
implementation of the contract rather than a comment about one.

See `example-checksum.handler.ts` (#269) for the node-eligible counterpart: it
streams a `StorageObject`, computes its SHA-256 and byte count, and stores them
in the object's `metadata`. It is deliberately generic — provider-agnostic, no
native dependency, and useful rather than a toy — and it is the type that makes
a worker node's claim return anything at all.

For a handler that does real work, see `job-history-purge.handler.ts` (#263):
the queue's own housekeeping, and the same four steps applied to a settings
read, a batched loop and a transaction. Its scheduling half lives in
`../tasks/job-history-purge.task.ts` and shows the other end of the recipe — a
`@Cron` that ENQUEUES rather than doing the work inline, so the run is
observable, retried on the queue's budget, and executed on a worker slot.

## Related Files

| File | What it is |
|---|---|
| `../job-handler.interface.ts` | The contract, and the node-eligibility rules |
| `../job-handler.registry.ts` | The registry, and why registration is explicit |
| `../job-keys.ts` | `buildDedupKey()` — the single definition of `Job.dedupKey` |
| `../job-type-labels.ts` | Display labels for the admin UI |
| `../contracts/` | Node result schemas, published as JSON Schema by `GET /api/nodes/job-types` |
| `../../storage/storage-job-input.ts` | `resolveStorageObjectInput()` — a job's input, or a named failure |
| `../../nodes/node-data-plane.service.ts` | The presigned download/upload routes a node uses |
| `../jobs.module.ts` | Where the registry and the example handlers are provided |
| `docs/specs/job-queue.md` | The design spec: decisions, rejected alternatives |
| `docs/specs/worker-nodes.md` | The node planes: control (#268) and data (#269) |
