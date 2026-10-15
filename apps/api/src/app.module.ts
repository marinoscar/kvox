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
import {
  CredentialsModule,
  OrgCredentialsModule,
  UserCredentialsModule,
} from './platform/credentials/credentials.config';
import { AllowlistRemindersModule } from './allowlist-reminders/allowlist-reminders.module';
import { CommonModule } from './common/common.module';
import { ProfileImageModule } from './settings/profile-image/profile-image.module';
import { StorageModule } from './storage/storage.module';
import { EmailModule } from './email/email.module';
import { BroadcastsModule } from './notifications/broadcasts/broadcasts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DbBackupModule } from './db-backup/db-backup.module';
import { LoggerModule } from './common/logger/logger.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { TranscriptsModule } from './transcripts/transcripts.module';
import { AiModule } from './ai/ai.module';
import { NotesModule } from './notes/notes.module';
import { GraphModule } from './graph/graph.module';
import { GraphExtractionModule } from './graph/extraction/extraction.module';
import { GraphResolutionModule } from './graph/resolution/resolution.module';
import { GraphDedupModule } from './graph/dedup/dedup.module';
import { GraphProposalsModule } from './graph/proposals/proposals.module';
import { GraphImportModule } from './graph/import/graph-import.module';
import { AskModule } from './ask/ask.module';
import { SearchIndexingModule } from './search/indexing/search-indexing.module';
import { UserDataModule } from './user-data/user-data.module';
import { SearchModule } from './search/search.module';
import { OnboardingModule } from './onboarding/onboarding.module';

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
    // Uploaded profile pictures (#367): its own module because it needs the
    // storage provider and SettingsModule must not (see the module).
    ProfileImageModule,
    // The platform host core (#464, epic #462): the event bus, the app metrics,
    // maintenance mode (`GET|PUT /api/admin/maintenance` and the application's
    // ONLY global guard, `MaintenanceGuard`), `/api/health/*`, the `{ data }`
    // envelope, the request log line, `HttpExceptionFilter` and request ids.
    // Replaces this app's HealthModule, MaintenanceModule and its own
    // APP_GUARD / APP_FILTER / APP_INTERCEPTOR providers and request-id
    // middleware. Sits where HealthModule sat so the OpenAPI path order is
    // stable. GLOBAL.
    hostCoreModule,
    StorageModule,
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

    // About (#124, epic #118; the platform's since #464): `GET /api/admin/about`,
    // the deployment record the CLI wrote plus live runtime and database facts,
    // with this app's "Transcription" and "Deployment" groups
    // (`app-registrations/host.ts`). Gated on `system_settings:read`.
    aboutModule,
    AboutContributorsModule,

    // This app's Doctor checks (#464): `<slug>.db.extensions` and
    // `<slug>.transcription.configured`, registered with the platform Doctor.
    DoctorChecksModule,

    // Transcription (#23, epic #19): the provider framework, the AssemblyAI
    // provider, the admin settings surface and the non-admin capability probe.
    // Imported after SettingsModule because it writes the `transcription`
    // namespace through `SystemSettingsService.patchSettings` rather than
    // touching `system_settings` itself — the same arrangement DbBackupModule
    // has with `databaseBackup`.
    TranscriptionModule,

    // The transcript pipeline (#25, epic #19): create, the upload listener,
    // five job handlers, the reconciliation cron and the read/lifecycle
    // routes. After TranscriptionModule because it imports it for the provider
    // registry and the settings service, and after StorageModule because it
    // calls `ObjectsService.initUpload` with a `managedBy` only a module may
    // claim.
    TranscriptsModule,

    // AI (#47, epic #45): the provider framework, the OpenAI provider, the
    // deployment policy surface, the PER-USER credential surface and the
    // capability probe. After SettingsModule because it writes the `ai`
    // namespace through `SystemSettingsService.patchSettings` rather than
    // touching `system_settings` itself — the same arrangement
    // TranscriptionModule and DbBackupModule have with their namespaces.
    //
    // It deliberately does NOT import CredentialsModule: this epic stores no
    // deployment AI key. Each user's key lives in `user_ai_credentials` behind
    // a cascading foreign key. See `AiModule`'s own header.
    AiModule,

    // Notes (#49, epic #45): the `note.generate` pipeline. AFTER AiModule
    // (provider registry, deployment policy, the per-user credential service)
    // and AFTER TranscriptsModule, which it imports for `materialize()` — a
    // note is generated from the transcript AS THE USER CORRECTED IT, never
    // from the AI's original result.
    NotesModule,

    // Connected knowledge (#354, epic #344): the graph scaffold — the
    // `graph:*` access service, the effective-ontology service and
    // `GET /api/graph/ontology`. After NotesModule and TranscriptsModule
    // (imported for #355's evidence validation); imported by nothing, so the
    // dependency edge runs one way.
    GraphModule,

    // Graph extraction (#363): `kg.extract`, its two routes and the proposal
    // stage registry. NotesModule imports it too (the note-ready hook); listed
    // here explicitly for the reason SearchIndexingModule is below.
    GraphExtractionModule,

    // Entity resolution (#364): the `resolution` proposal stage, merges and
    // their reversal, distinct pairs, and the `kg.resolve` / `kg.embed` jobs.
    // Imports GraphExtractionModule (the stage registry) and SearchModule (the
    // embedder contract); imported by nothing here, one-way.
    GraphResolutionModule,
    // Work-item dedup, temporal closing and rejection memory (#365): three
    // proposal stages after resolution. Imports GraphResolutionModule; one-way.
    GraphDedupModule,

    // Graph proposal review (#366): list/get/decide/add-from-span, the commit
    // (the one general write path into the graph) and its revert. Imports
    // GraphResolutionModule for merges, distinct pairs and alias learning.
    GraphProposalsModule,
    // Graph import (#387): `POST /api/graph/imports`, the attribute-offer
    // routes and `kg.import`, which runs every proposal stage over an import.
    // Imports GraphExtractionModule and GraphResolutionModule; one-way.
    GraphImportModule,

    // Ask (#376, epic #348): saved conversations with the read-only graph
    // agent. Imports GraphModule for `GraphAccessService` (scope validation);
    // imported by nothing, so the edge runs one way.
    AskModule,

    // Semantic search, indexing half (#188, epic #165): the `search.index` job
    // and the enqueue/forget surface its callers use. Listed explicitly even
    // though TranscriptsModule, NotesModule and UserDataModule each import it —
    // a module reached only transitively is one whose handler registration
    // depends on somebody else's import list, which is exactly the kind of
    // action-at-a-distance this file exists to make visible.
    //
    // It imports AiModule (registry, policy, the per-user credential service),
    // JobsModule and PrismaModule, and NEITHER TranscriptsModule NOR
    // NotesModule — it reads both documents' rows through Prisma directly, so
    // the dependency edge runs one way and no `forwardRef` is needed anywhere.
    SearchIndexingModule,

    // The Danger Zone (#80): a user deleting their own data in bulk. LAST of
    // the feature modules because it imports several of them and is imported by
    // none — it reuses `NotesService`, `TranscriptPipelineService`,
    // `ObjectsService`, `NoteTemplatesService`, `PatService` and
    // `UserAiCredentialsService` rather than reimplementing any of the per-item
    // deletion machinery those already own.
    UserDataModule,

    // Cross-module search (#175, epic #164): `GET /api/search`, ranked
    // full-text over transcript and note content. Registered AFTER both
    // feature modules for readability, but it imports NEITHER — it reads their
    // tables through raw `SELECT`s and depends only on `PrismaModule`. See
    // `SearchModule`'s own header for why that independence is deliberate
    // rather than an oversight.
    SearchModule,

    // First-run onboarding (#274/#275, epic #271): two read-only routes over
    // one step registry — the administrator's setup checklist and the user's
    // own activation checklist. Registered LAST among the feature modules
    // because it reads from most of them and owns no table of its own: every
    // status it reports is derived, on every request, from services declared
    // above. It stores nothing; the only persisted onboarding state in the
    // epic is the user's INTENT, which lives in `SettingsModule`'s `onboarding`
    // user-settings namespace (#272).
    OnboardingModule,
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
