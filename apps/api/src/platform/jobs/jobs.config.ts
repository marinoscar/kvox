// =============================================================================
// The jobs and nodes slices' composition (issue #468, epic #467)
// =============================================================================
//
// `JobsModule.forRoot` is GLOBAL and replaces this app's own queue: the enqueue
// and claim services, the terminal state machine, the in-process worker pool,
// the lease reaper, the job-history purge, the temp-file janitor, the provider
// throttle and `/api/admin/jobs/*`. `NodesModule.forRoot` replaces the
// worker-node control plane: `/api/nodes/*`, `/api/admin/nodes/*`, the fleet
// sweep and prune, and the brokered-secret sweep. `NodeCredentialModule` serves
// `/api/node-credentials` and is the `IDENTITY_NODE_CREDENTIALS` binding.
//
// ORDER: both `forRoot` calls register the `retention` system-settings
// namespace the jobs slice owns (the app's settings manifest lists `jobs` and
// `nodes` but not `retention`), and the platform refuses a namespace registered
// after `SettingsModule.forRoot()` composed the request bodies. So `app.module.ts`
// imports this file BEFORE `platform/settings/settings.config.ts`; the manifest
// import at the top of that file still runs first.
// =============================================================================

import { APP_NAME } from '@app/shared';
import { JobsModule } from '@marinoscar/platform-api/jobs';
import { NodeCredentialModule, NodesModule } from '@marinoscar/platform-api/nodes';

import '../../app-registrations/jobs';
import { JobsHostModule } from './jobs-host.module';

export const jobsModule = JobsModule.forRoot({
  appName: APP_NAME,
  imports: [JobsHostModule],
});

export const nodesModule = NodesModule.forRoot({ imports: [JobsHostModule] });

export { NodeCredentialModule };
