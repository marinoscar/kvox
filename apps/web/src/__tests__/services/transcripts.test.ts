import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { api, ApiError } from '../../services/api';
import {
  createTranscript,
  getTranscript,
  getTranscriptSegments,
  getTranscriptWords,
  getTranscripts,
} from '../../services/transcripts';

/**
 * The transcripts client, with the conditional-GET path as the main subject.
 *
 * Everything else in this module is a thin `api.*` call and is covered by the
 * pages that use it; `conditionalGet` is the one piece that reimplements part
 * of `ApiService.request` — because that method can express neither
 * `If-None-Match` nor a 304 — and so is the one piece that can be wrong on its
 * own.
 */

const API_BASE = 'http://localhost:3000/api';

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

beforeEach(() => {
  api.setAccessToken('test-token');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('getTranscript — the conditional read', () => {
  it('sends no If-None-Match on the first read, and returns the ETag it got', async () => {
    // Sending `If-None-Match: null` would be a header the server compares and
    // never matches — a poll that silently lost its own optimisation.
    let seenHeader: string | null = 'unset';
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, ({ request }) => {
        seenHeader = request.headers.get('if-none-match');
        return HttpResponse.json({ data: DETAIL }, { headers: { ETag: 'W/"v3"' } });
      }),
    );

    const result = await getTranscript('t1');

    expect(seenHeader).toBeNull();
    expect(result).toEqual({ status: 'ok', data: DETAIL, etag: 'W/"v3"' });
  });

  it('sends the validator back and reports a 304 as `not-modified`', async () => {
    // A discriminated union, not `T | null`: a polling hook has to be able to
    // tell "unchanged, and current" from "failed, and possibly stale", and
    // those need different treatment.
    let seenHeader: string | null = null;
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, ({ request }) => {
        seenHeader = request.headers.get('if-none-match');
        return new HttpResponse(null, { status: 304 });
      }),
    );

    const result = await getTranscript('t1', 'W/"v3"');

    expect(seenHeader).toBe('W/"v3"');
    expect(result).toEqual({ status: 'not-modified' });
  });

  it('sends the bearer token, like every other call in this app', async () => {
    let authorization: string | null = null;
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ data: DETAIL }, { headers: { ETag: 'W/"v3"' } });
      }),
    );

    await getTranscript('t1');

    expect(authorization).toBe('Bearer test-token');
  });

  it('refreshes ONCE on a 401 and retries, rather than reimplementing the dance', async () => {
    // `ApiService` dedupes concurrent refreshes behind one promise; a second
    // implementation here would race it and burn the rotating refresh token.
    const refresh = vi.spyOn(api, 'refreshToken').mockResolvedValue(true);
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, () => {
        calls += 1;
        if (calls === 1) return new HttpResponse(null, { status: 401 });
        return HttpResponse.json({ data: DETAIL }, { headers: { ETag: 'W/"v3"' } });
      }),
    );

    const result = await getTranscript('t1');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(result.status).toBe('ok');
    refresh.mockRestore();
  });

  it('throws a 401 ApiError when the refresh itself fails', async () => {
    const refresh = vi.spyOn(api, 'refreshToken').mockResolvedValue(false);
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, () => new HttpResponse(null, { status: 401 })),
    );

    await expect(getTranscript('t1')).rejects.toBeInstanceOf(ApiError);
    refresh.mockRestore();
  });

  it('turns a 404 into an ApiError carrying the status', async () => {
    // 404 and not 403 is the API's deliberate choice — the existence of a
    // transcript id is itself information — so the client has to treat "gone"
    // and "never yours" as one case.
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 }),
      ),
    );

    await expect(getTranscript('t1')).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    });
  });

  it('unwraps the { data } envelope, like ApiService does', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, () =>
        HttpResponse.json({ data: DETAIL, meta: { requestId: 'x' } }),
      ),
    );

    const result = await getTranscript('t1');

    expect(result).toMatchObject({ status: 'ok', data: DETAIL });
  });
});

describe('getTranscriptSegments — the same validator path', () => {
  it('round-trips an ETag and a 304', async () => {
    const body = { currentVersion: 3, segments: [] };
    let seenHeader: string | null = null;
    server.use(
      http.get(`${API_BASE}/transcripts/t1/segments`, ({ request }) => {
        seenHeader = request.headers.get('if-none-match');
        if (seenHeader === 'W/"v3"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json({ data: body }, { headers: { ETag: 'W/"v3"' } });
      }),
    );

    const first = await getTranscriptSegments('t1');
    expect(first).toEqual({ status: 'ok', data: body, etag: 'W/"v3"' });

    const second = await getTranscriptSegments('t1', 'W/"v3"');
    expect(second).toEqual({ status: 'not-modified' });
  });
});

describe('getTranscripts — the query string', () => {
  it('omits every absent filter rather than sending empty values', async () => {
    let url = '';
    server.use(
      http.get(`${API_BASE}/transcripts`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );

    await getTranscripts({ scope: 'owned' });

    const query = new URL(url).searchParams;
    expect(query.get('scope')).toBe('owned');
    expect(query.has('status')).toBe(false);
    expect(query.has('q')).toBe(false);
    expect(query.has('cursor')).toBe(false);
  });

  it('drops a whitespace-only search term', async () => {
    // `q=` would be a filter the API applies — "title contains the empty
    // string" is not what a user meant by clearing the box.
    let url = '';
    server.use(
      http.get(`${API_BASE}/transcripts`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );

    await getTranscripts({ scope: 'all', q: '   ' });

    expect(new URL(url).searchParams.has('q')).toBe(false);
  });

  it('trims a real search term', async () => {
    let url = '';
    server.use(
      http.get(`${API_BASE}/transcripts`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );

    await getTranscripts({ q: '  budget  ' });

    expect(new URL(url).searchParams.get('q')).toBe('budget');
  });
});

describe('getTranscriptWords — the window', () => {
  it('floors and clamps the window bounds it sends', async () => {
    let url = '';
    server.use(
      http.get(`${API_BASE}/transcripts/t1/words`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          data: { currentVersion: 1, fromMs: 0, toMs: 1000, segments: [] },
        });
      }),
    );

    await getTranscriptWords('t1', -50, 1000.7);

    const query = new URL(url).searchParams;
    // Negative is clamped to the beginning; the API rejects a negative bound,
    // and a rejected word window would silently kill word highlighting.
    expect(query.get('fromMs')).toBe('0');
    expect(query.get('toMs')).toBe('1000');
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
    server.use(
      http.post(`${API_BASE}/transcripts`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: response }, { status: 201 });
      }),
    );

    const result = await createTranscript({
      title: 'Standup',
      language: null,
      speakersExpected: 2,
      source: { name: 'standup.m4a', size: 1024, mimeType: 'audio/mp4' },
    });

    expect(body).toMatchObject({ title: 'Standup', language: null, speakersExpected: 2 });
    expect(result).toEqual(response);
  });
});
