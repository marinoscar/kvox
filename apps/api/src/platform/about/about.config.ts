// =============================================================================
// About, served by the platform (issue #464, epic #462)
// =============================================================================
//
// `GET /api/admin/about` (`system_settings:read`): the deployment record the
// deploy CLI wrote to `DEPLOY_INFO_PATH`, live runtime facts and a database
// liveness probe, plus one group per About contributor. This app's contributors
// ("Transcription" and "Deployment") are registered in
// `app-registrations/host.ts`.
//
// `resolveApiVersion` is this app's own (`APP_VERSION`, else the npm version,
// else `package.json`), so the version the About page shows is the one the
// OpenAPI document and the database backup already report.
// =============================================================================

import { AboutModule } from '@marinoscar/platform-api/host';

import { resolveApiVersion } from '../../openapi/version';
import { platformHost } from '../platform-host';

export const aboutModule = AboutModule.forRoot({
  apiVersion: resolveApiVersion,
  host: platformHost,
});
