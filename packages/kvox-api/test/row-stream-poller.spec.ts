import { firstValueFrom, toArray } from 'rxjs';

import { KvoxRowStreamPoller, type KvoxRowStreamHandlers, type KvoxStreamMessage } from '../src/core/index.js';

// =============================================================================
// KvoxRowStreamPoller (issue #497, epic #491)
// =============================================================================
//
// The loop the note and Ask streams share, tested on its own with a scripted row: the opening
// comment, a settled row closing the stream after its frames, a vanished row, the duration cap on
// an injected clock, a transient read failure that must not end the stream, and the client leaving.
// The two services' own specs prove the frames they build on top of it.
// =============================================================================

type Row = { n: number; settled?: boolean };

const frame = (n: number): KvoxStreamMessage => ({ type: 'tick', id: String(n), data: { n } });

function poller(over: { durationCapMs?: number; now?: () => number } = {}): KvoxRowStreamPoller {
  return new KvoxRowStreamPoller({ pollIntervalMs: 1, heartbeatMs: 10_000, durationCapMs: 10_000, ...over });
}

function handlers(rows: Array<Row | null | Error>, extra: Partial<KvoxRowStreamHandlers<Row>> = {}): KvoxRowStreamHandlers<Row> & { closed: string[] } {
  let index = 0;
  const closed: string[] = [];

  return {
    closed,
    read: async () => {
      const value = rows[Math.min(index, rows.length - 1)];
      index += 1;
      if (value instanceof Error) throw value;

      return value;
    },
    onRow: (row, emit) => {
      emit(frame(row.n));

      return row.settled ? 'settled' : null;
    },
    onGone: (emit) => emit({ type: 'error', data: { gone: true } }),
    onCap: (emit) => emit({ type: 'error', data: { cap: true } }),
    onClose: (reason) => closed.push(reason),
    ...extra,
  };
}

describe('KvoxRowStreamPoller', () => {
  it('opens with a comment, emits each row\'s frames in order and completes after the settled row\'s own frames', async () => {
    const h = handlers([{ n: 1 }, { n: 2 }, { n: 3, settled: true }]);
    const out = await firstValueFrom(poller().stream<Row>(h).pipe(toArray()));

    expect(out).toEqual([{ comment: 'connected' }, frame(1), frame(2), frame(3)]);
    expect(h.closed).toEqual(['settled']);
  });

  it('answers a row that is gone with the gone frame and completes', async () => {
    const h = handlers([null]);
    const out = await firstValueFrom(poller().stream<Row>(h).pipe(toArray()));

    expect(out).toEqual([{ comment: 'connected' }, { type: 'error', data: { gone: true } }]);
    expect(h.closed).toEqual(['gone']);
  });

  it('closes with the cap frame once the injected clock passes the duration cap', async () => {
    let now = 0;
    const h = handlers([{ n: 1 }], {
      onRow: (row, emit) => {
        emit(frame(row.n));
        now += 6_000;

        return null;
      },
    });
    const out = await firstValueFrom(poller({ durationCapMs: 10_000, now: () => now }).stream<Row>(h).pipe(toArray()));

    expect(out.at(-1)).toEqual({ type: 'error', data: { cap: true } });
    expect(h.closed).toEqual(['cap']);
  });

  it('survives a transient read failure and reports it', async () => {
    const onReadError = jest.fn();
    const h = handlers([new Error('blip'), { n: 1, settled: true }], { onReadError });
    const out = await firstValueFrom(poller().stream<Row>(h).pipe(toArray()));

    expect(out).toEqual([{ comment: 'connected' }, frame(1)]);
    expect(onReadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'blip' }));
  });

  it('allocates nothing until subscribed, and stops polling when the client unsubscribes', async () => {
    const read = jest.fn(async () => ({ n: 1 }) as Row);
    const h = handlers([{ n: 1 }], { read });
    const stream = poller().stream<Row>(h);

    expect(read).not.toHaveBeenCalled();

    const subscription = stream.subscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.unsubscribe();
    const calls = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBe(calls);
    expect(h.closed).toEqual(['client']);
  });
});
