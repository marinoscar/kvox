import { BadRequestException, ConflictException } from '@nestjs/common';

import { normalizeSpanText, spanMatches, SpanValidator } from './span-validator';

const OWNER = '0a000000-0000-4000-8000-000000000001';
const NOTE = '0b000000-0000-4000-8000-000000000001';
const TRANSCRIPT = '0c000000-0000-4000-8000-000000000001';
const OTHER_TRANSCRIPT = '0c000000-0000-4000-8000-000000000002';
const SEG = '0d000000-0000-4000-8000-000000000001';
const BODY = '# Kickoff\n\nSarah   Chen\njoined Northwind.';
const SEG_TEXT = "Hi, I'm Sarah Chen.";

function setup(opts: { originId?: string | null; segmentTranscript?: string; segmentRev?: number } = {}) {
  const origin = { resolve: jest.fn(async () => (opts.originId === null ? null : { id: opts.originId ?? TRANSCRIPT })) };
  const tx = {
    note: {
      findFirst: jest.fn(async () => ({ id: NOTE, currentVersion: 2, sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT, sourceNoteId: null })),
    },
    noteVersion: { findUnique: jest.fn(async ({ where }: any) => (where.noteId_version.version === 2 ? { body: BODY } : null)) },
    transcriptSegment: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === SEG && where.transcriptId === (opts.segmentTranscript ?? TRANSCRIPT)
          ? { id: SEG, transcriptId: where.transcriptId, rev: opts.segmentRev ?? 3, text: SEG_TEXT, startMs: 100, endMs: 900 }
          : null,
      ),
    },
  };
  return { validator: new SpanValidator(origin as never), tx: tx as never, origin };
}

const reasonOf = (e: unknown) => ((e as BadRequestException).getResponse() as { details: { reason: string } }).details.reason;

describe('SpanValidator', () => {
  it('normalizes NFC and whitespace, keeps case', () => {
    expect(normalizeSpanText('  Café\n\n  ok ')).toBe('Café ok');
    expect(spanMatches('Sarah   Chen', 0, 12, 'Sarah Chen')).toBe(true);
    expect(spanMatches('Sarah Chen', 0, 10, 'sarah chen')).toBe(false);
    expect(spanMatches('Sarah', 3, 3, '')).toBe(false);
    expect(spanMatches('Sarah', 0, 6, 'Sarah')).toBe(false);
  });

  it('a note span at the current version becomes note evidence', async () => {
    const { validator, tx } = setup();
    const start = BODY.indexOf('Sarah');
    const end = BODY.indexOf('Chen') + 4;
    const [e] = await validator.validate(tx, { ownerId: OWNER, noteId: NOTE }, [
      { source: 'note', noteVersion: 2, charStart: start, charEnd: end, quote: 'Sarah Chen' },
    ]);
    expect(e).toEqual(expect.objectContaining({ noteId: NOTE, noteVersion: 2, charStart: start, charEnd: end, quote: 'Sarah Chen', segmentId: null }));
  });

  it('a note span at an older version is 409 stale_note_version', async () => {
    const { validator, tx } = setup();
    const err = await validator
      .validate(tx, { ownerId: OWNER, noteId: NOTE }, [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 3, quote: '# K' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(reasonOf(err)).toBe('stale_note_version');
  });

  it.each([
    ['out of bounds', 0, 999, '# Kickoff'],
    ['mismatched text', 0, 9, '# Kickof!'],
  ])('a note span with %s is 400 span_mismatch', async (_n, charStart, charEnd, quote) => {
    const { validator, tx } = setup();
    const err = await validator
      .validate(tx, { ownerId: OWNER, noteId: NOTE }, [{ source: 'note', noteVersion: 2, charStart, charEnd, quote }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(reasonOf(err)).toBe('span_mismatch');
  });

  it('a segment span of the origin transcript carries its timing', async () => {
    const { validator, tx } = setup();
    const [e] = await validator.validate(tx, { ownerId: OWNER, noteId: NOTE }, [
      { source: 'segment', segmentId: SEG, segmentRev: 3, charStart: 8, charEnd: 18, quote: 'Sarah Chen' },
    ]);
    expect(e).toEqual(expect.objectContaining({ transcriptId: TRANSCRIPT, segmentId: SEG, segmentRev: 3, startMs: 100, endMs: 900, noteId: null }));
  });

  it('a segment of another transcript is 400 span_outside_source', async () => {
    const { validator, tx } = setup({ segmentTranscript: OTHER_TRANSCRIPT });
    const err = await validator
      .validate(tx, { ownerId: OWNER, noteId: NOTE }, [{ source: 'segment', segmentId: SEG, segmentRev: 3, charStart: 0, charEnd: 2, quote: 'Hi' }])
      .catch((e: unknown) => e);
    expect(reasonOf(err)).toBe('span_outside_source');
  });

  it('no origin transcript, or no note, is outside the source', async () => {
    const { validator, tx } = setup({ originId: null });
    const seg = await validator
      .validate(tx, { ownerId: OWNER, noteId: NOTE }, [{ source: 'segment', segmentId: SEG, segmentRev: 3, charStart: 0, charEnd: 2, quote: 'Hi' }])
      .catch((e: unknown) => e);
    expect(reasonOf(seg)).toBe('span_outside_source');
    const noNote = await validator
      .validate(tx, { ownerId: OWNER, noteId: null }, [{ source: 'note', noteVersion: 2, charStart: 0, charEnd: 2, quote: '# ' }])
      .catch((e: unknown) => e);
    expect(reasonOf(noNote)).toBe('span_outside_source');
  });

  it('a stale segment rev is 409 stale_segment_rev', async () => {
    const { validator, tx } = setup({ segmentRev: 4 });
    const err = await validator
      .validate(tx, { ownerId: OWNER, noteId: NOTE }, [{ source: 'segment', segmentId: SEG, segmentRev: 3, charStart: 0, charEnd: 2, quote: 'Hi' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(reasonOf(err)).toBe('stale_segment_rev');
  });

  it('resolves the origin transcript once per batch', async () => {
    const { validator, tx, origin } = setup();
    const span = { source: 'segment' as const, segmentId: SEG, segmentRev: 3, charStart: 0, charEnd: 2, quote: 'Hi' };
    await validator.validate(tx, { ownerId: OWNER, noteId: NOTE }, [span, span]);
    expect(origin.resolve).toHaveBeenCalledTimes(1);
  });
});
