import { UserDataModule, composedSchemaDatamodel } from '@marinoscar/platform-api/user-data';

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
// The same module also mounts the platform's admin factory reset and
// organization offboarding routes. Neither has a web page in this app yet, and
// both are gated on permissions only the Admin system role holds
// (`system:factory_reset`, `orgs:offboard`).
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
});
