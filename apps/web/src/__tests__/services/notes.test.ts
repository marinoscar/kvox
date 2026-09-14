import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  createNote,
  getNoteDocumentExtraction,
  getNotes,
  noteConflictReason,
  uploadNoteSourceDocument,
} from '../../services/notes';

/**
 * `services/notes.ts` — the wire contract, asserted against MSW.
 *
 * What is actually easy to get wrong here is the QUERY STRING (an empty filter
 * sent as `q=` is a filter the API applies) and the 409 BRANCH (a reason read
 * off the wrong field is a branch that silently never fires). Both are asserted
 * directly rather than through a page.
 */

const API_BASE = 'http://localhost:3000/api';

let seen: URL[] = [];

beforeEach(() => {
  seen = [];
  server.use(
    http.get(`${API_BASE}/notes`, ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json({ data: { items: [], nextCursor: null } });
    }),
  );
});

describe('getNotes — the query string', () => {
  it('sends nothing at all for an unfiltered list but the page size', async () => {
    await getNotes();
    expect(seen[0].search).toBe('');
  });

  it('omits a search term that is only whitespace', async () => {
    // `q=` is a filter the API applies — "title contains the empty string" is
    // not what a user meant by clearing the box.
    await getNotes({ q: '   ' });
    expect(seen[0].searchParams.has('q')).toBe(false);
  });

  it('trims the search term it does send', async () => {
    await getNotes({ q: '  budget ' });
    expect(seen[0].searchParams.get('q')).toBe('budget');
  });

  it('forwards every filter the API publishes', async () => {
    await getNotes({
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
      createNote({ templateId: 'tpl-1', source: { type: 'transcript', transcriptId: 't1' } }),
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

describe('getNoteDocumentExtraction — total over the metadata bag', () => {
  function respondWithMetadata(metadata: unknown) {
    server.use(
      http.get(`${API_BASE}/storage/objects/:id`, () =>
        HttpResponse.json({ data: { id: 'obj-1', name: 'brief.pdf', metadata } }),
      ),
    );
  }

  it('reads the namespaced block the extraction job writes', async () => {
    respondWithMetadata({
      extractedObjectId: 'obj-2',
      noteSourceExtraction: { status: 'extracted', characters: 4200 },
    });

    await expect(getNoteDocumentExtraction('obj-1')).resolves.toEqual({
      status: 'extracted',
      message: null,
      characters: 4200,
    });
  });

  it('carries the API’s own stored sentence for an unreadable document', async () => {
    respondWithMetadata({
      noteSourceExtraction: {
        status: 'unextractable',
        reason: 'encrypted',
        message: 'This PDF is password-protected.',
      },
    });

    await expect(getNoteDocumentExtraction('obj-1')).resolves.toEqual({
      status: 'unextractable',
      message: 'This PDF is password-protected.',
      characters: null,
    });
  });

  it.each([
    ['no metadata at all', null],
    ['metadata that is not an object', 'nonsense'],
    ['metadata with no extraction block', { uploadedFilename: 'brief.pdf' }],
    ['a block with a status this build does not know', { noteSourceExtraction: { status: 'weird' } }],
    ['a block that is not an object', { noteSourceExtraction: 7 }],
  ])('reports "extracting" for %s', async (_label, metadata) => {
    // ⚠ EVERY UNREADABLE SHAPE MEANS "NOT YET", and that direction is the safe
    // one: the caller uses this to decide whether Generate is enabled, and
    // guessing "extracted" would let a user start a generation that fails
    // minutes later on their own provider account.
    respondWithMetadata(metadata);

    await expect(getNoteDocumentExtraction('obj-1')).resolves.toEqual({
      status: 'extracting',
      message: null,
      characters: null,
    });
  });
});

describe('uploadNoteSourceDocument', () => {
  it('sends multipart with a single "file" part, as the controller requires', async () => {
    let receivedField: string | null = null;
    let receivedBytes: string | null = null;
    let receivedFieldCount = 0;

    server.use(
      http.post(`${API_BASE}/notes/sources/documents`, async ({ request }) => {
        const form = await request.formData();
        receivedFieldCount = [...form.keys()].length;
        const entry = form.get('file');
        receivedField = entry === null ? null : 'file';
        // NOT a string — i.e. a file part rather than a text field. The
        // filename and the bytes are deliberately not asserted: jsdom's `File`
        // does not survive msw's multipart round trip with either intact, which
        // is an artefact of the test transport rather than anything this client
        // controls. What this client IS responsible for is the shape the
        // controller reads — one part, named `file`, carrying a file — and that
        // is what is asserted.
        receivedBytes = entry !== null && typeof entry !== 'string' ? 'file-part' : null;
        return HttpResponse.json(
          {
            data: {
              objectId: 'obj-1',
              filename: 'brief.pdf',
              mimeType: 'application/pdf',
              size: 5,
              jobId: 'job-1',
              status: 'extracting',
            },
          },
          { status: 201 },
        );
      }),
    );

    const result = await uploadNoteSourceDocument(
      new File(['hello'], 'brief.pdf', { type: 'application/pdf' }),
    );

    expect(receivedField).toBe('file');
    expect(receivedBytes).toBe('file-part');
    // ⚠ EXACTLY ONE PART. The controller reads a single `file` part and refuses
    // anything else, and a second field would be a 400 nobody could diagnose.
    expect(receivedFieldCount).toBe(1);
    expect(result.objectId).toBe('obj-1');
    expect(result.status).toBe('extracting');
  });
});
