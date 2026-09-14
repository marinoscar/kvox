import { PassThrough } from 'node:stream';
import type { Job, StorageObject, TranscriptExport } from '@prisma/client';

import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TranscriptObjectsService } from '../transcript-objects.service';
import type { TranscriptExportService } from '../export/transcript-export.service';
import { MarkdownTranscriptExporter } from '../export/markdown.exporter';
import { TranscriptExporterRegistry } from '../export/transcript-exporter.interface';
import { fixtureDocument } from '../export/__fixtures__/document';
import {
  EXPORT_MAX_RUNTIME_MS,
  TranscriptExportHandler,
  alreadyDone,
} from './transcript-export.handler';

// =============================================================================
// `transcript.export` (issue #28, epic #19, spec §1.5.6)
// =============================================================================
//
// The acceptance criterion this file carries is "an export survives a worker
// restart (job retry)", which is really two claims: a second attempt after a
// crash mid-render produces the document, and a second attempt after a run that
// SUCCEEDED but never reported back does not render a second copy.
// =============================================================================

const EXPORT_ID = 'exp-1';

function exportRow(overrides: Partial<TranscriptExport> = {}): TranscriptExport {
  return {
    id: EXPORT_ID,
    transcriptId: 'tr-1',
    version: 4,
    format: 'markdown',
    options: { includeTimestamps: true, mergeConsecutive: false },
    optionsHash: 'hash',
    status: 'pending',
    objectId: null,
    jobId: 'job-1',
    requestedById: 'user-1',
    error: null,
    expiresAt: new Date('2026-09-21T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  } as TranscriptExport;
}

const JOB = { id: 'job-1', payload: { exportId: EXPORT_ID } } as unknown as Job;

function build() {
  const registry = new TranscriptExporterRegistry();
  const markdown = new MarkdownTranscriptExporter(registry);

  markdown.onModuleInit();

  const prisma = {
    transcriptExport: {
      findUnique: jest.fn().mockResolvedValue(exportRow()),
      update: jest.fn().mockResolvedValue(exportRow()),
    },
  };

  const exports = {
    exporterFor: jest.fn((format: string) => registry.get(format)),
    buildDocument: jest.fn().mockResolvedValue(fixtureDocument()),
    optionsOf: jest.fn().mockReturnValue({ includeTimestamps: true, mergeConsecutive: false }),
  };

  /** The bytes the render wrote, so a test can assert the document reached storage. */
  const written: Buffer[] = [];

  const objects = {
    putStream: jest.fn(() => {
      const body = new PassThrough();

      const done = new Promise<StorageObject>((resolve) => {
        body.on('data', (chunk: Buffer) => written.push(chunk));
        body.on('end', () =>
          resolve({ id: 'obj-1', size: BigInt(Buffer.concat(written).byteLength) } as StorageObject),
        );
      });

      return { body, done };
    }),
  };

  const handler = new TranscriptExportHandler(
    { register: jest.fn() } as unknown as JobHandlerRegistry,
    prisma as unknown as PrismaService,
    exports as unknown as TranscriptExportService,
    objects as unknown as TranscriptObjectsService,
  );

  return { handler, prisma, exports, objects, registry, written };
}

describe('TranscriptExportHandler', () => {
  it('registers itself for the permanent type string', () => {
    const registry = { register: jest.fn() };
    const handler = new TranscriptExportHandler(
      registry as unknown as JobHandlerRegistry,
      {} as PrismaService,
      {} as TranscriptExportService,
      {} as TranscriptObjectsService,
    );

    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('transcript.export');
  });

  it('declares a five-minute ceiling and two attempts', () => {
    const { handler } = build();

    expect(handler.profile).toEqual({ maxRuntimeMs: EXPORT_MAX_RUNTIME_MS, maxAttempts: 2 });
    expect(EXPORT_MAX_RUNTIME_MS).toBe(5 * 60 * 1000);
  });

  it('is NODE-INELIGIBLE by construction: it carries neither member', () => {
    // Eligibility is derived from `nodeResultSchema` + `persistNodeResult`, so
    // "server-only" is the absence of both rather than a flag somebody could
    // set inconsistently. See the handler's own header for why the renderers
    // staying in the API is the reason.
    const { handler } = build();

    expect(handler).not.toHaveProperty('nodeResultSchema');
    expect(handler).not.toHaveProperty('persistNodeResult');
  });

  it('renders the document and records the object on the row', async () => {
    const { handler, prisma, objects, written } = build();

    await handler.process(JOB);

    expect(objects.putStream).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: 'transcripts/tr-1/exports/exp-1.md',
        mimeType: 'text/markdown; charset=utf-8',
        ownerId: 'user-1',
        name: 'Weekly sync — Sept 10 (v4).md',
      }),
    );

    expect(Buffer.concat(written).toString('utf8')).toContain('**José Núñez** · 00:00:00');

    expect(prisma.transcriptExport.update).toHaveBeenCalledWith({
      where: { id: EXPORT_ID },
      data: { status: 'ready', objectId: 'obj-1', error: null },
    });
  });

  it('attributes the object to the requester, and tags it for the purge sweep', async () => {
    const { handler, objects } = build();

    await handler.process(JOB);

    expect(objects.putStream).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          transcriptId: 'tr-1',
          exportId: EXPORT_ID,
          version: 4,
          format: 'markdown',
          kind: 'transcript-export',
        }),
      }),
    );
  });

  it('does nothing for a job whose payload names no export', async () => {
    const { handler, prisma } = build();

    await handler.process({ id: 'job-2', payload: {} } as unknown as Job);

    expect(prisma.transcriptExport.findUnique).not.toHaveBeenCalled();
  });

  it('does nothing when the export row has gone', async () => {
    const { handler, prisma, objects } = build();

    prisma.transcriptExport.findUnique.mockResolvedValue(null);

    await expect(handler.process(JOB)).resolves.toBeUndefined();
    expect(objects.putStream).not.toHaveBeenCalled();
  });

  it('is a no-op on a retry of a run that already finished', async () => {
    // The worker-restart case that must NOT re-render: the first attempt wrote
    // the object and the row, then died before the queue recorded the success.
    // Rendering again would orphan the object the first run wrote, since only
    // one `object_id` can be referenced.
    const { handler, prisma, objects } = build();

    prisma.transcriptExport.findUnique.mockResolvedValue(
      exportRow({ status: 'ready', objectId: 'obj-1' }),
    );

    await handler.process(JOB);

    expect(objects.putStream).not.toHaveBeenCalled();
    expect(prisma.transcriptExport.update).not.toHaveBeenCalled();
  });

  it('re-renders after a crash mid-render, because the row is still pending', async () => {
    // The other half of "survives a worker restart": attempts are charged at
    // claim time, the lease expires, the reaper requeues, and the second claim
    // finds a `pending` row with no object and renders it from scratch.
    const { handler, prisma, objects } = build();

    prisma.transcriptExport.findUnique.mockResolvedValue(exportRow({ status: 'pending' }));

    await handler.process(JOB);

    expect(objects.putStream).toHaveBeenCalledTimes(1);
    expect(prisma.transcriptExport.update).toHaveBeenCalledWith({
      where: { id: EXPORT_ID },
      data: { status: 'ready', objectId: 'obj-1', error: null },
    });
  });

  it('marks the row failed AND rethrows, so both the user and the queue are told', async () => {
    const { handler, prisma, exports } = build();

    exports.buildDocument.mockRejectedValue(new Error('snapshot is missing from storage'));

    await expect(handler.process(JOB)).rejects.toThrow('snapshot is missing from storage');

    expect(prisma.transcriptExport.update).toHaveBeenCalledWith({
      where: { id: EXPORT_ID },
      data: { status: 'failed', error: 'snapshot is missing from storage' },
    });
  });

  it('fails with a named error for a format this build does not register', async () => {
    const { handler, prisma } = build();

    prisma.transcriptExport.findUnique.mockResolvedValue(exportRow({ format: 'docx' }));

    await expect(handler.process(JOB)).rejects.toThrow(/No exporter is registered for format/);
    expect(prisma.transcriptExport.update).toHaveBeenCalledWith({
      where: { id: EXPORT_ID },
      data: { status: 'failed', error: expect.stringContaining('docx') },
    });
  });

  it('truncates an enormous error rather than failing the update that records it', async () => {
    const { handler, prisma, exports } = build();

    exports.buildDocument.mockRejectedValue(new Error('x'.repeat(5_000)));

    await expect(handler.process(JOB)).rejects.toThrow();

    const data = prisma.transcriptExport.update.mock.calls[0][0].data as { error: string };

    expect(data.error.length).toBe(2_000);
  });
});

describe('alreadyDone', () => {
  it('is true only for a ready row that actually has an object', () => {
    expect(alreadyDone(exportRow({ status: 'ready', objectId: 'obj-1' }))).toBe(true);
    expect(alreadyDone(exportRow({ status: 'ready', objectId: null }))).toBe(false);
    expect(alreadyDone(exportRow({ status: 'pending' }))).toBe(false);
    expect(alreadyDone(exportRow({ status: 'failed' }))).toBe(false);
  });
});
