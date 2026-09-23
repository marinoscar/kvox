import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { useNameCheck } from '../../hooks/useNameCheck';

const API_BASE = '*/api';

function latest(status: 'running' | 'ready' | null) {
  return {
    run: status
      ? {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          transcriptId: 't1',
          mode: 'standard',
          status,
          basedOnVersion: 1,
          terms: [],
          providerId: null,
          model: null,
          candidateCount: 0,
          suggestionCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          errorClass: null,
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          startedAt: null,
          completedAt: null,
        }
      : null,
    suggestions: [],
    counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
  };
}

describe('useNameCheck', () => {
  it('polls while the run is running and stops once it is ready', async () => {
    const statuses: Array<'running' | 'ready'> = ['running', 'running', 'ready'];
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/transcripts/:id/name-checks/latest`, () => {
        const status = statuses[Math.min(calls, statuses.length - 1)];
        calls += 1;
        return HttpResponse.json({ data: latest(status) });
      }),
    );

    const { result } = renderHook(() =>
      useNameCheck({ transcriptId: 't1', enabled: true, pollMs: 20 }),
    );

    await waitFor(() => expect(result.current.latest?.run?.status).toBe('ready'));
    expect(result.current.isRunning).toBe(false);
    const settled = calls;
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(calls).toBe(settled);
  });

  it('makes no request when disabled', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/transcripts/:id/name-checks/latest`, () => {
        calls += 1;
        return HttpResponse.json({ data: latest(null) });
      }),
    );

    const { result } = renderHook(() =>
      useNameCheck({ transcriptId: 't1', enabled: false, pollMs: 20 }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));

    expect(calls).toBe(0);
    expect(result.current.latest).toBeNull();
  });
});
