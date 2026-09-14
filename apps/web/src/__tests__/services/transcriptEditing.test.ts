import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>(
    '../../services/api',
  );
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn() },
  };
});

import { ApiError, api } from '../../services/api';
import {
  applyOperations,
  newClientBatchId,
  parseOperationsConflict,
  restoreTranscriptVersion,
  searchTranscript,
} from '../../services/transcriptEditing';

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({} as never);
  mockPost.mockResolvedValue({} as never);
});

describe('parseOperationsConflict', () => {
  it('reads the conflict out of `details`, which is where the envelope puts it', () => {
    // Spec §5 draws this object at the top level; the global exception filter
    // publishes `{ statusCode, code, message, details }` and drops everything
    // else, so a client reaching for `err.currentVersion` finds nothing.
    const error = new ApiError('Conflict', 409, 'CONFLICT', {
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: 3 }],
    });

    expect(parseOperationsConflict(error)).toEqual({
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: 3 }],
    });
  });

  it('keeps a null `current` — that means the other editor DELETED it', () => {
    const error = new ApiError('Conflict', 409, 'CONFLICT', {
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: null }],
    });

    expect(parseOperationsConflict(error)?.conflicts[0].current).toBeNull();
  });

  it('answers null for a 409 that is not a conflict payload', () => {
    // A restore whose `baseVersion` is stale is also a 409 and carries nothing
    // resolvable; treating it as a conflict would offer a choice over an empty
    // list.
    expect(parseOperationsConflict(new ApiError('Already current', 409))).toBeNull();
    expect(
      parseOperationsConflict(new ApiError('x', 409, 'C', { currentVersion: 'seven' })),
    ).toBeNull();
  });

  it('answers null for anything that is not a 409', () => {
    expect(parseOperationsConflict(new ApiError('Forbidden', 403))).toBeNull();
    expect(parseOperationsConflict(new Error('network'))).toBeNull();
    expect(parseOperationsConflict(null)).toBeNull();
  });
});

describe('newClientBatchId', () => {
  it('is unique and long enough for the API’s 8-character minimum', () => {
    const first = newClientBatchId();
    const second = newClientBatchId();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(200);
  });
});

describe('the requests', () => {
  it('posts a batch to the transcript’s own operations route', async () => {
    await applyOperations('t1', {
      baseVersion: 4,
      clientBatchId: 'batch-1234567890',
      ops: [{ op: 'segment.delete', segmentId: 's1', rev: 2 }],
    });

    expect(mockPost).toHaveBeenCalledWith('/transcripts/t1/operations', {
      baseVersion: 4,
      clientBatchId: 'batch-1234567890',
      ops: [{ op: 'segment.delete', segmentId: 's1', rev: 2 }],
    });
  });

  it('spells the search booleans as the literal strings the API parses', async () => {
    // The API uses `z.enum(['true','false'])` and NOT `z.coerce.boolean()`,
    // deliberately, because `Boolean('false')` is `true`.
    await searchTranscript('t1', { q: 'budget', matchCase: false, wholeWord: true });

    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('matchCase=false');
    expect(url).toContain('wholeWord=true');
    expect(url).toContain('q=budget');
  });

  it('omits the speaker scope rather than sending an empty one', async () => {
    await searchTranscript('t1', { q: 'x', speakerId: null });
    expect(mockGet.mock.calls[0][0]).not.toContain('speakerId');
  });

  it('sends the restore’s baseVersion, which this route requires to match', async () => {
    await restoreTranscriptVersion('t1', 3, 9);
    expect(mockPost).toHaveBeenCalledWith('/transcripts/t1/versions/3/restore', {
      baseVersion: 9,
    });
  });
});
