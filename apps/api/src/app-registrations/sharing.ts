// =============================================================================
// This app's shareable resource types (issue #485, epic #478)
// =============================================================================
//
// One type: `transcript`. A share is a platform `grants` row (`resource_type =
// 'transcript'`, `resource_id` = the transcript id); `AccessPolicy` decides what
// the owner, a viewer and an editor may do, and `TranscriptAccessService` is its
// one caller in this app. The type id is PERMANENT once grants of it exist (the
// sharing conformance suite pins it: `test/conformance.spec.ts`).
//
//   roles       viewer < editor; `owner` is implicit and never grantable
//   actions     read: viewer, write: editor, share: owner, delete: owner
//   permission  `write` and `delete` ALSO need `transcripts:write`, even for the
//               owner. A share raises nobody above what their RBAC role allows
//   deny        a caller with no access gets 404, never 403 (`denyAs`)
//   grantable   users only: no group grants, no link grants (no UI for either)
//
// `transcripts` is not under row-level security. `loadOwners` only has to report
// the owner and the organization, which is why the spike for #485 settled on
// `org_id` without a policy. A soft-deleted transcript (`deleted_at` set, status
// `deleting`) is reported as missing, so nobody holds a role on it.
//
// IMPORTED BY `registrations.ts` (and `platform/sharing/sharing.config.ts`): the
// resource type registry freezes when the application bootstraps.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { registerResourceType } from '@marinoscar/platform-api/sharing';
import type { ResourceDescription, ResourceOwnerInfo } from '@marinoscar/platform-api/sharing';

import { PERMISSIONS } from '../common/constants/roles.constants';

/** The resource type id of a transcript. Permanent once grants exist. */
export const TRANSCRIPT_RESOURCE_TYPE = 'transcript';

registerResourceType({
  type: TRANSCRIPT_RESOURCE_TYPE,
  roles: ['viewer', 'editor'],
  actions: { read: 'viewer', write: 'editor', share: 'owner', delete: 'owner' },
  actionPermissions: {
    write: PERMISSIONS.TRANSCRIPTS_WRITE,
    delete: PERMISSIONS.TRANSCRIPTS_WRITE,
  },
  ownership: 'user',
  denyAs: 'not_found',
  grantable: { user: ['viewer', 'editor'], group: [], link: [] },

  async loadOwners(ids, tx): Promise<Map<string, ResourceOwnerInfo>> {
    const rows = await (tx as Prisma.TransactionClient).transcript.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: { id: true, orgId: true, ownerId: true },
    });

    return new Map(
      rows.map((row): [string, ResourceOwnerInfo] => [
        row.id,
        { orgId: row.orgId, owner: { kind: 'user', userId: row.ownerId } },
      ]),
    );
  },

  async describe(ids, tx): Promise<Map<string, ResourceDescription>> {
    const rows = await (tx as Prisma.TransactionClient).transcript.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: { id: true, title: true },
    });

    return new Map(
      rows.map((row): [string, ResourceDescription] => [
        row.id,
        { title: row.title, path: `/transcripts/${row.id}` },
      ]),
    );
  },
});
