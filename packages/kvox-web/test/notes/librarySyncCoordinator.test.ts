/**
 * `LibrarySyncCoordinator` (#725): one sync per library at a time, shared by the
 * library pages and a host's watcher. Driven with a fake file port and the fake host,
 * with scans held open until the test lets them answer.
 */

import { describe, expect, it, vi } from 'vitest';

import { REF, fakePort, scanAnswer } from './libraryFakes.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import {
  createLibrarySyncCoordinator,
  getLibrarySyncCoordinator,
  isLibrarySyncCancelled,
  syncLibrary,
} from '../../src/notes/headless/index.js';
import type { LibrarySyncProgress, LibrarySyncState } from '../../src/notes/headless/index.js';

/** A host whose scans wait for `release()`; each scan answers with the next batch id. */
function gatedHost(options: { fail?: (scan: number) => boolean } = {}) {
  const gates: Array<() => void> = [];
  let scans = 0;
  const host = createFakeKvoxWebHost({
    routes: {
      'POST /notes/libraries/:id/scan': async (request) => {
        scans += 1;
        const n = scans;
        await new Promise<void>((resolve) => gates.push(resolve));
        if (options.fail?.(n)) throw fakeApiError(500, 'Scan failed');
        return scanAnswer({ batchId: `batch-${request.params.id}-${n}`, upload: ['a.md'] });
      },
      'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
      'POST /notes/import-batches/:id/close': { id: 'x' },
    },
  });
  return {
    host,
    scans: () => scans,
    /** Lets the oldest held scan answer. */
    release: async () => {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
    },
  };
}

const port = () => fakePort({ 'a.md': 'aaaa' });

describe('LibrarySyncCoordinator', () => {
  it('joins concurrent requests for a library to one run', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    const second = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, whenRunning: 'join' });

    expect(first.disposition).toBe('started');
    expect(second.disposition).toBe('joined');
    await release();
    const [a, b] = await Promise.all([first.result, second.result]);
    expect(a).toBe(b);
    expect(scans()).toBe(1);
    await coordinator.idle();
    expect(coordinator.getStates()).toEqual([]);
  });

  it('a request for a library that waits for its turn joins it, whatever whenRunning says', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const other = coordinator.sync({ host, port: p, library: { id: 'other' }, ref: REF });
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    const second = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, whenRunning: 'rerun' });

    expect(second.disposition).toBe('joined');
    expect(coordinator.getStates().find((s) => s.libraryId === 'lib')?.status).toBe('waiting');
    await release();
    await other.result;
    await release();
    expect(await first.result).toBe(await second.result);
    expect(scans()).toBe(2);
  });

  it('queues exactly one rerun for requests made while a run is in flight, and runs it after the first', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const order: string[] = [];
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    await vi.waitFor(() => expect(scans()).toBe(1));
    const second = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    const third = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });

    expect(second.disposition).toBe('queued');
    expect(third.disposition).toBe('queued');
    expect(coordinator.getStates()).toEqual([expect.objectContaining({ libraryId: 'lib', status: 'running', rerunQueued: true })]);
    void first.result.then(() => order.push('first'));
    void second.result.then(() => order.push('rerun'));

    await release();
    const a = await first.result;
    // The rerun starts only once the first run has finished.
    await vi.waitFor(() => expect(scans()).toBe(2));
    await release();
    const [b, c] = await Promise.all([second.result, third.result]);

    expect(a.batchId).toBe('batch-lib-1');
    expect(b.batchId).toBe('batch-lib-2');
    expect(c).toBe(b);
    expect(order).toEqual(['first', 'rerun']);
    await coordinator.idle();
    expect(scans()).toBe(2);
  });

  it('runs one library at a time by default, in request order', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const a = coordinator.sync({ host, port: p, library: { id: 'a' }, ref: REF });
    const b = coordinator.sync({ host, port: p, library: { id: 'b' }, ref: REF });
    await vi.waitFor(() => expect(scans()).toBe(1));
    expect(coordinator.getStates().map((s) => [s.libraryId, s.status]).sort()).toEqual([
      ['a', 'running'],
      ['b', 'waiting'],
    ]);
    await release();
    expect((await a.result).batchId).toBe('batch-a-1');
    await release();
    expect((await b.result).batchId).toBe('batch-b-2');
  });

  it('runs libraries side by side with maxConcurrent', async () => {
    const coordinator = createLibrarySyncCoordinator({ maxConcurrent: 2 });
    const { host, release, scans } = gatedHost();
    const p = port();
    const a = coordinator.sync({ host, port: p, library: { id: 'a' }, ref: REF });
    const b = coordinator.sync({ host, port: p, library: { id: 'b' }, ref: REF });
    await vi.waitFor(() => expect(scans()).toBe(2));
    await release();
    await release();
    await Promise.all([a.result, b.result]);
  });

  it('releases the lock when a run fails, rejecting every attached request, and runs the rerun', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost({ fail: (n) => n === 1 });
    const p = port();
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    const joined = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, whenRunning: 'join' });
    await vi.waitFor(() => expect(scans()).toBe(1));
    const rerun = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });

    await release();
    await expect(first.result).rejects.toMatchObject({ status: 500 });
    await expect(joined.result).rejects.toMatchObject({ status: 500 });
    await release();
    expect((await rerun.result).batchId).toBe('batch-lib-2');

    await coordinator.idle();
    const after = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    expect(after.disposition).toBe('started');
    await release();
    await after.result;
  });

  it('reports progress to every attached request, replays the latest to a joiner, and carries the batch id after the scan', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const seen: LibrarySyncProgress[] = [];
    const joinedSeen: LibrarySyncProgress[] = [];
    const states: LibrarySyncState[][] = [];
    const off = coordinator.subscribe((s) => states.push(s));
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, onProgress: (x) => seen.push(x) });
    await vi.waitFor(() => expect(scans()).toBe(1));
    expect(seen.every((x) => x.batchId === undefined)).toBe(true);
    const joined = coordinator.sync({
      host,
      port: p,
      library: { id: 'lib' },
      ref: REF,
      whenRunning: 'join',
      onProgress: (x) => joinedSeen.push(x),
    });
    // The joiner gets the latest snapshot at once.
    expect(joinedSeen[0]).toBe(seen.at(-1));

    await release();
    await Promise.all([first.result, joined.result]);
    off();

    const afterScan = seen.find((x) => x.batchId !== undefined);
    expect(afterScan).toMatchObject({ phase: 'enumerating', batchId: 'batch-lib-1' });
    expect(seen.filter((x) => x.phase === 'uploading').every((x) => x.batchId === 'batch-lib-1')).toBe(true);
    expect(joinedSeen.at(-1)).toBe(seen.at(-1));
    expect(states.some((s) => s[0]?.progress?.batchId === 'batch-lib-1')).toBe(true);
    expect(states.at(-1)).toEqual([]);
  });

  it('detaches a request whose signal aborts, and stops the run when nobody is left', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const mine = new AbortController();
    const theirs = new AbortController();
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, signal: mine.signal });
    const second = coordinator.sync({
      host,
      port: p,
      library: { id: 'lib' },
      ref: REF,
      whenRunning: 'join',
      signal: theirs.signal,
    });
    await vi.waitFor(() => expect(scans()).toBe(1));

    mine.abort();
    await expect(first.result).rejects.toSatisfy(isLibrarySyncCancelled);
    // The other request still holds the run.
    expect(coordinator.getStates()).toHaveLength(1);
    theirs.abort();
    await expect(second.result).rejects.toSatisfy(isLibrarySyncCancelled);
    await release();
    await coordinator.idle();
    expect(host.callsTo('POST /notes/import-batches/batch-lib-1/files')).toHaveLength(0);
  });

  it('drops a queued rerun whose requests all aborted', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    await vi.waitFor(() => expect(scans()).toBe(1));
    const abort = new AbortController();
    const rerun = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF, signal: abort.signal });
    abort.abort();
    await expect(rerun.result).rejects.toSatisfy(isLibrarySyncCancelled);
    expect(coordinator.getStates()[0]?.rerunQueued).toBe(false);
    await release();
    await first.result;
    await coordinator.idle();
    expect(scans()).toBe(1);
  });

  it('cancel stops the run in flight and drops its rerun', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, release, scans } = gatedHost();
    const p = port();
    const first = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });
    await vi.waitFor(() => expect(scans()).toBe(1));
    const rerun = coordinator.sync({ host, port: p, library: { id: 'lib' }, ref: REF });

    coordinator.cancel('lib');
    await expect(first.result).rejects.toSatisfy(isLibrarySyncCancelled);
    await expect(rerun.result).rejects.toSatisfy(isLibrarySyncCancelled);
    await release();
    await coordinator.idle();
    expect(scans()).toBe(1);
  });

  it('a request with an already aborted signal rejects and leaves nothing behind', async () => {
    const coordinator = createLibrarySyncCoordinator();
    const { host, scans } = gatedHost();
    const ticket = coordinator.sync({ host, port: port(), library: { id: 'lib' }, ref: REF, signal: AbortSignal.abort() });
    await expect(ticket.result).rejects.toBeDefined();
    expect(coordinator.getStates()).toEqual([]);
    expect(scans()).toBe(0);
  });

  it('syncLibrary goes through the shared coordinator', async () => {
    const { host, release } = gatedHost();
    const p = port();
    const first = syncLibrary({ host, port: p, library: { id: 'shared-lib' }, ref: REF });
    const second = getLibrarySyncCoordinator().sync({
      host,
      port: p,
      library: { id: 'shared-lib' },
      ref: REF,
      whenRunning: 'join',
    });
    expect(second.disposition).toBe('joined');
    await release();
    expect(await first.result).toBe(await second.result);
    await getLibrarySyncCoordinator().idle();
  });
});
