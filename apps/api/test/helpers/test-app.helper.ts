import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AppModule } from '../../src/app.module';
import { JobWorker } from '../../src/jobs/job.worker';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prismaMock } from '../mocks/prisma.mock';

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  /** Access to Prisma mock methods (only available when isMocked is true) */
  prismaMock: any;
  module: TestingModule;
  isMocked: boolean;
}

export interface TestAppOptions {
  /**
   * If true, uses a mocked PrismaService instead of connecting to a real database
   * This is recommended for unit/integration tests
   * Set to false only for true E2E tests that need a real database
   */
  useMockDatabase?: boolean;

  /**
   * Called after the global prefix is set but before `init()` — the same point
   * in the boot sequence `main.ts` uses.
   *
   * Exists for `registerDocsRoutes`, which adds raw Fastify routes: Fastify
   * refuses new routes once its root plugin has booted, so a spec cannot add
   * them after `createTestApp` returns.
   */
  registerRoutes?: (app: NestFastifyApplication) => void;

  /**
   * Additional provider substitutions applied on top of the mandatory
   * `PrismaService` mock, e.g. `{ provide: CredentialsService, useValue: stub }`.
   *
   * Exists so a full-`AppModule` integration spec (issue #124's email-settings
   * suite is the first user) can control a narrow slice of the app — a
   * transport it does not want to hit the network, a service it wants to drive
   * with a controllable stub — while every other provider stays the REAL one
   * wired by `AppModule`. Only `PrismaService` gets a mock unconditionally;
   * everything else opts in here, one entry per provider, so a spec's fixture
   * list is a visible, reviewable diff rather than a growing pile of module
   * overrides only that spec knows about.
   */
  overrideProviders?: Array<{ provide: unknown; useValue: unknown }>;
}

/**
 * Creates a fully configured test application
 * By default, uses mocked PrismaService (no real database)
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  // Default to mocked database for unit/integration tests
  const shouldUseMock = options.useMockDatabase ?? true;

  let moduleFixture: TestingModule;

  if (shouldUseMock) {
    // Create test module with mocked PrismaService
    let builder = Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      // The background job worker (#262) starts a polling pool from
      // `onApplicationBootstrap`, which `app.init()` below reaches. Against a
      // mocked database it would claim nothing, log a failure every poll
      // interval, and add a timer to every spec in the suite for no benefit —
      // no test that uses this helper is about background execution. Its own
      // behaviour is covered by `src/jobs/job.worker.spec.ts` and
      // `src/jobs/job.worker.bootstrap.spec.ts`, both of which drive it
      // deliberately.
      .overrideProvider(JobWorker)
      .useValue({});

    for (const { provide, useValue } of options.overrideProviders ?? []) {
      builder = builder.overrideProvider(provide).useValue(useValue);
    }

    moduleFixture = await builder.compile();
  } else {
    // Create test module with real database (for true E2E tests)
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  }

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  // Register cookie plugin for auth tests
  await app.register(fastifyCookie, {
    secret: 'test-secret',
  });

  // Register multipart plugin, mirroring main.ts, so specs can drive a real
  // multipart/form-data request (e.g. the #367 profile-image upload) through
  // supertest's `.attach()` instead of stubbing `req.file()`. Harmless for
  // every other spec: nothing else in the app requires it to be absent.
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 1,
    },
  });

  app.setGlobalPrefix('api');
  // Note: ZodValidationPipe is already registered globally via APP_PIPE in AppModule
  // Do NOT add a standard ValidationPipe here as it conflicts with Zod DTOs

  options.registerRoutes?.(app);

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = moduleFixture.get<PrismaService>(PrismaService);

  return {
    app,
    prisma,
    prismaMock: shouldUseMock ? prismaMock : null,
    module: moduleFixture,
    isMocked: shouldUseMock,
  };
}

/**
 * Creates a minimal test module for unit testing
 */
export async function createTestModule(
  imports: any[] = [],
  providers: any[] = [],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports,
    providers,
  }).compile();
}

/**
 * Closes the test application and cleans up
 */
export async function closeTestApp(context: TestContext): Promise<void> {
  if (context && context.app) {
    await context.app.close();
  }
  // Skip disconnect if using mocked database
  if (context && context.prisma && !context.isMocked) {
    await context.prisma.$disconnect();
  }
}
