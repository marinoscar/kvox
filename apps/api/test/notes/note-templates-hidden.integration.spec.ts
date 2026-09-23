import request from 'supertest';

import { NOTE_TEMPLATE_NOT_FOUND_MESSAGE } from '../../src/notes/access/note-template-access.service';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// Per-user hidden note templates (issue #310), over the wire
// =============================================================================
//
// `PUT`/`DELETE /api/note-templates/{id}/hidden` — the two routes issue #310
// adds — plus the `hidden`/`includeHidden` surface it adds to the existing
// list/get routes. `note-templates.integration.spec.ts` covers the original
// seven routes; this file is deliberately scoped to what #310 changed, so a
// future revert of #310 fails exactly the tests that describe it.
//
// ⚠ THE ONE THING BOTH FILES ASSERT FROM OPPOSITE DIRECTIONS: hiding is a
// LISTING preference, never access control. This file proves the positive —
// PUT/DELETE succeed for a built-in and for the caller's own template, and
// are idempotent — while `notes.integration.spec.ts` proves the negative:
// `POST /api/notes` against a HIDDEN template still creates the note, because
// nothing on that path ever consults `user_hidden_note_templates`.
// =============================================================================

const TEMPLATES = '/api/note-templates';

const BUILT_IN_ID = '22222222-2222-4222-8222-222222222222';
const OWNED_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER_ID = '33333333-3333-4333-8333-333333333333';

const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: OWNED_ID,
  ownerId: 'owner-1',
  name: 'My notes',
  description: 'Mine',
  instructions: 'Write meeting notes.',
  outputFormat: 'meeting_notes',
  structure: ['Overview', 'Decisions'],
  tone: 'neutral',
  length: 'short',
  model: null,
  isArchived: false,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T00:00:00.000Z'),
  ...overrides,
});

const builtInRow = (overrides: Record<string, unknown> = {}) =>
  templateRow({
    id: BUILT_IN_ID,
    ownerId: null,
    name: 'Concise Meeting Notes',
    description: 'A short, scannable summary.',
    ...overrides,
  });

describe('Per-user hidden note templates (#310)', () => {
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

    prismaMock.note.count.mockResolvedValue(0);
    prismaMock.noteTemplate.findMany.mockResolvedValue([]);
  });

  // ==========================================================================
  // PUT /api/note-templates/:id/hidden
  // ==========================================================================

  describe('PUT /api/note-templates/:id/hidden', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).put(`${TEMPLATES}/${BUILT_IN_ID}/hidden`).expect(401);
    });

    it('is 204 for a BUILT-IN — hiding is allowed where PATCH/DELETE would be 403', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.upsert.mockResolvedValue({
        userId: user.id,
        templateId: BUILT_IN_ID,
      });

      const response = await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
      expect(prismaMock.userHiddenNoteTemplate.upsert).toHaveBeenCalledWith({
        where: { userId_templateId: { userId: user.id, templateId: BUILT_IN_ID } },
        create: { userId: user.id, templateId: BUILT_IN_ID },
        update: {},
      });
      // The shared row is never written — this is a listing preference, not a
      // template edit.
      expect(prismaMock.noteTemplate.update).not.toHaveBeenCalled();
    });

    it('is 204 for the caller\'s OWN template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow({ ownerId: user.id }));
      prismaMock.userHiddenNoteTemplate.upsert.mockResolvedValue({
        userId: user.id,
        templateId: OWNED_ID,
      });

      await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${OWNED_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('is 404 — never 403 — for ANOTHER USER\'S template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_ID, ownerId: 'somebody-else' }),
      );

      const response = await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${STRANGER_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
      expect(prismaMock.userHiddenNoteTemplate.upsert).not.toHaveBeenCalled();
    });

    it('is 404 for a template that does not exist at all', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${STRANGER_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('is 400 for a malformed id', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/not-a-uuid/hidden`)
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(prismaMock.noteTemplate.findUnique).not.toHaveBeenCalled();
    });

    it('is IDEMPOTENT — a repeated PUT is 204 again, with an empty `update`', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.upsert.mockResolvedValue({
        userId: user.id,
        templateId: BUILT_IN_ID,
      });

      await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      await request(context.app.getHttpServer())
        .put(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prismaMock.userHiddenNoteTemplate.upsert).toHaveBeenCalledTimes(2);
      for (const call of prismaMock.userHiddenNoteTemplate.upsert.mock.calls) {
        expect(call[0].update).toEqual({});
      }
    });
  });

  // ==========================================================================
  // DELETE /api/note-templates/:id/hidden
  // ==========================================================================

  describe('DELETE /api/note-templates/:id/hidden', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .expect(401);
    });

    it('is 204 for a BUILT-IN', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.deleteMany.mockResolvedValue({ count: 1 });

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prismaMock.userHiddenNoteTemplate.deleteMany).toHaveBeenCalledWith({
        where: { userId: user.id, templateId: BUILT_IN_ID },
      });
    });

    it('is 204 even when the template was NOT hidden — un-hiding is idempotent', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.deleteMany.mockResolvedValue({ count: 0 });

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('is 404 — never 403 — for ANOTHER USER\'S template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_ID, ownerId: 'somebody-else' }),
      );

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${STRANGER_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(prismaMock.userHiddenNoteTemplate.deleteMany).not.toHaveBeenCalled();
    });

    it('is 400 for a malformed id', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/not-a-uuid/hidden`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });

    it('repeated DELETE stays 204', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.deleteMany.mockResolvedValue({ count: 0 });

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}/hidden`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prismaMock.userHiddenNoteTemplate.deleteMany).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // GET /api/note-templates — includeHidden / hidden flag
  // ==========================================================================

  describe('GET /api/note-templates — hidden visibility', () => {
    it('excludes a hidden template by DEFAULT, and narrows on `hiddenBy: { none: { userId } }`', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(TEMPLATES)
        .set(authHeader(user.accessToken))
        .expect(200);

      const call = prismaMock.noteTemplate.findMany.mock.calls[0][0];

      expect(call.where.hiddenBy).toEqual({ none: { userId: user.id } });
    });

    it('`includeHidden=true` returns the hidden template WITH `hidden: true`', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findMany.mockResolvedValue([
        { ...builtInRow(), hiddenBy: [{ userId: user.id }] },
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}?includeHidden=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.noteTemplate.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'hiddenBy',
      );
      expect(response.body.data.items[0]).toMatchObject({ id: BUILT_IN_ID, hidden: true });
    });

    it('never shows another user\'s hide on a shared built-in — `hiddenBy` is filtered per caller', async () => {
      const user = await createMockTestUser(context);

      // Prisma's `include: { hiddenBy: { where: { userId } } }` would already
      // return an EMPTY array here for a hide belonging to somebody else; this
      // pins that the row is read as "empty means visible to me".
      prismaMock.noteTemplate.findMany.mockResolvedValue([{ ...builtInRow(), hiddenBy: [] }]);

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}?includeHidden=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0].hidden).toBe(false);
    });
  });

  // ==========================================================================
  // GET /api/note-templates/:id — carries `hidden`
  // ==========================================================================

  describe('GET /api/note-templates/:id — carries `hidden`', () => {
    it('reports `hidden: true` when the caller has hidden it', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.findUnique.mockResolvedValue({
        userId: user.id,
        templateId: BUILT_IN_ID,
      });

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.hidden).toBe(true);
    });

    it('reports `hidden: false` when it has not been hidden', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.userHiddenNoteTemplate.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.hidden).toBe(false);
    });
  });

  // ==========================================================================
  // POST /api/note-templates and POST /api/note-templates/:id/duplicate —
  // always `hidden: false`
  // ==========================================================================

  describe('create/duplicate always report `hidden: false`', () => {
    it('POST /api/note-templates returns `hidden: false`', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.create.mockResolvedValue(templateRow({ ownerId: user.id }));

      const response = await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({ name: 'My notes', instructions: 'Write meeting notes.', outputFormat: 'meeting_notes' })
        .expect(201);

      expect(response.body.data.hidden).toBe(false);
    });

    it('POST /api/note-templates/:id/duplicate returns `hidden: false` even off a HIDDEN source', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.noteTemplate.findMany.mockResolvedValue([]);
      prismaMock.noteTemplate.create.mockImplementation(async ({ data }: never) =>
        templateRow({ id: 'copy-1', ...(data as Record<string, unknown>) }),
      );
      // The source is hidden by the caller — duplicating it is still a
      // visible, fresh copy.
      prismaMock.userHiddenNoteTemplate.findUnique.mockResolvedValue({
        userId: user.id,
        templateId: BUILT_IN_ID,
      });

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${BUILT_IN_ID}/duplicate`)
        .set(authHeader(user.accessToken))
        .expect(201);

      expect(response.body.data.hidden).toBe(false);
    });
  });
});
