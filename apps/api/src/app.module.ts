// Belt and braces for tests that build `AppModule` without `test/setup.ts`: the
// settings DTOs below are composed from the registries this fills (see
// kvox.manifest.ts). Must stay the first import.
import './kvox.manifest';
// Fills core's role, permission, user-owned-model and model-ownership registries
// (issue #465). Imported here for the same reason as the manifest above: a test
// that builds `AppModule` without `test/setup.ts` still needs them registered.
import './app-registrations/registrations';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { platformHostModule } from './platform/platform-host.module';
import { doctorModule } from './doctor/doctor.config';
import { DoctorChecksModule } from './doctor/doctor-checks.module';
import { hostCoreModule } from './platform/host-core.config';
import { aboutModule } from './platform/about/about.config';
import { AboutContributorsModule } from './platform/about/about-contributors.module';
import { identityModule } from './platform/identity/identity.config';
// MUST precede `settings.config`: the jobs slice registers the `retention` settings
// namespace, which the platform refuses once the settings request bodies are
// composed (see `platform/jobs/jobs.config.ts`).
import { jobsModule, nodesModule, NodeCredentialModule } from './platform/jobs/jobs.config';
import { settingsModule } from './platform/settings/settings.config';
// The platform AI slice (#473). `ai.config.ts` imports `app-registrations/ai.ts`, which
// registers this app's AI features before the registry freezes.
import { aiModule } from './platform/ai/ai.config';
import {
  CredentialsModule,
  OrgCredentialsModule,
  UserCredentialsModule,
} from './platform/credentials/credentials.config';
import { AllowlistRemindersModule } from './allowlist-reminders/allowlist-reminders.module';
import { CommonModule } from './common/common.module';
import { profileImageModule, StorageConfigModule, storageModule } from './platform/storage/storage.config';
import { KvoxObjectsModule } from './kvox-objects/kvox-objects.module';
import { emailModule } from './platform/email/email.config';
import { BroadcastsModule, notificationsModule } from './platform/notifications/notifications.config';
import { dbBackupModule } from './platform/db-backup/db-backup.config';
import { telemetryModule } from './platform/telemetry/telemetry.config';
import { LoggerModule } from './common/logger/logger.module';
import { KvoxModule } from './kvox/kvox.module';
import { AiPortModule } from './ai-port/ai-port.module';
import { KvoxAiModule } from './ai-port/kvox-ai.module';
import { userDataModule } from './platform/user-data/user-data.config';
import { exportsModule } from './platform/exports/exports.config';
import { sharingModule } from './platform/sharing/sharing.config';
import { onboardingModule } from './platform/onboarding/onboarding.config';

import { NotModifiedInterceptor } from './platform/http/not-modified.interceptor';
import { UserSettingsChangeInterceptor } from './platform/settings/user-settings-change.interceptor';

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

    // The platform's DI-time host ports (audit sink, system settings store,
    // `PLATFORM_PRISMA`), bound to this app's current services (#465). Global.
    platformHostModule,
    // The platform Doctor: the identity slice registers its health checks with
    // it, so it cannot boot without it (#465). One read-only admin route.
    doctorModule,

    // Logger
    LoggerModule,

    // Feature modules
    CommonModule,
    // The platform's identity slice (#465, epic #462): `/api/auth/*`,
    // `/api/users`, `/api/roles`, `/api/allowlist`, `/api/pat`,
    // `/api/auth/device/*` and, outside production, `/api/auth/test/login`, in
    // single-organization mode. Replaces this app's own AuthModule, UsersModule,
    // AllowlistModule, PatModule, DeviceAuthModule and TestAuthModule. Global:
    // it provides `PatService` and the guards' dependencies to every module.
    identityModule,
    // The app-only allowlist reminder routes (`POST /api/allowlist/:id/reminder`,
    // `GET /api/allowlist/reminders`), a side table beside the platform's
    // allowlist, which has no seam for them (#301, moved by #465).
    AllowlistRemindersModule,
    // The platform's settings slice (#466, epic #462): `GET|PUT|PATCH
    // /api/system-settings`, `/api/user-settings` and `/api/org-settings`, with
    // the namespaces `settings/registry/` registers (the platform's five system
    // and three user declarations plus this app's `transcription`, `ai`,
    // `onboarding` and `graph`). Replaces this app's own SettingsModule. GLOBAL:
    // every module reads `SystemSettingsService` / `UserSettingsService`
    // without importing it. Must come after the manifest imports at the top.
    settingsModule,
    // Uploaded profile pictures (#367), the platform's since #469:
    // `GET|POST|DELETE /api/user-settings/profile-image` and the public avatar
    // route. A dynamic module built AFTER the user-settings namespaces are
    // registered (the upload response embeds the composed schema); it needs
    // `settingsModule` and the storage host ports.
    profileImageModule,
    // The platform host core (#464, epic #462): the event bus, the app metrics,
    // maintenance mode (`GET|PUT /api/admin/maintenance` and the application's
    // ONLY global guard, `MaintenanceGuard`), `/api/health/*`, the `{ data }`
    // envelope, the request log line, `HttpExceptionFilter` and request ids.
    // Replaces this app's HealthModule, MaintenanceModule and its own
    // APP_GUARD / APP_FILTER / APP_INTERCEPTOR providers and request-id
    // middleware. Sits where HealthModule sat so the OpenAPI path order is
    // stable. GLOBAL.
    hostCoreModule,
    // The platform's storage slice (#469, epic #467): `/api/storage/objects`
    // (the objects API, without this app's multipart-parts routes),
    // `/api/storage/status`, the `storage.cleanup.stale-uploads` and
    // `storage.object.process` job types and the stale-upload cron, over the
    // runtime-configured provider (the `storage` system setting plus the
    // credential store). Replaces this app's own `storage/` folder.
    storageModule,
    // `/api/admin/storage-config` (read, save, connection test, bucket
    // provisioning) and the `storage.*` Doctor checks.
    StorageConfigModule,
    // This app's side of storage (#469): `KvoxManagedObjects` (the only code that
    // reads `storage_objects` for the domain modules), the ownership table, the
    // multipart-parts routes the platform lacks, `GET /api/kvox/files` and the
    // transcript upload processor.
    KvoxObjectsModule,
    // Worker node credentials, the platform's since #468 (epic #467): the `nod_`
    // token family the node fleet authenticates with, and its
    // `/api/node-credentials` admin endpoints. @Global because the identity
    // slice's `JwtAuthGuard` resolves a `nod_` token through it
    // (`IDENTITY_NODE_CREDENTIALS`, bound in `platform/identity/identity-host.module.ts`).
    NodeCredentialModule,
    // Encrypted credential store (#115), the platform's since #466. Registered
    // here so it is part of the module graph; consumers still import
    // CredentialsModule explicitly (it is not @Global) so every user of a
    // plaintext-returning service is visible. The user and organization stores
    // are mounted but unused: this app keeps no credential in them.
    CredentialsModule,
    UserCredentialsModule,
    OrgCredentialsModule,
    // The platform's email slice (#470, epic #467): the SES and SMTP
    // transports, `GET|PUT /api/email-settings`, `POST /api/email-settings/test`
    // (`system_settings:read|write`), the template registry and layout (this
    // app's logo and brand colour, `platform/email/email.options.ts`) and the
    // doctor check. Replaces this app's own `email/` folder. Not global: the
    // modules that send mail import the same `emailModule` object. Neither
    // transport touches the network or reads a credential until its first send.
    emailModule,
    // The platform's notifications slice (#470, epic #467): the dispatcher
    // (`NotificationsService`), the email, in-app (inbox and SSE) and Web Push
    // channels, `/api/notifications/*`, `/api/admin/push-config/*`, the VAPID
    // Doctor check and the `jobs.job_failed` / `nodes.node_offline` notifiers.
    // Replaces this app's own `notifications/` folder. GLOBAL: a module that
    // injects `NotificationsService` imports nothing. The event registry is
    // filled by `platform/notifications/notification.manifest.ts`
    // (this app's events are in `notifications-registry/`).
    notificationsModule,
    // Admin broadcasts (#323/#324, epic #319; the platform's since #470):
    // `/api/admin/broadcasts/*` and the `admin.broadcast.start` and
    // `admin.broadcast.chunk` job handlers (type strings unchanged). A handler's
    // only wiring is the `registry.register(this)` in its own `onModuleInit`, so
    // being in the module graph IS the registration.
    BroadcastsModule,
    // The platform's jobs slice (#468, epic #467): the queue (enqueue with dedup,
    // claim, leases, the terminal state machine), the in-process worker pool,
    // the lease reaper, the job-history purge, the temp-file janitor, the
    // provider throttle and `/api/admin/jobs/*`. Replaces this app's own queue.
    // GLOBAL: a handler's only wiring is the `registry.register(this)` in its own
    // `onModuleInit`, so being in the module graph IS the registration, and a
    // broken one fails at boot.
    jobsModule,
    // The platform's worker-node control plane (#468): `/api/nodes/*` (register,
    // heartbeat, claim, lease renewal, result and failure, the brokered job
    // secret), `/api/admin/nodes/*`, the fleet sweep and prune and the
    // brokered-secret sweep. Needs `jobsModule` in the same app.
    nodesModule,

    // The platform's database backup and restore slice (#471, epic #467):
    // `/api/admin/db-backup/*` (`db_backup:read|write|restore`), the streaming
    // `pg_dump` engine, the schedule and retention, the restore (read-only
    // pre-flight with this app's extensions gate, swap, rollback), the four
    // job types `db.backup.run`, `db.backup.sweep`, `db.restore.run` and
    // `db.restore.old-db-drop` (strings unchanged) and the per-job database role
    // broker that lets `db.backup.run` run on a worker node. Replaces this app's
    // own `db-backup/` folder. Every dump and restore carries
    // `--enable-row-security` AND `PGOPTIONS=-c app.rls_bypass=on`.
    //
    // `DB_BACKUP_SCHEDULE_ENABLED=false` still turns the scheduler off in this
    // process (`config/configuration.ts`, `dbBackup.scheduleEnabled`). With
    // `JOBS_WORKER_MODE=off` this process queues backups and never takes them
    // (`system` mode does take them; the type is server-only by derivation).
    dbBackupModule,

    // The platform's telemetry slice (#471, epic #467): the `telemetry` settings
    // and runtime export gate, the GreptimeDB connection, the explorer, the
    // dashboard, the stack-agent surface, the assistant (over the platform AI slice, #472)
    // and the `telemetry.*` jobs, at `/api/admin/telemetry/*` and
    // `GET /api/telemetry/config` (`telemetry:read|write|query`). Replaces the
    // previous observability stack. The SDK that emits traces and metrics is `instrumentation.ts`.
    telemetryModule,

    // About (#124, epic #118; the platform's since #464): `GET /api/admin/about`,
    // the deployment record the CLI wrote plus live runtime and database facts,
    // with this app's "Transcription" and "Deployment" groups
    // (`app-registrations/host.ts`). Gated on `system_settings:read`.
    aboutModule,
    AboutContributorsModule,

    // This app's Doctor checks (#464): `<slug>.db.extensions` and
    // `<slug>.transcription.configured`, registered with the platform Doctor.
    DoctorChecksModule,

    // The domain as configured packages (`kvox/kvox.module.ts`, #492, epic #491). First the
    // web edition's binding of the host ports in `@marinoscar/kvox-api/ports` (#490, epic #486):
    // `KVOX_AI`, `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_IDENTITY`, `KVOX_NOTIFY`, `KVOX_EVENTS`,
    // `KVOX_PRISMA`, `KVOX_SETTINGS`, `KVOX_SECRETS` and `KVOX_AUDIT`, one adapter per port over a
    // platform slice (`platform-kvox/`; global; a missing binding stops the boot). Then each
    // slice's configuration, today transcription (#23, epic #19) and search (#175, #188, epic #164/#165):
    // the provider framework, the AssemblyAI provider, the admin settings surface and the non-admin
    // capability probe; `GET /api/search`, the hybrid ranking, the `search.index` job and its two routes.
    // After SettingsModule and CredentialsModule: the settings and secrets adapters inject their
    // services, and the slice writes its `transcription` namespace through the settings port
    // rather than touching `system_settings` itself.
    KvoxModule,

    // The transcript pipeline (#25, epic #19) is `@marinoscar/kvox-api/transcripts`, configured in
    // `kvox/transcripts/transcripts.config.ts` and imported by `KvoxModule` above (#493, epic #491).

    // The platform's sharing slice (#485, epic #478): `/api/grants` (share a record,
    // change or revoke a share, "shared with me"), `/api/grants/links`, `/api/groups`,
    // `AccessPolicy`, the user purge and the `sharing.grants.prune` job, over one
    // registered resource type, `transcript` (`app-registrations/sharing.ts`; users
    // only: no group or link shares). The transcripts configuration imports the same
    // module object for `AccessPolicy` and `GrantsService`.
    sharingModule,

    // The platform's AI slice (#473, epic #472): `GET /api/ai/config`, `/api/ai/keys`
    // (a user's own provider keys), the responses / embeddings / images / audio /
    // realtime / runs routes, `GET /api/ai/features`, `/api/ai/usage`, `/api/admin/ai/*`
    // (policy, model catalogue, deployment and organization keys, usage), the `ai.*`
    // job types and the kill switch. `AI_TARGET_RESOLVER` is this app's
    // `KvoxAiTargetResolver`, which keeps routing by connected-knowledge task. The
    // retired `apps/api/src/ai/` stack and its `user_ai_credentials` table are gone (#477).
    aiModule,
    // This app's side of the AI slice: `/api/ai-tasks/config` (the capability probe that
    // used to be `GET /api/ai/config`) and `/api/ai-tasks/settings` (task models).
    AiPortModule,
    // The `KvoxAi` port (`KVOX_AI`, #475): the one way a feature reaches a model, over
    // the platform `AiService`. Global; BEFORE the features that inject it.
    KvoxAiModule,

    // Notes (#49, epic #45) are `@marinoscar/kvox-api/notes`, configured in `kvox/notes/notes.config.ts`
    // and imported by `KvoxModule` above (#495, epic #491), after its transcripts configuration: a
    // note is generated from the transcript AS THE USER CORRECTED IT, never from the AI's original
    // result.

    // Connected knowledge (#354, epic #344) is `@marinoscar/kvox-api/graph`, `/graph-extraction` and
    // `/graph-rdf`, configured in `kvox/graph/graph.config.ts` and imported by `KvoxModule` above (#496,
    // epic #491), after the transcripts, notes and search configurations they read through. A ready note
    // reaches the extraction as the notes slice's ready event (`NOTE_READY_EVENT`) on the event port.

    // Ask (#376, epic #348) is `@marinoscar/kvox-api/ask`, configured in `kvox/ask/ask.config.ts` and
    // imported by `KvoxModule` above (#497, epic #491), after the graph, notes and search configurations it
    // reads through: saved conversations with the read-only graph agent, imported by nothing, so the
    // edge runs one way.

    // The platform's user-data slice (#480, epic #478): the Danger Zone. `GET
    // /api/user-data/summary`, `POST /api/user-data/deletions`, the `user.data.purge`
    // job (and the admin factory reset and organization offboarding routes), over the
    // categories, scopes and model hints `platform/user-data/user-data.manifest.ts`
    // registers. Replaces this app's own `user-data/` module. After the feature
    // modules because its delegates (`transcript.purge`, `note.purge`, `kg.purge`,
    // `files.purge_unmanaged`) are their handlers: it enqueues them by type string and
    // imports none of them.
    userDataModule,

    // The platform's exports slice (#532, Part B of #479): "Download your data". `GET
    // /api/exports/sources`, `POST|GET /api/exports`, `GET /api/exports/:id`, the `export.run`
    // and `export.purge` job types (server-only) and the daily expiry cron, over two sources:
    // the platform's `user-data` (every model the user-owned registry marks `include`) and this
    // app's `kvox-content` (`platform/exports/kvox-content.source.ts`: transcript speakers and
    // segments, note history, Ask messages, each tied to the user through its parent row). After
    // `userDataModule`: it reads the same user-owned registry and notifies through the global
    // `NotificationsService`.
    exportsModule,

    // First-run onboarding (#481, epic #478): the platform slice. `GET /api/onboarding` (the caller's
    // checklists, and the admin one for a holder of `system_settings:read`) and the activation
    // metrics, over the step and fact registries in `platform/onboarding/`. Last among the feature
    // modules because its facts read from most of them (resolved lazily through `ModuleRef`); it
    // owns no table and stores nothing but the user's intent, in the `onboarding` user-settings
    // namespace.
    onboardingModule,
  ],
  providers: [
    // The global guard, exception filter, logging and envelope interceptors and
    // the request-id middleware are the platform host core's (`hostCoreModule`
    // above, #464). `MaintenanceGuard` is the application's ONLY `APP_GUARD`: if
    // another global guard is ever added, list it under the `host` conformance
    // suite's `allowedAppGuards` with a reason.
    // Global validation pipe (Zod)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // PLATFORM-ADOPTION-SHIM(#464): a 304 leaves with no payload, as it did under
    // this app's own envelope interceptor. Registered here so it wraps the host
    // core's `TransformInterceptor` (see the interceptor).
    {
      provide: APP_INTERCEPTOR,
      useClass: NotModifiedInterceptor,
    },
    // PLATFORM-ADOPTION-SHIM(#466): `user-settings.namespace-changed` around
    // `PUT|PATCH /api/user-settings`, which the platform's service does not
    // emit and the graph's threshold re-scan depends on.
    {
      provide: APP_INTERCEPTOR,
      useClass: UserSettingsChangeInterceptor,
    },
  ],
})
export class AppModule {}
