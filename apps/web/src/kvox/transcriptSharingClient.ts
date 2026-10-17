/**
 * Transcript sharing, as the web app sees it (issue #29, epic #19; the platform's
 * grants since #485).
 *
 * A share is a platform `grants` row. The dialog that manages them is the
 * packaged `ShareDialog` (`@marinoscar/platform-web/sharing/ui`); this module holds
 * what the app adds around it: which resource type and roles a transcript offers,
 * and "leave", the one share action a RECIPIENT takes.
 *
 * =============================================================================
 * ⚠ THERE IS NO `searchUsers` IN HERE, AND THERE MUST NEVER BE ONE
 * =============================================================================
 *
 * The grants API takes ONE exact address per share and answers a generic refusal
 * for a miss, precisely so that no client can turn it into an autocomplete over the
 * user directory. The dialog calls it on SUBMIT, once, and nowhere else.
 *
 * The four `/api/transcripts/:id/shares` routes this app used before #485 are
 * deprecated adapters over the same grants, kept for one release for clients other
 * than this one. Nothing here calls them.
 */

import { createSharingClient } from '@marinoscar/platform-web/sharing/headless';
import type { ResourceRef, SharingRoleOption } from '@marinoscar/platform-web/sharing/headless';

import { appPlatformApi } from '../platform/platformHost';
import { ApiError } from '../services/api';

/** The resource type id of a transcript. Permanent once grants exist (the API registers the same id). */
export const TRANSCRIPT_RESOURCE_TYPE = 'transcript';

/** The two levels a share can grant, in the order the dialog's select offers them. `owner` is not a share. */
export const TRANSCRIPT_SHARE_ROLES: readonly SharingRoleOption[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

/** The platform's name for one transcript. */
export function transcriptResource(transcriptId: string): ResourceRef {
  return { type: TRANSCRIPT_RESOURCE_TYPE, id: transcriptId };
}

/** The platform's page size ceiling for "shared with me". */
const PAGE_SIZE = 100;

/** The most pages a lookup reads: a person is not shared this many transcripts in practice. */
const MAX_PAGES = 50;

/**
 * Give up your own access to a transcript somebody shared with you.
 *
 * Finds the grant that names the caller on "shared with me" and revokes it, which
 * any grantee may do to their own grant (the API needs only `sharing:read` for it).
 * Takes effect on the next request; nobody is told.
 *
 * @throws ApiError 404 when no active share names the caller on that transcript.
 */
export async function leaveTranscript(transcriptId: string): Promise<void> {
  const client = createSharingClient(appPlatformApi);

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await client.sharedWithMe({ resourceType: TRANSCRIPT_RESOURCE_TYPE, page, pageSize: PAGE_SIZE });
    const mine = result.items.find((item) => item.resourceId === transcriptId && item.via === 'user_grant');

    if (mine) {
      await client.revokeGrant(mine.grantId);
      return;
    }

    if (page >= result.totalPages || result.items.length === 0) break;
  }

  throw new ApiError('That transcript is not shared with you.', 404);
}
