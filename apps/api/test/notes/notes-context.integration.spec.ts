import request from 'supertest';

import { NOTE_NOT_FOUND_MESSAGE } from '../../src/notes/access/note-access.service';
import {
  NO_GENERATION_REASON,
  SOURCE_WITHHELD_NOTICE,
} from '../../src/notes/note-generation-context.service';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// GET /api/notes/:id/context and /:id/generations/:generationId/context (#307)
// =============================================================================
//
// Over the wire, through the real guard stack — the identical posture
// `notes.integration.spec.ts` takes for every other note route: only
// `PrismaService` is a stand-in.
// =============================================================================

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_NOTE_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT_ID = '44444444-4444-4444-8444-444444444444';
const GENERATION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_GENERATION_ID = '66666666-6666-4666-8666-666666666666';

const NOTES = '/api/notes';

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  ownerId: 'owner-1',
  title: 'Kestrel weekly',
  body: '# Kestrel weekly\n\nWe ship on Friday.',
  status: 'ready',
  currentVersion: 2,
  currentGenerationId: GENERATION_ID,
  sourceType: 'transcript',
  sourceTranscriptId: TRANSCRIPT_ID,
  sourceNoteId: null,
  sourceObjectId: null,
  templateId: TEMPLATE_ID,
  contextText: null,
  failureReason: null,
  deletedAt: null,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T01:00:00.000Z'),
  ...overrides,
});

const generationRow = (overrides: Record<string, unknown> = {}) => ({
  id: GENERATION_ID,
  noteId: NOTE_ID,
  kind: 'create',
  status: 'succeeded',
  templateId: TEMPLATE_ID,
  templateNameSnapshot: 'Meeting notes',
  contextText: null,
  sourceType: 'transcript',
  sourceTranscriptId: TRANSCRIPT_ID,
  sourceNoteId: null,
  sourceObjectId: null,
  providerId: 'openai',
  model: 'gpt-4o',
  content: '# Kestrel weekly\n\nWe ship on Friday.',
  lastEventId: 3,
  systemPrompt: 'You write meeting notes.',
  userContent: 'Source material:\nAna: we ship on Friday.',
  sourceVersion: 7,
  contextCapturedAt: new Date('2026-09-14T00:30:00.000Z'),
  promptTokens: 120,
  completionTokens: 40,
  startedAt: new Date('2026-09-14T00:29:00.000Z'),
  completedAt: new Date('2026-09-14T00:30:00.000Z'),
  errorClass: null,
  errorDetail: null,
  createdAt: new Date('2026-09-14T00:28:00.000Z'),
  updatedAt: new Date('2026-09-14T00:30:00.000Z'),
  ...overrides,
});

describe('Note generation context (#307)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    prismaMock.note.findUnique.mockResolvedValue(noteRow());
    prismaMock.noteGeneration.findUnique.mockResolvedValue(generationRow());
    // The source is readable by default: the caller owns the transcript.
    prismaMock.transcript.findMany.mockResolvedValue([
      { id: TRANSCRIPT_ID, title: 'Kestrel weekly' },
    ]);
  });

  // ==========================================================================
  // GET /api/notes/:id/context
  // ==========================================================================

  describe('GET /api/notes/:id/context', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(`${NOTES}/${NOTE_ID}/context`).expect(401);
    });

    it('returns the stored context, with the correct shape', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.transcript.findMany.mockResolvedValue([
        { id: TRANSCRIPT_ID, title: 'Kestrel weekly' },
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        generationId: GENERATION_ID,
        kind: 'create',
        status: 'succeeded',
        stored: true,
        capturedAt: '2026-09-14T00:30:00.000Z',
        templateId: TEMPLATE_ID,
        templateNameSnapshot: 'Meeting notes',
        provider: 'openai',
        model: 'gpt-4o',
        contextText: null,
        sourceType: 'transcript',
        sourceVersion: 7,
        sourceRedacted: false,
        systemPrompt: 'You write meeting notes.',
        userContent: 'Source material:\nAna: we ship on Friday.',
        promptTokens: 120,
        completionTokens: 40,
      });
    });

    it('reads the note\'s CURRENT generation', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));

      await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.noteGeneration.findUnique).toHaveBeenCalledWith({
        where: { id: GENERATION_ID },
      });
    });

    it('404s with details.reason "no_generation" for a note with no current generation', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(
        noteRow({ ownerId: user.id, currentGenerationId: null }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.details).toEqual({ reason: NO_GENERATION_REASON });
    });

    it('is 404 — never 403 — for another user\'s note', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: 'somebody-else' }));

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });

    it('is 404 for a note that does not exist', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`${NOTES}/${OTHER_NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('redacts the source material when the caller can no longer read the source', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));
      // The transcript is no longer owned or shared with this caller.
      prismaMock.transcript.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.sourceRedacted).toBe(true);
      expect(response.body.data.userContent).toBe(`Source material:\n${SOURCE_WITHHELD_NOTICE}`);
    });
  });

  // ==========================================================================
  // GET /api/notes/:id/generations/:generationId/context
  // ==========================================================================

  describe('GET /api/notes/:id/generations/:generationId/context', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/generations/${GENERATION_ID}/context`)
        .expect(401);
    });

    it('returns the named generation\'s context', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.noteGeneration.findUnique.mockResolvedValue(
        generationRow({ id: OTHER_GENERATION_ID }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/generations/${OTHER_GENERATION_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.generationId).toBe(OTHER_GENERATION_ID);
    });

    it('404s for a generation that belongs to a DIFFERENT note', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.noteGeneration.findUnique.mockResolvedValue(
        generationRow({ id: OTHER_GENERATION_ID, noteId: OTHER_NOTE_ID }),
      );

      await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/generations/${OTHER_GENERATION_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('404s for a generation id that does not exist', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.noteGeneration.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/generations/${OTHER_GENERATION_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('is 404 — never 403 — for another user\'s note', async () => {
      const user = await createMockTestUser(context);
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: 'somebody-else' }));

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/generations/${GENERATION_ID}/context`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });
  });
});
