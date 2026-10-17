/**
 * This app's binding of the domain web host (issue #499, epic #498).
 *
 * What is proved here is the binding, not the slices: the transports ride the
 * app's single `api` client (its token, its envelope unwrapping, its error type),
 * the viewer is the signed-in user's permission set, and the links and the
 * connected-knowledge switch are this app's.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useEffect } from 'react';

import {
  KvoxApiError,
  kvoxDelete,
  kvoxGet,
  kvoxGetBlob,
  kvoxGetWithMeta,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
  kvoxPut,
  kvoxRequestBlob,
  useKvoxHost,
} from '@marinoscar/kvox-web/core/headless';
import type { KvoxWebHost } from '@marinoscar/kvox-web/core/headless';

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser, waitFor } from '../utils/test-utils';
import { api } from '../../services/api';

let host: KvoxWebHost;

function Capture() {
  const value = useKvoxHost();
  useEffect(() => {
    host = value;
  });
  return null;
}

async function mountHost(user = mockAdminUser): Promise<KvoxWebHost> {
  render(<Capture />, { wrapperOptions: { user } });
  await waitFor(() => expect(host).toBeDefined());
  return host;
}

beforeEach(() => {
  api.setAccessToken('test-token');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('the HTTP port', () => {
  it('unwraps the { data } envelope and sends the app client\'s bearer token', async () => {
    let authorization: string | null = null;
    server.use(
      http.get('*/api/probe/ok', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ data: { fine: true } });
      }),
    );
    const kvox = await mountHost();

    expect(await kvoxGet(kvox, '/probe/ok')).toEqual({ fine: true });
    expect(authorization).toBe('Bearer test-token');
  });

  it('appends the query, sends JSON bodies and passes extra headers through', async () => {
    const seen: Array<{ method: string; url: string; body: unknown; ifMatch: string | null }> = [];
    server.use(
      http.all('*/api/probe/echo', async ({ request }) => {
        const text = await request.text();
        seen.push({
          method: request.method,
          url: request.url,
          body: text === '' ? undefined : JSON.parse(text),
          ifMatch: request.headers.get('if-match'),
        });
        return HttpResponse.json({ data: { ok: true } });
      }),
    );
    const kvox = await mountHost();

    await kvoxGet(kvox, '/probe/echo', { query: { page: 2, skip: undefined } });
    await kvoxPost(kvox, '/probe/echo', { a: 1 });
    await kvoxPut(kvox, '/probe/echo', { b: 2 }, { headers: { 'If-Match': '7' } });
    await kvoxPatch(kvox, '/probe/echo', { c: 3 });
    await kvoxDelete(kvox, '/probe/echo');

    expect(seen.map((call) => call.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(new URL(seen[0]!.url).search).toBe('?page=2');
    expect(seen[1]!.body).toEqual({ a: 1 });
    expect(seen[2]).toMatchObject({ body: { b: 2 }, ifMatch: '7' });
    expect(seen[3]!.body).toEqual({ c: 3 });
  });

  it('rejects with a KvoxApiError that keeps the status, the code and details.reason', async () => {
    server.use(
      http.put('*/api/probe/conflict', () =>
        HttpResponse.json(
          { message: 'stale', code: 'CONFLICT', details: { reason: 'ai_not_configured' } },
          { status: 409 },
        ),
      ),
    );
    const kvox = await mountHost();

    const error = await kvoxPut(kvox, '/probe/conflict', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvoxApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'ai_not_configured',
      kvoxCode: 'ai_not_configured',
      message: 'stale',
    });
  });

  it('posts multipart without hand-setting a Content-Type', async () => {
    let contentType: string | null = null;
    let hasFilePart = false;
    server.use(
      http.post('*/api/probe/upload', async ({ request }) => {
        contentType = request.headers.get('content-type');
        const form = await request.formData();
        hasFilePart = form.has('file');
        return HttpResponse.json({ data: { stored: true } });
      }),
    );
    const kvox = await mountHost();
    const form = new FormData();
    form.append('file', new File(['x'], 'doc.txt'));

    expect(await kvoxPostFormData(kvox, '/probe/upload', form)).toEqual({ stored: true });
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(hasFilePart).toBe(true);
  });

  it('downloads bytes with the response headers (GET and POST)', async () => {
    server.use(
      http.get('*/api/probe/file', () =>
        new HttpResponse('abc', {
          headers: { 'content-disposition': 'attachment; filename="a.txt"' },
        }),
      ),
      http.post('*/api/probe/export', () => new HttpResponse('exported')),
    );
    const kvox = await mountHost();

    const download = await kvoxRequestBlob(kvox, 'GET', '/probe/file');
    expect(await download.blob.text()).toBe('abc');
    expect(download.headers.get('Content-Disposition')).toBe('attachment; filename="a.txt"');
    expect(await (await kvoxGetBlob(kvox, '/probe/file')).text()).toBe('abc');
    const posted = await kvoxRequestBlob(kvox, 'POST', '/probe/export', { body: { format: 'pdf' } });
    expect(await posted.blob.text()).toBe('exported');
  });

  it('reads a conditional GET: the ETag on a 200, then a 304 that resolves with no data', async () => {
    const sentIfNoneMatch: Array<string | null> = [];
    server.use(
      http.get('*/api/probe/poll', ({ request }) => {
        sentIfNoneMatch.push(request.headers.get('if-none-match'));
        if (request.headers.get('if-none-match') === '"v1"') {
          return new HttpResponse(null, { status: 304 });
        }
        return HttpResponse.json({ data: { n: 1 } }, { headers: { etag: '"v1"' } });
      }),
    );
    const kvox = await mountHost();

    const first = await kvoxGetWithMeta<{ n: number }>(kvox, '/probe/poll');
    expect(first.status).toBe(200);
    expect(first.data).toEqual({ n: 1 });
    expect(first.headers.get('etag')).toBe('"v1"');

    const second = await kvoxGetWithMeta<{ n: number }>(kvox, '/probe/poll', {
      headers: { 'If-None-Match': '"v1"' },
    });
    expect(second.status).toBe(304);
    expect(second.data).toBeUndefined();
    expect(sentIfNoneMatch).toEqual([null, '"v1"']);
  });

  it('rejects a conditional GET failure with the API\'s message and status', async () => {
    server.use(
      http.get('*/api/probe/gone', () =>
        HttpResponse.json({ message: 'gone', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    );
    const kvox = await mountHost();

    await expect(kvoxGetWithMeta(kvox, '/probe/gone')).rejects.toMatchObject({
      status: 404,
      message: 'gone',
    });
  });
});

describe('the viewer, the links and the switches', () => {
  it('is the signed-in user with their permission set', async () => {
    const kvox = await mountHost(mockAdminUser);

    const viewer = kvox.viewer();
    expect(viewer?.userId).toBe(mockAdminUser.id);
    expect(viewer?.permissions.has('system_settings:read')).toBe(true);
    expect(viewer?.permissions.has('transcripts:write')).toBe(true);
  });

  it('holds only what the user holds', async () => {
    const kvox = await mountHost(mockUser);

    const viewer = kvox.viewer();
    expect(viewer?.permissions.has('system_settings:read')).toBe(false);
    expect(viewer?.permissions.has('user_settings:read')).toBe(true);
  });

  it('builds this app\'s routes', async () => {
    const { links } = await mountHost();

    expect(links.transcript('t1')).toBe('/transcripts/t1');
    expect(links.note('n1')).toBe('/notes/n1');
    expect(links.entity('e1')).toBe('/graph/entities/e1');
    expect(links.conversation('c1')).toBe('/ask/c1');
  });

  it('reports connected knowledge off until the app knows it is on', async () => {
    const kvox = await mountHost();

    expect(kvox.features().graphEnabled).toBe(false);
  });

  it('leaves the upload port out, so the engine sends parts with XMLHttpRequest', async () => {
    expect((await mountHost()).upload).toBeUndefined();
  });
});
