// =============================================================================
// Real-Postgres test: note export, reuse, versions and expiry (issue #54, §8)
// =============================================================================
//
// Six of issue #54's acceptance criteria cannot be proved against a mock, and
// they are the six this file exists for:
//
//   1. **Each of the three formats produces a downloadable file whose bytes
//      open in the corresponding reader.** The whole chain has to be real: a
//      row, a render, an upload that actually lands, and a `storage_objects`
//      row with a real byte count.
//   2. **An identical repeat request returns the EXISTING export without a
//      second render** — asserted by THE ROW ID AND A RENDER COUNTER, never by
//      timing. The counter is what makes "nothing was rendered" a fact rather
//      than an inference.
//   3. **Editing the note then re-exporting produces a NEW export**, because
//      `version` is part of the content address.
//   4. **Differing options produce a different `options_hash`** and therefore a
//      separate export.
//   5. **Exporting an earlier version renders THAT version's body**, not the
//      current one — which is only meaningful when there is a real version log
//      to read the wrong row out of.
//   6. **An expired export is swept and its storage object deleted.**
//      `note_exports.object_id` is `Restrict`, so the sweep must null the
//      reference before the object can go — a constraint that exists only in a
//      migrated database.
//
// Plus the access criterion, here rather than only over the wire because the
// download route names no note id: another user's note is 404 on export, list
// AND download.
//
// This is a `*.db.spec.ts` file, excluded from `npm test` and run by
// `npm run test:db`. See `../jobs/db-test-support.ts` for the probe.
// =============================================================================

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import type { StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import { NoteExportService } from '../../src/notes/export/note-export.service';
import { NoteExporterRegistry } from '../../src/notes/export/note-exporter.registry';
import { MarkdownNoteExporter } from '../../src/notes/export/markdown.exporter';
import { PdfNoteExporter } from '../../src/notes/export/pdf.exporter';
import { WordNoteExporter } from '../../src/notes/export/word.exporter';
import { docxText } from '../../src/notes/export/__fixtures__/docx-text';
import { extractPdfText } from '../../src/notes/export/__fixtures__/pdf-text';
import { NoteExportHandler } from '../../src/notes/handlers/note-export.handler';
import { NotesHousekeepingHandler } from '../../src/notes/handlers/notes-housekeeping.handler';
import { NOTE_EXPORT_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../../src/notes/job-types';
import { NoteObjectsService } from '../../src/notes/note-objects.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';

const { describeWithDb } = resolveDbSuite('note-export.db.spec');

const TITLE_PREFIX = 'i54-export-';
const EMAIL_PREFIX = 'i54-export';

const V1_BODY = ['# Draft', '', 'The **first** attempt.'].join('\n');
const V2_BODY = [
  '# Weekly Sync Recap',
  '',
  'The team agreed to **ship** the *export* feature.',
  '',
  '## Decisions',
  '',
  '- Ship Markdown, PDF and Word',
  '- Defer sharing',
  '',
  '> Provenance travels with the export.',
].join('\n');

describeWithDb('Note exports (real Postgres)', () => {
  let prisma: PrismaClient;
  let baseDir: string;
  let storage: StorageProvider;

  let objects: NoteObjectsService;
  let registry: NoteExporterRegistry;
  let exportService: NoteExportService;
  let handler: NoteExportHandler;
  let housekeeping: NotesHousekeepingHandler;
  let enqueue: jest.Mock;

  /**
   * How many times a renderer has actually run.
   *
   * ⚠ THIS COUNTER IS THE REUSE ASSERTION. "The second request was fast" is a
   * statement about a machine; "the second request rendered nothing" is a
   * statement about the feature, and only a counter can make it.
   */
  let renders: number;

  let user: RequestUser;
  let otherUser: RequestUser;
  let ownerId: string;
  let transcriptObjectId: string;
  let transcriptId: string;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    baseDir = await mkdtemp(join(tmpdir(), 'i54-export-'));

    // The real streaming provider, with ONE method stubbed: signing is not what
    // is under test here — the rendered bytes and the rows are.
    storage = Object.assign(new TmpDirStorageProvider(baseDir), {
      getSignedDownloadUrl: async () => 'https://signed.example/export',
    }) as StorageProvider;

    const service = prisma as unknown as PrismaService;

    objects = new NoteObjectsService(
      service,
      {
        deleteManagedObject: async (id: string) => {
          const row = await prisma.storageObject.findUnique({ where: { id } });

          if (!row) return;

          await storage.delete(row.storageKey);
          await prisma.storageObject.delete({ where: { id } });
        },
      } as unknown as ObjectsService,
      storage,
    );

    registry = new NoteExporterRegistry();
    renders = 0;

    for (const exporter of [
      new MarkdownNoteExporter(registry),
      new PdfNoteExporter(registry),
      new WordNoteExporter(registry),
    ]) {
      exporter.onModuleInit();

      // Count every real render, without replacing one: a stub would prove the
      // reuse path and nothing about the bytes the other assertions read back.
      const original = exporter.render.bind(exporter);

      (exporter as { render: typeof original }).render = async (...args) => {
        renders += 1;

        return original(...args);
      };
    }

    // A REAL `jobs` row, not a stub id: `note_exports.job_id` is a foreign key,
    // and a fake id would fail the constraint the moment the service links the
    // job back onto the export row.
    enqueue = jest.fn(async (input: { type: string; subjectId?: string | null }) =>
      prisma.job.create({
        data: {
          type: input.type,
          reason: 'rerun',
          subjectType: NOTE_SUBJECT_TYPE,
          subjectId: input.subjectId ?? null,
          status: 'pending',
        },
      }),
    );

    const access = new NoteAccessService(service);

    exportService = new NoteExportService(
      service,
      access,
      objects,
      registry,
      { get: () => ({ type: NOTE_EXPORT_JOB_TYPE }) } as unknown as JobHandlerRegistry,
      { enqueue } as unknown as JobsService,
    );

    handler = new NoteExportHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      service,
      exportService,
      objects,
    );

    housekeeping = new NotesHousekeepingHandler(
      { register: jest.fn() } as unknown as JobHandlerRegistry,
      service,
      objects,
      { enqueuePurge: jest.fn() } as never,
    );

    const account = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${randomUUID()}@example.test` },
    });
    const stranger = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-other-${randomUUID()}@example.test` },
    });

    ownerId = account.id;
    user = {
      id: account.id,
      email: account.email,
      roles: ['Contributor'],
      permissions: [PERMISSIONS.NOTES_READ, PERMISSIONS.NOTES_WRITE],
      isActive: true,
    };
    otherUser = {
      id: stranger.id,
      email: stranger.email,
      roles: ['Contributor'],
      permissions: [PERMISSIONS.NOTES_READ, PERMISSIONS.NOTES_WRITE],
      isActive: true,
    };

    const source = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${TITLE_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: account.id,
      },
    });

    transcriptObjectId = source.id;

    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: `${TITLE_PREFIX}Weekly Sync`,
        sourceObjectId: transcriptObjectId,
        provider: 'assemblyai',
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
      },
    });

    transcriptId = transcript.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({ where: { id: transcriptObjectId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma.$disconnect();
    await rm(baseDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await cleanup();
    enqueue.mockClear();
    renders = 0;
  });

  async function cleanup(): Promise<void> {
    const where = { note: { title: { startsWith: TITLE_PREFIX } } };

    await prisma.noteExport.deleteMany({ where });
    await prisma.noteVersion.deleteMany({ where });
    await prisma.note.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.job.deleteMany({ where: { type: NOTE_EXPORT_JOB_TYPE } });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'note' } });
    await prisma.storageObject.deleteMany({
      where: { managedBy: 'notes', uploadedById: { in: [ownerId] } },
    });
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  /** A note with a real two-entry version log, owned by `owner`. */
  async function seedNote(owner = ownerId): Promise<string> {
    const note = await prisma.note.create({
      data: {
        ownerId: owner,
        title: `${TITLE_PREFIX}${randomUUID()}`,
        body: V2_BODY,
        status: 'ready',
        currentVersion: 2,
        provider: 'openai',
        model: 'gpt-4o',
        sourceType: 'transcript',
        sourceTranscriptId: transcriptId,
      },
    });

    await prisma.noteVersion.createMany({
      data: [
        { noteId: note.id, version: 1, kind: 'ai_generated', body: V1_BODY, authorId: null },
        { noteId: note.id, version: 2, kind: 'edit', body: V2_BODY, authorId: owner },
      ],
    });

    return note.id;
  }

  /** Request an export and run the job that renders it, returning the row. */
  async function exportAndRender(
    noteId: string,
    dto: { format: string; version?: number; options?: Record<string, unknown> },
  ) {
    const result = await exportService.requestExport(noteId, dto, user);

    if (result.created && result.export.status === 'pending') {
      const job = await prisma.job.findFirstOrThrow({
        where: { type: NOTE_EXPORT_JOB_TYPE, subjectId: noteId },
        orderBy: { createdAt: 'desc' },
      });

      await handler.process({ ...job, payload: { exportId: result.export.id, noteId } });
    }

    return {
      result,
      row: await prisma.noteExport.findUniqueOrThrow({ where: { id: result.export.id } }),
    };
  }

  /** The bytes actually stored for a finished export. */
  async function storedBytes(objectId: string): Promise<Buffer> {
    const buffer = await objects.downloadBuffer(objectId);

    if (!buffer) throw new Error(`No bytes stored for object ${objectId}`);

    return buffer;
  }

  // ---------------------------------------------------------------------------
  // 1. Three formats, real bytes, real rows
  // ---------------------------------------------------------------------------

  it('renders Markdown, PDF and DOCX into real storage objects with real byte counts', async () => {
    const noteId = await seedNote();

    for (const format of ['markdown', 'pdf', 'docx']) {
      const { row } = await exportAndRender(noteId, { format });

      expect(row.status).toBe('ready');
      expect(row.objectId).not.toBeNull();

      const object = await prisma.storageObject.findUniqueOrThrow({
        where: { id: row.objectId as string },
      });

      // ⚠ THE SIZE IS METERED FROM THE ACTUAL STREAM, so a row that claimed a
      // length the file does not have would show here.
      const bytes = await storedBytes(object.id);

      expect(Number(object.size)).toBe(bytes.byteLength);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(object.managedBy).toBe('notes');
    }

    // Each format is its own render: the content address includes `format`.
    expect(renders).toBe(3);
  });

  it('produces bytes that open in the corresponding reader', async () => {
    const noteId = await seedNote();

    const markdown = await exportAndRender(noteId, { format: 'markdown' });
    const pdf = await exportAndRender(noteId, { format: 'pdf' });
    const docx = await exportAndRender(noteId, { format: 'docx' });

    const markdownBytes = await storedBytes(markdown.row.objectId as string);
    const pdfBytes = await storedBytes(pdf.row.objectId as string);
    const docxBytes = await storedBytes(docx.row.objectId as string);

    expect(markdownBytes.toString('utf8')).toContain(V2_BODY);
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await extractPdfText(pdfBytes)).toContain('Weekly Sync Recap');
    expect(docxBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(docxText(docxBytes)).toContain('Decisions');
  });

  // ---------------------------------------------------------------------------
  // 2. Provenance, against extracted text
  // ---------------------------------------------------------------------------

  it('names the source, template, version and timestamp in every format', async () => {
    const noteId = await seedNote();
    const template = await prisma.noteTemplate.create({
      data: {
        ownerId,
        name: `${TITLE_PREFIX}Meeting recap`,
        description: 'A short, scannable summary.',
        instructions: 'Write meeting notes.',
        outputFormat: 'meeting_notes',
        structure: ['Overview', 'Decisions'],
      },
    });

    await prisma.note.update({ where: { id: noteId }, data: { templateId: template.id } });

    const markdown = await exportAndRender(noteId, { format: 'markdown' });
    const pdf = await exportAndRender(noteId, { format: 'pdf' });
    const docx = await exportAndRender(noteId, { format: 'docx' });

    const texts = [
      (await storedBytes(markdown.row.objectId as string)).toString('utf8'),
      await extractPdfText(await storedBytes(pdf.row.objectId as string)),
      docxText(await storedBytes(docx.row.objectId as string)),
    ];

    for (const text of texts) {
      // ⚠ AGAINST EXTRACTED TEXT, NOT FILE SIZE. A renderer that stopped
      // emitting the provenance block would still produce a plausible file.
      expect(text).toContain(`${TITLE_PREFIX}Weekly Sync`);
      expect(text).toContain('(transcript)');
      expect(text).toContain(`${TITLE_PREFIX}Meeting recap`);
      expect(text).toContain('Version 2');
      expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }

    await prisma.note.update({ where: { id: noteId }, data: { templateId: null } });
    await prisma.noteTemplate.delete({ where: { id: template.id } });
  });

  // ---------------------------------------------------------------------------
  // 3. Content-addressed reuse
  // ---------------------------------------------------------------------------

  it('returns the EXISTING row for an identical repeat request, rendering nothing', async () => {
    const noteId = await seedNote();

    const first = await exportAndRender(noteId, { format: 'markdown' });

    expect(renders).toBe(1);

    const second = await exportService.requestExport(noteId, { format: 'markdown' }, user);

    // The row id and the counter: the two facts the criterion names.
    expect(second.created).toBe(false);
    expect(second.export.reused).toBe(true);
    expect(second.export.id).toBe(first.row.id);
    expect(renders).toBe(1);
    expect(await prisma.noteExport.count({ where: { noteId } })).toBe(1);
  });

  it('treats an omitted option and its explicit default as ONE export', async () => {
    const noteId = await seedNote();

    const first = await exportAndRender(noteId, { format: 'markdown' });
    const second = await exportService.requestExport(
      noteId,
      { format: 'markdown', options: { includeFrontMatter: true } },
      user,
    );

    expect(second.export.id).toBe(first.row.id);
    expect(renders).toBe(1);
  });

  it('gives differing options a different hash and a separate export', async () => {
    const noteId = await seedNote();

    const on = await exportAndRender(noteId, { format: 'markdown' });
    const off = await exportAndRender(noteId, {
      format: 'markdown',
      options: { includeFrontMatter: false },
    });

    expect(off.row.id).not.toBe(on.row.id);
    expect(off.row.optionsHash).not.toBe(on.row.optionsHash);
    expect(renders).toBe(2);

    // And the files genuinely differ, which is why they are two rows.
    const withFront = (await storedBytes(on.row.objectId as string)).toString('utf8');
    const without = (await storedBytes(off.row.objectId as string)).toString('utf8');

    expect(withFront.startsWith('---')).toBe(true);
    expect(without.startsWith('---')).toBe(false);
  });

  it('never reuses a failed row — a retry actually retries', async () => {
    const noteId = await seedNote();

    const first = await exportAndRender(noteId, { format: 'markdown' });

    await prisma.noteExport.update({
      where: { id: first.row.id },
      data: { status: 'failed', objectId: null, error: 'renderer exploded' },
    });

    const retry = await exportService.requestExport(noteId, { format: 'markdown' }, user);

    expect(retry.created).toBe(true);
    expect(retry.export.id).not.toBe(first.row.id);
  });

  // ---------------------------------------------------------------------------
  // 4. Versions
  // ---------------------------------------------------------------------------

  it('renders an earlier version\'s body, not the current one', async () => {
    const noteId = await seedNote();

    const { row } = await exportAndRender(noteId, { format: 'markdown', version: 1 });
    const text = (await storedBytes(row.objectId as string)).toString('utf8');

    expect(row.version).toBe(1);
    expect(text).toContain('The **first** attempt.');
    expect(text).not.toContain('The team agreed to');
    expect(text).toContain('> **Note version:** Version 1');
  });

  it('produces a NEW export after the note is edited, because version is in the address', async () => {
    const noteId = await seedNote();

    const before = await exportAndRender(noteId, { format: 'markdown' });

    // A third version, exactly as `PATCH /api/notes/:id` would write it.
    await prisma.noteVersion.create({
      data: {
        noteId,
        version: 3,
        kind: 'edit',
        body: `${V2_BODY}\n\nAnd one more decision.`,
        authorId: ownerId,
      },
    });
    await prisma.note.update({ where: { id: noteId }, data: { currentVersion: 3 } });

    const after = await exportAndRender(noteId, { format: 'markdown' });

    expect(after.row.id).not.toBe(before.row.id);
    expect(after.row.version).toBe(3);
    expect(renders).toBe(2);
    expect((await storedBytes(after.row.objectId as string)).toString('utf8')).toContain(
      'And one more decision.',
    );
  });

  it('404s a version the note does not have', async () => {
    const noteId = await seedNote();

    await expect(
      exportService.requestExport(noteId, { format: 'markdown', version: 9 }, user),
    ).rejects.toThrow(/Version 9 does not exist/);
  });

  // ---------------------------------------------------------------------------
  // 5. Access
  // ---------------------------------------------------------------------------

  it("404s another user's note on export, list AND download", async () => {
    const noteId = await seedNote();
    const { row } = await exportAndRender(noteId, { format: 'markdown' });

    await expect(
      exportService.requestExport(noteId, { format: 'pdf' }, otherUser),
    ).rejects.toThrow('Note not found');
    await expect(exportService.listExports(noteId, otherUser)).rejects.toThrow('Note not found');
    // ⚠ THE DOWNLOAD NAMES NO NOTE ID, so this is the one route where the
    // export id could become an oracle for somebody else's note. It answers
    // with the same message a missing note gets.
    await expect(exportService.download(row.id, otherUser)).rejects.toThrow('Note not found');

    // And the owner still can, so the 404 is about access rather than a broken
    // lookup.
    await expect(exportService.download(row.id, user)).resolves.toMatchObject({
      mimeType: 'text/markdown; charset=utf-8',
    });
  });

  it('lists a note\'s exports newest first, with a signed download once ready', async () => {
    const noteId = await seedNote();

    await exportAndRender(noteId, { format: 'markdown' });
    await exportAndRender(noteId, { format: 'pdf' });

    const { exports } = await exportService.listExports(noteId, user);

    expect(exports).toHaveLength(2);
    expect(exports[0]?.status).toBe('ready');
    expect(exports[0]?.downloadUrl).toBe('https://signed.example/export');
    expect(exports[0]?.sizeBytes).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 6. Expiry
  // ---------------------------------------------------------------------------

  it('expires an export and deletes its storage object, in the order the FK requires', async () => {
    const noteId = await seedNote();
    const { row } = await exportAndRender(noteId, { format: 'markdown' });
    const objectId = row.objectId as string;

    expect(await prisma.storageObject.findUnique({ where: { id: objectId } })).not.toBeNull();

    await prisma.noteExport.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await housekeeping.process({ id: randomUUID() } as never);

    // ⚠ BOTH GONE. `object_id` is `Restrict`, so a sweep that tried to delete
    // the storage row while the export still pointed at it would fail here
    // rather than silently leaving an orphan.
    expect(await prisma.noteExport.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await prisma.storageObject.findUnique({ where: { id: objectId } })).toBeNull();
  });

  it('leaves an unexpired export and its object alone', async () => {
    const noteId = await seedNote();
    const { row } = await exportAndRender(noteId, { format: 'markdown' });

    await housekeeping.process({ id: randomUUID() } as never);

    expect(await prisma.noteExport.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(
      await prisma.storageObject.findUnique({ where: { id: row.objectId as string } }),
    ).not.toBeNull();
  });

  it('records an audit row per queued export', async () => {
    const noteId = await seedNote();

    await exportAndRender(noteId, { format: 'docx' });

    const audits = await prisma.auditEvent.findMany({
      where: { action: 'note:export', targetId: noteId },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(ownerId);
  });
});
