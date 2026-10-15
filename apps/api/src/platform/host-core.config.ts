// =============================================================================
// The platform host core (issue #464, epic #462)
// =============================================================================
//
// `PlatformHostCoreModule.forRoot` is GLOBAL and replaces what this app ran by
// hand:
//
//   * the event bus (`EVENT_BUS`) and `AppMetricsService`;
//   * maintenance mode: `MaintenanceModeService`, `GET|PUT /api/admin/maintenance`
//     and `MaintenanceGuard`, the application's ONLY `APP_GUARD`;
//   * `GET /api/health`, `/api/health/live` and `/api/health/ready`;
//   * the `{ data, meta }` envelope (`TransformInterceptor`), the request log
//     line (`LoggingInterceptor`), `HttpExceptionFilter` and request ids.
//
// `./host` is imported FIRST so the About section and the Doctor checks this
// app contributes are registered before the application is created (the
// registries freeze when it bootstraps).
//
// The `maintenance` system settings namespace is registered by the settings
// manifest (#466), so this module may be mounted after `settingsModule`.
//
// ERROR MAPPERS: none. The platform filter, like the one it replaced, answers a
// thrown non-HTTP error with that error's own message (and, outside production,
// its stack in `details`), so no client lost a Prisma error text. Add an
// `errorMappers` entry here the day that stops being true.
// =============================================================================

import '../app-registrations/host';

import { PlatformHostCoreModule } from '@marinoscar/platform-api/host';

import { platformHost } from './platform-host';

export const hostCoreModule = PlatformHostCoreModule.forRoot({ host: platformHost });
