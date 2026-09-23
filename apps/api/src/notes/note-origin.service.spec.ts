import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { MAX_NOTE_HOPS, NoteOriginService, type NoteOriginFields } from './note-origin.service';

// =============================================================================
// NoteOriginService (#309)
// =============================================================================
//
// `resolve()` answers `originTranscript`: the transcript a note ultimately
// came from, following `sourceNoteId` up the chain when the note itself was
// generated from another note. Every test below is one way the chain can end
// — a direct hit, N hops of notes, the hop ceiling, and every reason the walk
// must give up and answer `null` rather than leak or dead-link.
// =============================================================================

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const TRANSCRIPT_ID = 'transcript-1';

/** A minimal starting note, as `resolve()`'s first argument requires. */
function startingNote(overrides: Partial<NoteOriginFields> = {}): NoteOriginFields {
  return {
    id: 'note-start',
    sourceType: 'transcript',
    sourceTranscriptId: null,
    sourceNoteId: null,
    ...overrides,
  } as NoteOriginFields;
}

/** One row `note.findUnique` returns while walking the chain. */
function intermediateNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: 'transcript',
    sourceTranscriptId: null,
    sourceNoteId: null,
    ownerId: USER_ID,
    status: 'ready',
    deletedAt: null,
    ...overrides,
  };
}

/** A transcript row `transcript.findFirst` returns. */
function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSCRIPT_ID,
    title: 'Kestrel weekly',
    durationMs: 120_000,
    status: 'ready',
    playbackStatus: 'ready',
    ...overrides,
  };
}

describe('NoteOriginService', () => {
  let service: NoteOriginService;
  let prisma: {
    note: { findUnique: jest.Mock };
    transcript: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      note: { findUnique: jest.fn() },
      transcript: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [NoteOriginService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<NoteOriginService>(NoteOriginService);
  });

  // ===========================================================================
  // Direct transcript source
  // ===========================================================================

  it('resolves a direct transcript source via "direct" at 0 hops, fields mapped', async () => {
    prisma.transcript.findFirst.mockResolvedValue(transcriptRow());

    const note = startingNote({ sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID });

    const result = await service.resolve(note, USER_ID);

    expect(result).toEqual({
      id: TRANSCRIPT_ID,
      title: 'Kestrel weekly',
      durationMs: 120_000,
      status: 'ready',
      playbackStatus: 'ready',
      via: 'direct',
      hops: 0,
    });
    expect(prisma.note.findUnique).not.toHaveBeenCalled();
  });

  it('answers null for a transcript source with no sourceTranscriptId', async () => {
    const note = startingNote({ sourceType: 'transcript', sourceTranscriptId: null });

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Note chains
  // ===========================================================================

  it('resolves note -> transcript at 1 hop, via "note_chain"', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({ sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID }),
    );
    prisma.transcript.findFirst.mockResolvedValue(transcriptRow());

    const result = await service.resolve(note, USER_ID);

    expect(result).toEqual(
      expect.objectContaining({ id: TRANSCRIPT_ID, via: 'note_chain', hops: 1 }),
    );
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.note.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'note-a' } }),
    );
  });

  it('resolves note -> note -> transcript at 2 hops', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique
      .mockResolvedValueOnce(intermediateNoteRow({ sourceType: 'note', sourceNoteId: 'note-b' }))
      .mockResolvedValueOnce(
        intermediateNoteRow({ sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID }),
      );
    prisma.transcript.findFirst.mockResolvedValue(transcriptRow());

    const result = await service.resolve(note, USER_ID);

    expect(result).toEqual(
      expect.objectContaining({ id: TRANSCRIPT_ID, via: 'note_chain', hops: 2 }),
    );
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(2);
  });

  it(`resolves exactly at ${MAX_NOTE_HOPS} hops`, async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-1' });

    // note-1 .. note-4 each point at the next note; note-5 (hop 5) points at
    // the transcript, landing exactly on MAX_NOTE_HOPS.
    for (let i = 1; i < MAX_NOTE_HOPS; i += 1) {
      prisma.note.findUnique.mockResolvedValueOnce(
        intermediateNoteRow({ sourceType: 'note', sourceNoteId: `note-${i + 1}` }),
      );
    }
    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({ sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID }),
    );
    prisma.transcript.findFirst.mockResolvedValue(transcriptRow());

    const result = await service.resolve(note, USER_ID);

    expect(result).toEqual(
      expect.objectContaining({ id: TRANSCRIPT_ID, via: 'note_chain', hops: MAX_NOTE_HOPS }),
    );
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(MAX_NOTE_HOPS);
  });

  it(`answers null when the chain needs ${MAX_NOTE_HOPS + 1} hops`, async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-1' });

    // note-1 .. note-5 each point at the next note (5 hops consumed just
    // walking notes); the transcript would only be reachable at hop 6.
    for (let i = 1; i <= MAX_NOTE_HOPS; i += 1) {
      prisma.note.findUnique.mockResolvedValueOnce(
        intermediateNoteRow({ sourceType: 'note', sourceNoteId: `note-${i + 1}` }),
      );
    }

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(MAX_NOTE_HOPS);
  });

  // ===========================================================================
  // Chain breaks
  // ===========================================================================

  it('answers null for a document source', async () => {
    const note = startingNote({ sourceType: 'document' } as Partial<NoteOriginFields>);

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.note.findUnique).not.toHaveBeenCalled();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null for a note source with no sourceNoteId', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: null });

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.note.findUnique).not.toHaveBeenCalled();
  });

  it('answers null when an intermediate note is missing', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(null);

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null when an intermediate note is owned by someone else', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({
        ownerId: OTHER_USER_ID,
        sourceType: 'transcript',
        sourceTranscriptId: TRANSCRIPT_ID,
      }),
    );

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null when an intermediate note has status "deleting"', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({
        status: 'deleting',
        sourceType: 'transcript',
        sourceTranscriptId: TRANSCRIPT_ID,
      }),
    );

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null when an intermediate note is soft-deleted', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({
        deletedAt: new Date(),
        sourceType: 'transcript',
        sourceTranscriptId: TRANSCRIPT_ID,
      }),
    );

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null on a cycle, without looping forever', async () => {
    // note-start -> note-a -> note-start (a cycle back to the very note that
    // started the walk).
    const note = startingNote({ id: 'note-start', sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique.mockResolvedValueOnce(
      intermediateNoteRow({ sourceType: 'note', sourceNoteId: 'note-start' }),
    );

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    // Only one lookup: the walk must detect the revisit before a second call.
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null on a two-note cycle (a -> b -> a)', async () => {
    const note = startingNote({ sourceType: 'note', sourceNoteId: 'note-a' });

    prisma.note.findUnique
      .mockResolvedValueOnce(intermediateNoteRow({ sourceType: 'note', sourceNoteId: 'note-b' }))
      .mockResolvedValueOnce(intermediateNoteRow({ sourceType: 'note', sourceNoteId: 'note-a' }));

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
  });

  it('answers null when the transcript is not visible (findFirst returns null), asserting the where clause', async () => {
    prisma.transcript.findFirst.mockResolvedValue(null);

    const note = startingNote({ sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID });

    const result = await service.resolve(note, USER_ID);

    expect(result).toBeNull();
    expect(prisma.transcript.findFirst).toHaveBeenCalledTimes(1);

    const args = prisma.transcript.findFirst.mock.calls[0][0];

    expect(args.where.id).toBe(TRANSCRIPT_ID);
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.status).toEqual({ not: 'deleting' });
    expect(args.where.OR).toEqual(
      expect.arrayContaining([
        { ownerId: USER_ID },
        { shares: { some: { userId: USER_ID } } },
      ]),
    );
  });
});
