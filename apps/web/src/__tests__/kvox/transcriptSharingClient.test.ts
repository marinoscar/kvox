/**
 * Transcript sharing, the web side (issue #485, epic #478).
 *
 * The share DIALOG is the packaged `ShareDialog` and is tested in the package. What
 * is asserted here is what this app adds around it: the resource and the two roles
 * a transcript offers, and "leave", which finds the caller's own grant on "shared
 * with me" and revokes it through the grants API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = {
  sharedWithMe: vi.fn(),
  revokeGrant: vi.fn(),
};

vi.mock('@marinoscar/platform-web/sharing/headless', () => ({
  createSharingClient: () => client,
}));

vi.mock('../../platform/platformHost', () => ({ appPlatformApi: {} }));

import { ApiError } from '../../services/api';
import {
  TRANSCRIPT_RESOURCE_TYPE,
  TRANSCRIPT_SHARE_ROLES,
  leaveTranscript,
  transcriptResource,
} from '../../kvox/transcriptSharingClient';

const page = (items: Array<Record<string, unknown>>, pageNumber = 1, totalPages = 1) => ({
  items,
  total: items.length,
  page: pageNumber,
  pageSize: 100,
  totalPages,
});

const shared = (resourceId: string, grantId: string, via = 'user_grant') => ({
  grantId,
  resourceType: 'transcript',
  resourceId,
  role: 'viewer',
  via,
});

beforeEach(() => {
  client.sharedWithMe.mockReset();
  client.revokeGrant.mockReset();
});

describe('what a transcript offers the share dialog', () => {
  it('is the transcript resource type, and exactly two roles: viewer and editor', () => {
    expect(TRANSCRIPT_RESOURCE_TYPE).toBe('transcript');
    expect(transcriptResource('t1')).toEqual({ type: 'transcript', id: 't1' });
    expect(TRANSCRIPT_SHARE_ROLES.map((role) => role.value)).toEqual(['viewer', 'editor']);
  });
});

describe('leaveTranscript', () => {
  it('revokes the grant that names the caller on that transcript', async () => {
    client.sharedWithMe.mockResolvedValue(page([shared('other', 'g-0'), shared('t1', 'g-1')]));
    client.revokeGrant.mockResolvedValue(undefined);

    await leaveTranscript('t1');

    expect(client.sharedWithMe).toHaveBeenCalledWith({ resourceType: 'transcript', page: 1, pageSize: 100 });
    expect(client.revokeGrant).toHaveBeenCalledWith('g-1');
  });

  it('reads on to the next page when the share is not on the first', async () => {
    client.sharedWithMe
      .mockResolvedValueOnce(page([shared('other', 'g-0')], 1, 2))
      .mockResolvedValueOnce(page([shared('t1', 'g-9')], 2, 2));
    client.revokeGrant.mockResolvedValue(undefined);

    await leaveTranscript('t1');

    expect(client.sharedWithMe).toHaveBeenCalledTimes(2);
    expect(client.revokeGrant).toHaveBeenCalledWith('g-9');
  });

  it('is a 404 when nothing names the caller, and revokes nothing', async () => {
    client.sharedWithMe.mockResolvedValue(page([shared('other', 'g-0')]));

    const error = await leaveTranscript('t1').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(client.revokeGrant).not.toHaveBeenCalled();
  });

  it('ignores a group grant: only the caller\'s own grant is theirs to give up', async () => {
    client.sharedWithMe.mockResolvedValue(page([shared('t1', 'g-group', 'group_grant')]));

    await expect(leaveTranscript('t1')).rejects.toBeInstanceOf(ApiError);
    expect(client.revokeGrant).not.toHaveBeenCalled();
  });
});
