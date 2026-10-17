/**
 * This app's binding of the domain web host (issue #499, epic #498).
 *
 * `@marinoscar/kvox-web` slices (core, transcription, and the domain slices that
 * follow) read their transport, the viewer, the links and the deployment
 * switches from ONE `KvoxWebHost`. This file is that host for the web edition.
 * It is the only place the domain UI meets the platform:
 *
 *   - `http`: the app's single `api` client (`services/api.ts`), so the bearer
 *     token, the one-shot 401 -> refresh -> retry, the cross-page refresh lock
 *     and the maintenance recogniser are the ones every other call uses. There is
 *     NO second token store. A failure reaches a slice as the platform's
 *     `ApiError`, which the core helpers normalise into `KvoxApiError`.
 *   - `sse`: the core's fetch-based single attempt (`createFetchSseConnect`) over
 *     the same token and the same refresh; `post` is the platform's `postSse`
 *     already wired in `platform/platformHost.tsx`.
 *   - `upload`: left out. The upload engine sends parts with `XMLHttpRequest`,
 *     the one browser transport that reports byte-level progress.
 *   - `viewer`: the signed-in user of the identity slice and `usePermissions`'s
 *     permission set, the same one every route guard reads.
 *   - `links`: this app's routes.
 *   - `features`: the connected-knowledge switch (`AppGraphFeatureProvider`).
 *
 * Mount `AppKvoxHostProvider` once, inside the identity providers, the graph
 * feature provider and the platform host, above the router outlet.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '@marinoscar/platform-web/core';
import type {
  PlatformHttpBlobWithHeaders,
  PlatformHttpRequestOptions,
} from '@marinoscar/platform-web/core';
import { useAuth, usePermissions } from '@marinoscar/platform-web/identity/headless';
import {
  KvoxWebHostProvider,
  buildKvoxUrl,
  createFetchSseConnect,
  type KvoxFeatures,
  type KvoxHttpMethod,
  type KvoxHttpPort,
  type KvoxLinks,
  type KvoxRequestInit,
  type KvoxResponseWithMeta,
  type KvoxViewer,
  type KvoxWebHost,
} from '@marinoscar/kvox-web/core/headless';
import { API_BASE_URL, api } from '../services/api';
import { appPostSse } from '../platform/platformHost';
import { useGraphFeature } from '../platform/GraphFeatureBinding';

/** The `api` client's per-request options for a slice's `init`. */
function optionsOf(init: KvoxRequestInit | undefined): PlatformHttpRequestOptions {
  return {
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
  };
}

function bearer(): string | null {
  const token = api.getAccessToken();
  return token ? `Bearer ${token}` : null;
}

/**
 * A conditional GET: the status and headers come back with the body, and a 304
 * resolves instead of throwing. `PlatformHttpClient.request` is private and
 * buffers a JSON body, so this is one `fetch` that borrows the client's token
 * and its refresh (never a second implementation of either) — the same shape the
 * transcripts poll has always used.
 */
async function requestWithMeta<T>(
  path: string,
  init: KvoxRequestInit | undefined,
): Promise<KvoxResponseWithMeta<T>> {
  const url = `${API_BASE_URL}${buildKvoxUrl(path, init?.query)}`;
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { ...init?.headers };
    const auth = bearer();
    if (auth) headers.Authorization = auth;
    return fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
  };

  let response = await send();
  // The 401 path is delegated, never reimplemented: the client dedupes
  // concurrent refreshes behind one promise, and a second implementation here
  // would race it and burn the rotating refresh token.
  if (response.status === 401) {
    const refreshed = await api.refreshToken();
    if (!refreshed) throw new ApiError('Unauthorized', 401);
    response = await send();
  }

  if (response.status === 304) {
    return { status: 304, headers: response.headers, data: undefined };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      details?: unknown;
    };
    throw new ApiError(body.message || 'Request failed', response.status, body.code, body.details);
  }
  if (response.status === 204) return { status: 204, headers: response.headers, data: undefined };
  const json = (await response.json()) as { data?: T };
  return { status: response.status, headers: response.headers, data: (json.data ?? json) as T };
}

/**
 * The HTTP port over the app's `api` client. Built ONCE, at module scope.
 */
export const appKvoxHttp: KvoxHttpPort = {
  request<T>(method: KvoxHttpMethod, path: string, init?: KvoxRequestInit): Promise<T> {
    const url = buildKvoxUrl(path, init?.query);
    const options = optionsOf(init);
    switch (method) {
      case 'GET':
        return api.get<T>(url, options);
      case 'POST':
        return api.post<T>(url, init?.body, options);
      case 'PUT':
        return api.put<T>(url, init?.body, options);
      case 'PATCH':
        return api.patch<T>(url, init?.body, options);
      case 'DELETE':
        return api.delete<T>(url, options);
    }
  },
  requestBlob(method, path, init) {
    const url = buildKvoxUrl(path, init?.query);
    const options: PlatformHttpRequestOptions = {
      ...optionsOf(init),
      responseType: 'blobWithHeaders',
    };
    const call =
      method === 'GET'
        ? api.get<PlatformHttpBlobWithHeaders>(url, options)
        : api.post<PlatformHttpBlobWithHeaders>(url, init?.body, options);
    return call;
  },
  postFormData<T>(path: string, body: FormData, init?: KvoxRequestInit): Promise<T> {
    return api.postFormData<T>(buildKvoxUrl(path, init?.query), body, optionsOf(init));
  },
  requestWithMeta: (_method, path, init) => requestWithMeta(path, init),
};

const kvoxSse: KvoxWebHost['sse'] = {
  connect: createFetchSseConnect({
    baseUrl: API_BASE_URL,
    authorization: bearer,
    reauthenticate: () => api.refreshToken(),
  }),
  post: (path, body, options) =>
    appPostSse(path, body, {
      onFrame: (event, data) => options.onFrame(event, data as never),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
};

const kvoxLinks: KvoxLinks = {
  transcript: (id) => `/transcripts/${id}`,
  note: (id) => `/notes/${id}`,
  entity: (id) => `/graph/entities/${id}`,
  conversation: (id) => `/ask/${id}`,
};

/**
 * This app's {@link KvoxWebHost}, memoised on the signed-in user, their
 * permissions and the connected-knowledge switch. Must run inside the identity
 * providers and `AppGraphFeatureProvider`.
 */
export function useAppKvoxHost(): KvoxWebHost {
  const { user } = useAuth();
  const { permissions } = usePermissions();
  const { graph } = useGraphFeature();
  const userId = user?.id ?? null;

  return useMemo<KvoxWebHost>(() => {
    const viewer: KvoxViewer | null = userId === null ? null : { userId, permissions };
    const features: KvoxFeatures = { graphEnabled: graph };
    return {
      http: appKvoxHttp,
      sse: kvoxSse,
      viewer: () => viewer,
      links: kvoxLinks,
      features: () => features,
    };
  }, [userId, permissions, graph]);
}

/** Mounts the packaged host provider with {@link useAppKvoxHost}. */
export function AppKvoxHostProvider({ children }: { children: ReactNode }) {
  const host = useAppKvoxHost();
  return <KvoxWebHostProvider host={host}>{children}</KvoxWebHostProvider>;
}
