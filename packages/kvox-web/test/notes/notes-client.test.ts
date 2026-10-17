import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from './msw-compat.js';

import { server } from './msw-compat.js';
import { KvoxApiError as ApiError } from '../../src/core/headless/index.js';
import { makeHost } from './helpers.js';
import type { FakeKvoxWebHost } from '../../src/core/testing/index.js';
import {
  createNote,
  getNoteDocumentExtraction,
  getNoteVersion,
  getNotes,
  noteConflictCurrentVersion,
  noteConflictReason,
  restoreNoteVersion,
  retitleNote,
  updateNote,
  uploadNoteSourceDocument,
} from '../../src/notes/headless/clients/notes.js';

/**
 * `clients/notes.ts` — the wire contract, asserted against the fake host.
 *
 * What is actually easy to get wrong here is the QUERY STRING (an empty filter
 * sent as `q=` is a filter the API applies) and the 409 BRANCH (a reason read
 * off the wrong field is a branch that silently never fires). Both are asserted
 * directly rather than through a page.
 */

const API_BASE = 'http://localhost:3000/api';

let seen: URL[] = [];
let host: FakeKvoxWebHost;

beforeEach(() => {
  seen = [];
  server.use(
    http.get(`${API_BASE}/notes`, ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json({ data: { items: [], nextCursor: null } });
    }),
  );
  host = makeHost();
});

describe('getNotes — the query string', () => {
  it('sends nothing at all for an unfiltered list but the page size', async () => {
    await getNotes(host);
    expect(seen[0].search).toBe('');
  });

  it('omits a search term that is only whitespace', async () => {
    // `q=` is a filter the API applies — "title contains the empty string" is
    // not what a user meant by clearing the box.
    await getNotes(host, { q: '   ' });
    expect(seen[0].searchParams.has('q')).toBe(false);
  });

  it('trims the search term it does send', async () => {
    await getNotes(host, { q: '  budget ' });
    expect(seen[0].searchParams.get('q')).toBe('budget');
  });

  it('forwards every filter the API publishes', async () => {
    await getNotes(host, {
      status: 'failed',
      sourceType: 'document',
      sourceTranscriptId: 't1',
      sourceNoteId: 'n1',
      sourceObjectId: 'obj-1',
      templateId: 'tpl-1',
      cursor: 'abc',
      limit: 5,
    });

    const params = seen[0].searchParams;
    expect(params.get('status')).toBe('failed');
    expect(params.get('sourceType')).toBe('document');
    expect(params.get('sourceTranscriptId')).toBe('t1');
    expect(params.get('sourceNoteId')).toBe('n1');
    expect(params.get('sourceObjectId')).toBe('obj-1');
    expect(params.get('templateId')).toBe('tpl-1');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('limit')).toBe('5');
  });
});

describe('noteConflictReason — the 409 branch', () => {
  it('reads the reason out of details, where the API puts it', async () => {
    // ⚠ `details.reason`, NOT the top-level `code`. The API's exception filter
    // derives `code` from the status and ignores any a handler supplies, so a
    // client reading `code` would branch on `CONFLICT` forever.
    server.use(
      http.post(`${API_BASE}/notes`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'No key.',
            details: { reason: 'ai_key_missing' },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(
      createNote(host, { templateId: 'tpl-1', source: { type: 'transcript', transcriptId: 't1' } }),
    ).rejects.toSatisfy((err: unknown) => noteConflictReason(err) === 'ai_key_missing');
  });

  it('answers null for anything that is not a 409 carrying a reason', () => {
    expect(noteConflictReason(new ApiError('Boom', 500))).toBeNull();
    expect(noteConflictReason(new ApiError('Conflict', 409))).toBeNull();
    expect(noteConflictReason(new ApiError('Conflict', 409, 'CONFLICT', {}))).toBeNull();
    expect(noteConflictReason(new Error('not an ApiError'))).toBeNull();
    // A 400 carrying a reason-shaped body is still not a conflict.
    expect(
      noteConflictReason(new ApiError('Bad', 400, 'BAD_REQUEST', { reason: 'ai_key_missing' })),
    ).toBeNull();
  });

  it('passes through a reason this build has never heard of', () => {
    // A newer server naming a branch this bundle does not implement: the caller
    // falls through to showing the message, which is the correct degradation.
    expect(
      noteConflictReason(new ApiError('X', 409, 'CONFLICT', { reason: 'something_new' })),
    ).toBe('something_new');
  });
});

describe('getNoteDocumentExtraction — total over the notes answer', () => {
  function respondWith(data: unknown) {
    server.use(
      http.get(`${API_BASE}/notes/sources/documents/:objectId`, () => HttpResponse.json({ data })),
    );
  }

  it('reads the extraction outcome from the notes slice', async () => {
    respondWith({ objectId: 'obj-1', status: 'extracted', message: null, characters: 4200 });

    await expect(getNoteDocumentExtraction(host, 'obj-1')).resolves.toEqual({
      status: 'extracted',
      message: null,
      characters: 4200,
    });
  });

  it('carries the API’s own stored sentence for an unreadable document', async () => {
    respondWith({
      objectId: 'obj-1',
      status: 'unextractable',
      message: 'This PDF is password-protected.',
      characters: null,
    });

    await expect(getNoteDocumentExtraction(host, 'obj-1')).resolves.toEqual({
      status: 'unextractable',
      message: 'This PDF is password-protected.',
      characters: null,
    });
  });

  it.each([
    ['no answer at all', null],
    ['an answer that is not an object', 'nonsense'],
    ['the API still extracting', { objectId: 'obj-1', status: 'extracting', message: null, characters: null }],
    ['a status this build does not know', { objectId: 'obj-1', status: 'weird', message: 'x', characters: 3 }],
    ['an answer with no status', { objectId: 'obj-1' }],
  ])('reports "extracting" for %s', async (_label, data) => {
    // ⚠ EVERY UNREADABLE SHAPE MEANS "NOT YET", and that direction is the safe
    // one: the caller uses this to decide whether Generate is enabled, and
    // guessing "extracted" would let a user start a generation that fails
    // minutes later on their own provider account.
    respondWith(data);

    await expect(getNoteDocumentExtraction(host, 'obj-1')).resolves.toEqual({
      status: 'extracting',
      message: null,
      characters: null,
    });
  });
});

describe('uploadNoteSourceDocument', () => {
  it('sends multipart with a single "file" part, as the controller requires', async () => {
    // ⚠ ASSERTED AGAINST THE `FormData` THIS CLIENT HANDS TO THE HOST, not
    // against a multipart body parsed back out of a request: undici's multipart
    // parser rejects jsdom's `File` on newer Node versions, and the round trip
    // was never the thing under test. What this client is responsible for is
    // the shape the controller reads — exactly one part, named `file`, carrying
    // the file itself — and that is what the body already is before it is
    // serialized.
    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });
    let body: FormData | null = null;

    server.use(
      http.post(`${API_BASE}/notes/sources/documents`, async ({ request }) => {
        body = await request.formData();
        return HttpResponse.json({
          data: {
            objectId: 'obj-1',
            filename: 'brief.pdf',
            mimeType: 'application/pdf',
            size: 5,
            jobId: 'job-1',
            status: 'extracting',
          },
        });
      }),
    );

    const result = await uploadNoteSourceDocument(host, file);

    expect(host.callsTo('POST /notes/sources/documents')).toHaveLength(1);

    expect(body).toBeInstanceOf(FormData);
    const sent = body as unknown as FormData;
    // EXACTLY ONE PART. The controller reads a single `file` part and
    // refuses anything else; a second field would be a 400 nobody could
    // diagnose from the UI.
    expect([...sent.keys()]).toEqual(['file']);
    // The part carries the file itself, not a stringified stand-in — and
    // here, unlike through a multipart round trip, the name survives.
    expect(sent.get('file')).toBe(file);

    expect(result.objectId).toBe('obj-1');
    expect(result.status).toBe('extracting');
  });
});

describe('notes service — saving an edit', () => {
  it('PATCHes exactly what it was given, `baseVersion` included', async () => {
    let sent: Record<string, unknown> | null = null;

    server.use(
      http.patch(`${API_BASE}/notes/:id`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { id: 'n1', currentVersion: 4 } });
      }),
    );

    const note = await updateNote(host, 'n1', { body: 'New text.', baseVersion: 3 });

    expect(sent).toEqual({ body: 'New text.', baseVersion: 3 });
    expect(note.currentVersion).toBe(4);
  });

  it('sends a rename with NO baseVersion — a title is not versioned content', async () => {
    let sent: Record<string, unknown> | null = null;

    server.use(
      http.patch(`${API_BASE}/notes/:id`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { id: 'n1', title: 'Renamed' } });
      }),
    );

    await updateNote(host, 'n1', { title: 'Renamed' });

    expect(sent).toEqual({ title: 'Renamed' });
  });
});

describe('notes service — the conflict readers', () => {
  it('names the reason AND the version a stale save collided with', async () => {
    server.use(
      http.patch(`${API_BASE}/notes/:id`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Stale.',
            details: { reason: 'stale_base_version', currentVersion: 7 },
          },
          { status: 409 },
        ),
      ),
    );

    const err = await updateNote(host, 'n1', { body: 'x', baseVersion: 3 }).catch((cause) => cause);

    expect(noteConflictReason(err)).toBe('stale_base_version');
    // ⚠ WITHOUT THIS, A CONFLICT UI HAS NOTHING TO OFFER BUT A RETRY — and a
    // retry is the one response that would overwrite the other version.
    expect(noteConflictCurrentVersion(err)).toBe(7);
  });

  it('answers null for a 409 that names no version, rather than inventing one', async () => {
    server.use(
      http.patch(`${API_BASE}/notes/:id`, () =>
        HttpResponse.json(
          { statusCode: 409, code: 'CONFLICT', message: 'Generating.', details: { reason: 'generating' } },
          { status: 409 },
        ),
      ),
    );

    const err = await updateNote(host, 'n1', { body: 'x', baseVersion: 3 }).catch((cause) => cause);

    expect(noteConflictReason(err)).toBe('generating');
    expect(noteConflictCurrentVersion(err)).toBeNull();
  });

  it('answers null for anything that is not a 409 at all', () => {
    expect(noteConflictCurrentVersion(new Error('boom'))).toBeNull();
  });
});

describe('notes service — versions', () => {
  it('reads one version in full, body included', async () => {
    server.use(
      http.get(`${API_BASE}/notes/:id/versions/:version`, ({ params }) =>
        HttpResponse.json({
          data: {
            version: Number(params.version),
            kind: 'ai_generated',
            summary: null,
            author: null,
            generationId: 'gen-1',
            restoredFromVersion: null,
            createdAt: new Date().toISOString(),
            noteId: 'n1',
            body: '# Original',
            isCurrent: false,
          },
        }),
      ),
    );

    const detail = await getNoteVersion(host, 'n1', 1);

    expect(detail.body).toBe('# Original');
    // ⚠ `author: null` MEANS THE AI. Carried through the client unchanged, so
    // no surface has to re-derive it.
    expect(detail.author).toBeNull();
  });

  it('restores by APPENDING, and pins the request to the current version', async () => {
    let sent: Record<string, unknown> | null = null;
    let path = '';

    server.use(
      http.post(`${API_BASE}/notes/:id/versions/:version/restore`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        path = new URL(request.url).pathname;
        return HttpResponse.json({ data: { id: 'n1', currentVersion: 6 } });
      }),
    );

    const note = await restoreNoteVersion(host, 'n1', 2, 5, 'Back to the AI draft');

    expect(path).toBe('/api/notes/n1/versions/2/restore');
    expect(sent).toEqual({ baseVersion: 5, summary: 'Back to the AI draft' });
    // A NEW version, higher than both — nothing was rewritten.
    expect(note.currentVersion).toBe(6);
  });

  it('omits an absent summary rather than sending an empty one', async () => {
    let sent: Record<string, unknown> | null = null;

    server.use(
      http.post(`${API_BASE}/notes/:id/versions/:version/restore`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: { id: 'n1', currentVersion: 6 } });
      }),
    );

    await restoreNoteVersion(host, 'n1', 2, 5);

    expect(sent).toEqual({ baseVersion: 5 });
  });
});

describe('retitleNote — #185', () => {
  it('POSTs to /notes/{id}/retitle and returns the parsed job, not a title', async () => {
    let method = '';
    let path = '';
    server.use(
      http.post(`${API_BASE}/notes/:id/retitle`, ({ request, params }) => {
        method = request.method;
        path = new URL(request.url).pathname;
        expect(params.id).toBe('n1');
        return HttpResponse.json(
          { data: { noteId: 'n1', jobId: 'job-9' } },
          { status: 202 },
        );
      }),
    );

    const result = await retitleNote(host, 'n1');

    expect(method).toBe('POST');
    expect(path).toBe('/api/notes/n1/retitle');
    // ⚠ EXACTLY {noteId, jobId} — the 202 the API answers has no `title` field
    // at all, and a caller reading one back would be reading a key this
    // response never carries.
    expect(result).toEqual({ noteId: 'n1', jobId: 'job-9' });
  });

  it('sends no body — there is nothing for the caller to configure', async () => {
    let body: unknown;
    server.use(
      http.post(`${API_BASE}/notes/:id/retitle`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json({ data: { noteId: 'n1', jobId: 'job-9' } }, { status: 202 });
      }),
    );

    await retitleNote(host, 'n1');

    expect(body).toBe('');
  });
});
