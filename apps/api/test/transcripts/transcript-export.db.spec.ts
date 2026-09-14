// =============================================================================
// Real-Postgres test: exporting a version, reuse, and expiry (issue #28, §8.5)
// =============================================================================
//
// Four of issue #28's acceptance criteria cannot be proved against a mock, and
// they are the four this file exists for:
//
//   1. **Exporting an older version exports THAT version's content.** The whole
//      chain has to be real for this to mean anything: a snapshot object
//      actually written to storage, a version log actually replayed through the
//      reducers, and the resulting document actually rendered. A mocked
//      `materialize` would prove the export service passes a number along.
//
//   2. **Identical requests reuse the existing export.** The reuse is a query
//      against the `(transcript_id, version, format, options_hash)` index issue
//      #24 declares for exactly this, and "the second request rendered nothing"
//      is only observable when there are real rows to find.
//
//   3. **Expired exports are cleaned up.** `transcripts.housekeeping` nulls the
//      `object_id` before deleting the storage object, because that FK is
//      `Restrict` — a constraint that exists only in a migrated database.
//
//   4. **The job handler's output actually lands in storage**, streamed, with a
//      real byte count on the `storage_objects` row.
//
// This is a `*.db.spec.ts` file, excluded from `npm test` and run by
// `npm run test:db`. See `../jobs/db-test-support.ts` for the probe.
// =============================================================================

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import type { StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { JobsService } from '../../src/jobs/jobs.service';
import type { TranscriptPipelineService } from '../../src/transcripts/transcript-pipeline.service';
import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { TranscriptEditingService } from '../../src/transcripts/transcript-editing.service';
import { TranscriptMaterializeService } from '../../src/transcripts/transcript-materialize.service';
import { TranscriptObjectsService } from '../../src/transcripts/transcript-objects.service';
import { TranscriptSnapshotHandler } from '../../src/transcripts/handlers/transcript-snapshot.handler';
import { TranscriptExportHandler } from '../../src/transcripts/handlers/transcript-export.handler';
import { TranscriptsHousekeepingHandler } from '../../src/transcripts/handlers/transcripts-housekeeping.handler';
import { TranscriptExportService } from '../../src/transcripts/export/transcript-export.service';
import { TranscriptExporterRegistry } from '../../src/transcripts/export/transcript-exporter.interface';
import { JsonTranscriptExporter } from '../../src/transcripts/export/json.exporter';
import { MarkdownTranscriptExporter } from '../../src/transcripts/export/markdown.exporter';
import { PdfTranscriptExporter } from '../../src/transcripts/export/pdf.exporter';
import { ORDINAL_GAP, OP_TYPES } from '../../src/transcripts/editing';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';

const { describeWithDb } = resolveDbSuite('transcript-export.db.spec');

const TITLE_PREFIX = 'i28-export-';
const EMAIL_PREFIX = 'i28-export';
const KEY_PREFIX = 'i28-export/';

describeWithDb('Transcript exports (real Postgres)', () => {
  let prisma: PrismaClient;
  let baseDir: string;
  let storage: StorageProvider;

  let objects: TranscriptObjectsService;
  let editing: TranscriptEditingService;
  let exportService: TranscriptExportService;
  let exportHandler: TranscriptExportHandler;
  let snapshotHandler: TranscriptSnapshotHandler;
  let housekeeping: TranscriptsHousekeepingHandler;
  let enqueue: jest.Mock;

  let user: RequestUser;
  let ownerId: string;
  let sourceObjectId: string;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    baseDir = await mkdtemp(join(tmpdir(), 'i28-export-'));

    // The real streaming provider, with ONE method stubbed: this suite's
    // `view()` calls sign a download for a ready export, and the tmp-dir
    // double deliberately throws for signed URLs rather than pretending. The
    // signature is not what is under test here — the rendered bytes are.
    storage = Object.assign(new TmpDirStorageProvider(baseDir), {
      getSignedDownloadUrl: async () => 'https://signed.example/export',
    }) as StorageProvider;

    const service = prisma as unknown as PrismaService;

    objects = new TranscriptObjectsService(
      service,
      {
        deleteManagedObject: async (id: string) => {
          const row = await prisma.storageObject.findUnique({ where: { id } });

          if (!row) return;

          await storage.delete(row.storageKey);
          await prisma.storageObject.delete({ where: { id } });
        },
      } as unknown as ObjectsService,
      new ConfigService({}),
      storage,
    );

    const materialize = new TranscriptMaterializeService(service, objects);
    const access = new TranscriptAccessService(service);

    // A REAL `jobs` row, not a stub id: `transcript_exports.job_id` is a
    // foreign key, and a fake id would fail the constraint the moment the
    // service links the job back onto the export row.
    enqueue = jest.fn(async (input: { type: string; subjectId?: string | null }) =>
      prisma.job.create({
        data: {
          type: input.type,
          reason: 'rerun',
          subjectType: 'transcript',
          subjectId: input.subjectId ?? null,
          status: 'pending',
        },
      }),
    );

    const registry = new TranscriptExporterRegistry();

    for (const exporter of [
      new JsonTranscriptExporter(registry),
      new MarkdownTranscriptExporter(registry),
      new PdfTranscriptExporter(registry),
    ]) {
      exporter.onModuleInit();
    }

    exportService = new TranscriptExportService(
      service,
      access,
      materialize,
      objects,
      registry,
      { enqueue } as unknown as JobsService,
    );

    exportHandler = new TranscriptExportHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      service,
      exportService,
      objects,
    );

    snapshotHandler = new TranscriptSnapshotHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      service,
      materialize,
      objects,
    );

    housekeeping = new TranscriptsHousekeepingHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      service,
      { enqueueFirstPoll: jest.fn(), markFailed: jest.fn() } as unknown as TranscriptPipelineService,
      objects,
    );

    editing = new TranscriptEditingService(service, access, materialize, {
      enqueueSnapshot: jest.fn().mockResolvedValue(true),
    } as unknown as TranscriptPipelineService);

    const account = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${randomUUID()}@example.test` },
    });

    ownerId = account.id;
    user = {
      id: account.id,
      email: account.email,
      roles: ['Contributor'],
      permissions: ['transcripts:read', 'transcripts:write'],
      isActive: true,
    };

    const source = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: account.id,
      },
    });

    sourceObjectId = source.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma.$disconnect();
    await rm(baseDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await cleanup();
    enqueue.mockClear();
  });

  async function cleanup(): Promise<void> {
    const where = { transcript: { title: { startsWith: TITLE_PREFIX } } };

    await prisma.transcriptExport.deleteMany({ where });
    await prisma.job.deleteMany({ where: { type: 'transcript.export' } });
    await prisma.transcriptVersion.deleteMany({ where });
    await prisma.transcriptSegment.deleteMany({ where });
    await prisma.transcriptSpeaker.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'transcript' } });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({
      where: {
        storageKey: { startsWith: 'transcripts/' },
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  interface Seed {
    transcriptId: string;
    speakerIds: string[];
    segmentIds: string[];
  }

  async function seedTranscript(): Promise<Seed> {
    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: `${TITLE_PREFIX}${randomUUID()}`,
        sourceObjectId,
        provider: 'assemblyai',
        providerOptions: { model: 'best' } as never,
        language: 'en',
        durationMs: 20_000,
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
        speakerCount: 2,
        wordCount: 8,
      },
    });

    const speakerIds: string[] = [];

    for (const [index, displayName] of ['José Núñez', 'Priya Patel'].entries()) {
      const speaker = await prisma.transcriptSpeaker.create({
        data: {
          transcriptId: transcript.id,
          label: String.fromCharCode(65 + index),
          displayName,
          colorIndex: index,
        },
      });

      speakerIds.push(speaker.id);
    }

    const segmentIds: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      const startMs = index * 5_000;
      const id = randomUUID();

      segmentIds.push(id);

      await prisma.transcriptSegment.create({
        data: {
          id,
          transcriptId: transcript.id,
          speakerId: speakerIds[index % 2],
          startMs,
          endMs: startMs + 4_000,
          ordinal: (index + 1) * ORDINAL_GAP,
          text: `original line ${index}`,
          words: [
            { t: 'original', s: startMs, e: startMs + 1_000, c: 0.9 },
            { t: 'line', s: startMs + 1_000, e: startMs + 2_000, c: 0.9 },
            { t: String(index), s: startMs + 2_000, e: startMs + 4_000, c: 0.9 },
          ] as never,
          wordsAlignment: 'exact',
          confidence: 0.9,
          origin: 'ai',
        },
      });
    }

    await prisma.transcriptVersion.create({
      data: {
        transcriptId: transcript.id,
        version: 1,
        kind: 'ai_original',
        authorId: null,
        summary: 'Transcribed by AssemblyAI',
        ops: [] as never,
      },
    });

    // Version 1 is the one version no sequence of ops can rebuild, so its
    // snapshot is what makes history reachable at all (spec §4.3).
    await snapshotHandler.process({
      id: 'seed-snapshot',
      payload: { transcriptId: transcript.id, version: 1 },
    } as never);

    return { transcriptId: transcript.id, speakerIds, segmentIds };
  }

  /** Queue an export and run its handler, as the worker would. */
  async function runExport(
    transcriptId: string,
    body: { format: string; version?: number; options?: Record<string, unknown> },
  ): Promise<{ exportId: string; created: boolean }> {
    const result = await exportService.requestExport(transcriptId, body, user);

    if (result.created) {
      await exportHandler.process({
        id: randomUUID(),
        payload: { exportId: result.export.id, transcriptId },
      } as never);
    }

    return { exportId: result.export.id, created: result.created };
  }

  /** The bytes of a finished export, read back out of storage. */
  async function exportBytes(exportId: string): Promise<string> {
    const row = await prisma.transcriptExport.findUniqueOrThrow({ where: { id: exportId } });

    expect(row.status).toBe('ready');
    expect(row.objectId).not.toBeNull();

    const stream = await objects.download(row.objectId as string);
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);

    return Buffer.concat(chunks).toString('utf8');
  }

  // ===========================================================================
  // 1. An older version exports THAT version's content
  // ===========================================================================

  describe('exporting a version', () => {
    it('exports the CURRENT version by default', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        {
          clientBatchId: `batch-${randomUUID()}`,
          baseVersion: 1,
          ops: [
            {
              op: OP_TYPES.UPDATE_TEXT,
              segmentId: seed.segmentIds[0],
              rev: 1,
              text: 'corrected line zero',
            },
          ],
        } as never,
        user,
      );

      const { exportId } = await runExport(seed.transcriptId, { format: 'markdown' });
      const markdown = await exportBytes(exportId);

      expect(markdown).toContain('corrected line zero');
      expect(markdown).toContain('version: 2');
    });

    it('exports an OLDER version with that version\'s content, not the current one', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        {
          clientBatchId: `batch-${randomUUID()}`,
          baseVersion: 1,
          ops: [
            {
              op: OP_TYPES.UPDATE_TEXT,
              segmentId: seed.segmentIds[0],
              rev: 1,
              text: 'corrected line zero',
            },
          ],
        } as never,
        user,
      );

      const { exportId } = await runExport(seed.transcriptId, {
        format: 'markdown',
        version: 1,
      });
      const markdown = await exportBytes(exportId);

      // The whole point: v1 is the AI original, and the correction that
      // produced v2 must not appear in it.
      expect(markdown).toContain('original line 0');
      expect(markdown).not.toContain('corrected line zero');
      expect(markdown).toContain('version: 1');
    });

    it('carries a speaker rename forward into the version that made it', async () => {
      const seed = await seedTranscript();

      await editing.applyOperations(
        seed.transcriptId,
        {
          clientBatchId: `batch-${randomUUID()}`,
          baseVersion: 1,
          ops: [
            {
              op: OP_TYPES.RENAME_SPEAKER,
              speakerId: seed.speakerIds[0],
              rev: 1,
              displayName: 'José Núñez (chair)',
            },
          ],
        } as never,
        user,
      );

      const current = await runExport(seed.transcriptId, { format: 'markdown' });
      const original = await runExport(seed.transcriptId, { format: 'markdown', version: 1 });

      expect(await exportBytes(current.exportId)).toContain('José Núñez (chair)');
      expect(await exportBytes(original.exportId)).not.toContain('(chair)');
    });

    it('renders JSON whose speakers and segments come from the exported version', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, {
        format: 'json',
        options: { includeWords: true },
      });

      const parsed = JSON.parse(await exportBytes(exportId)) as {
        schema: string;
        transcript: {
          version: number;
          language: string | null;
          provider: { id: string; model: string | null } | null;
          speakers: Array<{ displayName: string; talkTimeMs: number }>;
          segments: Array<{ text: string; words: unknown[] }>;
        };
      };

      expect(parsed.schema).toBe('kvox.transcript/v1');
      expect(parsed.transcript.version).toBe(1);
      expect(parsed.transcript.language).toBe('en');
      expect(parsed.transcript.provider).toEqual({ id: 'assemblyai', model: 'best' });
      expect(parsed.transcript.speakers.map((speaker) => speaker.displayName)).toEqual([
        'José Núñez',
        'Priya Patel',
      ]);
      expect(parsed.transcript.segments).toHaveLength(4);
      expect(parsed.transcript.segments[0].words).toHaveLength(3);
    });

    it('streams a real PDF into storage with a real byte count', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, { format: 'pdf' });

      const row = await prisma.transcriptExport.findUniqueOrThrow({ where: { id: exportId } });
      const object = await prisma.storageObject.findUniqueOrThrow({
        where: { id: row.objectId as string },
      });

      // Metered as the bytes passed, never declared — that is the whole point
      // of not buffering the document.
      expect(Number(object.size)).toBeGreaterThan(1_000);
      expect(object.mimeType).toBe('application/pdf');
      expect(object.managedBy).toBe('transcripts');
      // Attributed to the requester, not to whoever ran the worker.
      expect(object.uploadedById).toBe(ownerId);

      const stream = await objects.download(row.objectId as string);
      const chunks: Buffer[] = [];

      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);

      expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('404s for a version that does not exist', async () => {
      const seed = await seedTranscript();

      await expect(
        exportService.requestExport(seed.transcriptId, { format: 'markdown', version: 7 }, user),
      ).rejects.toThrow(/does not exist/);
    });
  });

  // ===========================================================================
  // 2. Reuse by options_hash
  // ===========================================================================

  describe('reuse', () => {
    it('returns the SAME export for an identical repeat request, rendering nothing', async () => {
      const seed = await seedTranscript();

      const first = await runExport(seed.transcriptId, { format: 'markdown' });
      const second = await runExport(seed.transcriptId, { format: 'markdown' });

      expect(second.created).toBe(false);
      expect(second.exportId).toBe(first.exportId);
      expect(await prisma.transcriptExport.count({ where: { transcriptId: seed.transcriptId } })).toBe(1);
    });

    it('treats omitted options and the explicit defaults as the same export', async () => {
      const seed = await seedTranscript();

      const first = await runExport(seed.transcriptId, { format: 'markdown' });
      const second = await runExport(seed.transcriptId, {
        format: 'markdown',
        options: { includeTimestamps: true, mergeConsecutive: false },
      });

      expect(second.exportId).toBe(first.exportId);
    });

    it('does NOT reuse across a different option, format or version', async () => {
      const seed = await seedTranscript();

      const base = await runExport(seed.transcriptId, { format: 'markdown' });
      const merged = await runExport(seed.transcriptId, {
        format: 'markdown',
        options: { mergeConsecutive: true },
      });
      const json = await runExport(seed.transcriptId, { format: 'json' });

      expect(merged.exportId).not.toBe(base.exportId);
      expect(json.exportId).not.toBe(base.exportId);
      expect(await prisma.transcriptExport.count({ where: { transcriptId: seed.transcriptId } })).toBe(3);
    });

    it('does NOT reuse a FAILED export — a retry must actually retry', async () => {
      const seed = await seedTranscript();

      const first = await runExport(seed.transcriptId, { format: 'markdown' });

      await prisma.transcriptExport.update({
        where: { id: first.exportId },
        data: { status: 'failed', objectId: null, error: 'storage was unavailable' },
      });

      const second = await runExport(seed.transcriptId, { format: 'markdown' });

      expect(second.created).toBe(true);
      expect(second.exportId).not.toBe(first.exportId);
    });

    it('does NOT reuse an expired export', async () => {
      const seed = await seedTranscript();

      const first = await runExport(seed.transcriptId, { format: 'markdown' });

      await prisma.transcriptExport.update({
        where: { id: first.exportId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const second = await runExport(seed.transcriptId, { format: 'markdown' });

      expect(second.created).toBe(true);
      expect(second.exportId).not.toBe(first.exportId);
    });

    it('records an audit event per queued export, and none for a reuse', async () => {
      const seed = await seedTranscript();

      await runExport(seed.transcriptId, { format: 'markdown' });
      await runExport(seed.transcriptId, { format: 'markdown' });

      const audits = await prisma.auditEvent.count({
        where: { targetType: 'transcript', targetId: seed.transcriptId, action: 'transcript:export' },
      });

      expect(audits).toBe(1);
    });
  });

  // ===========================================================================
  // 3. Expiry, swept by `transcripts.housekeeping`
  // ===========================================================================

  describe('expiry', () => {
    it('deletes the row and the file once the export has expired', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, { format: 'markdown' });
      const row = await prisma.transcriptExport.findUniqueOrThrow({ where: { id: exportId } });
      const objectId = row.objectId as string;

      expect(await storage.exists((await prisma.storageObject.findUniqueOrThrow({
        where: { id: objectId },
      })).storageKey)).toBe(true);

      await prisma.transcriptExport.update({
        where: { id: exportId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await housekeeping.process({ id: randomUUID(), payload: {} } as never);

      expect(await prisma.transcriptExport.findUnique({ where: { id: exportId } })).toBeNull();
      // `object_id` is `Restrict`, so the sweep has to null the reference
      // before it may delete the storage row — a constraint that exists only
      // in a migrated database.
      expect(await prisma.storageObject.findUnique({ where: { id: objectId } })).toBeNull();
    });

    it('leaves an unexpired export alone', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, { format: 'markdown' });

      await housekeeping.process({ id: randomUUID(), payload: {} } as never);

      expect(await prisma.transcriptExport.findUnique({ where: { id: exportId } })).not.toBeNull();
    });

    it('is set seven days out when the export is created', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, { format: 'markdown' });
      const row = await prisma.transcriptExport.findUniqueOrThrow({ where: { id: exportId } });
      const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;

      expect(days).toBeCloseTo(7, 1);
    });
  });

  // ===========================================================================
  // 4. Reading the export back
  // ===========================================================================

  describe('getExport', () => {
    it('reports a ready export with its size and a signed download', async () => {
      const seed = await seedTranscript();

      const { exportId } = await runExport(seed.transcriptId, { format: 'markdown' });
      const view = await exportService.getExport(seed.transcriptId, exportId, user);

      expect(view.status).toBe('ready');
      expect(view.downloadUrl).toBe('https://signed.example/export');
      expect(Number(view.sizeBytes)).toBeGreaterThan(0);
      expect(view.filename).toMatch(/^i28-export-.* \(v1\)\.md$/);
    });

    it('404s for an export id that belongs to a different transcript', async () => {
      const [mine, theirs] = await Promise.all([seedTranscript(), seedTranscript()]);
      const { exportId } = await runExport(theirs.transcriptId, { format: 'markdown' });

      await expect(
        exportService.getExport(mine.transcriptId, exportId, user),
      ).rejects.toThrow(/Export not found/);
    });
  });
});
