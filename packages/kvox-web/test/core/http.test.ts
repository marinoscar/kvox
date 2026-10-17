import { describe, expect, it } from 'vitest';

import {
  KvoxApiError,
  buildKvoxUrl,
  isKvoxApiError,
  kvoxDelete,
  kvoxGet,
  kvoxGetBlob,
  kvoxGetWithMeta,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
  kvoxPut,
  toKvoxApiError,
  unwrapEnvelope,
} from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';

describe('buildKvoxUrl', () => {
  it('appends a query string, skipping undefined and null and repeating array keys', () => {
    expect(buildKvoxUrl('/x', { a: 1, b: undefined, c: null, d: ['p', 'q'], e: false })).toBe(
      '/x?a=1&d=p&d=q&e=false',
    );
  });

  it('continues an existing query string and leaves a path alone when there is nothing to add', () => {
    expect(buildKvoxUrl('/x?y=1', { a: 'b' })).toBe('/x?y=1&a=b');
    expect(buildKvoxUrl('/x', {})).toBe('/x');
    expect(buildKvoxUrl('/x')).toBe('/x');
  });
});

describe('unwrapEnvelope', () => {
  it('removes the { data } envelope', () => {
    expect(unwrapEnvelope({ data: { a: 1 } })).toEqual({ a: 1 });
  });

  it('returns a body without an envelope, and a null data, as they are', () => {
    expect(unwrapEnvelope({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapEnvelope([1, 2])).toEqual([1, 2]);
    expect(unwrapEnvelope({ data: null, other: 1 })).toEqual({ data: null, other: 1 });
    expect(unwrapEnvelope(null)).toBeNull();
  });
});

describe('KvoxApiError', () => {
  it('keeps the status, the code and the details', () => {
    const error = new KvoxApiError('nope', 409, 'CONFLICT', { reason: 'something_odd', extra: 1 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KvoxApiError');
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'something_odd' });
    expect(error.details).toEqual({ reason: 'something_odd', extra: 1 });
    // Not a code of the contract's catalogue, so it has no `kvoxCode`.
    expect(error.kvoxCode).toBeUndefined();
  });

  it('maps details.reason through the contract catalogue', () => {
    const error = new KvoxApiError('stale', 409, 'CONFLICT', { reason: 'ai_not_configured' });

    expect(error.reason).toBe('ai_not_configured');
    expect(error.kvoxCode).toBe('ai_not_configured');
  });

  it('has no reason when details carry none or carry a non-string', () => {
    expect(new KvoxApiError('x', 500).reason).toBeUndefined();
    expect(new KvoxApiError('x', 500, undefined, 'text').reason).toBeUndefined();
    expect(new KvoxApiError('x', 500, undefined, { reason: 4 }).reason).toBeUndefined();
  });

  it('recognises itself', () => {
    expect(isKvoxApiError(new KvoxApiError('x', 400))).toBe(true);
    expect(isKvoxApiError(new Error('x'))).toBe(false);
  });
});

describe('toKvoxApiError', () => {
  it('wraps anything with a numeric status, keeping its fields', () => {
    const platformStyle = Object.assign(new Error('Forbidden'), {
      status: 403,
      code: 'FORBIDDEN',
      details: { reason: 'ai_not_configured' },
    });
    const mapped = toKvoxApiError(platformStyle);

    expect(mapped).toBeInstanceOf(KvoxApiError);
    expect(mapped).toMatchObject({
      message: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      reason: 'ai_not_configured',
    });
  });

  it('returns a KvoxApiError, an abort and a plain failure unchanged', () => {
    const own = new KvoxApiError('x', 400);
    const abort = new DOMException('Aborted', 'AbortError');
    const plain = new Error('offline');

    expect(toKvoxApiError(own)).toBe(own);
    expect(toKvoxApiError(abort)).toBe(abort);
    expect(toKvoxApiError(plain)).toBe(plain);
    expect(toKvoxApiError('text')).toBe('text');
  });
});

describe('the kvox* helpers', () => {
  it('carry the verb, the path, the body and the headers to the host', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /a': { v: 1 },
        'POST /a': (request) => ({ echoed: request.body }),
        'PUT /a': undefined,
        'PATCH /a': undefined,
        'DELETE /a': undefined,
      },
    });

    expect(await kvoxGet(host, '/a')).toEqual({ v: 1 });
    expect(await kvoxPost(host, '/a', { x: 1 })).toEqual({ echoed: { x: 1 } });
    await kvoxPut(host, '/a', { y: 2 }, { headers: { 'If-Match': '3' } });
    await kvoxPatch(host, '/a', { z: 3 });
    await kvoxDelete(host, '/a');

    expect(host.calls.map((call) => call.key)).toEqual([
      'GET /a',
      'POST /a',
      'PUT /a',
      'PATCH /a',
      'DELETE /a',
    ]);
    expect(host.callsTo('PUT /a')[0]).toMatchObject({ body: { y: 2 }, headers: { 'If-Match': '3' } });
  });

  it('hand the query to the host, which routes on the path alone', async () => {
    const host = createFakeKvoxWebHost({
      routes: { 'GET /list': (request) => request.query.get('page') },
    });

    expect(await kvoxGet(host, '/list', { query: { page: 2 } })).toBe('2');
    expect(host.calls[0]?.path).toBe('/list?page=2');
  });

  it('normalise a rejection with a status into KvoxApiError and leave other failures alone', async () => {
    // A host whose client raises its own error type, not ours.
    const host = createFakeKvoxWebHost();
    host.http.request = async () => {
      throw Object.assign(new Error('Conflict'), { status: 409, details: { reason: 'ai_not_configured' } });
    };

    const error = await kvoxGet(host, '/boom').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KvoxApiError);
    expect(error).toMatchObject({ status: 409, kvoxCode: 'ai_not_configured' });

    host.http.request = async () => {
      throw new Error('offline');
    };
    const plain = await kvoxGet(host, '/boom').catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(KvoxApiError);
  });

  it('reach the multipart, blob and meta transports', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /upload': (request) => ({ got: request.kind, isForm: request.body instanceof FormData }),
        'GET /file': { blob: new Blob(['abc']), headers: { 'content-disposition': 'attachment; filename="a.txt"' } },
        'GET /poll': { status: 304, headers: { etag: '"v1"' } },
      },
    });

    expect(await kvoxPostFormData(host, '/upload', form)).toEqual({ got: 'formData', isForm: true });
    const blob = await kvoxGetBlob(host, '/file');
    expect(blob.size).toBe(3);
    const meta = await kvoxGetWithMeta<unknown>(host, '/poll');
    expect(meta.status).toBe(304);
    expect(meta.data).toBeUndefined();
    expect(meta.headers.get('ETag')).toBe('"v1"');
  });
});
