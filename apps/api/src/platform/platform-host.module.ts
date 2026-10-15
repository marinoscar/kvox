// =============================================================================
// The platform host module (issue #465, epic #462)
// =============================================================================
//
// Binds the DI-time host ports every packaged slice reaches the app through:
//
//   AUDIT_SINK             -> `audit_events` (PrismaAuditSink)
//   SYSTEM_SETTINGS_STORE  -> the platform SystemSettingsService (#466)
//   PLATFORM_PRISMA        -> the existing PrismaService
//
// `PlatformHostModule.forRoot` is GLOBAL, so the identity slice (which injects
// `PLATFORM_PRISMA` in a dozen services) and the app route that reports an
// audit event resolve them without importing anything. Mounting the host CORE
// module (`PlatformHostCoreModule`: event bus, maintenance, the response
// envelope) is #464, not this issue.
// =============================================================================

import { PlatformHostModule } from '@marinoscar/platform-api/core';

import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditSink } from './audit-sink.adapter';
import { SystemSettingsStoreAdapter } from './system-settings-store.adapter';

export const platformHostModule = PlatformHostModule.forRoot({
  audit: { useClass: PrismaAuditSink },
  settings: { useClass: SystemSettingsStoreAdapter },
  prisma: { useExisting: PrismaService },
});
