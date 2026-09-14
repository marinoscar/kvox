import {
  NOTE_STREAM_DELTA_EVENT,
  NOTE_STREAM_DONE_EVENT,
  NOTE_STREAM_ERROR_EVENT,
  NoteStreamCursor,
  parseLastEventId,
  toDeltaFrame,
  toDoneFrame,
  toErrorFrame,
} from './note-stream';

// =============================================================================
// The delta computation (issue #52, epic #45)
// =============================================================================
//
// THE ASSERTION THIS FILE EXISTS FOR, stated once: across ANY sequence of
// polls, the concatenation of every delta emitted equals exactly the text the
// buffer ended with, from the cursor's starting offset onward. Not "roughly" —
// exactly, with no character sent twice and none skipped.
//
// It is a unit test rather than an integration one because the failure it
// guards against is invisible end to end: a cursor that skips a few characters
// at a flush boundary produces a note that renders almost right, and the only
// thing that catches it is comparing a concatenation to a source string.
// =============================================================================

/** Drive a cursor through a sequence of buffer states; collect what it sent. */
function replay(states: string[], from = 0): { deltas: string[]; cursor: NoteStreamCursor } {
  const cursor = new NoteStreamCursor(from);
  const deltas: string[] = [];

  for (const state of states) {
    const delta = cursor.advance(state);

    if (delta) deltas.push(delta.delta);
  }

  return { deltas, cursor };
}

describe('NoteStreamCursor', () => {
  it('emits each append exactly once, and the concatenation is the buffer', () => {
    const states = ['Hel', 'Hello', 'Hello, wor', 'Hello, world!'];

    const { deltas, cursor } = replay(states);

    expect(deltas).toEqual(['Hel', 'lo', ', wor', 'ld!']);
    expect(deltas.join('')).toBe('Hello, world!');
    expect(cursor.position).toBe('Hello, world!'.length);
  });

  it('sends nothing for a poll that saw no change — an idle poll is not a frame', () => {
    const cursor = new NoteStreamCursor();

    expect(cursor.advance('abc')).not.toBeNull();
    expect(cursor.advance('abc')).toBeNull();
    expect(cursor.advance('abc')).toBeNull();
    expect(cursor.advance('abcd')?.delta).toBe('d');
  });

  it('reports an offset equal to the buffer length it has consumed', () => {
    const cursor = new NoteStreamCursor();

    expect(cursor.advance('12345')).toEqual({ delta: '12345', offset: 5 });
    expect(cursor.advance('1234567')).toEqual({ delta: '67', offset: 7 });
  });

  // ==========================================================================
  // The flush boundary — the case the acceptance criterion names
  // ==========================================================================

  it('never re-sends or skips across offsets, however the flushes land', () => {
    // The full text, as one generation would end up with it.
    const full = Array.from({ length: 40 }, (_, i) => `chunk-${i} `).join('');

    // Three different flush cadences over the SAME text: a fast model (many
    // tiny flushes), a slow one (three big ones), and a ragged one whose writes
    // land on no particular boundary. All three must reconstruct `full`.
    const cadences: number[][] = [
      Array.from({ length: full.length }, (_, i) => i + 1),
      [Math.floor(full.length / 3), Math.floor((full.length * 2) / 3), full.length],
      [1, 2, 3, 17, 18, 99, 100, 101, 257, full.length - 1, full.length],
    ];

    for (const cadence of cadences) {
      const states = cadence.map((length) => full.slice(0, length));

      const { deltas, cursor } = replay(states);

      expect(deltas.join('')).toBe(full);
      expect(cursor.position).toBe(full.length);
    }
  });

  it('resumes from an offset, replaying the suffix and nothing before it', () => {
    const full = 'the quick brown fox jumps over the lazy dog';
    const from = 'the quick brown fox '.length;

    const { deltas } = replay([full.slice(0, 30), full], from);

    expect(deltas.join('')).toBe(full.slice(from));
    expect(deltas.join('')).not.toContain('quick');
  });

  it('a caught-up client is replayed nothing at all', () => {
    const full = 'already seen every byte of this';

    const { deltas } = replay([full], full.length);

    expect(deltas).toEqual([]);
  });

  // ==========================================================================
  // ⚠ The clamp. See `advance`'s comment: without it this is silent text loss.
  // ==========================================================================

  it('clamps an offset past the end of the buffer instead of skipping text', () => {
    const cursor = new NoteStreamCursor(10_000);

    // Nothing is replayed for text it claims to have seen...
    expect(cursor.advance('short buffer')).toBeNull();
    expect(cursor.position).toBe('short buffer'.length);

    // ...but everything written AFTERWARDS still arrives. Unclamped, the cursor
    // would sit at 10000 and swallow every character until the buffer passed it.
    expect(cursor.advance('short buffer and then some more')?.delta).toBe(
      ' and then some more',
    );
  });

  it('treats a negative or fractional starting offset as the beginning', () => {
    expect(new NoteStreamCursor(-5).position).toBe(0);
    expect(new NoteStreamCursor(3.9).position).toBe(3);
  });
});

describe('parseLastEventId', () => {
  it('reads a plain non-negative integer', () => {
    expect(parseLastEventId('0')).toBe(0);
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId(' 812 ')).toBe(812);
  });

  it('takes the first value when a header arrives repeated', () => {
    expect(parseLastEventId(['7', '9'])).toBe(7);
  });

  it('is total over garbage — anything unusable means "from the beginning"', () => {
    // Restarting from 0 replays text the client may already hold, which is
    // harmless; trusting a garbled id could lose text, which is not.
    for (const value of [
      undefined,
      '',
      '   ',
      'abc',
      '-1',
      '1.5',
      '1e3',
      '0x10',
      '99999999999999999999',
      'Infinity',
    ]) {
      expect(parseLastEventId(value as string | undefined)).toBe(0);
    }
  });
});

describe('frame builders', () => {
  it('renders `id:` and the body offset from the SAME number', () => {
    const delta = toDeltaFrame({ delta: 'hi', offset: 2 });

    expect(delta.type).toBe(NOTE_STREAM_DELTA_EVENT);
    expect(delta.id).toBe('2');
    expect(delta.data).toEqual({ delta: 'hi', offset: 2 });
  });

  it('names the final status and the note version on `done`', () => {
    const done = toDoneFrame({ status: 'succeeded', offset: 812, currentVersion: 3 });

    expect(done.type).toBe(NOTE_STREAM_DONE_EVENT);
    expect(done.id).toBe('812');
    expect(done.data).toEqual({ status: 'succeeded', offset: 812, currentVersion: 3 });
  });

  it('carries the recorded reason on `error`', () => {
    const error = toErrorFrame({
      status: 'failed',
      offset: 12,
      errorClass: 'auth',
      reason: 'Your API key was rejected.',
    });

    expect(error.type).toBe(NOTE_STREAM_ERROR_EVENT);
    expect(error.id).toBe('12');
    expect(error.data).toEqual({
      status: 'failed',
      offset: 12,
      errorClass: 'auth',
      reason: 'Your API key was rejected.',
    });
  });
});
