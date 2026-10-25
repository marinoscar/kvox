/**
 * One sync per library at a time (issue #725, epic #708): the lock the library pages
 * ("Sync now", "Add folder") and a host's watcher (KVox Desktop) share, so they never
 * sync the same library at once.
 *
 * Every request goes through a {@link LibrarySyncCoordinator}, keyed by library id:
 *
 *   no sync of the library     the request starts a run (it waits for its turn when
 *                              `maxConcurrent` runs are already going, default one)
 *   a run waiting for its turn the request joins it
 *   a run in flight            `whenRunning: 'rerun'` (default) queues exactly one run
 *                              after it, which every later request joins (a change seen
 *                              during a sync is not lost); `whenRunning: 'join'` joins
 *                              the run in flight and gets its result
 *
 * A run is `runLibrarySync` with the options of the request that created it; a request
 * that joins only adds its `onProgress` (replayed the latest snapshot at once) and its
 * `signal`. Aborting a request's signal detaches that request (its promise rejects with
 * the reason); the run itself stops only when every request attached to it has
 * detached, or on {@link LibrarySyncCoordinator.cancel}. A run that throws rejects
 * every attached request and releases the library like one that succeeds.
 *
 * The lock is per JavaScript realm (one tab, or one Desktop renderer): two browser tabs
 * do not share it. `getLibrarySyncCoordinator()` is the realm's shared instance.
 */

import { runLibrarySync } from './librarySync.js';
import type { LibrarySyncProgress, LibrarySyncResult, RunLibrarySyncOptions } from './librarySync.js';

// =============================================================================
// Shapes
// =============================================================================

/**
 * What a request does when a sync of its library is already in flight: `rerun` queues
 * one more run after it (coalesced with every other such request), `join` takes the
 * in-flight run's result.
 *
 * @stability experimental
 */
export type LibrarySyncWhenRunning = 'join' | 'rerun';

/**
 * How a request was placed: `started` a new run (it may still wait for its turn behind
 * another library), `joined` a run of the same library already in flight or waiting,
 * `queued` the one rerun after the run in flight (new, or shared with earlier requests).
 *
 * @stability experimental
 */
export type LibrarySyncDisposition = 'started' | 'joined' | 'queued';

/**
 * Arguments of {@link LibrarySyncCoordinator.sync}: those of `runLibrarySync`, plus
 * what to do when the library is already syncing.
 *
 * Only the request that creates a run sets its options (`host`, `port`, `ref`,
 * `confirm`, `sequential`, `concurrency`); a request that joins contributes its
 * `onProgress` and `signal` only.
 *
 * @stability experimental
 */
export interface SyncLibraryOptions extends RunLibrarySyncOptions {
  /** When the library is syncing right now. Default `rerun`. */
  whenRunning?: LibrarySyncWhenRunning;
}

/**
 * The answer to one request.
 *
 * @stability experimental
 */
export interface LibrarySyncTicket {
  /** The library. */
  libraryId: string;
  /** How the request was placed. */
  disposition: LibrarySyncDisposition;
  /**
   * The result of the run the request is attached to. Rejects with the run's error,
   * or with the request's own `signal` reason when it detached.
   */
  result: Promise<LibrarySyncResult>;
}

/**
 * One library the coordinator holds a run for.
 *
 * @stability experimental
 */
export interface LibrarySyncState {
  /** The library. */
  libraryId: string;
  /** `running`, or `waiting` for its turn behind another library. */
  status: 'waiting' | 'running';
  /** The latest progress of the run (`null` until it reports). */
  progress: LibrarySyncProgress | null;
  /** A rerun is queued after the run in flight. */
  rerunQueued: boolean;
}

/**
 * Options of {@link createLibrarySyncCoordinator}.
 *
 * @stability experimental
 */
export interface LibrarySyncCoordinatorOptions {
  /**
   * How many libraries sync at once; the others wait in request order. Default 1
   * (one database writer on Desktop, one progress for a page to draw).
   */
  maxConcurrent?: number;
}

/**
 * The per-library sync lock. See the file header.
 *
 * @stability experimental
 */
export interface LibrarySyncCoordinator {
  /**
   * Asks for a sync of `options.library`.
   *
   * @param options - The sync, and `whenRunning`.
   * @returns How the request was placed and the result it will get.
   */
  sync(options: SyncLibraryOptions): LibrarySyncTicket;
  /**
   * Stops the library's run (in flight or waiting) and drops its queued rerun; every
   * attached request rejects with `reason` (default an `AbortError`).
   *
   * @param libraryId - The library.
   * @param reason - The rejection reason.
   */
  cancel(libraryId: string, reason?: unknown): void;
  /**
   * The libraries with a run, in no particular order.
   *
   * @returns One state per library that is running or waiting.
   */
  getStates(): LibrarySyncState[];
  /**
   * Calls `listener` with {@link LibrarySyncCoordinator.getStates} after every change
   * (a run placed, started, reporting progress, or finished).
   *
   * @param listener - The listener.
   * @returns Unsubscribes.
   */
  subscribe(listener: (states: LibrarySyncState[]) => void): () => void;
  /**
   * Resolves once nothing is running or waiting.
   *
   * @returns A promise that resolves when the coordinator is idle.
   */
  idle(): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

interface Participant {
  onProgress: ((progress: LibrarySyncProgress) => void) | undefined;
  resolve: (result: LibrarySyncResult) => void;
  reject: (error: unknown) => void;
  unlisten: () => void;
  settled: boolean;
}

interface Run {
  libraryId: string;
  options: RunLibrarySyncOptions;
  status: 'waiting' | 'running';
  participants: Set<Participant>;
  controller: AbortController;
  progress: LibrarySyncProgress | null;
}

interface Slot {
  /** The run in flight, or waiting for its turn. */
  active: Run;
  /** The one run queued after `active` while it is in flight. */
  rerun: Run | null;
}

function cancelledError(): DOMException {
  return new DOMException('The library sync was cancelled.', 'AbortError');
}

/**
 * Whether a sync rejected because it was stopped (an aborted signal, or
 * {@link LibrarySyncCoordinator.cancel}) rather than because it failed.
 *
 * @param error - What the sync rejected with.
 * @returns `true` for an `AbortError`.
 *
 * @stability experimental
 */
export function isLibrarySyncCancelled(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * Creates a {@link LibrarySyncCoordinator}. A host normally uses the shared one,
 * {@link getLibrarySyncCoordinator}; a test creates its own.
 *
 * @param options - `maxConcurrent`.
 * @returns A new coordinator with nothing running.
 *
 * @stability experimental
 */
export function createLibrarySyncCoordinator(options: LibrarySyncCoordinatorOptions = {}): LibrarySyncCoordinator {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
  const slots = new Map<string, Slot>();
  const waiting: Run[] = [];
  const listeners = new Set<(states: LibrarySyncState[]) => void>();
  let idleWaiters: Array<() => void> = [];
  let running = 0;

  const getStates = (): LibrarySyncState[] =>
    [...slots.values()].map((slot) => ({
      libraryId: slot.active.libraryId,
      status: slot.active.status,
      progress: slot.active.progress,
      rerunQueued: slot.rerun !== null,
    }));

  const emit = () => {
    if (listeners.size > 0) {
      const states = getStates();
      for (const listener of [...listeners]) {
        try {
          listener(states);
        } catch {
          // A listener's failure is its own.
        }
      }
    }
    if (slots.size === 0 && idleWaiters.length > 0) {
      const done = idleWaiters;
      idleWaiters = [];
      for (const resolve of done) resolve();
    }
  };

  const newRun = (libraryId: string, request: SyncLibraryOptions): Run => {
    // The run's own signal and progress replace the request's.
    const { whenRunning: _whenRunning, signal: _signal, onProgress: _onProgress, ...rest } = request;
    return {
      libraryId,
      options: rest,
      status: 'waiting',
      participants: new Set(),
      controller: new AbortController(),
      progress: null,
    };
  };

  const settle = (participant: Participant, outcome: { result: LibrarySyncResult } | { error: unknown }) => {
    if (participant.settled) return;
    participant.settled = true;
    participant.unlisten();
    if ('result' in outcome) participant.resolve(outcome.result);
    else participant.reject(outcome.error);
  };

  /** Removes a run nobody started yet from the slot and the waiting line. */
  const drop = (run: Run) => {
    const slot = slots.get(run.libraryId);
    if (slot?.rerun === run) slot.rerun = null;
    else if (slot?.active === run) slots.delete(run.libraryId);
    const at = waiting.indexOf(run);
    if (at >= 0) waiting.splice(at, 1);
  };

  const detach = (run: Run, participant: Participant, reason: unknown) => {
    if (participant.settled) return;
    run.participants.delete(participant);
    settle(participant, { error: reason });
    if (run.participants.size > 0) return;
    if (run.status === 'running') run.controller.abort(reason);
    else drop(run);
    emit();
  };

  const finish = (run: Run, outcome: { result: LibrarySyncResult } | { error: unknown }) => {
    running -= 1;
    for (const participant of [...run.participants]) settle(participant, outcome);
    run.participants.clear();
    const slot = slots.get(run.libraryId);
    if (slot?.active === run) {
      if (slot.rerun) {
        slot.active = slot.rerun;
        slot.rerun = null;
        waiting.push(slot.active);
      } else {
        slots.delete(run.libraryId);
      }
    }
    pump();
    emit();
  };

  const start = (run: Run) => {
    run.status = 'running';
    running += 1;
    let sync: Promise<LibrarySyncResult>;
    try {
      sync = runLibrarySync({
        ...run.options,
        signal: run.controller.signal,
        onProgress: (progress) => {
          run.progress = progress;
          for (const participant of [...run.participants]) {
            try {
              participant.onProgress?.(progress);
            } catch {
              // A listener's failure is its own.
            }
          }
          emit();
        },
      });
    } catch (error) {
      sync = Promise.reject(error);
    }
    void sync.then(
      (result) => finish(run, { result }),
      (error: unknown) => finish(run, { error }),
    );
  };

  const pump = () => {
    while (running < maxConcurrent && waiting.length > 0) start(waiting.shift()!);
  };

  const attach = (run: Run, request: SyncLibraryOptions): Promise<LibrarySyncResult> =>
    new Promise<LibrarySyncResult>((resolve, reject) => {
      const { signal, onProgress } = request;
      const participant: Participant = { onProgress, resolve, reject, unlisten: () => undefined, settled: false };
      run.participants.add(participant);
      if (signal) {
        const onAbort = () => detach(run, participant, signal.reason ?? cancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
        participant.unlisten = () => signal.removeEventListener('abort', onAbort);
      }
      if (run.progress && onProgress) {
        try {
          onProgress(run.progress);
        } catch {
          // A listener's failure is its own.
        }
      }
    });

  return {
    sync(request) {
      const libraryId = request.library.id;
      const slot = slots.get(libraryId);
      let run: Run;
      let disposition: LibrarySyncDisposition;
      if (!slot) {
        run = newRun(libraryId, request);
        slots.set(libraryId, { active: run, rerun: null });
        waiting.push(run);
        disposition = 'started';
      } else if (slot.active.status === 'waiting' || request.whenRunning === 'join') {
        run = slot.active;
        disposition = 'joined';
      } else {
        slot.rerun ??= newRun(libraryId, request);
        run = slot.rerun;
        disposition = 'queued';
      }
      const result = attach(run, request);
      if (request.signal?.aborted) {
        const participant = [...run.participants].at(-1);
        if (participant) detach(run, participant, request.signal.reason ?? cancelledError());
      }
      pump();
      emit();
      return { libraryId, disposition, result };
    },

    cancel(libraryId, reason = cancelledError()) {
      const slot = slots.get(libraryId);
      if (!slot) return;
      const rejectAll = (run: Run) => {
        for (const participant of [...run.participants]) settle(participant, { error: reason });
        run.participants.clear();
      };
      if (slot.rerun) {
        rejectAll(slot.rerun);
        slot.rerun = null;
      }
      const active = slot.active;
      rejectAll(active);
      if (active.status === 'running') active.controller.abort(reason);
      else drop(active);
      emit();
    },

    getStates,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    idle() {
      if (slots.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

let shared: LibrarySyncCoordinator | null = null;

/**
 * The realm's shared {@link LibrarySyncCoordinator} (one sync at a time): the one the
 * packaged library pages use, and the one a host's watcher must use too so the two
 * never sync the same library at once.
 *
 * @returns The shared coordinator, created on first use.
 *
 * @stability experimental
 */
export function getLibrarySyncCoordinator(): LibrarySyncCoordinator {
  shared ??= createLibrarySyncCoordinator();
  return shared;
}

/**
 * Asks the shared coordinator for a sync: `getLibrarySyncCoordinator().sync(options)`.
 *
 * @param options - The sync, and `whenRunning` (default `rerun`).
 * @returns How the request was placed and the result it will get.
 *
 * @stability experimental
 */
export function syncLibrary(options: SyncLibraryOptions): LibrarySyncTicket {
  return getLibrarySyncCoordinator().sync(options);
}
