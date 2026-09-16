/**
 * Resolving a page of notes' source names — issue #192, epic #162.
 *
 * =============================================================================
 * TWO PROPERTIES, AND ONE OF THEM IS A SECURITY PROPERTY
 * =============================================================================
 *
 * 1. **Bounded queries.** The whole point of moving this server-side was to
 *    delete an N+1, so a resolver that issued one read per row would be no fix
 *    at all. These tests count the `findMany` calls, not the rows.
 *
 * 2. **⚠ Access scoping.** This is the part that would be a real bug written
 *    the obvious way. A note is owner-only, but its SOURCE need not still be
 *    readable by that owner — a transcript shared with them can be unshared
 *    afterwards, and the note keeps pointing at it forever. If the predicate
 *    were a bare `id IN (...)`, this endpoint would publish the titles of other
 *    people's private recordings on a list every user can call.
 *
 *    So the assertions below are on the WHERE CLAUSES, not only on the returned
 *    names: a test that passed the right ids and got the right titles back
 *    would go on passing after somebody widened the predicate, because the
 *    mock would happily answer either one.
 */

import { Test } from '@nestjs/testing';

import {
  NoteSourceNameService,
  noteSourceId,
  noteSourceNameKey,
} from '../../src/notes/note-source-name.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

const USER = 'user-1';

function note(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    ...overrides,
  } as never;
}

describe('NoteSourceNameService (#192)', () => {
  let service: NoteSourceNameService;

  beforeEach(async () => {
    resetPrismaMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NoteSourceNameService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = moduleRef.get(NoteSourceNameService);

    prismaMock.transcript.findMany.mockResolvedValue([]);
    prismaMock.note.findMany.mockResolvedValue([]);
    prismaMock.storageObject.findMany.mockResolvedValue([]);
  });

  describe('noteSourceId', () => {
    it('reads the column its discriminant names', () => {
      expect(noteSourceId(note())).toBe('t1');
      expect(
        noteSourceId(note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'n9' })),
      ).toBe('n9');
      expect(
        noteSourceId(
          note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'o9' }),
        ),
      ).toBe('o9');
    });

    it('answers null for a row whose discriminant and columns disagree', () => {
      // The schema permits it and nothing should produce it; the resolver must
      // skip such a row rather than look up `null`.
      expect(noteSourceId(note({ sourceTranscriptId: null }))).toBeNull();
    });
  });

  describe('bounded queries', () => {
    it('issues ONE query for twenty notes from twenty different transcripts', async () => {
      const notes = Array.from({ length: 20 }, (_, i) =>
        note({ sourceTranscriptId: `t${i}` }),
      );

      await service.resolve(notes, USER);

      expect(prismaMock.transcript.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.transcript.findMany.mock.calls[0][0].where.id.in).toHaveLength(20);
    });

    it('deduplicates ids, so twenty notes from ONE transcript ask for one', async () => {
      const notes = Array.from({ length: 20 }, () => note({ sourceTranscriptId: 't1' }));

      await service.resolve(notes, USER);

      expect(prismaMock.transcript.findMany.mock.calls[0][0].where.id.in).toEqual(['t1']);
    });

    it('issues at most three queries for a page mixing all three source kinds', async () => {
      await service.resolve(
        [
          note(),
          note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'n1' }),
          note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'o1' }),
        ],
        USER,
      );

      expect(prismaMock.transcript.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.note.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.storageObject.findMany).toHaveBeenCalledTimes(1);
    });

    it('issues NO query for a kind the page does not reference', async () => {
      await service.resolve([note()], USER);

      expect(prismaMock.transcript.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.note.findMany).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.findMany).not.toHaveBeenCalled();
    });

    it('issues nothing at all for an empty page — what `summary` hands it routinely', async () => {
      const names = await service.resolve([], USER);

      expect(names.size).toBe(0);
      expect(prismaMock.transcript.findMany).not.toHaveBeenCalled();
      expect(prismaMock.note.findMany).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.findMany).not.toHaveBeenCalled();
    });

    it('skips a row whose discriminant and columns disagree', async () => {
      await service.resolve([note({ sourceTranscriptId: null })], USER);

      expect(prismaMock.transcript.findMany).not.toHaveBeenCalled();
    });
  });

  describe('⚠ access scoping — the predicates, not just the answers', () => {
    it('reaches a transcript only when the caller OWNS or is SHARED it', async () => {
      await service.resolve([note()], USER);

      const where = prismaMock.transcript.findMany.mock.calls[0][0].where;

      expect(where.deletedAt).toBeNull();
      expect(where.OR).toEqual([
        { ownerId: USER },
        { shares: { some: { userId: USER } } },
      ]);
    });

    it('reaches a source NOTE only when the caller owns it', async () => {
      // There is no note share table in this epic and deliberately no
      // `notes:read_any` anywhere in the design, for any role.
      await service.resolve(
        [note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'n1' })],
        USER,
      );

      const where = prismaMock.note.findMany.mock.calls[0][0].where;

      expect(where.ownerId).toBe(USER);
      expect(where.deletedAt).toBeNull();
    });

    it('reaches an uploaded DOCUMENT only when the caller uploaded it', async () => {
      // `managed_by: 'notes'` hides these from the generic storage list, not
      // from a read by id — the uploader is still the only person entitled to
      // the filename.
      await service.resolve(
        [note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'o1' })],
        USER,
      );

      expect(prismaMock.storageObject.findMany.mock.calls[0][0].where.uploadedById).toBe(USER);
    });

    it('answers NOTHING for a source the predicate excluded — no title leaks', async () => {
      // The database returns no row for a transcript the caller was unshared
      // from, so the key is simply absent and every consumer falls through to
      // the category noun. Absent, never a uuid and never a partial answer.
      prismaMock.transcript.findMany.mockResolvedValue([]);

      const names = await service.resolve([note()], USER);

      expect(names.has(noteSourceNameKey('transcript', 't1'))).toBe(false);
      expect(names.size).toBe(0);
    });
  });

  describe('the answers', () => {
    it('keys names by TYPE and id, so two tables cannot collide', async () => {
      // These ids are uuids from three different tables; nothing stops one
      // matching another, and a bare-id key would label one row with another
      // table's title.
      prismaMock.transcript.findMany.mockResolvedValue([{ id: 'same', title: 'A transcript' }]);
      prismaMock.note.findMany.mockResolvedValue([{ id: 'same', title: 'A note' }]);

      const names = await service.resolve(
        [
          note({ sourceTranscriptId: 'same' }),
          note({ sourceType: 'note', sourceTranscriptId: null, sourceNoteId: 'same' }),
        ],
        USER,
      );

      expect(names.get(noteSourceNameKey('transcript', 'same'))).toBe('A transcript');
      expect(names.get(noteSourceNameKey('note', 'same'))).toBe('A note');
    });

    it('uses a document\'s filename as its name', async () => {
      prismaMock.storageObject.findMany.mockResolvedValue([
        { id: 'o1', name: 'board-pack.pdf' },
      ]);

      const names = await service.resolve(
        [note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'o1' })],
        USER,
      );

      expect(names.get(noteSourceNameKey('document', 'o1'))).toBe('board-pack.pdf');
    });
  });

  describe('resolveOne', () => {
    it('answers the one name for a single note', async () => {
      prismaMock.transcript.findMany.mockResolvedValue([{ id: 't1', title: 'Q3 planning' }]);

      expect(await service.resolveOne(note(), USER)).toBe('Q3 planning');
    });

    it('answers null for an unreadable source, and queries nothing for a broken row', async () => {
      expect(await service.resolveOne(note(), USER)).toBeNull();

      expect(await service.resolveOne(note({ sourceTranscriptId: null }), USER)).toBeNull();
      expect(prismaMock.transcript.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
