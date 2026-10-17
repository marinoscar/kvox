import { Module, type DynamicModule } from '@nestjs/common';
import { APP_NAME, APP_SLUG } from '@app/shared';
import { JwtAuthGuard } from '@marinoscar/platform-api/identity';
import { CredentialsModule } from '@marinoscar/platform-api/credentials';
import { ObjectProcessingModule } from '@marinoscar/platform-api/storage';
import { KvoxPortsModule, type KvoxPortBindings } from '@marinoscar/kvox-api/core';

import { PrismaService } from '../prisma/prisma.service';
import { KvoxObjectsModule } from '../kvox-objects/kvox-objects.module';
import { PlatformKvoxAiAdapter } from './ai/platform-kvox-ai.adapter';
import { PlatformKvoxAuditAdapter } from './audit/platform-kvox-audit.adapter';
import { PlatformKvoxEventsAdapter } from './events/platform-kvox-events.adapter';
import { PlatformKvoxIdentityAdapter } from './identity/platform-kvox-identity.adapter';
import { PlatformKvoxJobsAdapter } from './jobs/platform-kvox-jobs.adapter';
import { PlatformKvoxNotifyAdapter } from './notify/platform-kvox-notify.adapter';
import { PlatformKvoxObjectStoreAdapter } from './object-store/platform-kvox-object-store.adapter';
import { PlatformKvoxSecretsAdapter } from './secrets/platform-kvox-secrets.adapter';
import { PlatformKvoxSettingsAdapter } from './settings/platform-kvox-settings.adapter';

// =============================================================================
// PlatformKvoxModule (issue #490, epic #486)
// =============================================================================
//
// The web edition's binding of the host ports in `@marinoscar/kvox-api/ports`: one
// adapter per port over a platform slice. A packaged domain slice injects `KVOX_AI`,
// `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_IDENTITY`, `KVOX_NOTIFY`, `KVOX_EVENTS`,
// `KVOX_PRISMA`, `KVOX_SETTINGS`, `KVOX_SECRETS` and `KVOX_AUDIT` and imports nothing
// of the platform. This folder is the ONLY place in the domain's dependency graph that
// names `@marinoscar/platform-*` for these ports (the Desktop edition binds its own).
//
//   KVOX_AI            -> ai/        the app's `KvoxAi` facade (over `AiService.forUser`)
//   KVOX_OBJECT_STORE  -> object-store/  `KvoxManagedObjects`, `ObjectsService`, `ObjectProcessorRegistry`
//   KVOX_JOBS          -> jobs/      `JobsService`, `JobHandlerRegistry`, the provider throttle
//   KVOX_IDENTITY      -> identity/  `JwtAuthGuard`, normalised here
//   KVOX_NOTIFY        -> notify/    `NotificationsService`, `registerNotification`
//   KVOX_EVENTS        -> events/    the host core's `EVENT_BUS`
//   KVOX_PRISMA        -> (existing) the app's `PrismaService`
//   KVOX_SETTINGS      -> settings/  the platform settings registries and services
//   KVOX_SECRETS       -> secrets/   the platform encrypted `CredentialsService`
//   KVOX_AUDIT         -> audit/     the platform `AUDIT_SINK`
//
// GLOBAL, because `KvoxPortsModule` is: a domain module imports nothing to inject a
// port. Imported in `app.module.ts` before every domain module. A missing binding is a
// boot error naming the port (`KvoxPortsModule.forRoot`).
// =============================================================================

/**
 * Providers the adapters need that no module exports on its own: the platform
 * `JwtAuthGuard` (a guard class Nest normally builds where it is used) and the
 * modules whose providers the adapters inject.
 */
@Module({
  imports: [KvoxObjectsModule, CredentialsModule, ObjectProcessingModule],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard, KvoxObjectsModule, CredentialsModule, ObjectProcessingModule],
})
export class PlatformKvoxDepsModule {}

/** The binding of every port to its web-edition adapter. */
export const platformKvoxPorts: KvoxPortBindings = {
  ai: { useClass: PlatformKvoxAiAdapter },
  objectStore: { useClass: PlatformKvoxObjectStoreAdapter },
  jobs: { useClass: PlatformKvoxJobsAdapter },
  identity: { useClass: PlatformKvoxIdentityAdapter },
  notify: { useClass: PlatformKvoxNotifyAdapter },
  prisma: { useExisting: PrismaService },
  settings: { useClass: PlatformKvoxSettingsAdapter },
  secrets: { useClass: PlatformKvoxSecretsAdapter },
  events: { useClass: PlatformKvoxEventsAdapter },
  audit: { useClass: PlatformKvoxAuditAdapter },
  imports: [PlatformKvoxDepsModule],
};

/**
 * Builds the global ports module over the web-edition adapters.
 *
 * @param ports - bindings to replace or remove (tests use it to prove a missing
 *   binding stops the boot).
 */
export function createPlatformKvoxModule(ports: Partial<KvoxPortBindings> = {}): DynamicModule {
  return KvoxPortsModule.forRoot({
    ports: { ...platformKvoxPorts, ...ports },
    // What this deployment calls itself (the PDF footer reads it).
    brand: { appName: APP_NAME, appSlug: APP_SLUG },
  });
}

/** The module `app.module.ts` imports, before any domain module. */
export const platformKvoxModule: DynamicModule = createPlatformKvoxModule();
