import { describe, it, expect } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import {
  applyOperations,
  newClientBatchId,
  parseOperationsConflict,
  restoreTranscriptVersion,
  searchTranscript,
} from '../../src/transcripts/headless/clients/transcriptEditing.js';

describe('parseOperationsConflict', () => {
  it('reads the conflict out of `details`, which is where the envelope puts it', () => {
    // Spec §5 draws this object at the top level; the global exception filter
    // publishes `{ statusCode, code, message, details }` and drops everything
    // else, so a client reaching for `err.currentVersion` finds nothing.
    const error = new KvoxApiError('Conflict', 409, 'CONFLICT', {
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: 3 }],
    });

    expect(parseOperationsConflict(error)).toEqual({
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: 3 }],
    });
  });

  it('keeps a null `current` — that means the other editor DELETED it', () => {
    const error = new KvoxApiError('Conflict', 409, 'CONFLICT', {
      currentVersion: 7,
      conflicts: [{ entity: 'segment', id: 'seg_42', current: null }],
    });

    expect(parseOperationsConflict(error)?.conflicts[0].current).toBeNull();
  });

  it('answers null for a 409 that is not a conflict payload', () => {
    // A restore whose `baseVersion` is stale is also a 409 and carries nothing
    // resolvable; treating it as a conflict would offer a choice over an empty
    // list.
    expect(parseOperationsConflict(new KvoxApiError('Already current', 409))).toBeNull();
    expect(
      parseOperationsConflict(new KvoxApiError('x', 409, 'C', { currentVersion: 'seven' })),
    ).toBeNull();
  });

  it('answers null for anything that is not a 409', () => {
    expect(parseOperationsConflict(new KvoxApiError('Forbidden', 403))).toBeNull();
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
    const host = createFakeKvoxWebHost({ routes: { 'POST /transcripts/t1/operations': {} } });

    await applyOperations(host, 't1', {
      baseVersion: 4,
      clientBatchId: 'batch-1234567890',
      ops: [{ op: 'segment.delete', segmentId: 's1', rev: 2 }],
    });

    expect(host.callsTo('POST /transcripts/t1/operations')).toHaveLength(1);
    expect(host.calls[0]?.body).toEqual({
      baseVersion: 4,
      clientBatchId: 'batch-1234567890',
      ops: [{ op: 'segment.delete', segmentId: 's1', rev: 2 }],
    });
  });

  it('spells the search booleans as the literal strings the API parses', async () => {
    // The API uses `z.enum(['true','false'])` and NOT `z.coerce.boolean()`,
    // deliberately, because `Boolean('false')` is `true`.
    const host = createFakeKvoxWebHost({ routes: { 'GET /transcripts/t1/search': {} } });

    await searchTranscript(host, 't1', { q: 'budget', matchCase: false, wholeWord: true });

    const path = host.calls[0]!.path;
    expect(path).toContain('matchCase=false');
    expect(path).toContain('wholeWord=true');
    expect(path).toContain('q=budget');
  });

  it('omits the speaker scope rather than sending an empty one', async () => {
    const host = createFakeKvoxWebHost({ routes: { 'GET /transcripts/t1/search': {} } });

    await searchTranscript(host, 't1', { q: 'x', speakerId: null });

    expect(host.calls[0]!.path).not.toContain('speakerId');
  });

  it('sends the restore’s baseVersion, which this route requires to match', async () => {
    const host = createFakeKvoxWebHost({
      routes: { 'POST /transcripts/t1/versions/3/restore': {} },
    });

    await restoreTranscriptVersion(host, 't1', 3, 9);

    expect(host.calls[0]?.body).toEqual({ baseVersion: 9 });
  });
});
