// =============================================================================
// The platform Doctor (issue #464, epic #462)
// =============================================================================
//
// `GET /api/admin/doctor` (`system_settings:read`) runs every registered
// read-only health check and reports pass / warn / fail / skip with a remedy;
// `GET /api/admin/doctor/support-bundle` downloads a redacted diagnostic
// archive named after `APP_SLUG`. Mounted since #465 (the identity slice
// registers its `auth.*` and `tenancy.*` checks with the registry this module
// provides); #464 adds the support bundle and this app's own checks.
//
// This app's checks are in `./checks/` and are provided by `DoctorChecksModule`
// (`./doctor-checks.module.ts`). The platform's own (`db.connection`,
// `db.migrations`, `db.rls_role`, `maintenance.mode`, ...) come with
// `PlatformHostCoreModule`. `db.rls_role` FAILS while this app connects as the
// `postgres` superuser; that is expected and tracked by #471.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import { DoctorModule } from '@marinoscar/platform-api/doctor';

import { platformHost } from '../platform/platform-host';

export const doctorModule = DoctorModule.forRoot({
  host: platformHost,
  supportBundle: { appSlug: APP_SLUG },
});
