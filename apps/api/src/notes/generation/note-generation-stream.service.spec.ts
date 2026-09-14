import { firstValueFrom, toArray } from 'rxjs';

import type { PrismaService } from '../../prisma/prisma.service';
import { NOTE_GENERATE_MAX_RUNTIME_MS } from '../handlers/note-generate.handler';
import {
  DEFAULT_STREAM_DURATION_CAP_MS,
  NoteGenerationStreamService,
  STREAM_DURATION_CAP_MARGIN_MS,
  type NoteStreamTuning,
} from './note-generation-stream.service';
import type { NoteStreamMessage } from './note-stream';

// =============================================================================
// The reader's own decisions (issue #52, epic #45, docs/specs/notes.md §5.2)
// =============================================================================
//
// `note-stream.spec.ts` next door pins the delta arithmetic; this file pins the
// LOOP — what it emits, in what order, and every one of the four ways it stops.
//
// No fake timers and no wall-clock waits: the intervals are driven down to a
// millisecond through `NOTE_STREAM_TUNING`, and the duration cap runs on an
// INJECTED clock, so the cap test asserts an exact decision rather than racing
// a real one. A polling SSE endpoint is the classic way to leave a timer
// running after a suite finishes; every subscription here terminates, and the
// service's own teardown clears both timers on the way out.
// =============================================================================

/** A `note_generations` row as the poll's `select` returns it. */
interface Row {
  status: string;
  content: string;
  errorClass: string | null;
  errorDetail: string | null;
  note: { currentVersion: number } | null;
}

const row = (overrides: Partial<Row> = {}): Row => ({
  status: 'streaming',
  content: '',
  errorClass: null,
  errorDetail: null,
  note: { currentVersion: 0 },
  ...overrides,
});

/**
 * A Prisma stand-in that answers one scripted row per poll.
 *
 * The last entry REPEATS forever, so a script may end in a non-terminal state
 * and let the duration cap be what stops the stream.
 */
function scripted(rows: (Row | null)[]): {
  prisma: PrismaService;
  calls: () => number;
} {
  let index = 0;

  const findUnique = jest.fn(async () => {
    const value = rows[Math.min(index, rows.length - 1)];

    index += 1;

    return value;
  });

  return {
    prisma: { noteGeneration: { findUnique } } as unknown as PrismaService,
    calls: () => findUnique.mock.calls.length,
  };
}

/** Fast enough that a spec never waits on a real interval. */
const FAST: Partial<NoteStreamTuning> = {
  pollIntervalMs: 1,
  heartbeatIntervalMs: 10_000,
  durationCapMs: 10_000,
};

function service(
  prisma: PrismaService,
  tuning: Partial<NoteStreamTuning> = FAST,
): NoteGenerationStreamService {
  return new NoteGenerationStreamService(prisma, { ...FAST, ...tuning });
}

/** Every message one connection produced, in order, once it closed. */
function collect(
  stream: NoteGenerationStreamService,
  generationId = 'gen-1',
  from = 0,
): Promise<NoteStreamMessage[]> {
  return firstValueFrom(stream.stream(generationId, from).pipe(toArray()));
}

const frames = (messages: NoteStreamMessage[]): NoteStreamMessage[] =>
  messages.filter((message) => message.comment === undefined);

const comments = (messages: NoteStreamMessage[]): string[] =>
  messages
    .filter((message) => message.comment !== undefined)
    .map((message) => message.comment as string);

describe('NoteGenerationStreamService', () => {
  // ==========================================================================
  // The happy path
  // ==========================================================================

  it('emits ordered deltas whose concatenation is the final buffer, then done', async () => {
    const full = '# Weekly sync\n\nWe ship on Friday.\n\n- Ana confirms the date.';

    const { prisma } = scripted([
      row({ content: full.slice(0, 14) }),
      row({ content: full.slice(0, 35) }),
      row({ content: full }),
      row({ status: 'succeeded', content: full, note: { currentVersion: 1 } }),
    ]);

    const messages = await collect(service(prisma));
    const emitted = frames(messages);

    const deltas = emitted
      .filter((message) => message.type === 'delta')
      .map((message) => (message.data as { delta: string }).delta);

    expect(deltas.join('')).toBe(full);

    const done = emitted.at(-1);

    expect(done?.type).toBe('done');
    expect(done?.data).toEqual({
      status: 'succeeded',
      offset: full.length,
      currentVersion: 1,
    });
  });

  it('gives every frame an id equal to the offset it ends at, monotonically', async () => {
    const full = 'abcdefghij';

    const { prisma } = scripted([
      row({ content: 'abc' }),
      row({ content: 'abcdef' }),
      row({ status: 'succeeded', content: full, note: { currentVersion: 2 } }),
    ]);

    const ids = frames(await collect(service(prisma))).map((message) =>
      Number(message.id),
    );

    expect(ids).toEqual([3, 6, 10, 10]);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('flushes the last text written before a settle, in the same poll as done', async () => {
    // The terminal read is ALSO the read that first carries the final text —
    // exactly what happens when the commit lands between two polls. The tail
    // must not be stranded behind the frame that closes the stream.
    const { prisma } = scripted([
      row({ content: 'partial' }),
      row({ status: 'succeeded', content: 'partial and the rest', note: { currentVersion: 1 } }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((message) => message.type)).toEqual(['delta', 'delta', 'done']);
    expect((emitted[1].data as { delta: string }).delta).toBe(' and the rest');
  });

  // ==========================================================================
  // Attaching late, and resuming
  // ==========================================================================

  it('hands a late attach the whole buffer and an immediate done', async () => {
    const full = 'the note, already finished before anyone opened the page';

    const { prisma, calls } = scripted([
      row({ status: 'succeeded', content: full, note: { currentVersion: 4 } }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    // ONE round trip. The first poll is immediate, so a late reader is not made
    // to wait out a poll interval for text that is already durable.
    expect(calls()).toBe(1);
    expect(emitted).toHaveLength(2);
    expect((emitted[0].data as { delta: string }).delta).toBe(full);
    expect(emitted[1].data).toEqual({
      status: 'succeeded',
      offset: full.length,
      currentVersion: 4,
    });
  });

  it('resumes from an offset: no repeated text, no lost text', async () => {
    const full = 'first half of the note. second half of the note.';
    const seen = 'first half of the note.'.length;

    const { prisma } = scripted([
      row({ status: 'succeeded', content: full, note: { currentVersion: 1 } }),
    ]);

    const emitted = frames(await collect(service(prisma), 'gen-1', seen));
    const deltas = emitted
      .filter((message) => message.type === 'delta')
      .map((message) => (message.data as { delta: string }).delta);

    expect(deltas.join('')).toBe(full.slice(seen));
    expect(deltas.join('')).not.toContain('first half');
  });

  it('replays nothing to a client that is already caught up', async () => {
    const full = 'every byte of this was already delivered';

    const { prisma } = scripted([
      row({ status: 'succeeded', content: full, note: { currentVersion: 1 } }),
    ]);

    const emitted = frames(await collect(service(prisma), 'gen-1', full.length));

    expect(emitted.map((message) => message.type)).toEqual(['done']);
  });

  it('names currentVersion null for a preview, which has no note', async () => {
    const { prisma } = scripted([
      row({ status: 'succeeded', content: 'a preview body', note: null }),
    ]);

    const done = frames(await collect(service(prisma))).at(-1);

    expect(done?.data).toMatchObject({ status: 'succeeded', currentVersion: null });
  });

  // ==========================================================================
  // Termination
  // ==========================================================================

  it('emits error carrying the recorded class and reason, then closes', async () => {
    const { prisma } = scripted([
      row({ content: 'half a sentence' }),
      row({
        status: 'failed',
        content: 'half a sentence',
        errorClass: 'auth',
        errorDetail: 'Your OpenAI key was rejected.',
      }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    // `error` is terminal on its own — there is no `done` after it.
    expect(emitted.map((message) => message.type)).toEqual(['delta', 'error']);
    expect(emitted[1].data).toEqual({
      status: 'failed',
      offset: 'half a sentence'.length,
      errorClass: 'auth',
      reason: 'Your OpenAI key was rejected.',
    });
  });

  it('maps an unrecognised stored error class to other', async () => {
    const { prisma } = scripted([
      row({ status: 'failed', errorClass: 'something-a-later-build-added', errorDetail: 'x' }),
    ]);

    const error = frames(await collect(service(prisma))).at(-1);

    expect(error?.data).toMatchObject({ errorClass: 'other' });
  });

  it('closes with gone when the row disappears mid-connection', async () => {
    const { prisma } = scripted([row({ content: 'some text' }), null]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((message) => message.type)).toEqual(['delta', 'error']);
    expect(emitted[1].data).toMatchObject({ errorClass: 'gone', status: 'failed' });
  });

  it('closes a job that never settles on the duration cap', async () => {
    // An INJECTED clock, so this asserts the decision rather than racing a real
    // timer: every read advances it, and the cap is crossed on the third.
    let clock = 0;

    const findUnique = jest.fn(async () => {
      clock += 400;

      return row({ content: 'x'.repeat(clock / 400) });
    });

    const prisma = { noteGeneration: { findUnique } } as unknown as PrismaService;

    const emitted = frames(
      await collect(service(prisma, { durationCapMs: 1000, now: () => clock })),
    );

    const last = emitted.at(-1);

    expect(last?.type).toBe('error');
    expect(last?.data).toMatchObject({ status: 'failed', errorClass: 'timeout' });

    // It stopped. A wedged job cannot pin the connection, or the poll.
    const after = findUnique.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(findUnique.mock.calls.length).toBe(after);
  });

  it('stops polling the moment the client disconnects', async () => {
    // Never settles, so only the unsubscribe can end it.
    const { prisma, calls } = scripted([row({ content: 'still going' })]);

    const subscription = service(prisma).stream('gen-1').subscribe();

    await new Promise((resolve) => setTimeout(resolve, 10));

    subscription.unsubscribe();

    const atDisconnect = calls();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls()).toBe(atDisconnect);
    expect(atDisconnect).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Keeping the connection alive, and keeping it open through a blip
  // ==========================================================================

  it('emits heartbeat comments during a long wait for the first token', async () => {
    // A model thinking: `pending`, empty buffer, nothing to send. Without the
    // heartbeat this connection is indistinguishable from a dead one to every
    // proxy in the path.
    const { prisma } = scripted([row({ status: 'pending', content: '' })]);

    let clock = 0;

    const messages = await collect(
      service(prisma, {
        heartbeatIntervalMs: 1,
        durationCapMs: 25,
        now: () => (clock += 5),
      }),
    );

    expect(comments(messages)[0]).toBe('connected');
    expect(comments(messages).filter((c) => c === 'heartbeat').length).toBeGreaterThan(0);

    // Not one text frame was invented to keep it alive.
    expect(frames(messages).map((message) => message.type)).toEqual(['error']);
  });

  it('survives a transient read failure instead of failing the generation', async () => {
    let call = 0;

    const findUnique = jest.fn(async () => {
      call += 1;

      if (call === 1) throw new Error('connection terminated unexpectedly');

      return row({ status: 'succeeded', content: 'it was fine all along', note: { currentVersion: 1 } });
    });

    const prisma = { noteGeneration: { findUnique } } as unknown as PrismaService;

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((message) => message.type)).toEqual(['delta', 'done']);
  });

  // ==========================================================================
  // The cap is derived, not a second free number
  // ==========================================================================

  it('derives its default cap from the generation job’s own runtime budget', () => {
    expect(DEFAULT_STREAM_DURATION_CAP_MS).toBe(
      NOTE_GENERATE_MAX_RUNTIME_MS + STREAM_DURATION_CAP_MARGIN_MS,
    );
    // Strictly longer than the job may legitimately run, or a healthy long
    // generation would have its stream torn down at the finish line.
    expect(DEFAULT_STREAM_DURATION_CAP_MS).toBeGreaterThan(NOTE_GENERATE_MAX_RUNTIME_MS);
  });
});
