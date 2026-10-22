import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { GRAPH_NOT_FOUND_MESSAGE } from '../../src/graph/headless/hooks/graphHookUtils.js';
import { useGraphActivity } from '../../src/graph/headless/hooks/useGraphActivity.js';
import { renderHook } from './helpers.js';
import { HttpResponse, http, server } from './msw-compat.js';

/** `useGraphActivity` (GIC-15): the debounced read behind the TimeBar. */

const ids = Array.from({ length: 305 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
let seen: URL[];

beforeEach(() => {
  seen = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/graph/activity')) seen.push(url);
  });
});

describe('useGraphActivity', () => {
  it('asks once for the sorted, de-duplicated ids (at most 300) and returns the answer', async () => {
    server.use(
      http.get('*/api/graph/activity', () =>
        HttpResponse.json({
          data: { bucket: 'month', series: [{ start: '2026-01-01', total: 1, byType: { Person: 1 } }], byEntity: {} },
        }),
      ),
    );
    const { result } = renderHook(() => useGraphActivity([...ids].reverse().concat(ids[0]), 'month'));
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data?.series).toHaveLength(1));
    expect(result.current.isLoading).toBe(false);
    expect(seen).toHaveLength(1);
    const asked = seen[0].searchParams.get('ids')!.split(',');
    expect(asked).toHaveLength(300);
    expect(asked).toEqual([...asked].sort());
  });

  it('does nothing without ids', async () => {
    const { result } = renderHook(() => useGraphActivity([], 'month'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(seen).toHaveLength(0);
    expect(result.current).toEqual({ data: null, isLoading: false, error: null });
  });

  it('refetches for another bucket and keeps the previous answer while it loads', async () => {
    server.use(
      http.get('*/api/graph/activity', ({ request }) => {
        const bucket = new URL(request.url).searchParams.get('bucket');
        return HttpResponse.json({
          data: { bucket, series: [{ start: '2026-01-01', total: bucket === 'week' ? 5 : 1, byType: {} }], byEntity: {} },
        });
      }),
    );
    const { result, rerender } = renderHook(({ bucket }) => useGraphActivity([ids[0]], bucket), {
      initialProps: { bucket: 'month' as 'month' | 'week' },
    });
    await waitFor(() => expect(result.current.data?.bucket).toBe('month'));
    rerender({ bucket: 'week' });
    expect(result.current.data?.bucket).toBe('month');
    await waitFor(() => expect(result.current.data?.bucket).toBe('week'));
  });

  it('reports a 404 as the not-found sentence and keeps the last data', async () => {
    server.use(http.get('*/api/graph/activity', () => HttpResponse.json({ message: 'nope' }, { status: 404 })));
    const { result } = renderHook(() => useGraphActivity([ids[0]], 'month'));
    await waitFor(() => expect(result.current.error).toBe(GRAPH_NOT_FOUND_MESSAGE));
    expect(result.current.isLoading).toBe(false);
  });
});
