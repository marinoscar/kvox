// =============================================================================
// The lifecycle race, tested for real (issue #262, epic #254)
// =============================================================================
//
// THE ONE THING IN THIS FEATURE A UNIT TEST CANNOT PROVE. "The worker starts
// from `onApplicationBootstrap`" is a claim about Nest's phase ordering, and
// asserting the hook is spelled correctly proves only that somebody spelled
// it correctly. What has to be true is stronger and is what this file
// asserts: a handler that registers from its OWN `onModuleInit` — SLOWLY, so
// the window genuinely exists — is already in the registry when the worker
// issues its first claim.
//
// The handler below awaits a real timer before registering. That delay is the
// whole test: it is the slow boot (a handler that reads a table, resolves a
// credential, or warms a client in `onModuleInit`) under which a worker
// started in the same lifecycle phase WOULD claim a job whose handler has not
// registered yet — and a claimed job with no handler is failed PERMANENTLY,
// not retried. That is a real production bug in the application this design
// was extracted from; the hook choice is the fix.
//
// See `job-handler.registry.ts`'s header, `job.worker.ts`'s header, and §1.3
// of docs/specs/job-queue.md — the same constraint stated from three sides.
// =============================================================================

import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from '@prisma/client';

import { ClaimOptions, JobClaimService } from './job-claim.service';
import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import { JobWorker } from './job.worker';
import { JobsModule } from './jobs.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

/** How long the handler below stalls before registering itself. */
const REGISTRATION_DELAY_MS = 40;

/** Set when the handler finally registers; read by the assertions. */
let registeredAt: number | null = null;

/**
 * A handler that registers LATE from its own `onModuleInit`.
 *
 * Deliberately async and deliberately slow. A handler that registers
 * synchronously would leave nothing to race, and the test would pass whether
 * or not the worker respected the phase boundary.
 */
@Injectable()
class SlowRegisteringHandler implements JobHandler, OnModuleInit {
  readonly type = 'test.slow-registering';

  constructor(private readonly registry: JobHandlerRegistry) {}

  async onModuleInit(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_DELAY_MS));

    this.registry.register(this);
    registeredAt = Date.now();
  }

  async process(_job: Job): Promise<void> {}
}

@Module({
  imports: [JobsModule],
  providers: [SlowRegisteringHandler],
})
class SlowHandlerModule {}

describe('JobWorker lifecycle (real module graph)', () => {
  let moduleRef: TestingModule;
  let claims: ClaimOptions[];
  let firstClaimAt: number | null;
  let closed = false;

  beforeEach(async () => {
    registeredAt = null;
    firstClaimAt = null;
    claims = [];
    closed = false;

    moduleRef = await Test.createTestingModule({
      imports: [
        // `forRoot()`-ed exactly as `app.module.ts` does: a bare
        // `ConfigModule` would hand this graph a `ConfigService` with none of
        // `configuration()` loaded, which is a subtler wrong than a missing
        // provider.
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        SlowHandlerModule,
      ],
    })
      // `JobsModule` imports `SettingsModule` since #263 (the reaper and the
      // purge read the `jobs` policy through `SystemSettingsService`), which
      // brings the settings CONTROLLERS into this graph along with the guards
      // they are decorated with. This suite is about lifecycle ordering and
      // has no HTTP surface, so the guard is stubbed rather than dragging the
      // whole auth graph in behind it.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      // The graph must RESOLVE, not reach a database: this suite is about
      // lifecycle ordering and never runs a job.
      .overrideProvider(PrismaService)
      .useValue({})
      // The claim is the observation point. Recording `eligibleTypes` is
      // recording exactly what the registry contained at the moment the
      // worker asked.
      .overrideProvider(JobClaimService)
      .useValue({
        claim: async (options: ClaimOptions): Promise<Job[]> => {
          claims.push(options);
          firstClaimAt ??= Date.now();

          return [];
        },
      })
      .compile();

    // `init()` runs the `onModuleInit` hooks AND THEN the
    // `onApplicationBootstrap` hooks — the two phases whose ordering is the
    // whole subject of this file.
    await moduleRef.init();
  });

  /** Guarded so the one test that closes early does not close twice. */
  async function closeOnce(): Promise<void> {
    if (closed) {
      return;
    }

    closed = true;
    await moduleRef.close();
  }

  afterEach(async () => {
    await closeOnce();
  });

  it('claims at least once during bootstrap', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  it('sees the slow handler already registered in its FIRST claim', () => {
    // Not "eventually contains" — the very first claim. A worker started in
    // the onModuleInit phase would have issued this one against an empty or
    // partial registry.
    expect(claims[0].eligibleTypes).toContain('test.slow-registering');
  });

  it('registers the handler BEFORE the first claim, with a real window to lose', () => {
    expect(registeredAt).not.toBeNull();
    expect(firstClaimAt).not.toBeNull();

    expect(registeredAt as number).toBeLessThanOrEqual(firstClaimAt as number);
  });

  it('also has the framework example handler registered by then', () => {
    // `ExampleEchoHandler` self-registers from `JobsModule`, a DIFFERENT
    // module from the slow one — so this asserts the guarantee holds across
    // module boundaries, not just within one.
    expect(claims[0].eligibleTypes).toContain('example.echo');
  });

  it('claims as the server, one row at a time', () => {
    expect(claims[0].executor).toBe('server');
    expect(claims[0].nodeId).toBeNull();
    expect(claims[0].limit).toBe(1);
  });

  it('resolves the registry through DI rather than holding its own', () => {
    const registry = moduleRef.get(JobHandlerRegistry);

    expect(registry.get('test.slow-registering')).toBeInstanceOf(SlowRegisteringHandler);
  });

  it('shuts the pool down when the module closes', async () => {
    expect(moduleRef.get(JobWorker)).toBeInstanceOf(JobWorker);

    await closeOnce();

    const callsAtClose = claims.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(claims.length).toBe(callsAtClose);
  });
});
