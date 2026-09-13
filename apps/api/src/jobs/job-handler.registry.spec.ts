import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from '@prisma/client';
import { z } from 'zod';

import { ExampleEchoHandler } from './handlers/example-echo.handler';
import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import { JobWorker } from './job.worker';
import { JobsModule } from './jobs.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

// -----------------------------------------------------------------------------
// Test doubles for the three node-eligibility shapes.
//
// The point of these three is that they differ ONLY in which optional members
// they carry — no flag, no configuration, nothing else to set. That is the
// mechanism `serverOnlyTypes()` derives from, and these classes are the whole
// input space of it.
// -----------------------------------------------------------------------------

/** Carries NEITHER optional member: server-only, the default shape. */
class NeitherMemberHandler implements JobHandler {
  readonly type = 'test.neither';

  async process(): Promise<void> {}
}

/** Carries BOTH optional members: node-eligible. */
class BothMembersHandler implements JobHandler {
  readonly type = 'test.both';

  readonly nodeResultSchema = z.object({ ok: z.boolean() });

  async process(): Promise<void> {}

  async persistNodeResult(_job: Job, _result: unknown): Promise<void> {}
}

/** Schema only, no persist function: server-only, not half-eligible. */
class SchemaOnlyHandler implements JobHandler {
  readonly type = 'test.schema-only';

  readonly nodeResultSchema = z.object({ ok: z.boolean() });

  async process(): Promise<void> {}
}

/** Persist function only, no schema: server-only, not half-eligible. */
class PersistOnlyHandler implements JobHandler {
  readonly type = 'test.persist-only';

  async process(): Promise<void> {}

  async persistNodeResult(_job: Job, _result: unknown): Promise<void> {}
}

describe('JobHandlerRegistry', () => {
  let registry: JobHandlerRegistry;

  beforeEach(() => {
    registry = new JobHandlerRegistry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register / get / types', () => {
    it('returns the registered handler for its type', () => {
      const handler = new NeitherMemberHandler();
      registry.register(handler);

      expect(registry.get('test.neither')).toBe(handler);
    });

    it('returns undefined for an unregistered type rather than throwing', () => {
      // A `jobs` row can name a type this process does not run — a handler
      // that was removed or renamed. The caller decides what that means.
      expect(registry.get('test.never-registered')).toBeUndefined();
    });

    it('lists every registered type, in registration order', () => {
      registry.register(new NeitherMemberHandler());
      registry.register(new BothMembersHandler());

      expect(registry.types()).toEqual(['test.neither', 'test.both']);
    });

    it('starts empty', () => {
      expect(registry.types()).toEqual([]);
    });
  });

  describe('duplicate registration', () => {
    it('logs a warning and lets the LAST registration win', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const first = new NeitherMemberHandler();
      // A second, distinct class claiming the same `type` string.
      class ShadowingHandler implements JobHandler {
        readonly type = 'test.neither';

        async process(): Promise<void> {}
      }
      const second = new ShadowingHandler();

      registry.register(first);
      registry.register(second);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain('test.neither');
      expect(message).toContain('NeitherMemberHandler');
      expect(message).toContain('ShadowingHandler');

      // Last one wins — the override, not the first registration.
      expect(registry.get('test.neither')).toBe(second);
      // ...and the type is listed once, not twice.
      expect(registry.types()).toEqual(['test.neither']);
    });

    it('does not warn when two different types are registered', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      registry.register(new NeitherMemberHandler());
      registry.register(new BothMembersHandler());

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('serverOnlyTypes', () => {
    it('includes a handler carrying NEITHER optional member', () => {
      registry.register(new NeitherMemberHandler());

      expect(registry.serverOnlyTypes()).toEqual(['test.neither']);
    });

    it('EXCLUDES a handler carrying BOTH optional members', () => {
      registry.register(new BothMembersHandler());

      expect(registry.serverOnlyTypes()).toEqual([]);
      // It is registered — it is just not server-only.
      expect(registry.types()).toEqual(['test.both']);
    });

    it('counts a handler carrying ONLY nodeResultSchema as server-only', () => {
      registry.register(new SchemaOnlyHandler());

      expect(registry.serverOnlyTypes()).toEqual(['test.schema-only']);
    });

    it('counts a handler carrying ONLY persistNodeResult as server-only', () => {
      registry.register(new PersistOnlyHandler());

      expect(registry.serverOnlyTypes()).toEqual(['test.persist-only']);
    });

    it('partitions a mixed registry: everything but the both-members handler', () => {
      registry.register(new NeitherMemberHandler());
      registry.register(new BothMembersHandler());
      registry.register(new SchemaOnlyHandler());
      registry.register(new PersistOnlyHandler());

      expect(registry.serverOnlyTypes().sort()).toEqual(
        ['test.neither', 'test.persist-only', 'test.schema-only'].sort()
      );
    });

    it('is empty for an empty registry', () => {
      expect(registry.serverOnlyTypes()).toEqual([]);
    });
  });
});

describe('ExampleEchoHandler self-registration (via JobsModule)', () => {
  let moduleRef: TestingModule;
  let registry: JobHandlerRegistry;

  beforeEach(async () => {
    // `PrismaModule` is imported and its `PrismaService` STUBBED because
    // `JobsModule` gained two database-backed providers with #260
    // (`JobsService`, `JobClaimService`). This suite is about registration
    // and self-registration only — it never enqueues and never claims — so it
    // needs the injection to RESOLVE, not to reach a database. Importing the
    // (`@Global()`) module satisfies the graph; overriding the provider keeps
    // a unit test from opening a connection in `onModuleInit`.
    //
    // `ConfigModule` and `EventEmitterModule` are here for the same
    // "resolve, don't exercise" reason, added with #261: the terminal state
    // machine reads its retry budgets from `ConfigService` and announces
    // settled jobs through `EventEmitter2`. Both are `forRoot()`-ed exactly
    // as `app.module.ts` does — a bare `ConfigModule` import would hand this
    // graph a `ConfigService` with none of `configuration()` loaded, which is
    // a subtler wrong than a missing provider.
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        JobsModule,
      ],
    })
      // See the note in `job.worker.bootstrap.spec.ts`: `JobsModule` imports
      // `SettingsModule` since #263, which brings its controllers (and their
      // guards) into this graph. Nothing here serves a request.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PrismaService)
      .useValue({})
      // `JobWorker` (#262) is the one provider in `JobsModule` that RUNS on
      // its own: `init()` below reaches `onApplicationBootstrap` and it would
      // start polling a stubbed Prisma for the life of this suite. Its own
      // lifecycle is proven in `job.worker.bootstrap.spec.ts`; here it would
      // only add noise.
      .overrideProvider(JobWorker)
      .useValue({})
      .compile();

    // `init()` is what runs the `onModuleInit` hooks — the registration path
    // itself. Without it the registry would be empty, which is exactly the
    // race the worker avoids by starting from `onApplicationBootstrap`.
    await moduleRef.init();

    registry = moduleRef.get(JobHandlerRegistry);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('registers itself, so its type appears in types()', () => {
    expect(registry.types()).toContain('example.echo');
  });

  it('is retrievable by type and is the module instance', () => {
    expect(registry.get('example.echo')).toBe(moduleRef.get(ExampleEchoHandler));
  });

  it('is server-only: it carries neither optional member', () => {
    // Typed as the INTERFACE, not the class: the class does not declare the
    // optional members at all, which is the point — server-only is the
    // absence of them, not a value set to false anywhere.
    const handler: JobHandler = moduleRef.get(ExampleEchoHandler);

    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain('example.echo');
  });

  it('processes a job without throwing, and logs the payload', async () => {
    const handler = moduleRef.get(ExampleEchoHandler);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const job = {
      id: 'job-1',
      type: 'example.echo',
      reason: 'rerun',
      attempts: 1,
      payload: { hello: 'world' },
    } as unknown as Job;

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0] as string).toContain('job-1');
    expect(log.mock.calls[0][0] as string).toContain('"hello":"world"');

    log.mockRestore();
  });
});
