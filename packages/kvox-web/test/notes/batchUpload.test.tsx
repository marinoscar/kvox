/**
 * Background uploads of an import batch (#814): the engine (concurrency, pause, resume,
 * cancel, retry, closing the batch) and the provider (start returns the batch at once;
 * the hooks; the fallback without a provider).
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import type { FakeRouteRequest } from '../../src/core/testing/index.js';
import {
  BatchUploadProvider,
  createBatchUploadEngine,
  useBatchUpload,
  useBatchUploads,
  useOptionalBatchUploads,
} from '../../src/notes/headless/index.js';
import type { BatchUpload } from '../../src/notes/headless/index.js';
import { render, renderHook } from './helpers.js';

interface Gate {
  path: string;
  release: () => void;
  fail: (error: unknown) => void;
}

/** An upload route whose requests wait until the test lets them go. */
function gatedUploads() {
  const waiting: Gate[] = [];
  const route = (request: FakeRouteRequest) =>
    new Promise((resolve, reject) => {
      const path = String((request.body as FormData).get('path'));
      request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      waiting.push({
        path,
        release: () => resolve({ itemId: `item-${path}`, action: 'new', skipped: false }),
        fail: reject,
      });
    });
  const next = async () => {
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    return waiting.shift()!;
  };
  return { route, waiting, next };
}

const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ file: new File([`# note ${i}`], `n${i}.md`), path: `pack/n${i}.md` }));

describe('createBatchUploadEngine', () => {
  it('uploads with the given concurrency, then closes the batch', async () => {
    const gates = gatedUploads();
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches/:id/files': gates.route,
        'POST /notes/import-batches/:id/close': { id: 'b1', status: 'running' },
      },
    });
    const snapshots: BatchUpload[] = [];
    const engine = createBatchUploadEngine({
      host,
      batchId: 'b1',
      entries: files(5),
      concurrency: 2,
      onChange: (s) => snapshots.push(s),
    });
    const done = engine.run();

    await waitFor(() => expect(gates.waiting).toHaveLength(2));
    expect(engine.snapshot().counts).toMatchObject({ uploading: 2, queued: 3 });
    for (let i = 0; i < 5; i += 1) (await gates.next()).release();
    await done;

    const last = engine.snapshot();
    expect(last.status).toBe('done');
    expect(last.counts.uploaded).toBe(5);
    expect(last.files[0]).toMatchObject({ path: 'pack/n0.md', state: 'uploaded', itemId: 'item-pack/n0.md' });
    await waitFor(() => expect(host.callsTo('POST /notes/import-batches/b1/close')).toHaveLength(1));
    expect(snapshots.length).toBeGreaterThan(5);
  });

  it('pauses (in-flight files finish, no new one starts) and resumes', async () => {
    const gates = gatedUploads();
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches/:id/files': gates.route,
        'POST /notes/import-batches/:id/close': {},
      },
    });
    const engine = createBatchUploadEngine({ host, batchId: 'b1', entries: files(3), concurrency: 1 });
    const done = engine.run();
    const first = await gates.next();
    engine.pause();
    first.release();
    await waitFor(() => expect(engine.snapshot().counts.uploaded).toBe(1));
    expect(engine.snapshot()).toMatchObject({ status: 'paused', counts: { queued: 2, uploading: 0 } });
    expect(gates.waiting).toHaveLength(0);

    engine.resume();
    (await gates.next()).release();
    (await gates.next()).release();
    await done;
    expect(engine.snapshot()).toMatchObject({ status: 'done', counts: { uploaded: 3 } });
  });

  it('cancels: aborts in flight, leaves the rest unsent, closes the batch', async () => {
    const gates = gatedUploads();
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches/:id/files': gates.route,
        'POST /notes/import-batches/:id/close': {},
      },
    });
    const engine = createBatchUploadEngine({ host, batchId: 'b1', entries: files(4), concurrency: 2 });
    const done = engine.run();
    await waitFor(() => expect(gates.waiting).toHaveLength(2));
    await engine.cancel();
    await done;
    await waitFor(() => expect(engine.snapshot().counts.cancelled).toBe(4));
    expect(engine.snapshot().status).toBe('cancelled');
    expect(host.callsTo('POST /notes/import-batches/b1/close')).toHaveLength(1);
    await engine.retry();
    expect(engine.snapshot().status).toBe('cancelled');
  });

  it('keeps a failed upload with its message, and retries it', async () => {
    let attempts = 0;
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches/:id/files': () => {
          attempts += 1;
          if (attempts === 1) throw fakeApiError(413, 'Payload Too Large');
          return { itemId: 'i', action: 'new', skipped: false };
        },
        'POST /notes/import-batches/:id/close': {},
      },
    });
    const engine = createBatchUploadEngine({ host, batchId: 'b1', entries: files(1) });
    await engine.run();
    expect(engine.snapshot().files[0]).toMatchObject({ state: 'failed', reason: 'too_large' });
    expect(engine.snapshot().files[0]!.message).toBeTruthy();

    await engine.retry(['pack/n0.md']);
    expect(engine.snapshot()).toMatchObject({ status: 'done', counts: { uploaded: 1, failed: 0 } });
  });
});

describe('BatchUploadProvider', () => {
  it('opens the batch, answers its id at once, and exposes the upload by batch', async () => {
    const gates = gatedUploads();
    const routes = {
      'POST /notes/import-batches': { batchId: 'bg-1' },
      'POST /notes/import-batches/:id/files': gates.route,
      'POST /notes/import-batches/:id/close': {},
    };
    const result: { current: { all: ReturnType<typeof useBatchUploads>; one: ReturnType<typeof useBatchUpload> } } = {
      current: null as never,
    };
    function Probe() {
      result.current = { all: useBatchUploads(), one: useBatchUpload('bg-1') };
      return null;
    }
    render(
      <BatchUploadProvider>
        <Probe />
      </BatchUploadProvider>,
      { hostOptions: { routes: routes as never } },
    );

    let batchId = '';
    await act(async () => {
      batchId = await result.current.all.start(files(2));
    });
    expect(batchId).toBe('bg-1');
    await waitFor(() => expect(result.current.one?.upload.counts.uploading).toBe(2));

    act(() => result.current.one!.pause());
    expect(result.current.one!.upload.status).toBe('paused');
    // While anything is pending, leaving the page asks first.
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await act(async () => {
      (await gates.next()).release();
      (await gates.next()).release();
    });
    await waitFor(() => expect(result.current.one!.upload.status).toBe('done'));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('is optional: the hooks answer null without it', () => {
    const { result } = renderHook(() => ({ optional: useOptionalBatchUploads(), one: useBatchUpload('x') }));
    expect(result.current).toEqual({ optional: null, one: null });
  });
});
