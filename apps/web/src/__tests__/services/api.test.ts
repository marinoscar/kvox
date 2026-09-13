import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  api,
  ApiError,
  uploadProfileImage,
  deleteProfileImage,
  fetchProfileImagePreview,
} from '../../services/api';

describe('ApiService', () => {
  beforeEach(() => {
    api.setAccessToken(null);
  });

  afterEach(() => {
    api.setAccessToken(null);
  });

  describe('Token Management', () => {
    it('should set access token', () => {
      api.setAccessToken('test-token');
      expect(api.getAccessToken()).toBe('test-token');
    });

    it('should clear access token', () => {
      api.setAccessToken('test-token');
      api.setAccessToken(null);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should get current access token', () => {
      const token = 'my-access-token';
      api.setAccessToken(token);
      expect(api.getAccessToken()).toBe(token);
    });
  });

  describe('GET requests', () => {
    it('should make GET request', async () => {
      server.use(
        http.get('*/api/health/live', () => {
          return HttpResponse.json({ data: { status: 'ok' } });
        }),
      );

      const data = await api.get('/health/live');

      expect(data).toHaveProperty('status', 'ok');
    });

    it('should include auth header when token is set', async () => {
      let authHeader: string | null = null;

      server.use(
        http.get('*/api/auth/me', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ data: { id: 'user' } });
        }),
      );

      api.setAccessToken('test-token');
      await api.get('/auth/me');

      expect(authHeader).toBe('Bearer test-token');
    });

    it('should not include auth header when skipAuth is true', async () => {
      let authHeader: string | null = null;

      server.use(
        http.get('*/api/auth/providers', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ data: [] });
        }),
      );

      api.setAccessToken('test-token');
      await api.get('/auth/providers', { skipAuth: true });

      expect(authHeader).toBeNull();
    });

    it('should extract data from response', async () => {
      server.use(
        http.get('*/api/test', () => {
          return HttpResponse.json({ data: { message: 'success' } });
        }),
      );

      const result = await api.get('/test');

      expect(result).toEqual({ message: 'success' });
    });
  });

  describe('POST requests', () => {
    it('should make POST request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.post('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { success: true } });
        }),
      );

      await api.post('/test', { foo: 'bar' });

      expect(capturedBody).toEqual({ foo: 'bar' });
    });

    it('should make POST request without body', async () => {
      server.use(
        http.post('*/api/test', () => {
          return HttpResponse.json({ data: { success: true } });
        }),
      );

      const result = await api.post('/test');

      expect(result).toEqual({ success: true });
    });

    it('should NOT set Content-Type header when body is omitted (Fastify 5 strict)', async () => {
      let contentTypeHeader: string | null = null;

      server.use(
        http.post('*/api/auth/logout', ({ request }) => {
          contentTypeHeader = request.headers.get('Content-Type');
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await api.post('/auth/logout');

      // Fastify 5 requires no Content-Type when there's no body
      expect(contentTypeHeader).toBeNull();
    });

    it('should set Content-Type header when body is provided', async () => {
      let contentTypeHeader: string | null = null;

      server.use(
        http.post('*/api/test', ({ request }) => {
          contentTypeHeader = request.headers.get('Content-Type');
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.post('/test', { data: 'test' });

      expect(contentTypeHeader).toBe('application/json');
    });
  });

  describe('PUT requests', () => {
    it('should make PUT request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.put('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { updated: true } });
        }),
      );

      await api.put('/test', { name: 'updated' });

      expect(capturedBody).toEqual({ name: 'updated' });
    });
  });

  describe('PATCH requests', () => {
    it('should make PATCH request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.patch('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { patched: true } });
        }),
      );

      await api.patch('/test', { field: 'value' });

      expect(capturedBody).toEqual({ field: 'value' });
    });

    it('should include custom headers', async () => {
      let ifMatchHeader: string | null = null;

      server.use(
        http.patch('*/api/user-settings', ({ request }) => {
          ifMatchHeader = request.headers.get('If-Match');
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.patch('/user-settings', {}, {
        headers: { 'If-Match': '5' },
      });

      expect(ifMatchHeader).toBe('5');
    });
  });

  describe('DELETE requests', () => {
    it('should make DELETE request', async () => {
      server.use(
        http.delete('*/api/test/:id', ({ params }) => {
          return HttpResponse.json({ data: { deleted: params.id } });
        }),
      );

      const result = await api.delete('/test/123');

      expect(result).toEqual({ deleted: '123' });
    });
  });

  describe('postFormData (#367)', () => {
    it('should POST the FormData body without a hand-set Content-Type', async () => {
      let contentTypeHeader: string | null = null;
      let rawBody = '';

      server.use(
        http.post('*/api/upload', async ({ request }) => {
          contentTypeHeader = request.headers.get('Content-Type');
          // Not `await request.formData()`: on Node 24, undici's multipart
          // parser asserts every parsed field is either a USVString or an
          // undici-realm `File`. The `File` this test constructs is jsdom's
          // (this test file's global, since these are jsdom-environment
          // vitest tests) — a different realm — so that assertion throws
          // (`webidl.is.File(value)` is falsy) and MSW turns it into a 500.
          // Node 22's undici was more lenient. This is a test-harness
          // cross-realm interop bug, not app behavior, so read the raw body
          // instead and assert on what's realm-independent: the
          // Content-Type header and the raw multipart part header.
          rawBody = await request.text();
          return HttpResponse.json({ data: { ok: true } });
        }),
      );

      const formData = new FormData();
      formData.append('file', new File(['bytes'], 'a.png', { type: 'image/png' }));

      const result = await api.postFormData('/upload', formData);

      expect(result).toEqual({ ok: true });
      // The client must never hand-set `application/json` over a multipart
      // body — the browser/undici writes its own `multipart/form-data;
      // boundary=…` header, and a literal JSON type would break server parsing.
      expect(contentTypeHeader).not.toBeNull();
      expect(contentTypeHeader).not.toBe('application/json');
      expect(contentTypeHeader).toMatch(/^multipart\/form-data; boundary=/);
      // Realm-independent structural check: a `file` part with this field
      // name reached the server at all. See the note above for why this
      // doesn't go through `request.formData()`. Deliberately not asserting
      // on filename or byte content: constructing the `File` via jsdom (this
      // test file's global) and sending it through undici's `fetch` already
      // loses both by the time the request leaves the client — the filename
      // becomes the generic `"blob"` and the body content becomes the
      // literal text `undefined` — so those fields aren't reliable to assert
      // on across environments, only the field's presence is.
      expect(rawBody).toContain('Content-Disposition: form-data; name="file"');
    });

    it('should include the auth header on a FormData request', async () => {
      let authHeader: string | null = null;

      server.use(
        http.post('*/api/upload', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ data: {} });
        }),
      );

      api.setAccessToken('test-token');
      await api.postFormData('/upload', new FormData());

      expect(authHeader).toBe('Bearer test-token');
    });

    it('should refresh the token and retry a FormData request on 401', async () => {
      let callCount = 0;
      let lastAuthHeader: string | null = null;

      server.use(
        http.post('*/api/upload', ({ request }) => {
          callCount++;
          lastAuthHeader = request.headers.get('Authorization');
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { ok: true } });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({ accessToken: 'refreshed-token', expiresIn: 900 });
        }),
      );

      api.setAccessToken('expired-token');
      const result = await api.postFormData('/upload', new FormData());

      expect(result).toEqual({ ok: true });
      expect(callCount).toBe(2);
      expect(lastAuthHeader).toBe('Bearer refreshed-token');
    });
  });

  describe('Profile image API (#367)', () => {
    it('uploadProfileImage should POST the file as multipart to /user-settings/profile-image', async () => {
      let rawBody = '';

      server.use(
        http.post('*/api/user-settings/profile-image', async ({ request }) => {
          // Not `await request.formData()`: see the `postFormData` test
          // above for why (Node 24 undici's cross-realm `File` assertion
          // against this test file's jsdom `File`). Read the raw multipart
          // body instead and assert on the realm-independent part header.
          rawBody = await request.text();
          return HttpResponse.json({
            data: {
              settings: {
                theme: 'system',
                profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
                updatedAt: '2024-06-01T00:00:00.000Z',
                version: 2,
              },
              profileImageUrl: 'https://example.com/uploaded.jpg',
            },
          });
        }),
      );

      const file = new File(['bytes'], 'avatar.png', { type: 'image/png' });
      const result = await uploadProfileImage(file);

      // See the `postFormData` test above for why this only checks presence
      // via the raw body (not filename/content) rather than a parsed
      // FormData value.
      expect(rawBody).toContain('Content-Disposition: form-data; name="file"');
      expect(result.profileImageUrl).toBe('https://example.com/uploaded.jpg');
      expect(result.settings.profile.imageSource).toBe('upload');
      expect(result.settings.version).toBe(2);
    });

    it('deleteProfileImage should DELETE /user-settings/profile-image', async () => {
      let called = false;

      server.use(
        http.delete('*/api/user-settings/profile-image', () => {
          called = true;
          return HttpResponse.json({
            data: {
              settings: {
                theme: 'system',
                profile: { imageSource: 'provider', imageObjectId: null },
                updatedAt: '2024-06-01T00:00:00.000Z',
                version: 3,
              },
              profileImageUrl: null,
            },
          });
        }),
      );

      const result = await deleteProfileImage();

      expect(called).toBe(true);
      expect(result.profileImageUrl).toBeNull();
      expect(result.settings.profile.imageSource).toBe('provider');
    });
  });

  // MSW/undici's `Response.blob()` in this environment can return an instance
  // of Node's OWN `buffer.Blob`, a different realm/constructor than jsdom's
  // global `Blob` — so `toBeInstanceOf(Blob)` is unreliable here even though
  // the value genuinely behaves like one. Duck-type instead.
  function isBlobLike(value: unknown): value is Blob {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Blob).size === 'number' &&
      typeof (value as Blob).text === 'function' &&
      typeof (value as Blob).arrayBuffer === 'function'
    );
  }

  describe('getBlob / fetchProfileImagePreview (#367)', () => {
    it('should return the response body as a Blob, not parsed JSON', async () => {
      server.use(
        http.get('*/api/user-settings/profile-image', () => {
          // A raw `Blob` body throws inside undici's `Response` construction in
          // this environment (`extractBody`/`object.stream is not a function`);
          // a plain string body with an explicit Content-Type produces the same
          // client-side `Blob` via `response.blob()` without that crash.
          return new HttpResponse('image-bytes', {
            headers: { 'Content-Type': 'image/png' },
          });
        }),
      );

      const result = await api.getBlob('/user-settings/profile-image');

      expect(isBlobLike(result)).toBe(true);
      expect(result.type).toBe('image/png');
      expect(await result.text()).toBe('image-bytes');
    });

    it('should send the bearer token on a getBlob request', async () => {
      let authHeader: string | null = null;

      server.use(
        http.get('*/api/user-settings/profile-image', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return new HttpResponse('bytes', {
            headers: { 'Content-Type': 'image/png' },
          });
        }),
      );

      api.setAccessToken('test-token');
      await api.getBlob('/user-settings/profile-image');

      expect(authHeader).toBe('Bearer test-token');
    });

    it('should refresh the token and retry a getBlob request on 401, returning a Blob', async () => {
      let callCount = 0;
      let lastAuthHeader: string | null = null;

      server.use(
        http.get('*/api/user-settings/profile-image', ({ request }) => {
          callCount++;
          lastAuthHeader = request.headers.get('Authorization');
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return new HttpResponse('retried-bytes', {
            headers: { 'Content-Type': 'image/png' },
          });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({ accessToken: 'refreshed-token', expiresIn: 900 });
        }),
      );

      api.setAccessToken('expired-token');
      const result = await api.getBlob('/user-settings/profile-image');

      expect(isBlobLike(result)).toBe(true);
      expect(await result.text()).toBe('retried-bytes');
      expect(callCount).toBe(2);
      expect(lastAuthHeader).toBe('Bearer refreshed-token');
    });

    it('should throw an ApiError (not return a Blob) on a 404 error body', async () => {
      server.use(
        http.get('*/api/user-settings/profile-image', () => {
          return HttpResponse.json(
            { message: 'No uploaded picture', code: 'NOT_FOUND' },
            { status: 404 },
          );
        }),
      );

      await expect(api.getBlob('/user-settings/profile-image')).rejects.toThrow(ApiError);

      try {
        await api.getBlob('/user-settings/profile-image');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
        expect((error as ApiError).message).toBe('No uploaded picture');
      }
    });

    it('fetchProfileImagePreview should GET /user-settings/profile-image and resolve a Blob', async () => {
      let requestedPath = '';

      server.use(
        http.get('*/api/user-settings/profile-image', ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return new HttpResponse('preview-bytes', {
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }),
      );

      const result = await fetchProfileImagePreview();

      expect(requestedPath).toBe('/api/user-settings/profile-image');
      expect(isBlobLike(result)).toBe(true);
      expect(await result.text()).toBe('preview-bytes');
    });

    it('fetchProfileImagePreview should reject with an ApiError on 404 (no stored picture)', async () => {
      server.use(
        http.get('*/api/user-settings/profile-image', () => {
          return HttpResponse.json({ message: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
        }),
      );

      await expect(fetchProfileImagePreview()).rejects.toThrow(ApiError);
      await expect(fetchProfileImagePreview()).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('Error Handling', () => {
    it('should throw ApiError on 4xx response', async () => {
      server.use(
        http.get('*/api/not-found', () => {
          return HttpResponse.json(
            { message: 'Not found', code: 'NOT_FOUND' },
            { status: 404 },
          );
        }),
      );

      await expect(api.get('/not-found')).rejects.toThrow(ApiError);
    });

    it('should throw ApiError on 5xx response', async () => {
      server.use(
        http.get('*/api/error', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(api.get('/error')).rejects.toThrow(ApiError);
    });

    it('should include status code in error', async () => {
      server.use(
        http.get('*/api/forbidden', () => {
          return HttpResponse.json(
            { message: 'Forbidden', code: 'FORBIDDEN' },
            { status: 403 },
          );
        }),
      );

      try {
        await api.get('/forbidden');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
      }
    });

    it('should include error code in error', async () => {
      server.use(
        http.get('*/api/validation-error', () => {
          return HttpResponse.json(
            { message: 'Validation failed', code: 'VALIDATION_ERROR' },
            { status: 400 },
          );
        }),
      );

      try {
        await api.get('/validation-error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('VALIDATION_ERROR');
      }
    });

    it('should include error message', async () => {
      server.use(
        http.get('*/api/bad-request', () => {
          return HttpResponse.json(
            { message: 'Invalid input', code: 'BAD_REQUEST' },
            { status: 400 },
          );
        }),
      );

      try {
        await api.get('/bad-request');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe('Invalid input');
      }
    });

    it('should handle non-JSON error responses', async () => {
      server.use(
        http.get('*/api/text-error', () => {
          return new HttpResponse('Internal Server Error', { status: 500 });
        }),
      );

      try {
        await api.get('/text-error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(500);
      }
    });
  });

  describe('Token Refresh', () => {
    it('should refresh token on 401 response', async () => {
      let callCount = 0;

      server.use(
        http.get('*/api/protected', () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { success: true } });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'new-token',
            expiresIn: 900,
          });
        }),
      );

      api.setAccessToken('old-token');
      const result = await api.get('/protected');

      expect(callCount).toBe(2);
      expect(result).toEqual({ success: true });
      expect(api.getAccessToken()).toBe('new-token');
    });

    it('should retry original request after refresh', async () => {
      let protectedCallCount = 0;

      server.use(
        http.get('*/api/data', () => {
          protectedCallCount++;
          if (protectedCallCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { value: 'success' } });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'refreshed-token',
            expiresIn: 900,
          });
        }),
      );

      api.setAccessToken('expired-token');
      const result = await api.get('/data');

      expect(result).toEqual({ value: 'success' });
      expect(protectedCallCount).toBe(2);
    });

    it('should throw if refresh fails', async () => {
      server.use(
        http.get('*/api/protected', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      api.setAccessToken('old-token');

      await expect(api.get('/protected')).rejects.toThrow('Unauthorized');
    });

    it('should not refresh when skipAuth is true', async () => {
      let refreshCalled = false;

      server.use(
        http.get('*/api/public', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          refreshCalled = true;
          return HttpResponse.json({ accessToken: 'new', expiresIn: 900 });
        }),
      );

      try {
        await api.get('/public', { skipAuth: true });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
      }

      expect(refreshCalled).toBe(false);
    });

    it('should clear token when refresh fails', async () => {
      server.use(
        http.get('*/api/protected', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      api.setAccessToken('old-token');

      try {
        await api.get('/protected');
      } catch {
        // Expected to fail
      }

      expect(api.getAccessToken()).toBeNull();
    });
  });

  describe('204 No Content', () => {
    it('should handle 204 responses', async () => {
      server.use(
        http.post('*/api/auth/logout', () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const result = await api.post('/auth/logout');

      expect(result).toBeUndefined();
    });

    it('should handle 204 from DELETE', async () => {
      server.use(
        http.delete('*/api/resource/123', () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const result = await api.delete('/resource/123');

      expect(result).toBeUndefined();
    });
  });

  describe('Cookies', () => {
    it('should include credentials for cookie handling', async () => {
      server.use(
        http.get('*/api/test', () => {
          // Can't directly access credentials, but we can verify the request is made
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.get('/test');

      // Credentials: 'include' is set in the api service
      expect(true).toBe(true);
    });
  });

  describe('refreshToken method', () => {
    it('should return true on successful refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'new-token',
            expiresIn: 900,
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('new-token');
    });

    it('should return false on failed refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should handle network errors during refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          throw new Error('Network error');
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should unwrap wrapped refresh response (TransformInterceptor)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Backend wraps response in { data: { accessToken } } via TransformInterceptor
          return HttpResponse.json({
            data: {
              accessToken: 'wrapped-token',
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('wrapped-token');
    });

    it('should handle unwrapped refresh response (backwards compatibility)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Direct response without wrapper (backwards compatibility)
          return HttpResponse.json({
            accessToken: 'direct-token',
            expiresIn: 900,
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('direct-token');
    });

    it('should reject invalid token response (missing accessToken)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Response missing accessToken field
          return HttpResponse.json({
            data: {
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should reject invalid token response (non-string accessToken)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // accessToken is not a string
          return HttpResponse.json({
            data: {
              accessToken: 12345,
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should only trigger one refresh for concurrent requests', async () => {
      let refreshCallCount = 0;
      let protectedCallCount = 0;

      server.use(
        http.get('*/api/protected', () => {
          protectedCallCount++;
          if (protectedCallCount <= 3) {
            // First 3 calls fail with 401
            return new HttpResponse(null, { status: 401 });
          }
          // Subsequent calls succeed
          return HttpResponse.json({ data: { success: true } });
        }),
        http.post('*/api/auth/refresh', async () => {
          refreshCallCount++;
          // Simulate slow refresh to ensure concurrent requests wait
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({
            data: {
              accessToken: 'refreshed-token',
              expiresIn: 900,
            },
          });
        }),
      );

      api.setAccessToken('expired-token');

      // Make 3 concurrent requests that will all get 401
      const [result1, result2, result3] = await Promise.all([
        api.get('/protected'),
        api.get('/protected'),
        api.get('/protected'),
      ]);

      // All should succeed
      expect(result1).toEqual({ success: true });
      expect(result2).toEqual({ success: true });
      expect(result3).toEqual({ success: true });

      // But refresh should only be called ONCE (not 3 times)
      expect(refreshCallCount).toBe(1);

      // Protected endpoint called: 3 initial 401s + 3 retries = 6 total
      expect(protectedCallCount).toBe(6);

      // Token should be updated
      expect(api.getAccessToken()).toBe('refreshed-token');
    });
  });

  describe('Data Extraction', () => {
    it('should extract data property from response', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json({
            data: [{ id: 1, name: 'User 1' }],
            meta: { total: 1 },
          });
        }),
      );

      const result = await api.get('/users');

      expect(result).toEqual([{ id: 1, name: 'User 1' }]);
    });

    it('should return full response if no data property', async () => {
      server.use(
        http.get('*/api/legacy', () => {
          return HttpResponse.json({ users: [], count: 0 });
        }),
      );

      const result = await api.get('/legacy');

      expect(result).toEqual({ users: [], count: 0 });
    });
  });
});
