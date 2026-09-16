// =============================================================================
// Chunking a transcript (issue #186, epic #165)
// =============================================================================

import {
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNK_CHARS,
  MAX_SPEAKER_LABEL_CHARS,
} from './chunk.types';
import { contentHash } from './content-hash';
import {
  ChunkableSegment,
  chunkTranscript,
  transcriptSourceBody,
} from './transcript-chunker';

// -----------------------------------------------------------------------------
// Fixtures. Deterministic by construction - no randomness, no clock.
// -----------------------------------------------------------------------------

/** A sentence of roughly `chars` characters, seeded so it is reproducible. */
const sentence = (seed: number, chars: number): string => {
  const words = [
    'migration',
    'deployment',
    'invoice',
    'schedule',
    'retention',
    'threshold',
    'rollback',
    'capacity',
    'handover',
    'estimate',
  ];
  const parts: string[] = [];
  let index = seed;
  let length = 0;
  while (length < chars) {
    const word = words[index % words.length];
    parts.push(word);
    length += word.length + 1;
    index += 1;
  }
  return `${parts.join(' ')}.`;
};

const dialogue = (count: number, chars = 300): ChunkableSegment[] =>
  Array.from({ length: count }, (_unused, index) => ({
    ordinal: (index + 1) * 1000,
    text: `${sentence(index, chars)} ${sentence(index + 5, chars / 2)}`,
    speakerLabel: index % 2 === 0 ? 'Alice' : 'Bob',
  }));

const sharedTail = (previous: string, next: string): number => {
  for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
};

// -----------------------------------------------------------------------------

describe('chunkTranscript: nothing in, nothing out', () => {
  it('returns [] for no segments', () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  it('returns [] for whitespace-only segments rather than one empty chunk', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: '   ', speakerLabel: 'Alice' },
      { ordinal: 2000, text: '\n\t\n', speakerLabel: 'Bob' },
      { ordinal: 3000, text: '', speakerLabel: null },
    ]);
    expect(chunks).toEqual([]);
  });

  it('never emits an empty or whitespace-only chunk from mixed input', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: '   ', speakerLabel: 'Alice' },
      { ordinal: 2000, text: 'Real content here.', speakerLabel: 'Bob' },
      { ordinal: 3000, text: '\n\n', speakerLabel: 'Bob' },
    ]);
    expect(chunks).toHaveLength(1);
    for (const chunk of chunks) expect(chunk.text.trim()).not.toBe('');
  });
});

describe('chunkTranscript: determinism', () => {
  it('produces identical hashes for the same input, twice', () => {
    const segments = dialogue(30);
    const first = chunkTranscript(segments);
    const second = chunkTranscript(segments);
    expect(first.length).toBeGreaterThan(3);
    expect(second.map((chunk) => chunk.contentHash)).toEqual(
      first.map((chunk) => chunk.contentHash),
    );
    expect(second).toEqual(first);
  });

  it('does not depend on the input array order, only on `ordinal`', () => {
    const segments = dialogue(12);
    const shuffled = [...segments].reverse();
    expect(chunkTranscript(shuffled)).toEqual(chunkTranscript(segments));
  });

  it('hashes exactly the chunk text that will be embedded', () => {
    for (const chunk of chunkTranscript(dialogue(10))) {
      expect(chunk.contentHash).toBe(contentHash(chunk.text));
    }
  });
});

describe('chunkTranscript: stability under edit', () => {
  // This is the actual product requirement from the epic: re-indexing an edited
  // transcript re-embeds only the chunks whose text actually moved.

  it('leaves every unaffected chunk byte-identical for a same-length edit', () => {
    const before = dialogue(20);
    const target = 14;
    const after = before.map((segment, index) =>
      index !== target
        ? segment
        :           // 'rollback' -> 'fallback': same length, so no offset downstream
          // of it moves and the packing is bit-for-bit unshifted.
          { ...segment, text: segment.text.replace('rollback', 'fallback') },
    );
    expect(after[target].text).not.toBe(before[target].text);
    expect(after[target].text).toHaveLength(before[target].text.length);

    const chunksBefore = chunkTranscript(before);
    const chunksAfter = chunkTranscript(after);
    expect(chunksBefore.length).toBeGreaterThan(4);
    expect(chunksAfter).toHaveLength(chunksBefore.length);

    const changed = chunksBefore
      .map((chunk, index) =>
        chunk.contentHash === chunksAfter[index].contentHash ? -1 : index,
      )
      .filter((index) => index >= 0);

    // At most two: the chunk holding the edited segment, and at most one
    // successor that carried part of it as overlap. Asserting the COUNT is the
    // point - "some hashes changed" would pass for a chunker that re-cut the
    // whole document on every edit, which is the regression this guards.
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(2);
    // And they are adjacent, in the middle - not the first chunk, not the last.
    expect(changed[0]).toBeGreaterThan(1);
    if (changed.length === 2) expect(changed[1]).toBe(changed[0] + 1);
  });

  it('leaves every chunk BEFORE the edit unchanged when the edit changes length', () => {
    const before = dialogue(20);
    const target = 14;
    const after = before.map((segment, index) =>
      index !== target
        ? segment
        : { ...segment, text: `${segment.text} And one more sentence entirely.` },
    );

    const chunksBefore = chunkTranscript(before);
    const chunksAfter = chunkTranscript(after);
    const firstChanged = chunksBefore.findIndex(
      (chunk, index) =>
        chunksAfter[index] === undefined ||
        chunk.contentHash !== chunksAfter[index].contentHash,
    );

    expect(firstChanged).toBeGreaterThan(1);
    // Everything before the edit is byte-identical, because packing runs
    // strictly left to right and a chunk depends only on what precedes it.
    for (let index = 0; index < firstChanged; index += 1) {
      expect(chunksAfter[index]).toEqual(chunksBefore[index]);
    }
  });

  it('changes the document fingerprint only when a chunk changes', () => {
    const segments = dialogue(20);
    const untouched = segments.map((segment) => ({ ...segment }));
    expect(chunkTranscript(untouched).map((chunk) => chunk.contentHash)).toEqual(
      chunkTranscript(segments).map((chunk) => chunk.contentHash),
    );
  });
});

describe('chunkTranscript: budget and overlap', () => {
  it('never exceeds the character budget', () => {
    for (const chunk of chunkTranscript(dialogue(40))) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('numbers chunks 0, 1, 2, ...', () => {
    const chunks = chunkTranscript(dialogue(30));
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_unused, index) => index),
    );
  });

  it('overlaps: each chunk opens with a suffix of its predecessor', () => {
    const chunks = chunkTranscript(dialogue(30));
    expect(chunks.length).toBeGreaterThan(3);
    for (let index = 1; index < chunks.length; index += 1) {
      const shared = sharedTail(chunks[index - 1].text, chunks[index].text);
      expect(shared).toBeGreaterThan(20);
      expect(shared).toBeLessThanOrEqual(
        CHUNK_OVERLAP_CHARS + MAX_SPEAKER_LABEL_CHARS + 2,
      );
    }
  });

  it('packs several segments into one chunk rather than one chunk per segment', () => {
    const chunks = chunkTranscript(dialogue(30, 120));
    expect(chunks.length).toBeLessThan(30);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('chunkTranscript: speaker labels', () => {
  const alternating = chunkTranscript(dialogue(30, 200));

  it('carries the label into the embedded text', () => {
    expect(alternating[0].text).toContain('Alice: ');
    expect(alternating[0].text).toContain('Bob: ');
  });

  it('does not repeat a label while the speaker does not change', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: 'First thing.', speakerLabel: 'Alice' },
      { ordinal: 2000, text: 'Second thing.', speakerLabel: 'Alice' },
      { ordinal: 3000, text: 'Third thing.', speakerLabel: 'Alice' },
      { ordinal: 4000, text: 'A reply.', speakerLabel: 'Bob' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(
      'Alice: First thing.\nSecond thing.\nThird thing.\nBob: A reply.',
    );
  });

  it('re-states the speaker at the head of every chunk', () => {
    // A chunk that opened mid-monologue would otherwise be unattributed prose.
    const long = Array.from({ length: 20 }, (_unused, index) => ({
      ordinal: (index + 1) * 1000,
      text: sentence(index, 400),
      speakerLabel: 'Alice',
    }));
    const chunks = chunkTranscript(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text).toContain('Alice: ');
  });

  it('chunks an undiarized transcript with no labels at all', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: 'No speakers here.' },
      { ordinal: 2000, text: 'Still none.', speakerLabel: null },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('No speakers here.\nStill none.');
  });

  it('bounds a pathological label instead of spending the budget on it', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: 'Hello.', speakerLabel: 'X'.repeat(500) },
    ]);
    expect(chunks[0].text).toBe(`${'X'.repeat(MAX_SPEAKER_LABEL_CHARS)}: Hello.`);
  });
});

describe('chunkTranscript: source offsets', () => {
  it('reconstructs a source body the offsets index', () => {
    const segments: ChunkableSegment[] = [
      { ordinal: 2000, text: '  second  ', speakerLabel: 'Bob' },
      { ordinal: 1000, text: 'first', speakerLabel: 'Alice' },
      { ordinal: 3000, text: '   ', speakerLabel: 'Bob' },
    ];
    // Ordinal order, trimmed, blanks dropped, one per line. No labels: the
    // labels live in the chunk text, not in the source.
    expect(transcriptSourceBody(segments)).toBe('first\nsecond');
  });

  it('slices back to exactly the chunk text when there is no decoration', () => {
    // With no speaker labels a chunk's text IS a source substring, which makes
    // the frame of reference assertable exactly rather than approximately.
    const segments = dialogue(30).map(({ ordinal, text }) => ({ ordinal, text }));
    const source = transcriptSourceBody(segments);
    const chunks = chunkTranscript(segments);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it('slices back to the chunk text with whole labels removed', () => {
    const segments = dialogue(30);
    const source = transcriptSourceBody(segments);
    for (const chunk of chunkTranscript(segments)) {
      const undecorated = chunk.text.replace(/(^|\n)(Alice|Bob): /g, '$1');
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(undecorated);
    }
  });

  it('keeps offsets in bounds, ordered, and covering the whole source', () => {
    const segments = dialogue(30);
    const source = transcriptSourceBody(segments);
    const chunks = chunkTranscript(segments);

    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(source.length);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeLessThanOrEqual(source.length);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      if (index > 0) {
        const previous = chunks[index - 1];
        expect(chunk.charStart).toBeGreaterThan(previous.charStart);
        expect(chunk.charEnd).toBeGreaterThan(previous.charEnd);
        // Consecutive chunks overlap, so the successor starts at or before the
        // predecessor ends. Nothing between two chunks is unreachable.
        expect(chunk.charStart).toBeLessThanOrEqual(previous.charEnd);
      }
    }
  });

  it('puts every segment wholly inside at least one chunk', () => {
    const segments = dialogue(30);
    const source = transcriptSourceBody(segments);
    const chunks = chunkTranscript(segments);
    for (const segment of segments) {
      const start = source.indexOf(segment.text.trim());
      const end = start + segment.text.trim().length;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(
        chunks.some(
          (chunk) => chunk.charStart <= start && chunk.charEnd >= end,
        ),
      ).toBe(true);
    }
  });
});

describe('chunkTranscript: oversized segments', () => {
  const monologue = `${sentence(1, 2000)} ${sentence(2, 2000)} ${sentence(3, 2000)}`;

  it('hard-splits a segment longer than the whole budget rather than dropping it', () => {
    expect(monologue.length).toBeGreaterThan(MAX_CHUNK_CHARS * 2);
    const chunks = chunkTranscript([
      { ordinal: 1000, text: monologue, speakerLabel: 'Alice' },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(chunk.text.trim()).not.toBe('');
    }
  });

  it('loses no character of an oversized segment', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: monologue, speakerLabel: 'Alice' },
    ]);
    const source = transcriptSourceBody([{ ordinal: 1000, text: monologue }]);
    // Walk the chunk spans and rebuild the source from them. Overlap means the
    // spans intersect, so the rebuild takes only the new part of each.
    let rebuilt = '';
    for (const chunk of chunks) {
      const from = Math.max(chunk.charStart, rebuilt.length);
      expect(from).toBeLessThanOrEqual(chunk.charEnd);
      rebuilt += source.slice(from, chunk.charEnd);
    }
    expect(rebuilt).toBe(source);
  });

  it('repeats the speaker label on every piece of a hard split', () => {
    const chunks = chunkTranscript([
      { ordinal: 1000, text: monologue, speakerLabel: 'Alice' },
    ]);
    for (const chunk of chunks) expect(chunk.text).toContain('Alice: ');
  });

  it('hard-splits a segment with no whitespace at all', () => {
    const wall = 'x'.repeat(MAX_CHUNK_CHARS * 3);
    const chunks = chunkTranscript([{ ordinal: 1000, text: wall }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    expect(chunks.map((chunk) => chunk.charEnd - chunk.charStart).length).toBe(
      chunks.length,
    );
  });
});
