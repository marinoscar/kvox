import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Transcript, TranscriptExport } from '@prisma/client';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TranscriptAccessService } from '../transcript-access.service';
import type { TranscriptMaterializeService } from '../transcript-materialize.service';
import type { TranscriptObjectsService } from '../transcript-objects.service';
import { JsonTranscriptExporter } from './json.exporter';
import { MarkdownTranscriptExporter } from './markdown.exporter';
import { hashExportRequest } from './export-options';
import {
  EXPORT_JOB_PRIORITY,
  EXPORT_TTL_DAYS,
  TranscriptExportService,
  contentDisposition,
  exportFilename,
} from './transcript-export.service';
import { TranscriptExporterRegistry } from './transcript-exporter.interface';

// =============================================================================
// TranscriptExportService (issue #28, epic #19, spec §8.5)
// =============================================================================

const USER: RequestUser = {
  id: 'user-1',
  email: 'someone@example.test',
  roles: ['Contributor'],
  permissions: ['transcripts:read'],
  isActive: true,
};

const TRANSCRIPT = {
  id: 'tr-1',
  title: 'Weekly sync',
  currentVersion: 4,
  ownerId: 'user-1',
} as unknown as Transcript;

function exportRow(overrides: Partial<TranscriptExport> = {}): TranscriptExport {
  return {
    id: 'exp-1',
    transcriptId: 'tr-1',
    version: 4,
    format: 'markdown',
    options: { includeTimestamps: true, mergeConsecutive: false },
    optionsHash: 'hash',
    status: 'pending',
    objectId: null,
    jobId: null,
    requestedById: 'user-1',
    error: null,
    expiresAt: new Date('2026-09-21T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  } as TranscriptExport;
}

function build() {
  const prisma = {
    transcriptExport: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    transcript: { findUnique: jest.fn() },
    transcriptVersion: { findUnique: jest.fn() },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  const access = {
    require: jest.fn().mockResolvedValue({ transcript: TRANSCRIPT, role: 'owner' }),
  };
  const materialize = { materialize: jest.fn() };
  const objects = { signedUrlFor: jest.fn().mockResolvedValue(null) };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const registry = new TranscriptExporterRegistry();

  new JsonTranscriptExporter(registry).onModuleInit();
  new MarkdownTranscriptExporter(registry).onModuleInit();

  const service = new TranscriptExportService(
    prisma as unknown as PrismaService,
    access as unknown as TranscriptAccessService,
    materialize as unknown as TranscriptMaterializeService,
    objects as unknown as TranscriptObjectsService,
    registry,
    jobs as unknown as JobsService,
  );

  return { service, prisma, access, objects, jobs, registry };
}

/** A queued export whose row and job link both resolve. */
function primeCreate(prisma: ReturnType<typeof build>['prisma']): void {
  prisma.transcriptExport.create.mockResolvedValue(exportRow());
  prisma.transcriptExport.update.mockResolvedValue(exportRow({ jobId: 'job-1' }));
}

describe('listExporters', () => {
  it('publishes each format with the options the dialog draws', () => {
    const { service } = build();
    const { exporters } = service.listExporters();

    expect(exporters.map((exporter) => exporter.format)).toEqual(['json', 'markdown']);

    const markdown = exporters.find((exporter) => exporter.format === 'markdown');

    expect(markdown?.extension).toBe('md');
    expect(markdown?.options.map((option) => option.key)).toEqual([
      'includeTimestamps',
      'mergeConsecutive',
    ]);
    expect(markdown?.options[0]).toMatchObject({ type: 'boolean', default: true });
  });
});

describe('requestExport', () => {
  it('requires VIEW access, so a viewer share can export', async () => {
    const { service, prisma, access } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(access.require).toHaveBeenCalledWith('user-1', 'tr-1', 'view');
  });

  it('refuses an unknown format with a 400 naming the ones that exist', async () => {
    const { service } = build();

    await expect(service.requestExport('tr-1', { format: 'docx' }, USER)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.requestExport('tr-1', { format: 'docx' }, USER)).rejects.toThrow(
      /json, markdown/,
    );
  });

  it('refuses an option the format does not accept, rather than ignoring it', async () => {
    const { service } = build();

    await expect(
      service.requestExport(
        'tr-1',
        { format: 'markdown', options: { includeTimestamp: true } },
        USER,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("defaults to the transcript's current version", async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(prisma.transcriptExport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 4 }) }),
    );
  });

  it('404s for a version that does not exist', async () => {
    const { service } = build();

    await expect(
      service.requestExport('tr-1', { format: 'markdown', version: 9 }, USER),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.requestExport('tr-1', { format: 'markdown', version: 0 }, USER),
    ).rejects.toThrow(NotFoundException);
  });

  it('stores the PARSED options and their hash, so defaults are reusable', async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown', options: {} }, USER);

    const data = prisma.transcriptExport.create.mock.calls[0][0].data as Record<string, unknown>;

    expect(data.options).toEqual({ includeTimestamps: true, mergeConsecutive: false });
    expect(data.optionsHash).toBe(
      hashExportRequest({
        format: 'markdown',
        version: 4,
        options: { includeTimestamps: true, mergeConsecutive: false },
      }),
    );
  });

  it('expires the row seven days out', async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    const before = Date.now();

    await service.requestExport('tr-1', { format: 'markdown' }, USER);

    const data = prisma.transcriptExport.create.mock.calls[0][0].data as { expiresAt: Date };

    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + EXPORT_TTL_DAYS * 24 * 3_600_000 - 5_000,
    );
  });

  it('enqueues the job at a more-urgent-than-default priority, with dedup off', async () => {
    const { service, prisma, jobs } = build();

    primeCreate(prisma);

    const result = await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'transcript.export',
        subjectType: 'transcript',
        subjectId: 'tr-1',
        priority: EXPORT_JOB_PRIORITY,
        // Two formats of one transcript are legitimately distinct work; the
        // queue's subject-scoped dedup key would collapse them into one.
        skipDedup: true,
        payload: { exportId: 'exp-1', transcriptId: 'tr-1' },
      }),
    );
    expect(EXPORT_JOB_PRIORITY).toBeLessThan(0);
    expect(result.created).toBe(true);
    expect(result.export.reused).toBe(false);
  });

  it('links the job back onto the export row', async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(prisma.transcriptExport.update).toHaveBeenCalledWith({
      where: { id: 'exp-1' },
      data: { jobId: 'job-1' },
    });
  });

  it('writes an audit event naming the format and version', async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'transcript:export',
        targetType: 'transcript',
        targetId: 'tr-1',
        actorUserId: 'user-1',
      }),
    });
  });

  it('reuses an existing unexpired export and renders nothing', async () => {
    const { service, prisma, jobs } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(exportRow({ status: 'ready' }));

    const result = await service.requestExport('tr-1', { format: 'markdown' }, USER);

    expect(result.created).toBe(false);
    expect(result.export.reused).toBe(true);
    expect(prisma.transcriptExport.create).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('looks the reuse up on the whole content-addressed key, excluding failures', async () => {
    const { service, prisma } = build();

    primeCreate(prisma);

    await service.requestExport('tr-1', { format: 'markdown', version: 2 }, USER);

    const where = prisma.transcriptExport.findFirst.mock.calls[0][0].where as Record<
      string,
      unknown
    >;

    expect(where).toMatchObject({
      transcriptId: 'tr-1',
      version: 2,
      format: 'markdown',
      // A failed row is never reused: "you asked before and it broke" is not an
      // answer to "please export this".
      status: { in: ['pending', 'ready'] },
    });
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    expect(where.optionsHash).toEqual(expect.any(String));
  });
});

describe('getExport', () => {
  it('scopes the lookup to the transcript, which IS the authorisation', async () => {
    const { service, prisma } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(exportRow());

    await service.getExport('tr-1', 'exp-1', USER);

    expect(prisma.transcriptExport.findFirst).toHaveBeenCalledWith({
      where: { id: 'exp-1', transcriptId: 'tr-1' },
    });
  });

  it('404s for an export belonging to another transcript', async () => {
    const { service, prisma } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(null);

    await expect(service.getExport('tr-1', 'exp-9', USER)).rejects.toThrow(NotFoundException);
  });

  it('has no download URL while the export is pending', async () => {
    const { service, prisma, objects } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(exportRow());

    const view = await service.getExport('tr-1', 'exp-1', USER);

    expect(view.downloadUrl).toBeNull();
    expect(view.sizeBytes).toBeNull();
    expect(objects.signedUrlFor).not.toHaveBeenCalled();
  });

  it('signs a download with an attachment disposition once ready', async () => {
    const { service, prisma, objects } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(
      exportRow({ status: 'ready', objectId: 'obj-1' }),
    );
    objects.signedUrlFor.mockResolvedValue({
      url: 'https://storage.example/signed',
      expiresAt: new Date('2026-09-14T00:15:00.000Z'),
      object: { size: BigInt(2048) },
    });

    const view = await service.getExport('tr-1', 'exp-1', USER);

    expect(view.downloadUrl).toBe('https://storage.example/signed');
    expect(view.sizeBytes).toBe('2048');
    expect(view.filename).toBe('Weekly sync (v4).md');
    expect(objects.signedUrlFor).toHaveBeenCalledWith(
      'obj-1',
      expect.any(Number),
      expect.stringContaining('attachment; filename="Weekly sync (v4).md"'),
    );
  });

  it('reports the failure reason for a failed export', async () => {
    const { service, prisma } = build();

    prisma.transcriptExport.findFirst.mockResolvedValue(
      exportRow({ status: 'failed', error: 'pdfkit exploded' }),
    );

    const view = await service.getExport('tr-1', 'exp-1', USER);

    expect(view.status).toBe('failed');
    expect(view.error).toBe('pdfkit exploded');
    expect(view.downloadUrl).toBeNull();
  });
});

describe('exportFilename', () => {
  it('is `<title> (v<n>).<ext>`', () => {
    expect(exportFilename('Weekly sync', 4, 'pdf')).toBe('Weekly sync (v4).pdf');
  });

  it('keeps accents — the name travels in `filename*` as UTF-8', () => {
    expect(exportFilename('Reunión', 1, 'md')).toBe('Reunión (v1).md');
  });

  it('replaces path separators and reserved characters rather than dropping them', () => {
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j', 2, 'json')).toBe(
      'a-b-c-d-e-f-g-h-i-j (v2).json',
    );
  });

  it('strips control characters', () => {
    expect(exportFilename('a bc', 1, 'md')).toBe('a b c (v1).md');
  });

  it('falls back rather than producing `(v3).pdf`', () => {
    expect(exportFilename('   ', 3, 'pdf')).toBe('transcript (v3).pdf');
    expect(exportFilename(' ', 3, 'pdf')).toBe('transcript (v3).pdf');
  });

  it('replaces rather than strips, so a title of separators keeps its shape', () => {
    // `///` becomes `---`, not nothing: the fallback is for a title that
    // genuinely reduces to empty, not for one that is merely all punctuation.
    expect(exportFilename('///', 3, 'pdf')).toBe('--- (v3).pdf');
  });

  it('bounds the length so the whole name fits a filesystem limit', () => {
    const name = exportFilename('x'.repeat(500), 1, 'pdf');

    expect(name.length).toBeLessThan(140);
  });
});

describe('contentDisposition', () => {
  it('carries both an ASCII filename and a UTF-8 filename*', () => {
    expect(contentDisposition('Reunión (v1).md')).toBe(
      "attachment; filename=\"Reuni_n (v1).md\"; filename*=UTF-8''Reuni%C3%B3n%20(v1).md",
    );
  });

  it('cannot be terminated early by a quote in the title', () => {
    // A bare quote would close the quoted string and let the rest of the name
    // be parsed as header parameters.
    expect(contentDisposition('a"b (v1).md')).toContain('filename="a_b (v1).md"');
  });
});
