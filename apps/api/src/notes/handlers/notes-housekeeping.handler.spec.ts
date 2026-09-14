import { Test } from '@nestjs/testing';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTES_HOUSEKEEPING_JOB_TYPE, NOTE_PURGE_JOB_TYPE } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import { NotesService } from '../notes.service';
import { NotesHousekeepingHandler } from './notes-housekeeping.handler';

// =============================================================================
// `notes.housekeeping` (issue #53, epic #45)
// =============================================================================
//
// Three steps, and one property that matters more than any of them: NO STEP MAY
// THROW PAST THE OTHERS. A sweep that aborted on the first bad row would let one
// damaged note stop every other note from ever being reconciled — the classic
// failure of a housekeeping job that trusts its own input.
// =============================================================================

const JOB = { id: 'job-1', payload: null } as never;

describe('NotesHousekeepingHandler', () => {
  let handler: NotesHousekeepingHandler;
  let prisma: any;
  let objects: { deleteIfPresent: jest.Mock };
  let notes: { enqueuePurge: jest.Mock };

  beforeEach(async () => {
    prisma = {
      noteGeneration: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      noteExport: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      note: { findMany: jest.fn().mockResolvedValue([]) },
      job: { findMany: jest.fn().mockResolvedValue([]) },
    };

    objects = { deleteIfPresent: jest.fn().mockResolvedValue(true) };
    notes = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        NotesHousekeepingHandler,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: NoteObjectsService, useValue: objects },
        { provide: NotesService, useValue: notes },
      ],
    }).compile();

    handler = module.get(NotesHousekeepingHandler);
  });

  it('is the type the cron queues', () => {
    expect(handler.type).toBe(NOTES_HOUSEKEEPING_JOB_TYPE);
  });

  it('hard-deletes expired PREVIEW generations, and only previews', async () => {
    prisma.noteGeneration.findMany.mockResolvedValue([{ id: 'gen-1' }]);
    prisma.noteGeneration.deleteMany.mockResolvedValue({ count: 1 });

    await handler.process(JOB);

    // A preview has no note, no version and nothing referencing it, which is
    // why it is hard-deleted rather than given an `expired` status: there is
    // nothing a soft expiry would need to be visible to.
    expect(prisma.noteGeneration.findMany.mock.calls[0][0].where.kind).toBe('preview');
    expect(prisma.noteGeneration.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['gen-1'] } },
    });
  });

  it('expires an export reference-first, then bytes, then row', async () => {
    prisma.noteExport.findMany.mockResolvedValue([{ id: 'export-1', objectId: 'object-1' }]);

    await handler.process(JOB);

    // `object_id` is `Restrict`: the storage row cannot go while the export
    // points at it.
    expect(prisma.noteExport.update).toHaveBeenCalledWith({
      where: { id: 'export-1' },
      data: { objectId: null },
    });
    expect(objects.deleteIfPresent).toHaveBeenCalledWith('object-1');
    expect(prisma.noteExport.delete).toHaveBeenCalledWith({ where: { id: 'export-1' } });
  });

  it('re-queues a purge for a note stuck in `deleting` with no job', async () => {
    prisma.note.findMany.mockResolvedValue([{ id: 'note-1' }]);

    await handler.process(JOB);

    expect(prisma.job.findMany.mock.calls[0][0].where.type).toBe(NOTE_PURGE_JOB_TYPE);
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-1');
  });

  it('leaves a note alone while its purge is still pending or running', async () => {
    prisma.note.findMany.mockResolvedValue([{ id: 'note-1' }]);
    prisma.job.findMany.mockResolvedValue([{ subjectId: 'note-1' }]);

    await handler.process(JOB);

    expect(notes.enqueuePurge).not.toHaveBeenCalled();
  });

  it('runs every step even when one fails, then reports the failure', async () => {
    prisma.noteGeneration.findMany.mockRejectedValue(new Error('previews exploded'));
    prisma.noteExport.findMany.mockResolvedValue([{ id: 'export-1', objectId: null }]);
    prisma.note.findMany.mockResolvedValue([{ id: 'note-1' }]);

    await expect(handler.process(JOB)).rejects.toThrow(/previews exploded/);

    // ⚠ THE LATER STEPS STILL RAN. This is the property the file exists for.
    expect(prisma.noteExport.delete).toHaveBeenCalled();
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-1');
  });
});
