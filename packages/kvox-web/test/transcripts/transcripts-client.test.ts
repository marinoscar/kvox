import { describe, it, expect } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import {
  createTranscript,
  getTranscript,
  getTranscriptSegments,
  getTranscriptWords,
  getTranscripts,
} from '../../src/transcripts/headless/clients/transcripts.js';

/**
 * The transcripts client, with the conditional-GET path as the main subject.
 *
 * Everything else in this module is a thin `kvox*` call and is covered by the
 * pages that use it; `conditionalGet` is the one piece with logic of its own:
 * a plain JSON request can express neither `If-None-Match` nor a 304, so the two
 * polled reads go through `host.http.requestWithMeta`. What a host does about
 * the bearer token and a 401 is the host's (the web edition's is tested in
 * `apps/web/src/__tests__/platform-kvox/`).
 */

const DETAIL = {
  id: 't1',
  title: 'Standup',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'ready',
  language: 'en',
  durationMs: 600_000,
  speakerCount: 2,
  wordCount: 1200,
  currentVersion: 3,
  failureReason: null,
  access: 'owner',
  recordedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:10:00.000Z',
  speakers: [],
  provider: 'AssemblyAI',
  remoteDeletedAt: null,
  submittedAt: null,
  completedAt: null,
  sourceName: 'standup.m4a',
  sourceMimeType: 'audio/mp4',
  sourceSizeBytes: '1048576',
};

const ETAG = { etag: 'W/"v3"' };

describe('getTranscript — the conditional read', () => {
  it('sends no If-None-Match on the first read, and returns the ETag it got', async () => {
    // Sending `If-None-Match: null` would be a header the server compares and
    // never matches — a poll that silently lost its own optimisation.
    let seenHeaders: Record<string, string> = { sentinel: 'unset' };
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/t1': (request) => {
          seenHeaders = request.headers;
          return { headers: ETAG, data: DETAIL };
        },
      },
    });

    const result = await getTranscript(host, 't1');

    expect(Object.keys(seenHeaders).some((name) => name.toLowerCase() === 'if-none-match')).toBe(false);
    expect(result).toEqual({ status: 'ok', data: DETAIL, etag: 'W/"v3"' });
  });

  it('sends the validator back and reports a 304 as `not-modified`', async () => {
    // A discriminated union, not `T | null`: a polling hook has to be able to
    // tell "unchanged, and current" from "failed, and possibly stale", and
    // those need different treatment.
    let seen: string | undefined;
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/t1': (request) => {
          seen = request.headers['If-None-Match'];
          return { status: 304 };
        },
      },
    });

    const result = await getTranscript(host, 't1', 'W/"v3"');

    expect(seen).toBe('W/"v3"');
    expect(result).toEqual({ status: 'not-modified' });
  });

  it('turns a 404 into a KvoxApiError carrying the status', async () => {
    // 404 and not 403 is the API's deliberate choice — the existence of a
    // transcript id is itself information — so the client has to treat "gone"
    // and "never yours" as one case.
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/t1': () => {
          throw fakeApiError(404, 'Not found');
        },
      },
    });

    const error = await getTranscript(host, 't1').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(KvoxApiError);
    expect(error).toMatchObject({ status: 404, message: 'Not found' });
  });
});

describe('getTranscriptSegments — the same validator path', () => {
  it('round-trips an ETag and a 304', async () => {
    const body = { currentVersion: 3, segments: [] };
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/t1/segments': (request) =>
          request.headers['If-None-Match'] === 'W/"v3"'
            ? { status: 304 }
            : { headers: ETAG, data: body },
      },
    });

    const first = await getTranscriptSegments(host, 't1');
    expect(first).toEqual({ status: 'ok', data: body, etag: 'W/"v3"' });

    const second = await getTranscriptSegments(host, 't1', 'W/"v3"');
    expect(second).toEqual({ status: 'not-modified' });
  });
});

/** A host that answers `GET /transcripts` and remembers the query it was asked. */
function listHost() {
  const seen: { query: URLSearchParams | null } = { query: null };
  const host = createFakeKvoxWebHost({
    routes: {
      'GET /transcripts': (request) => {
        seen.query = request.query;
        return { items: [], total: 0, nextCursor: null };
      },
    },
  });
  return { host, seen };
}

describe('getTranscripts — the query string', () => {
  it('omits every absent filter rather than sending empty values', async () => {
    const { host, seen } = listHost();

    await getTranscripts(host, { scope: 'owned' });

    const query = seen.query!;
    expect(query.get('scope')).toBe('owned');
    expect(query.has('status')).toBe(false);
    expect(query.has('q')).toBe(false);
    expect(query.has('cursor')).toBe(false);
  });

  it('drops a whitespace-only search term', async () => {
    // `q=` would be a filter the API applies — "title contains the empty
    // string" is not what a user meant by clearing the box.
    const { host, seen } = listHost();

    await getTranscripts(host, { scope: 'all', q: '   ' });

    expect(seen.query!.has('q')).toBe(false);
  });

  it('trims a real search term', async () => {
    const { host, seen } = listHost();

    await getTranscripts(host, { q: '  budget  ' });

    expect(seen.query!.get('q')).toBe('budget');
  });
});

describe('getTranscriptWords — the window', () => {
  it('floors and clamps the window bounds it sends', async () => {
    let query: URLSearchParams | null = null;
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/t1/words': (request) => {
          query = request.query;
          return { currentVersion: 1, fromMs: 0, toMs: 1000, segments: [] };
        },
      },
    });

    await getTranscriptWords(host, 't1', -50, 1000.7);

    // Negative is clamped to the beginning; the API rejects a negative bound,
    // and a rejected word window would silently kill word highlighting.
    expect(query!.get('fromMs')).toBe('0');
    expect(query!.get('toMs')).toBe('1000');
  });
});

describe('createTranscript', () => {
  it('posts the create body and returns both rows', async () => {
    const response = {
      transcript: DETAIL,
      upload: {
        objectId: 'obj-1',
        uploadId: 'up-1',
        partSize: 8_388_608,
        totalParts: 1,
        presignedUrls: [{ partNumber: 1, url: 'https://storage.example/put' }],
      },
    };
    let body: unknown;
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /transcripts': (request) => {
          body = request.body;
          return response;
        },
      },
    });

    const result = await createTranscript(host, {
      title: 'Standup',
      language: null,
      speakersExpected: 2,
      source: { name: 'standup.m4a', size: 1024, mimeType: 'audio/mp4' },
    });

    expect(body).toMatchObject({ title: 'Standup', language: null, speakersExpected: 2 });
    expect(result).toEqual(response);
  });
});
