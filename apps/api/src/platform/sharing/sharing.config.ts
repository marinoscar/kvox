import { SharingModule } from '@marinoscar/platform-api/sharing';

// Registers the `transcript` resource type BEFORE the module is composed (the
// registry freezes when the application bootstraps).
import '../../app-registrations/sharing';
import { platformHost } from '../platform-host';
import { SharingHostModule } from './sharing-host.module';

// =============================================================================
// The platform's sharing slice (issue #485, epic #478)
// =============================================================================
//
// `/api/grants` (share a record, change or revoke a share, "shared with me"),
// `/api/grants/links`, `/api/groups`, `/api/public/links/current`, `AccessPolicy`,
// the user purge, the `sharing.groups.orphaned` Doctor check and the
// `sharing.grants.prune` job. One resource type is registered: `transcript`
// (`app-registrations/sharing.ts`). Per-user `viewer` / `editor` shares are the
// only grantable shape: groups, link shares and group ownership are off.
//
// This is ONE object, imported by `app.module.ts` and by every feature module that
// injects `AccessPolicy` or `GrantsService` (the module is not global).
// =============================================================================

export const sharingModule = SharingModule.forRoot({
  host: platformHost,
  imports: [SharingHostModule],
});
