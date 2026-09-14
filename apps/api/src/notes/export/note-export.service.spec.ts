import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { hashExportRequest } from '../../export/export-options';
import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NoteAccessService } from '../access/note-access.service';
import { NOTE_EXPORT_JOB_TYPE } from '../job-types';
import type { NoteObjectsService } from '../note-objects.service';
import { MarkdownNoteExporter } from './markdown.exporter';
import { NoteExportService, NOTE_EXPORT_JOB_PRIORITY } from './note-export.service';
import { NoteExporterRegistry } from './note-exporter.registry';
import { PdfNoteExporter } from './pdf.exporter';
import { WordNoteExporter } from './word.exporter';

// =============================================================================
// NoteExportService (issue #54, docs/specs/notes.md §8.4)
// =============================================================================
//
// The decisions this file makes that no renderer can make for it: which row to
// reuse, what the options hash is over, which statuses are reusable, and what
// the job is enqueued with. The real end-to-end reuse — a render counter and a
// row id across a real database — is `test/notes/note-export.db.spec.ts`; this
// suite pins the rules themselves.
// =============================================================================

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const USER: RequestUser = {
  id: 'owner-1',
  email: 'owner@example.test',
  roles: ['Contributor'],
  permissions: [PERMISSIONS.NOTES_READ, PERMISSIONS.NOTES_WRITE],
  isActive: true,
};

describe('NoteExportService', () => {
  let prisma: {
    noteExport: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    auditEvent: { create: jest.Mock };
  };
  let access: { require: jest.Mock };
  let objects: { signedUrlFor: jest.Mock };
  let handlers: { get: jest.Mock };
  let jobs: { enqueue: jest.Mock };
  let service: NoteExportService;

  const note = {
    id: NOTE_ID,
    title: 'Weekly Sync Recap',
    currentVersion: 3,
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'export-1',
    noteId: NOTE_ID,
    version: 3,
    format: 'markdown',
    options: { includeFrontMatter: true },
    optionsHash: 'hash',
    status: 'pending',
    objectId: null,
    jobId: null,
    requestedById: USER.id,
    error: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      noteExport: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => row(data)),
        update: jest.fn().mockImplementation(async ({ data }) => row(data)),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    access = { require: jest.fn().mockResolvedValue({ note, role: 'owner' }) };
    objects = { signedUrlFor: jest.fn().mockResolvedValue(null) };
    handlers = { get: jest.fn().mockReturnValue({ type: NOTE_EXPORT_JOB_TYPE }) };
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const registry = new NoteExporterRegistry();

    for (const exporter of [
      new MarkdownNoteExporter(registry),
      new PdfNoteExporter(registry),
      new WordNoteExporter(registry),
    ]) {
      exporter.onModuleInit();
    }

    service = new NoteExportService(
      prisma as unknown as PrismaService,
      access as unknown as NoteAccessService,
      objects as unknown as NoteObjectsService,
      registry,
      handlers as unknown as JobHandlerRegistry,
      jobs as unknown as JobsService,
    );
  });

  describe('listExporters', () => {
    it('publishes the three formats with the options each accepts', () => {
      const { exporters } = service.listExporters();

      expect(exporters.map((exporter) => exporter.format)).toEqual(['docx', 'markdown', 'pdf']);
      expect(exporters[1]?.options.map((option) => option.key)).toEqual(['includeFrontMatter']);
    });
  });

  describe('requestExport', () => {
    it('queues a render and links the job back onto the row', async () => {
      const result = await service.requestExport(NOTE_ID, { format: 'pdf' }, USER);

      expect(result.created).toBe(true);
      expect(result.export.reused).toBe(false);
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NOTE_EXPORT_JOB_TYPE,
          subjectId: NOTE_ID,
          priority: NOTE_EXPORT_JOB_PRIORITY,
          // ⚠ Three formats of one note are legitimately distinct work; the
          // queue's subject-scoped dedup key would collapse them into one.
          skipDedup: true,
        }),
      );
      expect(prisma.noteExport.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { jobId: 'job-1' } }),
      );
    });

    it('requires edit access, so `notes:write` is enforced in one place', async () => {
      await service.requestExport(NOTE_ID, { format: 'pdf' }, USER);

      expect(access.require).toHaveBeenCalledWith(USER.id, NOTE_ID, 'edit', USER.permissions);
    });

    it('defaults to the current version and refuses one that does not exist', async () => {
      await service.requestExport(NOTE_ID, { format: 'pdf' }, USER);

      expect(prisma.noteExport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ version: 3 }) }),
      );

      await expect(
        service.requestExport(NOTE_ID, { format: 'pdf', version: 9 }, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('hashes the options AS PARSED, so an omitted key and its default agree', async () => {
      // The property content-addressed reuse rests on: `{}` and
      // `{"includeFrontMatter": true}` describe the same file, so they must
      // produce the same key or the identical document renders twice.
      await service.requestExport(NOTE_ID, { format: 'markdown' }, USER);
      await service.requestExport(
        NOTE_ID,
        { format: 'markdown', options: { includeFrontMatter: true } },
        USER,
      );

      const [first, second] = prisma.noteExport.create.mock.calls.map(
        (call) => call[0].data.optionsHash as string,
      );

      expect(first).toBe(second);
      expect(first).toBe(
        hashExportRequest({
          format: 'markdown',
          version: 3,
          options: { includeFrontMatter: true },
        }),
      );
    });

    it('gives a different hash to different options and to a different version', async () => {
      await service.requestExport(NOTE_ID, { format: 'markdown' }, USER);
      await service.requestExport(
        NOTE_ID,
        { format: 'markdown', options: { includeFrontMatter: false } },
        USER,
      );
      await service.requestExport(NOTE_ID, { format: 'markdown', version: 2 }, USER);

      const hashes = prisma.noteExport.create.mock.calls.map(
        (call) => call[0].data.optionsHash as string,
      );

      expect(new Set(hashes).size).toBe(3);
    });

    it('reuses an existing unexpired row instead of rendering again', async () => {
      prisma.noteExport.findFirst.mockResolvedValue(row({ id: 'existing-1', status: 'ready' }));

      const result = await service.requestExport(NOTE_ID, { format: 'markdown' }, USER);

      expect(result.created).toBe(false);
      expect(result.export.id).toBe('existing-1');
      expect(result.export.reused).toBe(true);
      expect(prisma.noteExport.create).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('never reuses a `failed` row, and never an expired one', async () => {
      await service.requestExport(NOTE_ID, { format: 'markdown' }, USER);

      const where = prisma.noteExport.findFirst.mock.calls[0]?.[0].where;

      // "You asked for this before and it broke" is not an answer to "please
      // export this" — a retry must actually retry.
      expect(where.status).toEqual({ in: ['pending', 'ready'] });
      expect(where.expiresAt.gt).toBeInstanceOf(Date);
    });

    it('refuses an unknown format with a 400 naming the ones that exist', async () => {
      await expect(
        service.requestExport(NOTE_ID, { format: 'rtf' }, USER),
      ).rejects.toThrow(/Available formats: docx, markdown, pdf/);
      await expect(
        service.requestExport(NOTE_ID, { format: 'rtf' }, USER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an option the chosen format does not accept', async () => {
      // Stripping would be friendlier to a stale client and worse for everybody
      // else: the typo'd request hashes to the SAME key as the default one, so
      // it would also be handed back somebody else's already-rendered file.
      await expect(
        service.requestExport(
          NOTE_ID,
          { format: 'markdown', options: { includeFrontmatter: true } },
          USER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the row failed rather than queueing when no handler is registered', async () => {
      // `job-types.ts`'s registry guard: a build without the handler must queue
      // nothing rather than leave a `pending` export spinning forever.
      handlers.get.mockReturnValue(undefined);

      const result = await service.requestExport(NOTE_ID, { format: 'pdf' }, USER);

      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(result.export.status).toBe('failed');
    });

    it('records one audit row per queued export', async () => {
      await service.requestExport(NOTE_ID, { format: 'docx' }, USER);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'note:export', targetId: NOTE_ID }),
        }),
      );
    });
  });

  describe('download', () => {
    it('404s for an export id that does not exist', async () => {
      await expect(service.download('missing', USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('authorises the NOTE the export belongs to, not the export id', async () => {
      // The export id must not become an oracle for the existence of somebody
      // else's note, so access is decided on the note behind the row.
      prisma.noteExport.findUnique.mockResolvedValue(row({ status: 'ready', objectId: 'obj-1' }));
      access.require.mockRejectedValue(new NotFoundException('Note not found'));

      await expect(service.download('export-1', USER)).rejects.toThrow('Note not found');
    });

    it('404s while the export is still rendering', async () => {
      prisma.noteExport.findUnique.mockResolvedValue(row({ status: 'pending' }));

      await expect(service.download('export-1', USER)).rejects.toThrow('still rendering');
    });

    it('signs the filename INTO the url as a content disposition', async () => {
      prisma.noteExport.findUnique.mockResolvedValue(row({ status: 'ready', objectId: 'obj-1' }));
      objects.signedUrlFor.mockResolvedValue({
        url: 'https://signed.example/get',
        expiresAt: new Date('2026-09-14T05:00:00.000Z'),
        object: { size: BigInt(2048) },
      });

      const result = await service.download('export-1', USER);

      expect(result.filename).toBe('Weekly Sync Recap (v3).md');
      expect(result.sizeBytes).toBe('2048');
      expect(objects.signedUrlFor).toHaveBeenCalledWith(
        'obj-1',
        expect.any(Number),
        expect.stringContaining('attachment; filename="Weekly Sync Recap (v3).md"'),
      );
    });
  });

  describe('listExports', () => {
    it('lists this note\'s exports newest first, after authorising the note', async () => {
      prisma.noteExport.findMany.mockResolvedValue([row(), row({ id: 'export-2' })]);

      const result = await service.listExports(NOTE_ID, USER);

      expect(result.exports.map((entry) => entry.id)).toEqual(['export-1', 'export-2']);
      expect(prisma.noteExport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { noteId: NOTE_ID }, orderBy: { createdAt: 'desc' } }),
      );
    });
  });
});
