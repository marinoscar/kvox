import { PassThrough } from 'node:stream';
import type { Job, NoteExport } from '@prisma/client';

import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NoteExportService } from '../export/note-export.service';
import { noteDocument } from '../export/__fixtures__/note-document';
import { NOTE_EXPORT_JOB_TYPE } from '../job-types';
import type { NoteObjectsService } from '../note-objects.service';
import { NoteExportHandler, alreadyDone } from './note-export.handler';

// =============================================================================
// `note.export` (issue #54, docs/specs/notes.md §8.5)
// =============================================================================
//
// Four properties the handler is responsible for and nothing else is:
//
//   1. IT IS SERVER-ONLY, declaring NEITHER `nodeResultSchema` NOR
//      `persistNodeResult` — never exactly one. The renderers live in the API,
//      and a second copy in `apps/cli` would make one content-addressed export
//      request produce different bytes depending on which codebase claimed it.
//   2. A SECOND ATTEMPT ON A FINISHED EXPORT IS A NO-OP. Attempts are charged
//      at claim time, so a worker killed mid-render leaves a row the reaper
//      requeues — and re-rendering would orphan the object the first run wrote.
//   3. THE ROW IS MARKED FAILED **AND** THE JOB STILL THROWS. Recording one
//      without the other leaves an export `pending` forever beside a `failed`
//      job, or the reverse.
//   4. BOTH THE RENDER AND THE UPLOAD ARE AWAITED. Awaiting only one reports
//      success on a failure of the other.
// =============================================================================

const JOB: Job = { id: 'job-1', payload: { exportId: 'export-1' } } as unknown as Job;

const row = (overrides: Partial<NoteExport> = {}): NoteExport =>
  ({
    id: 'export-1',
    noteId: 'note-1',
    version: 3,
    format: 'markdown',
    options: {},
    optionsHash: 'hash',
    status: 'pending',
    objectId: null,
    jobId: 'job-1',
    requestedById: 'owner-1',
    error: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  }) as NoteExport;

describe('NoteExportHandler', () => {
  let prisma: { noteExport: { findUnique: jest.Mock; update: jest.Mock } };
  let exports: {
    exporterFor: jest.Mock;
    buildDocument: jest.Mock;
    optionsOf: jest.Mock;
    filenameFor: jest.Mock;
  };
  let objects: { putStream: jest.Mock };
  let handler: NoteExportHandler;
  let render: jest.Mock;
  let uploaded: { id: string; size: bigint };

  beforeEach(() => {
    uploaded = { id: 'object-1', size: BigInt(1234) };

    render = jest.fn(async (_doc: unknown, _options: unknown, out: PassThrough) => {
      out.end('rendered');
    });

    prisma = {
      noteExport: {
        findUnique: jest.fn().mockResolvedValue(row()),
        update: jest.fn().mockResolvedValue(row()),
      },
    };

    exports = {
      exporterFor: jest.fn().mockReturnValue({ render, extension: 'md', mimeType: 'text/markdown' }),
      buildDocument: jest.fn().mockResolvedValue(noteDocument()),
      optionsOf: jest.fn().mockReturnValue({ includeFrontMatter: true }),
      filenameFor: jest.fn().mockReturnValue('Weekly Sync Recap (v3).md'),
    };

    objects = {
      putStream: jest.fn(() => {
        const body = new PassThrough();

        body.resume();
        // The real `putStream` attaches one too — see its comment: an `error`
        // event with no listener is an uncaught exception, not a failed job.
        body.on('error', () => undefined);

        return { body, done: Promise.resolve(uploaded) };
      }),
    };

    handler = new NoteExportHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      prisma as unknown as PrismaService,
      exports as unknown as NoteExportService,
      objects as unknown as NoteObjectsService,
    );
  });

  it('declares neither node member, so no node can ever claim it', () => {
    // `JobHandlerRegistry.serverOnlyTypes()` derives eligibility from these two
    // being present TOGETHER; there is no flag to set inconsistently.
    const members = handler as unknown as Record<string, unknown>;

    expect(members.nodeResultSchema).toBeUndefined();
    expect(members.persistNodeResult).toBeUndefined();
  });

  it('declares the profile spec §8.5 specifies', () => {
    expect(handler.type).toBe(NOTE_EXPORT_JOB_TYPE);
    expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60 * 1000, maxAttempts: 2 });
  });

  it('renders, uploads to a key derived from the row, and marks the export ready', async () => {
    await handler.process(JOB);

    expect(objects.putStream).toHaveBeenCalledWith(
      // A PURE FUNCTION OF THE ROW, so a retry overwrites the first attempt's
      // bytes rather than leaving an orphan at a random key.
      expect.objectContaining({ storageKey: 'notes/note-1/exports/export-1.md' }),
    );
    expect(render).toHaveBeenCalled();
    expect(prisma.noteExport.update).toHaveBeenCalledWith({
      where: { id: 'export-1' },
      data: { status: 'ready', objectId: 'object-1', error: null },
    });
  });

  it('does nothing for a job naming no export, or an export that is gone', async () => {
    await handler.process({ id: 'job-2', payload: {} } as unknown as Job);

    prisma.noteExport.findUnique.mockResolvedValue(null);
    await handler.process(JOB);

    expect(render).not.toHaveBeenCalled();
    expect(prisma.noteExport.update).not.toHaveBeenCalled();
  });

  it('leaves a finished export alone on a second attempt', async () => {
    prisma.noteExport.findUnique.mockResolvedValue(row({ status: 'ready', objectId: 'object-1' }));

    await handler.process(JOB);

    expect(render).not.toHaveBeenCalled();
    expect(prisma.noteExport.update).not.toHaveBeenCalled();
  });

  it('marks the row failed AND rethrows when the render fails', async () => {
    render.mockImplementation(async (_doc, _options, out: PassThrough) => {
      out.destroy(new Error('renderer exploded'));

      throw new Error('renderer exploded');
    });

    await expect(handler.process(JOB)).rejects.toThrow('renderer exploded');
    expect(prisma.noteExport.update).toHaveBeenCalledWith({
      where: { id: 'export-1' },
      data: { status: 'failed', error: 'renderer exploded' },
    });
  });

  it('fails with a named error when this build registers no such format', async () => {
    // A row written by a deployment with a plugin exporter, or a fork's format
    // on a framework build — a domain failure, not an undefined dereference.
    exports.exporterFor.mockReturnValue(undefined);

    await expect(handler.process(JOB)).rejects.toThrow(
      /No exporter is registered for format "markdown"/,
    );
  });

  it('fails when the upload fails even though the render succeeded', async () => {
    // Awaiting only the render would report success on a file that never
    // reached storage.
    objects.putStream.mockImplementation(() => {
      const body = new PassThrough();

      body.resume();
      body.on('error', () => undefined);

      return { body, done: Promise.reject(new Error('bucket unreachable')) };
    });

    await expect(handler.process(JOB)).rejects.toThrow('bucket unreachable');
    expect(prisma.noteExport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});

describe('alreadyDone', () => {
  it('is true only for a ready row that actually has an object', () => {
    expect(alreadyDone(row({ status: 'ready', objectId: 'object-1' }))).toBe(true);
    // `ready` with no object is a row a crash left half-written; re-rendering
    // it is exactly right.
    expect(alreadyDone(row({ status: 'ready', objectId: null }))).toBe(false);
    expect(alreadyDone(row({ status: 'failed', objectId: 'object-1' }))).toBe(false);
  });
});
