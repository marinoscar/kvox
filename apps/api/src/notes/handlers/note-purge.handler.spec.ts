import { Test } from '@nestjs/testing';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTE_PURGE_JOB_TYPE } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import { NotePurgeHandler, readNoteId } from './note-purge.handler';

// =============================================================================
// `note.purge` (issue #53, epic #45)
// =============================================================================
//
// THE ASSERTION PAIR THIS FILE EXISTS FOR, and they are the two halves of one
// decision:
//
//   • the source document IS deleted when this note was the last thing
//     referencing it; and
//   • it is NOT deleted while another note still points at it — because
//     `notes.source_object_id` is `Restrict` and PostgreSQL would refuse
//     anyway, so checking first turns a foreign-key violation into a skip.
//
// Plus the one thing a purge must never do: touch the source TRANSCRIPT. A note
// is derived FROM a recording; deleting the derivative must not delete the
// evidence.
// =============================================================================

const NOTE_ID = 'note-1';
const JOB_ID = 'job-1';
const SOURCE_OBJECT = 'object-source';
const EXTRACTED_OBJECT = 'object-extracted';
const EXPORT_OBJECT = 'object-export';

describe('NotePurgeHandler', () => {
  let handler: NotePurgeHandler;
  let prisma: any;
  let objects: { deleteIfPresent: jest.Mock };
  let registry: { register: jest.Mock };

  const job = (payload: unknown = { noteId: NOTE_ID }) =>
    ({ id: JOB_ID, payload }) as never;

  beforeEach(async () => {
    prisma = {
      note: {
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      noteExport: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          metadata: { extractedObjectId: EXTRACTED_OBJECT },
        }),
      },
      transcript: { delete: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    };

    objects = { deleteIfPresent: jest.fn().mockResolvedValue(true) };
    registry = { register: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        NotePurgeHandler,
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: NoteObjectsService, useValue: objects },
      ],
    }).compile();

    handler = module.get(NotePurgeHandler);
  });

  it('registers itself under the permanent type string', () => {
    handler.onModuleInit();

    expect(handler.type).toBe(NOTE_PURGE_JOB_TYPE);
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is server-only — it declares neither node member, so no node can claim it', () => {
    // Eligibility is DERIVED from the presence of both members; there is no
    // flag that could disagree with the derivation.
    const members = handler as unknown as Record<string, unknown>;

    expect(members.nodeResultSchema).toBeUndefined();
    expect(members.persistNodeResult).toBeUndefined();
  });

  it('deletes the exports, the rows, and the source document that nothing else names', async () => {
    prisma.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      sourceType: 'document',
      sourceObjectId: SOURCE_OBJECT,
      exports: [{ id: 'export-1', objectId: EXPORT_OBJECT }],
    });

    await handler.process(job());

    // The export's reference is cleared before its bytes — `object_id` is
    // `Restrict`, so the storage row cannot go while the export points at it.
    expect(prisma.noteExport.updateMany).toHaveBeenCalled();
    expect(objects.deleteIfPresent).toHaveBeenCalledWith(EXPORT_OBJECT);

    expect(prisma.note.delete).toHaveBeenCalledWith({ where: { id: NOTE_ID } });

    // The extraction and the upload, in that order.
    expect(objects.deleteIfPresent).toHaveBeenCalledWith(EXTRACTED_OBJECT);
    expect(objects.deleteIfPresent).toHaveBeenCalledWith(SOURCE_OBJECT);
  });

  it('KEEPS the source document while another note still references it', async () => {
    prisma.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      sourceType: 'document',
      sourceObjectId: SOURCE_OBJECT,
      exports: [],
    });
    prisma.note.count.mockResolvedValue(1);

    await handler.process(job());

    expect(objects.deleteIfPresent).not.toHaveBeenCalledWith(SOURCE_OBJECT);
    expect(objects.deleteIfPresent).not.toHaveBeenCalledWith(EXTRACTED_OBJECT);

    // ⚠ ASKED AFTER THE ROW IS GONE. "Does anything STILL reference this" would
    // answer "yes" forever if the row being purged were one of the referrers.
    expect(prisma.note.delete).toHaveBeenCalled();
    expect(prisma.note.count.mock.calls[0][0].where).toEqual({
      sourceObjectId: SOURCE_OBJECT,
      id: { not: NOTE_ID },
    });
  });

  it('NEVER touches the source transcript', async () => {
    prisma.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      sourceType: 'transcript',
      sourceTranscriptId: 'transcript-1',
      sourceObjectId: null,
      exports: [],
    });

    await handler.process(job());

    // A note is derived FROM a recording. Deleting the derivative must never
    // delete the evidence — that is what `Restrict` on the pointer is for, and
    // this handler does not reach through it in either direction.
    expect(prisma.transcript.delete).not.toHaveBeenCalled();
    expect(prisma.transcript.update).not.toHaveBeenCalled();
    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    expect(objects.deleteIfPresent).not.toHaveBeenCalled();
  });

  it('is a no-op for a note that is already gone, so a retry is safe', async () => {
    prisma.note.findUnique.mockResolvedValue(null);

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(prisma.note.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['a string', 'note-1'],
    ['an array', ['note-1']],
    ['an object with the wrong field', { transcriptId: 'note-1' }],
  ])('returns successfully for a payload that is %s', async (_label, payload) => {
    await expect(handler.process(job(payload))).resolves.toBeUndefined();

    expect(prisma.note.findUnique).not.toHaveBeenCalled();
  });

  it('reads a note id out of a payload, totally', () => {
    expect(readNoteId({ noteId: NOTE_ID })).toBe(NOTE_ID);
    expect(readNoteId({ noteId: '' })).toBeNull();
    expect(readNoteId({ noteId: 7 } as never)).toBeNull();
    expect(readNoteId(null)).toBeNull();
  });
});
