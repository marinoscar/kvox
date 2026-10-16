/**
 * `useAiTasksConfig` — `GET /api/ai-tasks/config` (issue #477, epic #472; the
 * former AI config hook, moved).
 *
 * Over MSW: the hook is thin, and what matters is what it does with the
 * server's answer. The consumers rely on its field names, and
 * the fail-closed behaviour is the point: no answer is never "keyed".
 */

import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { useAiTasksConfig } from '../../hooks/useAiTasksConfig';
import { mockGraphAiConfig } from '../mocks/graphData';

const API = '*/api';

function serve(data: Record<string, unknown>) {
  server.use(http.get(`${API}/ai-tasks/config`, () => HttpResponse.json({ data })));
}

describe('useAiTasksConfig', () => {
  it('is closed while loading: not keyed, not available, not able to generate', async () => {
    serve(mockGraphAiConfig());
    const { result } = renderHook(() => useAiTasksConfig());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.config).toBeNull();
    expect(result.current.keyConfigured).toBe(false);
    expect(result.current.available).toBe(false);
    expect(result.current.canGenerate).toBe(false);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('exposes the probe once it answers', async () => {
    serve(mockGraphAiConfig({ defaultModel: 'gpt-4.1' }));
    const { result } = renderHook(() => useAiTasksConfig());

    await waitFor(() => expect(result.current.config).not.toBeNull());

    expect(result.current.loadError).toBeNull();
    expect(result.current.keyConfigured).toBe(true);
    expect(result.current.available).toBe(true);
    expect(result.current.canGenerate).toBe(true);
    expect(result.current.config?.graphEnabled).toBe(true);
    expect(result.current.config?.defaultModel).toBe('gpt-4.1');
  });

  it('keeps keyConfigured and available independent: canGenerate needs both', async () => {
    serve(mockGraphAiConfig({ keyConfigured: false }));
    const { result } = renderHook(() => useAiTasksConfig());

    await waitFor(() => expect(result.current.config).not.toBeNull());

    expect(result.current.available).toBe(true);
    expect(result.current.keyConfigured).toBe(false);
    expect(result.current.canGenerate).toBe(false);
  });

  it('names a 403 and clears the config, so a failure is never read as keyed', async () => {
    server.use(
      http.get(`${API}/ai-tasks/config`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useAiTasksConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.config).toBeNull();
    expect(result.current.loadError).toBe('You do not have permission to use AI features');
    expect(result.current.keyConfigured).toBe(false);
  });

  it('clears a stale answer when a refresh fails', async () => {
    serve(mockGraphAiConfig());
    const { result } = renderHook(() => useAiTasksConfig());
    await waitFor(() => expect(result.current.keyConfigured).toBe(true));

    server.use(
      http.get(`${API}/ai-tasks/config`, () =>
        HttpResponse.json({ message: 'Down' }, { status: 500 }),
      ),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.config).toBeNull();
    expect(result.current.keyConfigured).toBe(false);
    expect(result.current.loadError).toBe('Down');
  });

  it('refresh re-reads the answer', async () => {
    serve(mockGraphAiConfig({ keyConfigured: false }));
    const { result } = renderHook(() => useAiTasksConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());
    expect(result.current.keyConfigured).toBe(false);

    serve(mockGraphAiConfig());
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.keyConfigured).toBe(true);
  });

  it('reads nothing while skipped, and drops the answer it held once skipped again (#484)', async () => {
    let requests = 0;
    server.use(
      http.get(`${API}/ai-tasks/config`, () => {
        requests += 1;
        return HttpResponse.json({ data: mockGraphAiConfig() });
      }),
    );
    const { result, rerender } = renderHook(({ skip }) => useAiTasksConfig({ skip }), {
      initialProps: { skip: true },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests).toBe(0);
    expect(result.current.config).toBeNull();

    rerender({ skip: false });
    await waitFor(() => expect(result.current.config).not.toBeNull());
    expect(requests).toBe(1);

    rerender({ skip: true });
    await waitFor(() => expect(result.current.config).toBeNull());
    expect(result.current.keyConfigured).toBe(false);
  });
});
