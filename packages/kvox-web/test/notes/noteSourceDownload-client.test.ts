import { describe, it, expect, beforeEach } from 'vitest';

import { http, HttpResponse, server } from './msw-compat.js';
import { makeHost } from './helpers.js';
import type { FakeKvoxWebHost } from '../../src/core/testing/index.js';
import { KvoxApiError } from '../../src/core/headless/index.js';
import { getNoteSourceDownload } from '../../src/notes/headless/clients/notes.js';

/**
 * `getNoteSourceDownload` — issue #732: `GET /api/notes/{id}/source`, a
 * short-lived signed link to the original file an imported note came from.
 */

const API_BASE = 'http://localhost:3000/api';

const ANSWER = {
  url: 'https://storage.example/signed/board-pack.pdf?sig=abc',
  filename: 'board-pack.pdf',
  mimeType: 'application/pdf',
  expiresAt: '2026-10-24T10:15:00.000Z',
};

let host: FakeKvoxWebHost;

beforeEach(() => {
  host = makeHost();
});

describe('getNoteSourceDownload', () => {
  it('reads the signed link for the current version, parsed with the contract schema', async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ data: ANSWER });
      }),
    );

    await expect(getNoteSourceDownload(host, 'n1')).resolves.toEqual(ANSWER);
    expect(seen!.pathname).toBe('/api/notes/n1/source');
    expect(seen!.searchParams.has('version')).toBe(false);
  });

  it('asks for a named version when given one', async () => {
    let version: string | null = null;
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, ({ request }) => {
        version = new URL(request.url).searchParams.get('version');
        return HttpResponse.json({ data: ANSWER });
      }),
    );

    await getNoteSourceDownload(host, 'n1', 3);

    expect(version).toBe('3');
  });

  it('refuses an answer that is not a NoteSourceDownload', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, () =>
        HttpResponse.json({ data: { url: 42, filename: 'x' } }),
      ),
    );

    await expect(getNoteSourceDownload(host, 'n1')).rejects.toThrow();
  });

  it('surfaces a 404 as a KvoxApiError with the status', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id/source`, () =>
        HttpResponse.json(
          { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    const err = await getNoteSourceDownload(host, 'n1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KvoxApiError);
    expect((err as KvoxApiError).status).toBe(404);
  });
});
