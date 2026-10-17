---
name: add-job-type
description: Add a background job type to the job queue - implement a JobHandler, self-register it, enqueue it through JobsService with an explicit orgId, declare its label and execution profile, decide node eligibility, and add the tests that pin it. Use when a feature must do long-running work (a dump, a sweep, an export, a network round trip per row), when adding an AI job that spends a user's own key, or when a @Cron or @OnEvent body would otherwise work inline.
---

# Add a job type

The queue and the worker-node fleet are the platform's: `@marinoscar/platform-api/jobs` and `@marinoscar/platform-api/nodes`. This repository has no queue code of its own (the old `apps/api/src/jobs` and `apps/api/src/nodes` folders are gone), only handlers and their host ports (`apps/api/src/platform/jobs/`). Read the contract in the installed package: the slice section of `node_modules/@marinoscar/platform-api/README.md` and the TSDoc in `node_modules/@marinoscar/platform-api/dist/jobs/job-handler.interface.d.ts` (every optional member is documented there). Spec and rules: `docs/specs/job-queue.md` (section 7.10) and `docs/specs/worker-nodes.md`.

## Imports

```ts
import {
  JobHandlerRegistry, JobsService, JobScope,
  enqueueHousekeepingJob, RateLimitError, ProviderThrottleService,
  type Job, type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveJobOrgId } from '@marinoscar/platform-api/identity';
```

## Steps

1. Create the handler beside the feature: a class implementing `JobHandler` with a dotted, lowercase `type`, a `label` (sentence case, sized for a table cell) and `process(job)`. Throw to fail; a normal return means the work committed. Be idempotent: the queue is at-least-once.
2. Self-register in `onModuleInit`: `this.registry.register(this)` with an injected `JobHandlerRegistry`. Add the class to the feature module's `providers`. `JobsModule.forRoot` is global, so no `JobsModule` import is needed.
3. Enqueue through `JobsService.enqueue` (or `enqueueWithin(tx, ...)`) with identifiers in `payload`, not copies of data. **Pass `orgId` explicitly on every enqueue.** This app has no ambient organization (`JOBS_ORG_SCOPE` answers null), so an omitted `orgId` becomes `null`.
   - `orgId: null` is right for housekeeping and system jobs.
   - A job whose handler touches `storage_objects` (or any RLS-protected table) needs the default organization's id. A handler runs that work through `JobScope.run(job, fn)`, which refuses a job with a null `orgId`. For a row queued before the port, fall back with `job.orgId ?? await resolveJobOrgId(prisma, job)` (reference: `apps/api/src/notes/job-org-scope.ts`).
4. A `@Cron` only decides whether work is due and enqueues, through `enqueueHousekeepingJob` (reference: `apps/api/src/notes/tasks/notes-housekeeping.task.ts`; the transcripts cron lives in `packages/kvox-api/src/transcripts/tasks/` and enqueues through the jobs port). An `@OnEvent` body enqueues; it never downloads or spawns.
5. Labels. A live handler declares `label` on itself and the registry records it. Only a type with no handler in the process (a retired one) registers a label with `registerJobTypeLabel`, in `apps/api/src/app-registrations/jobs.ts` (`RETIRED_JOB_TYPE_LABELS`).
6. Write a handler spec. Add the new type string to `KVOX_JOB_TYPES` in `apps/api/test/jobs/job-type-snapshot.spec.ts` (append only). The `cron-enqueue-only` and `on-event-no-io` conformance suites (`apps/api/test/conformance.spec.ts`) must still pass.

## Rules

- A job `type` string is permanent once jobs of that type exist. A rename is a new type. The snapshot spec pins every string the app has registered.
- Any work that outlives the request or cron tick is a job. No detached `void this.doIt()`. The only permanent exemptions are the three listed in `AGENTS.md` and `docs/specs/job-queue.md` section 7.10 (the platform's lease reaper, temp-file janitor and node-secret sweep); the `cron-enqueue-only` conformance suite is their executable form. Never add a fourth.
- Node eligibility is the default: provide both `nodeResultSchema` and `persistNodeResult` unless the handler writes as it goes, reads several tables mid-computation, or needs a privilege a node must never hold. Eligibility is derived; there is no `nodeEligible` flag. Never provide only one of the two. A server-only type is listed by `JobHandlerRegistry.serverOnlyTypes()`, which `JOBS_WORKER_MODE=system` also uses.
- A per-job secret is declared with `nodeSecretBroker`. A node never persists it; `job_node_secrets` stores handles only.
- `profile` is optional and exactly `{ maxRuntimeMs, maxAttempts }`. Never add `leaseMs` or `heartbeatMs`.
- A provider call that can be throttled throws `RateLimitError` (or a self-classifying error) so the queue defers the job instead of failing it. Register the provider key with `ProviderThrottleService.registerProviderKey(type, key)`.
- AI jobs spend the requesting user's own key, so they are server-only (no `nodeResultSchema`, no `persistNodeResult`). Use `aiProviderThrottleKey(userId)` from `apps/api/src/notes/job-types.ts` (per user, never a shared deployment key). Use `profile.maxAttempts: 1` when a retry would double-bill; regenerate by user action is the retry path.
- A job that re-enqueues itself for the same subject needs `skipDedup: true`, or the enqueue returns the running row and the chain stops silently.
- Guard an enqueue of a type that a later issue registers with a registry check; otherwise it creates `pending` rows no worker can claim.
- Send notifications after the job's write commits, outside any `$transaction`.
- No migration is needed: `jobs.type` is a plain string.

## Verify

```bash
cd apps/api && npm run typecheck && npm test
```

Flag the new type for the docs agent (type table in `docs/specs/job-queue.md` and the relevant spec).
