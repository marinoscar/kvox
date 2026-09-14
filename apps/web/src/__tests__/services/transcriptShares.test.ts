/**
 * `services/transcriptShares.ts` (issue #29, epic #19).
 *
 * The `api` transport is mocked; what is under test is the CONTRACT this
 * module puts on the wire — the four paths, the encoding of ids into them,
 * and above all that there is NO speculative lookup call anywhere in the
 * module for a type-ahead to reach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));

import { api } from '../../services/api';
import * as shares from '../../services/transcriptShares';
import {
  addShare,
  getShares,
  removeShare,
  shareDisplayLabel,
  shareRoleDescription,
  updateShareRole,
  type TranscriptShare,
} from '../../services/transcriptShares';

const mockApi = vi.mocked(api);

const share = (overrides: Partial<TranscriptShare> = {}): TranscriptShare => ({
  id: 'share-1',
  userId: 'user-2',
  email: 'colleague@example.test',
  displayName: 'A Colleague',
  role: 'viewer',
  grantedById: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('services/transcriptShares', () => {
  it('reads the list and unwraps `items`', async () => {
    mockApi.get.mockResolvedValue({ items: [share()] } as never);

    await expect(getShares('t-1')).resolves.toEqual([share()]);
    expect(mockApi.get).toHaveBeenCalledWith('/transcripts/t-1/shares');
  });

  it('posts one address and one role, and nothing else', async () => {
    mockApi.post.mockResolvedValue(share() as never);

    await addShare('t-1', { email: 'colleague@example.test', role: 'editor' });

    expect(mockApi.post).toHaveBeenCalledWith('/transcripts/t-1/shares', {
      email: 'colleague@example.test',
      role: 'editor',
    });
  });

  it('patches the role at the RECIPIENT\'s user id, not the share row id', async () => {
    mockApi.patch.mockResolvedValue(share({ role: 'editor' }) as never);

    await updateShareRole('t-1', 'user-2', 'editor');

    expect(mockApi.patch).toHaveBeenCalledWith('/transcripts/t-1/shares/user-2', {
      role: 'editor',
    });
  });

  it('deletes at the same user-id path — the one route that serves revoke AND leave', async () => {
    mockApi.delete.mockResolvedValue(undefined as never);

    await removeShare('t-1', 'user-2');

    expect(mockApi.delete).toHaveBeenCalledWith('/transcripts/t-1/shares/user-2');
  });

  it('encodes ids into the path rather than interpolating them raw', async () => {
    mockApi.delete.mockResolvedValue(undefined as never);

    await removeShare('t 1/../x', 'u/2');

    expect(mockApi.delete).toHaveBeenCalledWith('/transcripts/t%201%2F..%2Fx/shares/u%2F2');
  });

  it('exports NO user-search or lookup function for a type-ahead to reach', () => {
    // Issue #29 rejected autocomplete over the user directory outright. The
    // API enforces it with a generic 404 and a per-caller rate limit; this
    // assertion is the client half — a helper named `searchUsers`,
    // `lookupUser` or `findUserByEmail` appearing here is the shape of the
    // mistake, so it fails the moment one is added.
    const forbidden = Object.keys(shares).filter((name) =>
      /search|lookup|suggest|autocomplete|find/i.test(name),
    );

    expect(forbidden).toEqual([]);
  });

  it('labels a recipient by name, falling back to the address', () => {
    expect(shareDisplayLabel(share())).toBe('A Colleague');
    expect(shareDisplayLabel(share({ displayName: null }))).toBe('colleague@example.test');
    expect(shareDisplayLabel(share({ displayName: '   ' }))).toBe('colleague@example.test');
  });

  it('describes each role without naming a permission string', () => {
    expect(shareRoleDescription('editor')).toMatch(/correct/i);
    expect(shareRoleDescription('viewer')).toMatch(/cannot change/i);
    expect(shareRoleDescription('editor')).not.toMatch(/transcripts:/);
  });
});
