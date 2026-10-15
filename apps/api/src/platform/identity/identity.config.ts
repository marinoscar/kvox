// =============================================================================
// Identity's composition (issue #465, epic #462)
// =============================================================================
//
// `IdentityModule.forRoot` serves `/api/auth/*`, `/api/users`, `/api/roles`,
// `/api/allowlist`, `/api/pat`, `/api/auth/device/*` and, outside production,
// `/api/auth/test/login`, in single-organization mode (`TENANCY_MODE` unset).
//
// GOOGLE IS BUILT IN. Do not call `registerAuthProvider` for it:
// `GET /api/auth/providers` lists `google` when `GOOGLE_CLIENT_ID` and
// `GOOGLE_CLIENT_SECRET` are set. `registerAuthProvider` is only for an extra
// provider added later.
//
// The configuration keys the slice reads (`jwt`, `google`, `deviceAuth`,
// `initialAdminEmail`, `tenancy`) are built by `identityConfiguration()` in
// `config/configuration.ts`; the environment variable names are unchanged.
// =============================================================================

import { IdentityModule } from '@marinoscar/platform-api/identity';

import { IdentityHostModule } from './identity-host.module';

/**
 * The identity slice for this app. `enableTestAuth` mounts the test-only login
 * (`POST /api/auth/test/login`); the slice itself refuses it, as a boot error,
 * when `NODE_ENV` is `production`.
 */
export const identityModule = IdentityModule.forRoot({
  imports: [IdentityHostModule],
  enableTestAuth: process.env.NODE_ENV !== 'production',
});
