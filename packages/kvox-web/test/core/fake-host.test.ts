import { describe, expect, it, vi } from 'vitest';

import { KvoxApiError, kvoxGet, kvoxPost } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';

describe('createFakeKvoxWebHost', () => {
  it('routes by method and path, with :params and a trailing wildcard', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /transcripts/:id': (request) => ({ id: request.params.id }),
        'GET /files/*': 'wild',
        'GET /exact?x=1': 'with-query',
        'GET /exact': 'plain',
      },
    });

    expect(await kvoxGet(host, '/transcripts/t%2F1')).toEqual({ id: 't/1' });
    expect(await kvoxGet(host, '/files/a/b/c')).toBe('wild');
    expect(await kvoxGet(host, '/exact', { query: { x: 1 } })).toBe('with-query');
    expect(await kvoxGet(host, '/exact')).toBe('plain');
  });

  it('answers an unknown route with a 404 KvoxApiError naming it, and does no network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const host = createFakeKvoxWebHost();

    const error = await kvoxGet(host, '/nope').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvoxApiError);
    expect(error).toMatchObject({ status: 404, reason: 'fake_route_missing' });
    expect((error as Error).message).toMatch(/GET \/nope/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('lets a handler fail the call like the API does', async () => {
    const host = createFakeKvoxWebHost({
      routes: { 'POST /x': () => { throw fakeApiError(409, 'stale', { reason: 'version_conflict' }); } },
    });

    await expect(kvoxPost(host, '/x', {})).rejects.toMatchObject({ status: 409, reason: 'version_conflict' });
  });

  it('records every call and can forget them', async () => {
    const host = createFakeKvoxWebHost({ routes: { 'GET /a': 1, 'POST /b': 2 } });
    await kvoxGet(host, '/a');
    await kvoxPost(host, '/b', { k: 1 });

    expect(host.calls.map((c) => c.key)).toEqual(['GET /a', 'POST /b']);
    expect(host.callsTo('POST /b')[0]?.body).toEqual({ k: 1 });
    host.reset();
    expect(host.calls).toEqual([]);
  });

  it('plays a scripted event stream and a scripted POST stream', async () => {
    const host = createFakeKvoxWebHost({
      sse: { '/s': [{ event: 'delta', data: 'x' }] },
      ssePost: { '/gen': [['delta', { t: 'a' }], ['done', {}]] },
    });
    const got: string[] = [];
    await host.sse.connect('/s', { lastEventId: '9', signal: new AbortController().signal, onEvent: (e) => got.push(e.event) });
    const frames: string[] = [];
    await host.sse.post('/gen', { prompt: 1 }, { onFrame: (event) => frames.push(event) });

    expect(got).toEqual(['delta']);
    expect(frames).toEqual(['delta', 'done']);
    expect(host.callsTo('/s')[0]?.lastEventId).toBe('9');
    expect(host.callsTo('/gen')[0]?.body).toEqual({ prompt: 1 });
  });

  it('records uploaded parts, and leaves the upload port out when asked', async () => {
    const host = createFakeKvoxWebHost();
    const result = await host.upload!.putPart('https://s3.example/p1', new Blob(['abcd']));

    expect(result.etag).toBe('etag-1');
    expect(host.uploads).toEqual([{ url: 'https://s3.example/p1', size: 4 }]);
    expect(createFakeKvoxWebHost({ upload: false }).upload).toBeUndefined();
  });

  it('exposes a replaceable viewer, features and default links', () => {
    const host = createFakeKvoxWebHost({ viewer: { userId: 'u', permissions: ['a'] } });

    expect(host.viewer()?.permissions.has('a')).toBe(true);
    host.setViewer(null);
    expect(host.viewer()).toBeNull();
    expect(host.features().graphEnabled).toBe(true);
    host.setFeatures({ graphEnabled: false });
    expect(host.features().graphEnabled).toBe(false);
    expect(host.links.transcript('7')).toBe('/transcripts/7');
    expect(host.links.conversation('7')).toBe('/ask/7');
  });
});
