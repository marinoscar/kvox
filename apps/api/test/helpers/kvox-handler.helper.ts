// =============================================================================
// Test helper: a slice's job handler as the platform queue sees it (issue #493, epic #491)
// =============================================================================
//
// A handler of `@marinoscar/kvox-api` registers through the `KVOX_JOBS` port; the web edition's
// adapter (`PlatformKvoxJobsAdapter`) turns it into a platform `JobHandler` with the same type,
// profile, node members and throttle behaviour. The platform's handler conformance helper
// (`describeJobHandlerConformance`) holds a PLATFORM handler to the contract every job type
// shares, so a spec of a slice handler builds the adapter, lets the handler register itself
// through it, and hands the helper what the registry holds.
// =============================================================================

import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  type JobHandler,
  type JobsService,
} from '@marinoscar/platform-api/jobs';

import { PlatformKvoxJobsAdapter } from '../../src/platform-kvox/jobs/platform-kvox-jobs.adapter';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** The adapter and the registry it registers into. */
export interface KvoxJobsHarness {
  /** Inject this as `KVOX_JOBS`. */
  adapter: PlatformKvoxJobsAdapter;
  registry: JobHandlerRegistry;
}

/**
 * The web edition's jobs adapter over `jobs` (the platform queue, often the fake one) and a
 * stub database that answers only what the adapter asks: the default organization, and "no
 * active job" for the dedup look-up.
 */
export function createKvoxJobsHarness(jobs: Partial<JobsService> = {}): KvoxJobsHarness {
  const prisma = {
    organization: { findFirst: async () => ({ id: 'org-1' }) },
    job: { findFirst: async () => null, findMany: async () => [] },
  } as unknown as PrismaService;

  const registry = new JobHandlerRegistry();
  const adapter = new PlatformKvoxJobsAdapter(
    jobs as JobsService,
    registry,
    new ProviderThrottleService({ get: () => undefined } as never),
    prisma,
    new EventEmitter2(),
  );

  return { adapter, registry };
}

/**
 * Starts `handler` (it registers itself through the adapter, as at boot) and returns the
 * platform handler the registry now holds for its type.
 */
export function platformHandlerOf(harness: KvoxJobsHarness, handler: { type: string; onModuleInit(): void }): JobHandler {
  handler.onModuleInit();

  const registered = harness.registry.get(handler.type);

  if (!registered) throw new Error(`The adapter registered no handler for "${handler.type}"`);

  return registered;
}
