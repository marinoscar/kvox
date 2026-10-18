import { BadRequestException, ConflictException } from '@nestjs/common';

import type { EvidenceSpanInput } from './dto/proposal.dto.js';
import { normalizeSpanText, spanMatches, SpanValidator, type SpanSource } from './span-validator.js';

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
  // The mock serves both phases (#615): `prepare` reads the note through the root
  // client before the transaction, `validate` reads it again on `tx`.
  const real = new SpanValidator(origin as never, tx as never);
  const validator = {
    validate: async (t: never, source: SpanSource, spans: readonly EvidenceSpanInput[]) =>
      real.validate(t, source, spans, await real.prepare(source, spans)),
  };
  return { validator, tx: tx as never, origin };
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

// #615: `prepare` runs before the caller's transaction (root client + origin service),
// `validate` inside it (tx only). Counted here, with a root client and an origin service
// that record every call.
describe('SpanValidator — two phases (#615)', () => {
  const SEGMENT_SPAN: EvidenceSpanInput = { source: 'segment', segmentId: SEG, segmentRev: 3, charStart: 8, charEnd: 18, quote: 'Sarah Chen' };
  const NOTE_SPAN: EvidenceSpanInput = { source: 'note', noteVersion: 2, charStart: 0, charEnd: 9, quote: '# Kickoff' };
  const source: SpanSource = { ownerId: OWNER, noteId: NOTE };

  function phases() {
    const origin = { resolve: jest.fn(async () => ({ id: TRANSCRIPT })) };
    const root = {
      note: { findFirst: jest.fn(async () => ({ id: NOTE, sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT, sourceNoteId: null })) },
    };
    const tx = {
      note: { findFirst: jest.fn(async () => ({ id: NOTE, currentVersion: 2 })) },
      noteVersion: { findUnique: jest.fn(async () => ({ body: BODY })) },
      transcriptSegment: {
        findFirst: jest.fn(async () => ({ id: SEG, transcriptId: TRANSCRIPT, rev: 3, text: SEG_TEXT, startMs: 100, endMs: 900 })),
      },
    };
    const validator = new SpanValidator(origin as never, root as never);
    return { validator, origin, root, tx: tx as never, txMock: tx };
  }

  it('prepare with no segment span reads nothing: root client and origin service untouched', async () => {
    const { validator, origin, root } = phases();
    const context = await validator.prepare(source, [NOTE_SPAN]);
    expect(context).toEqual({ ownerId: OWNER, noteId: NOTE });
    expect(context.originTranscriptId).toBeUndefined();
    expect(root.note.findFirst).not.toHaveBeenCalled();
    expect(origin.resolve).not.toHaveBeenCalled();
  });

  it('prepare with no spans at all reads nothing either', async () => {
    const { validator, origin, root } = phases();
    await validator.prepare(source, []);
    expect(root.note.findFirst).not.toHaveBeenCalled();
    expect(origin.resolve).not.toHaveBeenCalled();
  });

  it('prepare with a segment span resolves the origin once, however many segment spans', async () => {
    const { validator, origin, root } = phases();
    const context = await validator.prepare(source, [SEGMENT_SPAN, NOTE_SPAN, SEGMENT_SPAN]);
    expect(context.originTranscriptId).toBe(TRANSCRIPT);
    expect(root.note.findFirst).toHaveBeenCalledTimes(1);
    expect(origin.resolve).toHaveBeenCalledTimes(1);
    expect(origin.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: NOTE }), OWNER);
  });

  it('prepare for a proposal with no note resolves a null origin without reading', async () => {
    const { validator, origin, root } = phases();
    const context = await validator.prepare({ ownerId: OWNER, noteId: null }, [SEGMENT_SPAN]);
    expect(context.originTranscriptId).toBeNull();
    expect(root.note.findFirst).not.toHaveBeenCalled();
    expect(origin.resolve).not.toHaveBeenCalled();
  });

  it('validate makes no root-client and no origin-service call, for note and segment spans', async () => {
    const { validator, origin, root, tx, txMock } = phases();
    const context = await validator.prepare(source, [SEGMENT_SPAN, NOTE_SPAN]);
    root.note.findFirst.mockClear();
    origin.resolve.mockClear();

    const rows = await validator.validate(tx, source, [SEGMENT_SPAN, NOTE_SPAN], context);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ transcriptId: TRANSCRIPT, segmentId: SEG }));
    expect(root.note.findFirst).not.toHaveBeenCalled();
    expect(origin.resolve).not.toHaveBeenCalled();
    expect(txMock.transcriptSegment.findFirst).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another owner', { ownerId: 'someone-else', noteId: NOTE }],
    ['another note', { ownerId: OWNER, noteId: 'another-note' }],
    ['no note', { ownerId: OWNER, noteId: null }],
  ])('validate throws an internal Error (not an HTTP error) for a context prepared for %s', async (_n, other) => {
    const { validator, tx } = phases();
    const context = await validator.prepare(other, [NOTE_SPAN]);
    const err = await validator.validate(tx, source, [NOTE_SPAN], context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect(err).not.toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/different source/);
  });

  it('validate throws an internal Error when a segment span has no origin in its context', async () => {
    const { validator, tx } = phases();
    const context = await validator.prepare(source, [NOTE_SPAN]); // prepared without the segment span
    const err = await validator.validate(tx, source, [SEGMENT_SPAN], context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/needs a context prepared with it/);
  });

  it('a null origin in the context is the client error span_outside_source, not an internal one', async () => {
    const { validator, origin, tx } = phases();
    origin.resolve.mockResolvedValue(null as never);
    const context = await validator.prepare(source, [SEGMENT_SPAN]);
    const err = await validator.validate(tx, source, [SEGMENT_SPAN], context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(reasonOf(err)).toBe('span_outside_source');
  });
});
