import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { ProfileImageModule } from './settings/profile-image/profile-image.module';
import { HealthModule } from './health/health.module';
import { AllowlistModule } from './allowlist/allowlist.module';
import { DeviceAuthModule } from './device-auth/device-auth.module';
import { StorageModule } from './storage/storage.module';
import { PatModule } from './pat/pat.module';
import { NodeCredentialModule } from './nodes/node-credential.module';
import { NodesModule } from './nodes/nodes.module';
import { CredentialsModule } from './credentials/credentials.module';
import { EmailModule } from './email/email.module';
import { BroadcastsModule } from './notifications/broadcasts/broadcasts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { JobsModule } from './jobs/jobs.module';
import { DbBackupModule } from './db-backup/db-backup.module';
import { LoggerModule } from './common/logger/logger.module';
import { TestAuthModule } from './test-auth/test-auth.module';
import { MaintenanceModule } from './common/maintenance/maintenance.module';
import { MaintenanceGuard } from './common/maintenance/maintenance.guard';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

import configuration from './config/configuration';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Scheduling (must be at root level for NestJS 11)
    ScheduleModule.forRoot(),

    // Event emitter for async events
    EventEmitterModule.forRoot(),

    // Database
    PrismaModule,

    // Logger
    LoggerModule,

    // Feature modules
    CommonModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    // Uploaded profile pictures (#367): its own module because it needs the
    // storage provider and SettingsModule must not (see the module).
    ProfileImageModule,
    HealthModule,
    AllowlistModule,
    DeviceAuthModule,
    StorageModule,
    PatModule,
    // Worker node credentials (#267, epic #254): the `nod_` token family the
    // node fleet authenticates with, and its `/api/node-credentials` admin
    // endpoints. Registered here beside `PatModule` and for the same reason —
    // both are @Global providers of a service `JwtAuthGuard` injects, so the
    // module that owns the application is where they belong rather than
    // scattered through whichever feature module happened to need one.
    //
    // DELIBERATELY NOT the (much heavier) nodes module #268 will add; see the
    // block comment in `nodes/node-credential.module.ts` for why splitting by
    // dependency weight rather than by topic is what keeps the guard's
    // dependency graph acyclic.
    NodeCredentialModule,
    // Encrypted credential store (#115). Registered here so it is part of the
    // module graph; consumers still import CredentialsModule explicitly (it is
    // not @Global) so every user of a plaintext-returning service is visible.
    CredentialsModule,
    // Email transports (#122, epic #109) and, since #124, the admin email
    // settings endpoints. Registered here even though nothing sends mail
    // automatically yet: it makes a broken provider graph fail at boot rather
    // than surfacing as a DI error in #125. It costs nothing at runtime --
    // neither transport touches the network or reads a credential until its
    // first send.
    EmailModule,
    // Notifications (#121/#124/#125, epic #109): the event registry endpoint,
    // and since #125 the dispatcher, preference resolution and delivery
    // records. Registered here even though no real event is wired yet (#128)
    // so a broken channel graph — a duplicate channel registration, a missing
    // transport — fails at boot rather than at the first notification.
    NotificationsModule,
    // Admin notification broadcasts -- the fan-out half (#323, epic #319): the
    // `admin.broadcast.start` and `admin.broadcast.chunk` job handlers, which
    // turn one composed announcement into a chunked, resumable send to every
    // active user over the existing dispatcher. Registered here for the reason
    // `NotificationsModule` and `JobsModule` above are: a handler's only
    // wiring is the `registry.register(this)` in its own `onModuleInit`, so
    // being in the graph IS the registration, and a broken one fails at boot
    // rather than the first time an admin presses Send. The admin API (#324)
    // and page (#325) land on top of this module later.
    BroadcastsModule,
    // Background job queue (#259, epic #254): the handler contract, the
    // handler registry and one worked example handler. Registered here even
    // though nothing enqueues, claims or runs a job yet (#260-#263 add
    // enqueue/claim, the terminal state machine, the worker pool and the
    // hygiene crons) so a broken graph fails at boot rather than at the first
    // job -- and so the example handler's self-registration is exercised on
    // every boot, which is what proves the extension point actually works. It
    // costs nothing at runtime: no loop is started and no query is issued
    // until a worker exists.
    JobsModule,
    // The worker-node control plane (#268, epic #254): register/reattach,
    // heartbeat, claim, lease renewal, result and failure submission at
    // `/api/nodes`. Registered AFTER `JobsModule` for readability only — Nest
    // resolves the graph, not the order — but the dependency is real and
    // one-way: this module claims through `JobClaimService` and settles
    // through `JobTerminalService` rather than owning either, which is what
    // keeps the two executors (this API's own worker pool, and a remote node)
    // from ever disagreeing about a row.
    //
    // Deliberately separate from the `@Global` `NodeCredentialModule` above,
    // which carries only the guard's dependency; see the block comments in
    // both node modules for why splitting by dependency weight is what keeps
    // `JwtAuthGuard` out of a cycle with `JobsModule`.
    NodesModule,

    // The database backup engine (#281, epic #254): the `database_backup_runs`
    // table's only writer, and the streaming `pg_dump` behind it. Registered
    // here so a broken provider graph fails at boot rather than at 02:00 on
    // the first night backups are switched on.
    //
    // ⚠ IT IS A JOB TYPE SINCE #351 (epic #345), having deliberately not been
    // one before. `db.backup.run` is registered by `DbBackupModule`, and the
    // dump's lifetime is the job's lifetime. The three objections the schema
    // used to raise — the 30-minute reaper resetting a long dump, an
    // in-process worker that never renewed its lease, and an attempt budget
    // that would re-run a failed multi-gigabyte dump — are answered by the
    // handler's `{ maxRuntimeMs: 6h, maxAttempts: 1 }` profile (#346) and by
    // #347's lease renewal. See the "### Why this WAS not a queue job" block
    // above `DatabaseBackupRun` in prisma/schema.prisma, which keeps the
    // history rather than pretending the objections were never valid.
    //
    // ⚠ CONSEQUENCE FOR AN ENQUEUE-ONLY DEPLOYMENT: with
    // `JOBS_WORKER_MODE=off` this process queues backups and never takes them.
    // `system` mode DOES take them (the type is server-only by derivation, so
    // that mode claims it); only `off` does not, which is what `off` means.
    // The stale sweep's `pending` arm is what stops those unclaimed rows
    // holding the single active backup slot forever.
    DbBackupModule,

    // Maintenance mode (#257, epic #254): the three-layer switch, its admin
    // endpoints, and the global guard registered below. Imported here — rather
    // than left to whichever module happened to need it — because the guard it
    // provides runs in front of every route in this application, and that
    // belongs in the module that owns the application.
    MaintenanceModule,

    // Test modules (non-production only)
    ...(process.env.NODE_ENV !== 'production' ? [TestAuthModule] : []),
  ],
  providers: [
    // ------------------------------------------------------------------------
    // The application's ONLY global guard (#257, epic #254)
    // ------------------------------------------------------------------------
    //
    // It runs on every Nest route, before any route-level `UseGuards`, and
    // answers exactly one question: is this deployment deliberately out of
    // service? Routes carrying `@AllowDuringMaintenance()` are exempt — health,
    // sign-in, token refresh, device activation, the test-auth routes, and the
    // maintenance endpoints themselves. Everything else is a 503 while a window
    // is open.
    //
    // `useExisting`, not `useClass`: the instance is constructed in
    // `MaintenanceModule`, which is where its `JwtService` lives (that module
    // registers its own rather than importing `AuthModule` — see the module for
    // why). `useClass` here would try to construct the guard in THIS context
    // and would need the whole auth graph exported into it.
    //
    // NOT COVERED, and documented rather than discovered: `/api/docs` and
    // `/api/openapi.json` are mounted directly on the Fastify instance by
    // `openapi/register-docs-routes.ts`, outside Nest's router, so they never
    // reach this guard and stay readable during a window. See
    // docs/specs/maintenance-mode.md.
    {
      provide: APP_GUARD,
      useExisting: MaintenanceGuard,
    },
    // Global validation pipe (Zod)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global response transform interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes('*');
  }
}
