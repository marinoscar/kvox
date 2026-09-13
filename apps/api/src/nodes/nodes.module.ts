// =============================================================================
// NodesModule — the control plane, deliberately NOT the credential module
// (issue #268, epic #254)
// =============================================================================
//
// This is the heavy half of `src/nodes/`. `NodeCredentialModule` beside it is
// `@Global`, imports `PrismaModule` and nothing else, and exists to give
// `JwtAuthGuard` one small service; this one imports `JobsModule` and is
// imported by nobody. That split was designed in #267 and its reasoning is
// worth re-stating from this side, because THIS is the module whose weight it
// was protecting the guard from:
//
//   `JwtAuthGuard` runs on nearly every authenticated route in the
//   application. If node credentials lived here, the guard would depend on a
//   module that depends on `JobsModule`, whose own controller uses `@Auth()`,
//   whose guard depends on this module — a cycle Nest reports at boot, and
//   one that gets "fixed" under time pressure with `forwardRef`, making the
//   cycle invisible rather than absent. Same directory, so the relationship
//   is obvious; different modules, so the graph stays acyclic.
//
// -----------------------------------------------------------------------------
// TWO IMPORTS, AND THE FIRST IS THE POINT OF THE WHOLE ISSUE
// -----------------------------------------------------------------------------
//
// `JobsModule` is imported for exactly three of its exports:
//
//   - `JobClaimService` — so the node plane takes rows with THE SAME
//     `FOR UPDATE SKIP LOCKED` statement the in-process worker uses. That
//     shared statement is the only reason a node and the server can poll
//     concurrently without ever receiving the same row.
//   - `JobTerminalService` — so a node-reported outcome reaches the same
//     conclusions (attempt budget, rate-limit deferral, settled event,
//     backoff) that an in-process handler's would.
//   - `JobHandlerRegistry` — so "which types can a node run" is derived from
//     the handlers themselves rather than from a list somebody maintains,
//     and (since #348) so the data plane can ask a type where its output must
//     land instead of hard-coding one prefix for the whole fleet. Both
//     questions are answered by the handler that owns the type, which is why
//     neither needs a second list.
//
// The direction is one-way: nothing in `JobsModule` imports this module, and
// nothing should. The queue does not need to know that nodes exist — a node
// is one more claimer of rows, which is precisely what `ClaimOptions`
// carrying `nodeId` and `executor` encodes.
//
// -----------------------------------------------------------------------------
// `StorageProvidersModule`, AND WHY IT IS NOT `StorageModule` (#269)
// -----------------------------------------------------------------------------
//
// The data plane needs exactly one thing out of storage: `STORAGE_PROVIDER`,
// so it can mint a signed URL. `StorageProvidersModule` provides that and
// nothing else — no controller, no `ObjectsService`, no processing pipeline,
// no event emitter subscriptions.
//
// REJECTED: importing `StorageModule`. It would bring `ObjectsController` and
// `ObjectsService` into this graph for a capability we do not want, and worse,
// it would put `ObjectsService.getDownloadUrl` within reach — the method that
// applies a PER-USER OWNERSHIP CHECK. A node is a trusted internal executor,
// not a user acting on their own file, and the owner a `nod_` credential
// resolves to has no relationship to whoever uploaded the object a job is
// about; routing a node through that check would `403` every cross-user job.
// `node-data-plane.service.ts`'s header states the full argument. Not
// importing the module is what keeps the wrong method out of reach.
//
// `NodeDataPlaneService` is a provider and not an export, exactly like
// `NodesService`: its only caller is the controller in this module, and a
// feature module that could inject it could mint storage capabilities against
// any job it could name.
//
// NOT `@Global`, and NOT EXPORTING `NodesService`. Its only caller is the
// controller in this module. A feature module that could inject it could
// claim jobs on a node's behalf or settle a job outside the terminal
// chokepoint, and neither is a capability any feature should have — the same
// argument `JobsModule` makes for not exporting `JobWorker`.
//
// -----------------------------------------------------------------------------
// `SettingsModule`, THE TWO CRONS AND THE ADMIN PLANE (#270)
// -----------------------------------------------------------------------------
//
// `SettingsModule` is imported for exactly one thing: `SystemSettingsService`'s
// narrow `getNodesPolicy()` accessor, behind which `NodeLifecycleService` reads
// the stale window, the offline multiplier and the offline retention. The
// direction is acyclic — settings depends on nothing here — and it mirrors
// `JobsModule`, which imports it for `getJobsPolicy()` for the identical
// reason.
//
// `NodeStaleOfflineTask` and `NodeOfflinePruneTask` are registered here as
// plain providers, exactly as `JobStuckResetTask` is in `JobsModule` and
// `StorageCleanupTask` is in `StorageModule`; `ScheduleModule.forRoot()` in
// `app.module.ts` is what makes their `@Cron` methods fire. Neither is
// exported: nothing outside this module should be able to trigger a sweep.
// ⚠ THE PAIR IS ORDERED, NOT INDEPENDENT — the prune selects `offline` rows,
// which only the sweep produces for a node that crashed. Their headers carry
// the argument; do not register one without the other.
//
// `NodesAdminController` is mounted here rather than in a module of its own so
// that the two node planes are configured, tested and reviewed together, and
// so the `nod_` allowlist argument above stays visible from both. It is a
// SEPARATE controller on a SEPARATE prefix (`admin/nodes`) precisely because
// everything under `NodesController` is reachable by a worker token, and
// nothing on the admin plane may be. `NodesAdminService` is a provider and not
// an export, like every other service here: it performs no ownership check at
// all, and a feature module that could inject it could read or delete any
// node in the deployment.
//
// -----------------------------------------------------------------------------
// `NotificationsModule` (#288, epic #254), AND WHY IT IS NOT A CYCLE
// -----------------------------------------------------------------------------
//
// Imported for exactly one method: `NotificationsService
// .notifyPermissionHolders`, which `NodeStaleOfflineTask` calls once per node
// its sweep flips to `offline`. The direction is one-way, like every other
// import here — `NotificationsModule`'s own graph is `PrismaModule`,
// `EmailModule` and `SettingsModule`, and not one of those reaches back into
// nodes or into `JobsModule`.
//
// Note the contrast with #288's OTHER call site. `jobs.job_failed` deliberately
// does NOT wire `JobsModule` to notifications: it is raised by a listener on
// the global event emitter, registered on the notifications side
// (`notifications/ops/job-failure-notifier.ts`), precisely because `JobsModule`
// is imported by this module and by the app root, and pointing it at the
// notifier is the edge that would eventually close a cycle. A cron task in a
// leaf module has no such risk, which is why this one is a plain import and
// that one is not.
//
// -----------------------------------------------------------------------------
// THE SECRET BROKER'S THREE PROVIDERS (#349, epic #345)
// -----------------------------------------------------------------------------
//
// `NodeSecretBrokerService` mints and revokes the per-job credential; it is a
// PROVIDER AND NOT AN EXPORT, for the same reason `NodeDataPlaneService` is —
// a feature module that could inject it could mint a database credential
// against any job it could name.
//
// `NodeSecretSweepTask` is a plain provider beside the other two crons, and
// `NodeSecretRevoker` is a plain provider carrying an `@OnEvent` listener.
// ⚠ THE PAIR IS NOT REDUNDANT — the event path structurally cannot cover a job
// settled by the reaper's `updateMany`, a replica that died between settling
// and revoking, or a `write-failed` outcome. Both headers carry the argument;
// do not register one without the other.
//
// Note the CONTRAST with `jobs.job_failed`, whose listener lives on the
// notifications side (`notifications/ops/job-failure-notifier.ts`) precisely to
// avoid pointing `JobsModule` at `NotificationsModule`. The same reasoning puts
// `NodeSecretRevoker` HERE rather than in `JobsModule`: this module already
// imports `JobsModule`, the direction stays one-way, and
// `jobs/events/job-settled.event.ts` imports only `@prisma/client`, so
// subscribing to it adds a class and a string to the bundle and nothing to the
// provider graph.
//
// `SettingsModule` earns a second reader here: `NodeLifecycleService.getPolicy`
// now also carries `jobSecretBrokerEnabled`, which `NodesService` reads at
// claim time and the broker service reads on every issue.
//
// `PrismaModule` is not imported here: it is `@Global()`. `ConfigService`
// likewise, via `ConfigModule.forRoot({ isGlobal: true })`.
// =============================================================================

import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { NodeDataPlaneService } from './node-data-plane.service';
import { NodeLifecycleService } from './node-lifecycle.service';
import { NodeSecretBrokerService } from './node-secret-broker.service';
import { NodesAdminController } from './nodes-admin.controller';
import { NodesAdminService } from './nodes-admin.service';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';
import { NodeSecretRevoker } from './ops/node-secret-revoker';
import { NodeFleetPruneHandler } from './handlers/node-fleet-prune.handler';
import { NodeFleetSweepHandler } from './handlers/node-fleet-sweep.handler';
import { NodeOfflinePruneTask } from './tasks/node-offline-prune.task';
import { NodeSecretSweepTask } from './tasks/node-secret-sweep.task';
import { NodeStaleOfflineTask } from './tasks/node-stale-offline.task';

@Module({
  imports: [
    JobsModule,
    SettingsModule,
    StorageProvidersModule,
    NotificationsModule,
  ],
  controllers: [NodesController, NodesAdminController],
  providers: [
    NodesService,
    NodeDataPlaneService,
    NodeSecretBrokerService,
    NodesAdminService,
    NodeLifecycleService,
    NodeStaleOfflineTask,
    NodeOfflinePruneTask,
    // #353 (epic #345): the two fleet sweeps are queue jobs now. The tasks
    // above only enqueue; these two do the work on a worker slot.
    NodeFleetSweepHandler,
    NodeFleetPruneHandler,
    NodeSecretSweepTask,
    NodeSecretRevoker,
  ],
})
export class NodesModule {}
