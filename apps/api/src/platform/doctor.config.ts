// =============================================================================
// The platform Doctor, mounted because identity needs its registry (issue #465)
// =============================================================================
//
// The identity slice registers its `auth.*` and `tenancy.*` health checks with
// `DoctorCheckRegistry` (and the sign-in providers' outbound hosts with the
// `EgressRegistry`), both provided by the doctor slice, so the slice cannot
// boot without it. Mounting it adds ONE read-only route:
// `GET /api/admin/doctor` (permission `system_settings:read`).
//
// The support bundle (`GET /api/admin/doctor/support-bundle`) is switched off:
// it is a separate feature with its own host ports, not needed by identity. The
// registries it would share are still provided.
// =============================================================================

import { DoctorModule } from '@marinoscar/platform-api/doctor';

import { platformHost } from './platform-host';

export const doctorModule = DoctorModule.forRoot({
  host: platformHost,
  supportBundle: false,
});
