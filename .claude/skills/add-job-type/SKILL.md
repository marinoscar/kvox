---
name: add-job-type
description: Add a background job type to the kvox queue - implement a JobHandler, self-register it, enqueue it through JobsService, declare its execution profile, decide node eligibility, and add the tests that pin it. Use when a feature must do long-running work (a dump, a sweep, an export, a network round trip per row), when adding an AI job that spends a user's own key, or when a @Cron or @OnEvent body would otherwise work inline.
---

# Add a job type

Recipe with full code: `apps/api/src/jobs/handlers/README.md` (`grep -n '^##' <file>` first; read only the section you need). Worked examples: `apps/api/src/jobs/handlers/example-echo.handler.ts` (server-only) and `apps/api/src/jobs/handlers/example-checksum.handler.ts` (node-eligible). Spec: `docs/specs/job-queue.md`.

## Steps

1. Create the handler beside the feature: a class implementing `JobHandler` (`apps/api/src/jobs/job-handler.interface.ts`) with a dotted, lowercase `type` and `process(job)`. Throw to fail; a normal return means the work committed. Be idempotent: the queue is at-least-once.
2. Self-register in `onModuleInit`: `this.registry.register(this)`. Add the class to the feature module's `providers` and import `JobsModule`.
3. Enqueue through `JobsService` (`apps/api/src/jobs/jobs.service.ts`) with identifiers in `payload`, not copies of data. A `@Cron` only decides whether work is due and enqueues (`enqueueHousekeepingJob` in `apps/api/src/jobs/housekeeping.enqueue.ts`; reference `apps/api/src/jobs/tasks/job-history-purge.task.ts`). An `@OnEvent` body enqueues; it never downloads or spawns.
4. Add a friendly label in a `job-type-labels.ts` beside your module and register it in `apps/api/src/kvox.manifest.ts` (base types go in `apps/api/src/jobs/job-type-labels.ts`). It is optional for display but pinned by `apps/api/src/jobs/job-type-labels.spec.ts`; run that spec.
5. Write a handler spec. If the cron or event body is new, `apps/api/test/jobs/cron-enqueue-only.spec.ts` must still pass.

## Rules

- A job `type` string is permanent once jobs of that type exist. A rename is a new type.
- Any work that outlives the request or cron tick is a job. No detached `void this.doIt()`. The only permanent exemptions are the three listed in `AGENTS.md` and `docs/specs/job-queue.md` section 7.10; `cron-enqueue-only.spec.ts` is their executable form. Never add a fourth without editing both.
- Node eligibility is the default: provide both `nodeResultSchema` and `persistNodeResult` unless the handler writes as it goes, reads several tables mid-computation, or needs a privilege a node must never hold. Eligibility is derived; there is no `nodeEligible` flag. Never provide only one of the two.
- A per-job secret is declared with `nodeSecretBroker` (`apps/api/src/jobs/job-secret-broker.ts`). A node never persists it; `job_node_secrets` stores handles only.
- `profile` is optional and exactly `{ maxRuntimeMs, maxAttempts }` (`apps/api/src/jobs/job-execution-profile.ts`). Never add `leaseMs` or `heartbeatMs`.
- AI jobs spend the requesting user's own key, so they are server-only (no `nodeResultSchema`, no `persistNodeResult`). Use `aiProviderThrottleKey(userId)` from `apps/api/src/notes/job-types.ts` (per user, never a shared deployment key). Use `profile.maxAttempts: 1` when a retry would double-bill; regenerate by user action is the retry path.
- A job that re-enqueues itself for the same subject needs `skipDedup: true`, or the enqueue returns the running row and the chain stops silently.
- Guard an enqueue of a type that a later issue registers with a registry check; otherwise it creates `pending` rows no worker can claim.
- Send notifications after the job's write commits, outside any `$transaction`.
- No migration is needed: `jobs.type` is a plain string.

## Verify

```bash
cd apps/api && npm run typecheck && npm test
```

Flag the new type for the docs agent (job inventory in `docs/ARCHITECTURE.md` and the relevant spec).
