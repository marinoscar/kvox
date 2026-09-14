import request from 'supertest';

import { NOTE_NOT_FOUND_MESSAGE } from '../../src/notes/access/note-access.service';
import { NOTE_EXPORT_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../../src/notes/job-types';
import { NoteSourceService } from '../../src/notes/generation/note-source.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// Note exports over the wire (issue #54, epic #45, docs/specs/notes.md §8)
// =============================================================================
//
// The acceptance criteria that are about the WIRE rather than about a renderer:
//
//   * `GET /api/notes/exporters` lists the three formats and their options —
//     and resolves as a LITERAL path rather than being eaten by `:id`;
//   * an export is **202** when it queues a render and **200** when an
//     identical, unexpired one already exists, with `reused` saying which;
//   * ANOTHER USER'S NOTE IS 404 ON ALL THREE ROUTES — export, list and
//     download — in the same words a non-existent note gets, because two
//     differently-worded 404s would reintroduce exactly the oracle the status
//     code removes;
//   * an unknown format and an unknown option are both 400 — the first through
//     the registry, the second through the chosen exporter's own schema.
//
// The reuse that actually matters — "the second request rendered nothing",
// asserted by a render counter and a row id — is against REAL PostgreSQL in
// `note-export.db.spec.ts`. A mock can only show which query was issued.
// =============================================================================

const NOTES = '/api/notes';

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_NOTE_ID = '22222222-2222-4222-8222-222222222222';
const EXPORT_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  ownerId: 'owner-1',
  title: 'Kestrel weekly',
  body: '# Kestrel weekly\n\nWe ship on Friday.',
  status: 'ready',
  currentVersion: 2,
  provider: 'openai',
  model: 'gpt-4o',
  currentGenerationId: null,
  sourceType: 'transcript',
  sourceTranscriptId: '55555555-5555-4555-8555-555555555555',
  sourceNoteId: null,
  sourceObjectId: null,
  templateId: null,
  contextText: null,
  failureReason: null,
  deletedAt: null,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T01:00:00.000Z'),
  ...overrides,
});

const exportRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXPORT_ID,
  noteId: NOTE_ID,
  version: 2,
  format: 'markdown',
  options: { includeFrontMatter: true },
  optionsHash: 'hash',
  status: 'pending',
  objectId: null,
  jobId: null,
  requestedById: 'owner-1',
  error: null,
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-09-14T02:00:00.000Z'),
  ...overrides,
});

describe('Note exports integration (#54)', () => {
  let context: TestContext;
  const sources = { resolve: jest.fn() };
  let mockStorage: Record<string, jest.Mock>;

  beforeAll(async () => {
    mockStorage = {
      initMultipartUpload: jest.fn(),
      getSignedUploadUrl: jest.fn(),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/get'),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      listParts: jest.fn(),
      getMetadata: jest.fn(),
      setMetadata: jest.fn(),
      getSignedPutUrl: jest.fn(),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: NoteSourceService, useValue: sources },
        { provide: STORAGE_PROVIDER, useValue: mockStorage },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    mockStorage.getSignedDownloadUrl.mockResolvedValue('https://signed.example/get');
    prismaMock.noteExport.findFirst.mockResolvedValue(null);
    prismaMock.noteExport.findMany.mockResolvedValue([]);
    prismaMock.noteExport.findUnique.mockResolvedValue(null);
    // Stateful, because the service CREATES the row and then UPDATES it with
    // the job id: an `update` mock that echoed only its own `data` would hand
    // the response a row missing every field the create had just set.
    let created = exportRow();

    prismaMock.noteExport.create.mockImplementation(async ({ data }: any) => {
      created = exportRow(data);

      return created;
    });
    prismaMock.noteExport.update.mockImplementation(async ({ data }: any) => {
      created = { ...created, ...data };

      return created;
    });
    prismaMock.job.create.mockResolvedValue({ id: JOB_ID });
    prismaMock.auditEvent.create.mockResolvedValue({});
  });

  /** A note this caller owns. */
  function ownedNote(userId: string, overrides: Record<string, unknown> = {}): void {
    prismaMock.note.findUnique.mockResolvedValue(
      noteRow({ ownerId: userId, ...overrides }) as never,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /api/notes/exporters
  // ---------------------------------------------------------------------------

  describe('GET /api/notes/exporters', () => {
    it('resolves as a literal path and lists the three formats with their options', async () => {
      // ⚠ NOT eaten by `@Get(':id')`. A route ordering regression here shows up
      // as a 400 from `ParseUUIDPipe` for a path that exists.
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/exporters`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.exporters.map((e: { format: string }) => e.format)).toEqual([
        'docx',
        'markdown',
        'pdf',
      ]);

      const markdown = response.body.data.exporters.find(
        (e: { format: string }) => e.format === 'markdown',
      );

      expect(markdown.extension).toBe('md');
      expect(markdown.options[0]).toMatchObject({ key: 'includeFrontMatter', default: true });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/notes/:id/exports
  // ---------------------------------------------------------------------------

  describe('POST /api/notes/:id/exports', () => {
    it('answers 202 and queues `note.export` against the note', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'pdf' })
        .expect(202);

      expect(response.body.data).toMatchObject({ format: 'pdf', status: 'pending', reused: false });
      expect(prismaMock.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: NOTE_EXPORT_JOB_TYPE,
            subjectType: NOTE_SUBJECT_TYPE,
            subjectId: NOTE_ID,
          }),
        }),
      );
    });

    it('answers 200 with `reused: true` when an identical export already exists', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteExport.findFirst.mockResolvedValue(
        exportRow({ id: 'existing-1', status: 'ready' }) as never,
      );

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown' })
        .expect(200);

      expect(response.body.data).toMatchObject({ id: 'existing-1', reused: true });
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('exports the current version by default and any earlier one on request', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'docx' })
        .expect(202);

      expect(prismaMock.noteExport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ version: 2 }) }),
      );

      await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'docx', version: 1 })
        .expect(202);

      expect(prismaMock.noteExport.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ version: 1 }) }),
      );
    });

    it('404s for a version the note does not have', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'pdf', version: 99 })
        .expect(404);
    });

    it('400s for a format nobody registered, naming the ones that exist', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'rtf' })
        .expect(400);

      expect(response.body.message).toContain('docx, markdown, pdf');
    });

    it('400s for an option the chosen format does not accept', async () => {
      // Stripping it would hash to the SAME key as the default request and hand
      // the caller somebody else's already-rendered file as if it were theirs.
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown', options: { includeFrontmatter: true } })
        .expect(400);
    });

    it("404s for another user's note, in the same words a missing note gets", async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue(
        noteRow({ id: OTHER_NOTE_ID, ownerId: 'somebody-else' }) as never,
      );

      const foreign = await request(context.app.getHttpServer())
        .post(`${NOTES}/${OTHER_NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'pdf' })
        .expect(404);

      prismaMock.note.findUnique.mockResolvedValue(null);

      const missing = await request(context.app.getHttpServer())
        .post(`${NOTES}/${OTHER_NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'pdf' })
        .expect(404);

      expect(foreign.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
      expect(missing.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });

    // ⚠ THERE IS DELIBERATELY NO 403 CASE HERE. `notes:write` is seeded to all
    // three roles (`docs/specs/notes.md` §6.3 — producing a note is the core
    // product action and a fresh account's default role is Viewer), so the mock
    // user factory cannot build a signed-in caller without it. That the export
    // route asks for `edit` rather than `view` is asserted directly in
    // `note-export.service.spec.ts`, and the 403-not-404 rule for a caller who
    // can see a note is `note-access.service.spec.ts`'s subject.
  });

  // ---------------------------------------------------------------------------
  // GET /api/notes/:id/exports
  // ---------------------------------------------------------------------------

  describe('GET /api/notes/:id/exports', () => {
    it("lists this note's exports newest first", async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteExport.findMany.mockResolvedValue([
        exportRow({ id: 'export-a', format: 'pdf' }),
        exportRow({ id: 'export-b', format: 'docx' }),
      ] as never);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.exports.map((e: { id: string }) => e.id)).toEqual([
        'export-a',
        'export-b',
      ]);
    });

    it("404s for another user's note", async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue(
        noteRow({ id: OTHER_NOTE_ID, ownerId: 'somebody-else' }) as never,
      );

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${OTHER_NOTE_ID}/exports`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/notes/exports/:exportId/download
  // ---------------------------------------------------------------------------

  describe('GET /api/notes/exports/:exportId/download', () => {
    it('hands back a signed url with the filename signed into it', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteExport.findUnique.mockResolvedValue(
        exportRow({ status: 'ready', objectId: 'object-1' }) as never,
      );
      prismaMock.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        storageKey: 'notes/x/exports/y.md',
        status: 'ready',
        size: BigInt(4096),
      } as never);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/exports/${EXPORT_ID}/download`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: 'https://signed.example/get',
        filename: 'Kestrel weekly (v2).md',
        sizeBytes: '4096',
      });
      // ⚠ SIGNED INTO THE URL, not added as a response header afterwards.
      expect(mockStorage.getSignedDownloadUrl).toHaveBeenCalledWith(
        'notes/x/exports/y.md',
        expect.objectContaining({
          responseContentDisposition: expect.stringContaining('attachment; filename='),
        }),
      );
    });

    it('404s while the export is still rendering', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteExport.findUnique.mockResolvedValue(exportRow() as never);

      await request(context.app.getHttpServer())
        .get(`${NOTES}/exports/${EXPORT_ID}/download`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it("404s for an export of another user's note, and for one that does not exist", async () => {
      // The export id must not become an oracle for the existence of somebody
      // else's note, so both answers are 404.
      const user = await createMockTestUser(context);

      prismaMock.noteExport.findUnique.mockResolvedValue(
        exportRow({ noteId: OTHER_NOTE_ID, status: 'ready', objectId: 'object-1' }) as never,
      );
      prismaMock.note.findUnique.mockResolvedValue(
        noteRow({ id: OTHER_NOTE_ID, ownerId: 'somebody-else' }) as never,
      );

      const foreign = await request(context.app.getHttpServer())
        .get(`${NOTES}/exports/${EXPORT_ID}/download`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(foreign.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);

      prismaMock.noteExport.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`${NOTES}/exports/${EXPORT_ID}/download`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });
});
