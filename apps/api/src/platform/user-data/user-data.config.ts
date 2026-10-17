import { UserDataModule, composedSchemaDatamodel, groupMembershipRemovalHook } from '@marinoscar/platform-api/user-data';

// Registers this app's categories, scopes and model hints, THEN the platform's
// (a platform entry whose id is already registered is skipped, so the app's win
// where they overlap). Must be imported before the module is composed.
import './user-data.manifest';
import { UserDataHostModule } from './user-data-host.module';

// =============================================================================
// The platform's user-data slice (issue #480, epic #478)
// =============================================================================
//
// `GET /api/user-data/summary`, `POST /api/user-data/deletions` and the
// `user.data.purge` job, over the registries `user-data.manifest.ts` fills. It
// replaces this app's own `apps/api/src/user-data/` module: the route paths, the
// job type, the five scope ids and their confirmation phrases are unchanged.
//
// The same module also mounts the platform's admin factory reset
// (`/api/admin/factory-reset/*`, the admin `Danger Zone` card at `/admin/settings/factory-reset`, gated on
// `system:factory_reset`) and organization offboarding routes (`orgs:offboard`, no web
// page yet). Both permissions are held by the Admin system role only. The factory
// reset deletes this app's content through the steps in `factory-reset.steps.ts`;
// the platform's own steps cannot reach it (issue #562).
//
// `factoryReset.keepJobsReferencedBy`: a backup run's job survives the reset's first step,
// which the page promises ("Database backups, their files and their jobs").
// `userRemovalHooks`: the sharing slice's last-admin rule runs before a user row is deleted.
//
// `datamodel` is the composed Prisma schema folder (`prisma/schema`), parsed once
// when the purge plan is first computed: the generated client's DMMF lacks
// `onDelete`, and the planner orders the deletes from it.
//
// No `legacyJobTypes`: a `user.data.purge` row queued by the previous build
// carries `{ userId, scope, requestId }`, which the platform's payload schema
// accepts (`requestId` is stripped), so a deploy mid-deletion loses nothing.
// =============================================================================

export const userDataModule = UserDataModule.forRoot({
  imports: [UserDataHostModule],
  datamodel: composedSchemaDatamodel(__dirname),
  userRemovalHooks: [groupMembershipRemovalHook],
  factoryReset: { keepJobsReferencedBy: [{ model: 'DatabaseBackupRun', field: 'jobId' }] },
});
