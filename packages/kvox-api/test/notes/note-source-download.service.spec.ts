import { NotFoundException } from '@nestjs/common';

import { NoteAccessService } from '../../src/notes/access/note-access.service.js';
import type { KvoxNotesDb } from '../../src/notes/data/notes-db.js';
import type { NoteObjectsService } from '../../src/notes/note-objects.service.js';
import {
  NOTE_SOURCE_DOWNLOAD_TTL_SECONDS,
  NoteSourceDownloadService,
  noteSourceFilename,
} from '../../src/notes/note-source-download.service.js';
import type { NotesActor } from '../../src/notes/notes-actor.js';
import { NOTES_READ_PERMISSION } from '../../src/notes/notes.permissions.js';

// GET /api/notes/:id/source (#732): owner-only, 404 for every "nothing to hand back".

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER: NotesActor = { id: 'owner-1', permissions: [NOTES_READ_PERMISSION] };
const STRANGER: NotesActor = { id: 'owner-2', permissions: [NOTES_READ_PERMISSION] };

describe('NoteSourceDownloadService', () => {
  let note: Record<string, unknown> | null;
  let prisma: { note: { findUnique: jest.Mock }; noteVersion: { findUnique: jest.Mock } };
  let objects: { describe: jest.Mock; signedUrlFor: jest.Mock };
  let service: NoteSourceDownloadService;

  beforeEach(() => {
    note = {
      id: NOTE_ID,
      ownerId: OWNER.id,
      deletedAt: null,
      currentVersion: 3,
      sourceType: 'document',
      sourceObjectId: 'obj-1',
    };
    prisma = {
      note: { findUnique: jest.fn(async () => note) },
      noteVersion: {
        findUnique: jest.fn(async ({ where }: { where: { noteId_version: { version: number } } }) =>
          where.noteId_version.version <= 3 ? { id: 'v' } : null,
        ),
      },
    };
    objects = {
      describe: jest.fn().mockResolvedValue({ id: 'obj-1', name: 'Q3: plan/draft.docx' }),
      signedUrlFor: jest.fn().mockResolvedValue({
        url: 'https://signed.example/obj-1',
        expiresAt: new Date('2026-10-24T12:15:00.000Z'),
        object: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 },
      }),
    };
    const db = prisma as unknown as KvoxNotesDb;

    service = new NoteSourceDownloadService(
      db,
      new NoteAccessService(db),
      objects as unknown as NoteObjectsService,
    );
  });

  it('gives the owner a signed URL with the sanitized original filename', async () => {
    const result = await service.download(NOTE_ID, OWNER);

    expect(result).toEqual({
      url: 'https://signed.example/obj-1',
      filename: 'Q3- plan-draft.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      expiresAt: '2026-10-24T12:15:00.000Z',
    });
    expect(objects.signedUrlFor).toHaveBeenCalledWith(
      'obj-1',
      NOTE_SOURCE_DOWNLOAD_TTL_SECONDS,
      'Q3- plan-draft.docx',
    );
  });

  it('answers 404 to another user, and for a missing or deleted note', async () => {
    await expect(service.download(NOTE_ID, STRANGER)).rejects.toBeInstanceOf(NotFoundException);

    note = { ...note, deletedAt: new Date() };
    await expect(service.download(NOTE_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);

    note = null;
    await expect(service.download(NOTE_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(objects.signedUrlFor).not.toHaveBeenCalled();
  });

  it('answers 404 for a note with no source document', async () => {
    note = { ...note, sourceType: 'transcript', sourceObjectId: null };

    await expect(service.download(NOTE_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when the object is gone or not ready', async () => {
    objects.signedUrlFor.mockResolvedValue(null);
    await expect(service.download(NOTE_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);

    objects.describe.mockResolvedValue(null);
    await expect(service.download(NOTE_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 for an unknown version and accepts an existing one', async () => {
    await expect(service.download(NOTE_ID, OWNER, 9)).rejects.toBeInstanceOf(NotFoundException);

    await expect(service.download(NOTE_ID, OWNER, 2)).resolves.toMatchObject({ filename: 'Q3- plan-draft.docx' });
    expect(prisma.noteVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { noteId_version: { noteId: NOTE_ID, version: 2 } } }),
    );

    // The current version needs no lookup.
    prisma.noteVersion.findUnique.mockClear();
    await service.download(NOTE_ID, OWNER, 3);
    expect(prisma.noteVersion.findUnique).not.toHaveBeenCalled();
  });
});

describe('noteSourceFilename', () => {
  it('replaces unsafe characters, falls back to "source" and bounds the length keeping the extension', () => {
    expect(noteSourceFilename('a\u0000b"c.pdf')).toBe('a b-c.pdf');
    expect(noteSourceFilename('')).toBe('source');
    expect(noteSourceFilename(null)).toBe('source');

    const long = noteSourceFilename(`${'x'.repeat(400)}.docx`);

    expect(long.length).toBe(200);
    expect(long.endsWith('.docx')).toBe(true);
  });
});
