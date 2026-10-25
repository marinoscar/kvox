/**
 * `useLibrarySyncRunner` over the coordinator (#725): the page joins a sync a host's
 * watcher already started instead of running a second one, and "Stop" stops it.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { REF, fakePort, scanAnswer } from './libraryFakes.js';
import { renderHook } from './helpers.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import { createLibrarySyncCoordinator, isLibrarySyncCancelled } from '../../src/notes/headless/index.js';
import { useLibrarySyncRunner } from '../../src/notes/ui/index.js';

const LIBRARY = { id: 'lib-1', name: 'Work notes', autoExtract: true };

function heldScanHost() {
  const gates: Array<() => void> = [];
  let scans = 0;
  const host = createFakeKvoxWebHost({
    routes: {
      'POST /notes/libraries/:id/scan': async () => {
        scans += 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        return scanAnswer({ batchId: 'batch-1', upload: ['a.md'] });
      },
      'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
      'POST /notes/import-batches/:id/close': { id: 'batch-1' },
    },
  });
  host.files = fakePort({ 'a.md': 'aaaa' });
  return { host, scans: () => scans, release: () => gates.shift()?.() };
}

describe('useLibrarySyncRunner', () => {
  it('joins the sync a host already runs for the library, sharing its progress and result', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, scans, release } = heldScanHost();
    const watcher = coordinator.sync({ host, port: host.files!, library: { id: LIBRARY.id }, ref: REF, confirm: () => true });
    await waitFor(() => expect(scans()).toBe(1));

    const { result } = renderHook(() => useLibrarySyncRunner({ coordinator }), { host });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.start(LIBRARY, REF);
    });
    await waitFor(() => expect(result.current.runningLibraryId).toBe(LIBRARY.id));
    expect(result.current.progress).not.toBeNull();

    await act(async () => {
      release();
      await pending;
    });
    expect(await pending).toBe(await watcher.result);
    expect(scans()).toBe(1);
    expect(result.current.runningLibraryId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('Stop cancels the library run, whoever started it', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, scans, release } = heldScanHost();
    const watcher = coordinator.sync({ host, port: host.files!, library: { id: LIBRARY.id }, ref: REF, confirm: () => true });
    await waitFor(() => expect(scans()).toBe(1));

    const { result } = renderHook(() => useLibrarySyncRunner({ coordinator }), { host });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.start(LIBRARY, REF);
    });
    await waitFor(() => expect(result.current.runningLibraryId).toBe(LIBRARY.id));
    act(() => result.current.stop());

    await expect(watcher.result).rejects.toSatisfy(isLibrarySyncCancelled);
    await act(async () => {
      expect(await pending).toBeNull();
    });
    release();
    await coordinator.idle();
    expect(result.current.error).toBeNull();
    expect(host.callsTo('POST /notes/import-batches/batch-1/files')).toHaveLength(0);
  });
});
