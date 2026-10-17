// =============================================================================
// kvoxFetch helpers: request building over `host.http`
// =============================================================================
//
// A slice's API client calls `kvoxGet(host, '/transcription/config')` instead of
// an app singleton. These functions add what every call needs and a host must
// not have to repeat: the query string, and the normalisation of a rejection
// into `KvoxApiError`.
// =============================================================================

import { toKvoxApiError } from './errors.js';
import type {
  KvoxBlobResponse,
  KvoxHttpMethod,
  KvoxRequestInit,
  KvoxResponseWithMeta,
  KvoxWebHost,
} from './host.js';

/**
 * Per-call options of the `kvox*` helpers: the transport's, without `body`
 * (it is a parameter of the verbs that take one).
 *
 * @stability experimental
 */
export type KvoxCallOptions = Omit<KvoxRequestInit, 'body'>;

/**
 * `path` with `query` appended as a query string. `undefined` and `null`
 * values are skipped, an array repeats its key, everything else is `String()`ed.
 *
 * @param path - A path, with or without a query string already.
 * @param query - The parameters to append.
 * @returns The path with the query string.
 *
 * @stability experimental
 */
export function buildKvoxUrl(path: string, query?: Record<string, unknown>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  if (text === '') return path;
  return path + (path.includes('?') ? '&' : '?') + text;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toKvoxApiError(error);
  }
}

/**
 * A JSON request over the host.
 *
 * @param host - The host.
 * @param method - The HTTP verb.
 * @param path - The path below the API base, for example `/transcription/config`.
 * @param init - Body, query, headers and signal.
 * @returns The response payload.
 * @throws {@link KvoxApiError} when the call fails with a status.
 *
 * @stability experimental
 */
export function kvoxRequest<T>(
  host: KvoxWebHost,
  method: KvoxHttpMethod,
  path: string,
  init?: KvoxRequestInit,
): Promise<T> {
  return guarded(() => host.http.request<T>(method, path, init));
}

/**
 * `GET`.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param options - Query, headers and signal.
 * @returns The response payload.
 *
 * @stability experimental
 */
export function kvoxGet<T>(host: KvoxWebHost, path: string, options?: KvoxCallOptions): Promise<T> {
  return kvoxRequest<T>(host, 'GET', path, options);
}

/**
 * `POST` with a JSON body.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param body - The JSON body.
 * @param options - Query, headers and signal.
 * @returns The response payload.
 *
 * @stability experimental
 */
export function kvoxPost<T>(
  host: KvoxWebHost,
  path: string,
  body?: unknown,
  options?: KvoxCallOptions,
): Promise<T> {
  return kvoxRequest<T>(host, 'POST', path, { ...options, body });
}

/**
 * `PUT` with a JSON body.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param body - The JSON body.
 * @param options - Query, headers (`If-Match`) and signal.
 * @returns The response payload.
 *
 * @stability experimental
 */
export function kvoxPut<T>(
  host: KvoxWebHost,
  path: string,
  body?: unknown,
  options?: KvoxCallOptions,
): Promise<T> {
  return kvoxRequest<T>(host, 'PUT', path, { ...options, body });
}

/**
 * `PATCH` with a JSON body.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param body - The JSON body.
 * @param options - Query, headers and signal.
 * @returns The response payload.
 *
 * @stability experimental
 */
export function kvoxPatch<T>(
  host: KvoxWebHost,
  path: string,
  body?: unknown,
  options?: KvoxCallOptions,
): Promise<T> {
  return kvoxRequest<T>(host, 'PATCH', path, { ...options, body });
}

/**
 * `DELETE`.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param options - Query, headers and signal.
 * @returns The response payload (`undefined` for a 204).
 *
 * @stability experimental
 */
export function kvoxDelete<T = void>(
  host: KvoxWebHost,
  path: string,
  options?: KvoxCallOptions,
): Promise<T> {
  return kvoxRequest<T>(host, 'DELETE', path, options);
}

/**
 * A `multipart/form-data` `POST`.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param body - The form.
 * @param options - Query, headers and signal.
 * @returns The response payload.
 *
 * @stability experimental
 */
export function kvoxPostFormData<T>(
  host: KvoxWebHost,
  path: string,
  body: FormData,
  options?: KvoxCallOptions,
): Promise<T> {
  return guarded(() => host.http.postFormData<T>(path, body, options));
}

/**
 * A binary response (an export, an image): the bytes and the headers.
 *
 * @param host - The host.
 * @param method - `GET` or `POST`.
 * @param path - The path below the API base.
 * @param init - Body (for `POST`), query, headers and signal.
 * @returns The blob and the response headers.
 *
 * @stability experimental
 */
export function kvoxRequestBlob(
  host: KvoxWebHost,
  method: 'GET' | 'POST',
  path: string,
  init?: KvoxRequestInit,
): Promise<KvoxBlobResponse> {
  return guarded(() => host.http.requestBlob(method, path, init));
}

/**
 * `GET` that returns only the bytes.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param options - Query, headers and signal.
 * @returns The blob.
 *
 * @stability experimental
 */
export async function kvoxGetBlob(
  host: KvoxWebHost,
  path: string,
  options?: KvoxCallOptions,
): Promise<Blob> {
  return (await kvoxRequestBlob(host, 'GET', path, options)).blob;
}

/**
 * `GET` with the status and headers, resolving on `304 Not Modified`.
 *
 * @param host - The host.
 * @param path - The path below the API base.
 * @param options - Query, headers (`If-None-Match`) and signal.
 * @returns The status, the headers and the payload (`undefined` on a 304).
 *
 * @stability experimental
 */
export function kvoxGetWithMeta<T>(
  host: KvoxWebHost,
  path: string,
  options?: KvoxCallOptions,
): Promise<KvoxResponseWithMeta<T>> {
  return guarded(() => host.http.requestWithMeta<T>('GET', path, options));
}
