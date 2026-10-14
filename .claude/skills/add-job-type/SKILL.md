---
name: add-job-type
description: Add a background job type to the queue - implement a JobHandler, self-register it, enqueue it through JobsService, declare its execution profile, decide node eligibility, and add the tests that pin it. Use when a feature must do long-running work (a dump, a sweep, an export, a network round trip per row), when adding a job that spends a user's AI key, or when a @Cron or @OnEvent body would otherwise work inline.
---

# Add a job type

Recipe with full code: `apps/api/src/jobs/handlers/README.md` (`grep -n '^##' <file>` first; read only the section you need). Worked examples: `apps/api/src/jobs/handlers/example-echo.handler.ts` (server-only) and `example-checksum.handler.ts` (node-eligible, with its contract in `apps/api/src/jobs/contracts/`). Spec: `docs/specs/job-queue.md`.

## Steps

1. Create the handler beside the feature: a class implementing `JobHandler` (`apps/api/src/jobs/job-handler.interface.ts`) with `type` (a dotted, lowercase string) and `process(job)`. Throw to fail; a normal return means the work committed. Be idempotent: the queue is at-least-once.
2. Self-register in `onModuleInit`: `this.registry.register(this)`. Add the class to the feature module's `providers`; the module imports `JobsModule`.
3. Enqueue through `JobsService` (`apps/api/src/jobs/jobs.service.ts`). Keep `payload` to identifiers. Same `type` + subject is deduplicated while one is `pending`/`running`; pass `skipDedup: true` only when several jobs on one subject are distinct work (a job re-enqueueing itself must, or the enqueue returns the row that is running).
4. A `@Cron` only decides whether work is due and enqueues, through `enqueueHousekeepingJob` (`apps/api/src/jobs/housekeeping.enqueue.ts`); reference `apps/api/src/jobs/tasks/job-history-purge.task.ts`.
5. Optional: add a friendly label in `apps/api/src/jobs/job-type-labels.ts`. An unmapped type renders as its raw string, never blank. `job-type-labels.spec.ts` pins the labels that exist; there is no snapshot of all registered types.
6. Write a handler spec beside the handler (`example-checksum.handler.spec.ts` is the model).

## Rules

- A job `type` string is permanent once jobs of that type exist. Rename = new type.
- Any work that outlives the request or tick is a job. No detached `void this.doIt()`, no inline `@Cron` body, no `@OnEvent` that downloads or spawns. `apps/api/test/jobs/cron-enqueue-only.spec.ts` pins the three permanent exemptions (lease reaper, temp-file janitor, node secret sweep); never add a fourth without editing it and `docs/specs/job-queue.md` section 7.10.
- Node eligibility is the default: provide `nodeResultSchema` plus `persistNodeResult` (both or neither, never one) unless the handler writes as it goes, reads several tables mid-computation, or needs a privilege a node must never hold. Eligibility is derived; there is no `nodeEligible` flag. Publish the result contract under `apps/api/src/jobs/contracts/`. A deployment declines offload with a system setting or `nodeOffloadEnabled()`, never by editing the handler.
- A per-job secret is declared with `nodeSecretBroker` (`apps/api/src/jobs/job-secret-broker.ts`); a node never persists it; `job_node_secrets` stores handles only.
- `profile` is optional and exactly `{ maxRuntimeMs, maxAttempts }`. Never add `leaseMs` or `heartbeatMs`; the lease is derived from `maxRuntimeMs`.
- A job that spends a user's own AI key is server-only (no `nodeResultSchema`, no `persistNodeResult`), declares `profile.maxAttempts: 1` so a retry never double-charges, and defers a vendor 429 with `aiProviderThrottleKey(userId)` from `apps/api/src/notes/job-types.ts`. Never one shared `'ai-provider'` key.
- Domain failures that cannot change on retry set the row's failure state and return normally; they do not spend an attempt.
- Guard an enqueue of a type that a later issue registers with `JobHandlerRegistry.get(type)`; otherwise it creates `pending` rows no worker can claim.
- Notify after the job's write commits, outside any `$transaction`.
- No migration is needed: `jobs.type` is a plain string.

## Verify

```bash
cd apps/api && npm run typecheck && npm test
npm run test:db --workspace=api    # if you touched queue SQL or tables
```

Flag the new type for the docs agent (job-type inventory in `docs/ARCHITECTURE.md` and `CLAUDE.md`).
