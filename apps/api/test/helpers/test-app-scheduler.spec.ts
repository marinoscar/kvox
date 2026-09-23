// =============================================================================
// Regression test for issue #319
// =============================================================================
//
// `createTestApp` boots the real `AppModule`, which wires
// `ScheduleModule.forRoot()` — so every integration spec built on it starts
// the same crons a running deployment does (node-stale-offline, the db-backup
// scheduler, notes/transcripts housekeeping, and the rest). Left running,
// those tasks fire on real 10-minute wall-clock boundaries and enqueue jobs
// through `prisma.job.create`, which is exactly what turned
// `test/broadcasts/broadcasts.integration.spec.ts`'s
// `expect(prisma.job.create).not.toHaveBeenCalled()` into a test that only
// failed on the unlucky CI runs that crossed `hh:x0:00`.
//
// `stopScheduledWork` (called from `createTestApp` right after `app.init()`)
// is the fix, and this spec is what pins it: every cron `SchedulerRegistry`
// knows about must be stopped once the app is up, and — so this test cannot
// pass by accident because `AppModule` registered nothing — there must be at
// least one registered cron to begin with.
// =============================================================================

import { SchedulerRegistry } from '@nestjs/schedule';

import { TestContext, createTestApp, closeTestApp } from './test-app.helper';

describe('createTestApp scheduled work (#319)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('registers at least one cron job, so the "none are running" assertion below is not vacuous', () => {
    const registry = context.app.get(SchedulerRegistry, { strict: false });
    const cronJobs = [...registry.getCronJobs().values()];

    expect(cronJobs.length).toBeGreaterThan(0);
  });

  it('stops every registered cron job so integration tests never depend on the wall clock', () => {
    const registry = context.app.get(SchedulerRegistry, { strict: false });
    const cronJobs = [...registry.getCronJobs().values()];

    for (const job of cronJobs) {
      expect(job.isActive).toBe(false);
    }
  });

  it('clears every registered interval and timeout', () => {
    const registry = context.app.get(SchedulerRegistry, { strict: false });

    expect(registry.getIntervals()).toEqual([]);
    expect(registry.getTimeouts()).toEqual([]);
  });
});
