import { createTranscriptSchema, updateTranscriptSchema } from './transcript.dto';

// =============================================================================
// `POST /api/transcripts` body — the keyterms field (issue #327)
// =============================================================================
//
// Normalised FIRST (trim, blanks dropped, case-insensitive dedup keeping the
// first spelling), THEN held to this API's limits — so a list padded with
// blanks or repeats is judged on what it actually says, and each violation is
// a 400 rather than a silent truncation.
// =============================================================================

const SOURCE = { name: 'meeting.mp3', size: 1_000, mimeType: 'audio/mpeg' };

function parse(keyterms: unknown) {
  return createTranscriptSchema.safeParse({ source: SOURCE, keyterms });
}

describe('createTranscriptSchema — keyterms (#327)', () => {
  it('is optional', () => {
    const result = createTranscriptSchema.safeParse({ source: SOURCE });

    expect(result.success).toBe(true);
    expect(result.data?.keyterms).toBeUndefined();
  });

  it('trims, collapses whitespace and drops empties', () => {
    const result = parse(['  Kvox  ', '', '   ', 'Oscar   Marín']);

    expect(result.success).toBe(true);
    expect(result.data?.keyterms).toEqual(['Kvox', 'Oscar Marín']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    const result = parse(['PostgreSQL', 'postgresql', 'POSTGRESQL ', 'Prisma']);

    expect(result.success).toBe(true);
    expect(result.data?.keyterms).toEqual(['PostgreSQL', 'Prisma']);
  });

  it('accepts exactly six words', () => {
    expect(parse(['one two three four five six']).success).toBe(true);
  });

  it('rejects a term of more than six words', () => {
    const result = parse(['ok', 'one two three four five six seven']);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['keyterms', 1]);
    expect(result.error?.issues[0].message).toMatch(/more than 6 words/);
  });

  it('rejects a term longer than 100 characters', () => {
    const result = parse(['x'.repeat(101)]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/longer than 100 characters/);
  });

  it('accepts 200 distinct terms', () => {
    const terms = Array.from({ length: 200 }, (_, i) => `term${i}`);

    expect(parse(terms).success).toBe(true);
  });

  it('rejects more than 200 distinct terms', () => {
    const terms = Array.from({ length: 201 }, (_, i) => `term${i}`);
    const result = parse(terms);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/At most 200 keyterms/);
  });

  it('counts the limit AFTER dedup, so repeats do not push a list over it', () => {
    const terms = [
      ...Array.from({ length: 200 }, (_, i) => `term${i}`),
      ...Array.from({ length: 50 }, (_, i) => `TERM${i}`),
    ];
    const result = parse(terms);

    expect(result.success).toBe(true);
    expect(result.data?.keyterms).toHaveLength(200);
  });

  it('rejects a non-string entry', () => {
    expect(parse(['ok', 42]).success).toBe(false);
  });
});

// =============================================================================
// `PATCH /api/transcripts/:id` body — title and/or recordedAt (issue #352)
// =============================================================================

describe('updateTranscriptSchema (#352)', () => {
  it('rejects an empty body with a message naming both fields', () => {
    const result = updateTranscriptSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Nothing to update: send `title`, `recordedAt`, or both.',
    );
  });

  it('accepts a title alone, trimmed', () => {
    const result = updateTranscriptSchema.safeParse({ title: '  Renamed  ' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: 'Renamed' });
  });

  it('rejects a blank title', () => {
    expect(updateTranscriptSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it.each([
    '2026-03-02T15:00:00-05:00',
    '2026-03-02T20:00:00Z',
    '2026-03-02T20:00:00.123Z',
    '2026-03-02T20:00:00+00:00',
  ])('accepts recordedAt %s, which carries an offset', (recordedAt) => {
    expect(updateTranscriptSchema.safeParse({ recordedAt }).success).toBe(true);
  });

  it.each([
    '2026-03-02T15:00:00',
    '2026-03-02T15:00',
    '2026-03-02',
    'yesterday',
    '',
  ])('rejects recordedAt %j — offset-less or not a datetime', (recordedAt) => {
    expect(updateTranscriptSchema.safeParse({ recordedAt }).success).toBe(false);
  });

  it('rejects a non-string recordedAt', () => {
    expect(updateTranscriptSchema.safeParse({ recordedAt: 1_700_000_000_000 }).success).toBe(
      false,
    );
  });

  it('accepts both fields together', () => {
    const result = updateTranscriptSchema.safeParse({
      title: 'Both',
      recordedAt: '2026-03-02T20:00:00Z',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: 'Both', recordedAt: '2026-03-02T20:00:00Z' });
  });
});
