import request from 'supertest';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import {
  BUILT_IN_TEMPLATE_IMMUTABLE_MESSAGE,
  NOTE_TEMPLATE_NOT_FOUND_MESSAGE,
} from '../../src/notes/access/note-template-access.service';
import { NoteSourceService } from '../../src/notes/generation/note-source.service';
import { MAX_INSTRUCTIONS_CHARS } from '../../src/notes/dto/note-template.dto';
import {
  authHeader,
  createMockTestUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// Note templates, over the wire (issue #50, epic #45)
// =============================================================================
//
// The seven routes as a client meets them, through everything `AppModule` wires
// — the guards, the Zod pipe, the response envelope and the exception filter.
// Only `PrismaService` and `NoteSourceService` are stand-ins (the latter so a
// preview does not have to materialize a real transcript to exercise the wire
// contract this file is about).
//
// -----------------------------------------------------------------------------
// THE ASSERTION PAIR THIS FILE EXISTS FOR
// -----------------------------------------------------------------------------
//
//   `PATCH`/`DELETE` a BUILT-IN         → **403**
//   `PATCH`/`DELETE` ANOTHER USER'S     → **404**
//
// They are asserted in the same `describe`, one after the other, ON PURPOSE.
// The difference is deliberate and it looks like an inconsistency to anyone who
// has not been told why: a built-in is listed in every account's own catalogue,
// so its existence is not a secret and a 404 would be misleading rather than
// protective; another user's template's existence IS a secret, and the uniform
// 404 is what stops this API confirming it. `note-template-access.service.ts`'s
// header carries the full argument. If a later change "makes these consistent",
// one of these two tests fails and points at that header.
// =============================================================================

const TEMPLATES = '/api/note-templates';

const OWNER_TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const BUILT_IN_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '44444444-4444-4444-8444-444444444444';
const TRANSCRIPT_ID = '55555555-5555-4555-8555-555555555555';

/** A `note_templates` row as Prisma returns it. */
const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: OWNER_TEMPLATE_ID,
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

/** A seeded built-in: `ownerId` permanently NULL (spec §7.1). */
const builtInRow = (overrides: Record<string, unknown> = {}) =>
  templateRow({
    id: BUILT_IN_ID,
    ownerId: null,
    name: 'Concise Meeting Notes',
    description: 'A short, scannable summary.',
    ...overrides,
  });

/** `ai` policy with the feature actually switched on. */
const ENABLED_AI_SETTINGS = {
  ...DEFAULT_SYSTEM_SETTINGS,
  ai: {
    ...DEFAULT_SYSTEM_SETTINGS.ai,
    enabled: true,
    providers: {
      openai: {
        ...DEFAULT_SYSTEM_SETTINGS.ai.providers.openai,
        allowedModels: ['gpt-4o'],
        defaultModel: 'gpt-4o',
      },
    },
  },
};

describe('Note templates (#50)', () => {
  let context: TestContext;
  const sources = { resolve: jest.fn() };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: NoteSourceService, useValue: sources }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    sources.resolve.mockResolvedValue({
      text: '**Ana** · 00:00\n\nWe should ship on Friday.',
      describe: 'transcript at version 3',
    });

    prismaMock.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: ENABLED_AI_SETTINGS,
      version: 1,
      updatedAt: new Date(),
      updatedByUser: null,
    });

    prismaMock.note.count.mockResolvedValue(0);
    prismaMock.noteTemplate.findMany.mockResolvedValue([]);
  });

  // ==========================================================================
  // GET /api/note-templates
  // ==========================================================================

  describe('GET /api/note-templates', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(TEMPLATES).expect(401);
    });

    it('returns the caller\'s own templates AND the built-ins, correctly flagged', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findMany.mockResolvedValue([
        builtInRow(),
        templateRow({ ownerId: user.id }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(TEMPLATES)
        .set(authHeader(user.accessToken))
        .expect(200);

      const byId = Object.fromEntries(
        response.body.data.items.map((item: { id: string }) => [item.id, item]),
      );

      expect(byId[BUILT_IN_ID].builtIn).toBe(true);
      expect(byId[OWNER_TEMPLATE_ID].builtIn).toBe(false);
      expect(response.body.data.total).toBe(2);

      // `ownerId` is never published — `builtIn` is the single derived statement
      // of the fact, and two that could disagree are what this avoids.
      expect(byId[BUILT_IN_ID]).not.toHaveProperty('ownerId');
    });

    it('scopes the query to "mine or built-in", so another user\'s can never appear', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(TEMPLATES)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = prismaMock.noteTemplate.findMany.mock.calls[0][0].where;

      expect(where.OR).toEqual([{ ownerId: null }, { ownerId: user.id }]);
      // Archived hidden by default.
      expect(where.isArchived).toBe(false);
    });

    it('includes archived rows only when asked', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(`${TEMPLATES}?includeArchived=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.noteTemplate.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'isArchived',
      );
    });
  });

  // ==========================================================================
  // GET /api/note-templates/:id
  // ==========================================================================

  describe('GET /api/note-templates/:id', () => {
    it('reads a built-in', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.builtIn).toBe(true);
    });

    it('is 404 — not 403 — for another user\'s template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${STRANGER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
    });

    it('answers a missing row and an unowned one in the SAME words', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValueOnce(null);
      const missing = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${MISSING_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      prismaMock.noteTemplate.findUnique.mockResolvedValueOnce(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );
      const unowned = await request(context.app.getHttpServer())
        .get(`${TEMPLATES}/${STRANGER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      // Two differently-worded 404s would reintroduce exactly the oracle the
      // status code was chosen to remove.
      expect(missing.body.message).toBe(unowned.body.message);
    });
  });

  // ==========================================================================
  // POST /api/note-templates
  // ==========================================================================

  describe('POST /api/note-templates', () => {
    it('creates a template owned by the caller', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.create.mockResolvedValue(templateRow({ ownerId: user.id }));

      const response = await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({
          name: 'My notes',
          instructions: 'Write meeting notes.',
          outputFormat: 'meeting_notes',
          structure: ['Overview', 'Decisions'],
        })
        .expect(201);

      expect(prismaMock.noteTemplate.create.mock.calls[0][0].data.ownerId).toBe(user.id);
      expect(response.body.data.builtIn).toBe(false);
    });

    it('refuses a client-supplied ownerId rather than silently dropping it', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({
          name: 'Sneaky',
          instructions: 'x',
          outputFormat: 'summary',
          // A client that could name an owner could name `null`, which is how a
          // user would mint a built-in.
          ownerId: null,
        })
        .expect(400);

      expect(prismaMock.noteTemplate.create).not.toHaveBeenCalled();
    });

    it('validates `structure` as an ordered list of non-empty strings', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({
          name: 'Bad structure',
          instructions: 'x',
          outputFormat: 'summary',
          // `parseTemplateStructure` would silently drop both of these at
          // generation time, so they are refused at the door instead.
          structure: [{ heading: 'Overview' }, ''],
        })
        .expect(400);

      expect(prismaMock.noteTemplate.create).not.toHaveBeenCalled();
    });

    it('refuses an unknown outputFormat', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({ name: 'x', instructions: 'x', outputFormat: 'haiku' })
        .expect(400);
    });

    it('refuses oversized instructions WITH THE SIZE IN THE MESSAGE', async () => {
      const user = await createMockTestUser(context);

      const oversized = 'a'.repeat(MAX_INSTRUCTIONS_CHARS + 25);

      const response = await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(user.accessToken))
        .send({ name: 'Huge', instructions: oversized, outputFormat: 'summary' })
        .expect(400);

      // BOTH numbers, because "too long" with neither is a guessing game — and
      // the reason the ceiling is not a Zod `.max()` (which renders as a flat
      // "Validation failed").
      expect(response.body.message).toContain(
        (MAX_INSTRUCTIONS_CHARS + 25).toLocaleString('en-US'),
      );
      expect(response.body.message).toContain(MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US'));
      expect(prismaMock.noteTemplate.create).not.toHaveBeenCalled();
    });

    it('lets a Viewer create one — the permissions are seeded to all three roles', async () => {
      const viewer = await createMockViewerUser(context);

      prismaMock.noteTemplate.create.mockResolvedValue(templateRow({ ownerId: viewer.id }));

      await request(context.app.getHttpServer())
        .post(TEMPLATES)
        .set(authHeader(viewer.accessToken))
        .send({ name: 'Viewer notes', instructions: 'x', outputFormat: 'summary' })
        .expect(201);
    });
  });

  // ==========================================================================
  // ⚠ THE PAIR. 403 for a built-in, 404 for somebody else's. See the header.
  // ==========================================================================

  describe('immutability of built-ins vs. privacy of other users\' templates', () => {
    it('PATCH on a BUILT-IN is 403 — its existence is public, so hiding it would mislead', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());

      const response = await request(context.app.getHttpServer())
        .patch(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(user.accessToken))
        .send({ instructions: 'Rewritten.' })
        .expect(403);

      expect(response.body.message).toBe(BUILT_IN_TEMPLATE_IMMUTABLE_MESSAGE);
      // It names the remedy, because duplicate-to-mine is the designed path and
      // not merely a workaround.
      expect(response.body.message).toMatch(/duplicate/i);
      expect(prismaMock.noteTemplate.update).not.toHaveBeenCalled();
    });

    it('PATCH on ANOTHER USER\'S template is 404 — its existence is private', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );

      const response = await request(context.app.getHttpServer())
        .patch(`${TEMPLATES}/${STRANGER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ instructions: 'Rewritten.' })
        .expect(404);

      expect(response.body.message).toBe(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
      expect(prismaMock.noteTemplate.update).not.toHaveBeenCalled();
    });

    it('DELETE on a BUILT-IN is 403', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      expect(prismaMock.noteTemplate.delete).not.toHaveBeenCalled();
    });

    it('DELETE on ANOTHER USER\'S template is 404', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );

      await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${STRANGER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(prismaMock.noteTemplate.delete).not.toHaveBeenCalled();
    });

    it('is 403 for a built-in even for an ADMIN — immutability is not a permission check', async () => {
      const admin = await createMockTestUser(context, { roleName: 'admin' });

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());

      await request(context.app.getHttpServer())
        .patch(`${TEMPLATES}/${BUILT_IN_ID}`)
        .set(authHeader(admin.accessToken))
        .send({ name: 'Renamed' })
        .expect(403);
    });
  });

  // ==========================================================================
  // PATCH /api/note-templates/:id
  // ==========================================================================

  describe('PATCH /api/note-templates/:id', () => {
    it('edits the caller\'s own template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow({ ownerId: user.id }));
      prismaMock.noteTemplate.update.mockResolvedValue(
        templateRow({ ownerId: user.id, instructions: 'Rewritten.' }),
      );

      const response = await request(context.app.getHttpServer())
        .patch(`${TEMPLATES}/${OWNER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ instructions: 'Rewritten.' })
        .expect(200);

      // An absent key leaves the column alone rather than clearing it.
      expect(prismaMock.noteTemplate.update.mock.calls[0][0].data).toEqual({
        instructions: 'Rewritten.',
      });
      expect(response.body.data.instructions).toBe('Rewritten.');
    });

    it('un-archives, which is what makes archiving reversible', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ ownerId: user.id, isArchived: true }),
      );
      prismaMock.noteTemplate.update.mockResolvedValue(
        templateRow({ ownerId: user.id, isArchived: false }),
      );

      const response = await request(context.app.getHttpServer())
        .patch(`${TEMPLATES}/${OWNER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ isArchived: false })
        .expect(200);

      expect(response.body.data.isArchived).toBe(false);
    });
  });

  // ==========================================================================
  // DELETE /api/note-templates/:id
  // ==========================================================================

  describe('DELETE /api/note-templates/:id', () => {
    it('deletes when nothing references it', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow({ ownerId: user.id }));
      prismaMock.note.count.mockResolvedValue(0);
      prismaMock.noteTemplate.delete.mockResolvedValue(templateRow({ ownerId: user.id }));

      const response = await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${OWNER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.outcome).toBe('deleted');
      expect(prismaMock.noteTemplate.delete).toHaveBeenCalled();
    });

    it('ARCHIVES when notes still reference it, and never touches the notes', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow({ ownerId: user.id }));
      prismaMock.note.count.mockResolvedValue(3);
      prismaMock.noteTemplate.update.mockResolvedValue(
        templateRow({ ownerId: user.id, isArchived: true }),
      );

      const response = await request(context.app.getHttpServer())
        .delete(`${TEMPLATES}/${OWNER_TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ outcome: 'archived', noteCount: 3 });

      // The row survives...
      expect(prismaMock.noteTemplate.delete).not.toHaveBeenCalled();
      expect(prismaMock.noteTemplate.update).toHaveBeenCalledWith({
        where: { id: OWNER_TEMPLATE_ID },
        data: { isArchived: true },
      });

      // ...and THE REFERENCING NOTE'S `templateId` SURVIVES WITH IT. Nothing in
      // this path writes to `notes` at all, which is the point: `SetNull` being
      // available is the argument FOR archiving, not against it — a note that
      // can no longer say what produced it is the opposite of what this is for.
      expect(prismaMock.note.update).not.toHaveBeenCalled();
      expect(prismaMock.note.updateMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /api/note-templates/:id/duplicate
  // ==========================================================================

  describe('POST /api/note-templates/:id/duplicate', () => {
    it('copies a BUILT-IN into an owned, editable template — the sanctioned way to customise one', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.noteTemplate.findMany.mockResolvedValue([]);
      prismaMock.noteTemplate.create.mockImplementation(async ({ data }: never) =>
        templateRow({ id: 'copy-1', ...(data as Record<string, unknown>) }),
      );

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${BUILT_IN_ID}/duplicate`)
        .set(authHeader(user.accessToken))
        .expect(201);

      const created = prismaMock.noteTemplate.create.mock.calls[0][0].data;

      expect(created.ownerId).toBe(user.id);
      expect(created.name).toBe('Concise Meeting Notes (copy)');
      // EVERY column, not just `instructions` — a copy that dropped these would
      // hand the user a form to refill from scratch.
      expect(created).toMatchObject({
        instructions: 'Write meeting notes.',
        outputFormat: 'meeting_notes',
        structure: ['Overview', 'Decisions'],
        tone: 'neutral',
        length: 'short',
        isArchived: false,
      });
      expect(response.body.data.builtIn).toBe(false);

      // The built-in itself is untouched — that is what keeps the seeded set a
      // re-runnable baseline rather than something a re-seed fights a user over.
      expect(prismaMock.noteTemplate.update).not.toHaveBeenCalled();
    });

    it('resets `isArchived` — a duplicate is a fresh starting point', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ ownerId: user.id, isArchived: true }),
      );
      prismaMock.noteTemplate.findMany.mockResolvedValue([]);
      prismaMock.noteTemplate.create.mockImplementation(async ({ data }: never) =>
        templateRow({ id: 'copy-1', ...(data as Record<string, unknown>) }),
      );

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${OWNER_TEMPLATE_ID}/duplicate`)
        .set(authHeader(user.accessToken))
        .expect(201);

      expect(prismaMock.noteTemplate.create.mock.calls[0][0].data.isArchived).toBe(false);
    });

    it('suffixes past a name that is already taken', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.noteTemplate.findMany.mockResolvedValue([
        { name: 'Concise Meeting Notes (copy)' },
      ]);
      prismaMock.noteTemplate.create.mockImplementation(async ({ data }: never) =>
        templateRow({ id: 'copy-2', ...(data as Record<string, unknown>) }),
      );

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${BUILT_IN_ID}/duplicate`)
        .set(authHeader(user.accessToken))
        .expect(201);

      expect(prismaMock.noteTemplate.create.mock.calls[0][0].data.name).toBe(
        'Concise Meeting Notes (copy 2)',
      );
    });

    it('is 404 for another user\'s template', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${STRANGER_TEMPLATE_ID}/duplicate`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(prismaMock.noteTemplate.create).not.toHaveBeenCalled();
    });

    it('lets a Viewer duplicate a built-in', async () => {
      const viewer = await createMockViewerUser(context);

      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());
      prismaMock.noteTemplate.findMany.mockResolvedValue([]);
      prismaMock.noteTemplate.create.mockImplementation(async ({ data }: never) =>
        templateRow({ id: 'copy-1', ...(data as Record<string, unknown>) }),
      );

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/${BUILT_IN_ID}/duplicate`)
        .set(authHeader(viewer.accessToken))
        .expect(201);
    });
  });

  // ==========================================================================
  // POST /api/note-templates/preview
  // ==========================================================================

  describe('POST /api/note-templates/preview', () => {
    /** The caller has a key, and the transcript is theirs. */
    function readyToPreview(userId: string): void {
      prismaMock.userAiCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
      prismaMock.transcript.findUnique.mockResolvedValue({
        id: TRANSCRIPT_ID,
        ownerId: userId,
        deletedAt: null,
        currentVersion: 3,
      });
      prismaMock.noteGeneration.create.mockImplementation(async ({ data }: never) => ({
        id: 'gen-1',
        ...(data as Record<string, unknown>),
      }));
      prismaMock.noteGeneration.update.mockResolvedValue({ id: 'gen-1' });
      prismaMock.job.create.mockResolvedValue({ id: 'job-1', type: 'note.generate' });
    }

    const inlineBody = {
      template: {
        name: 'Unsaved draft',
        instructions: 'Write meeting notes, but shorter.',
        outputFormat: 'meeting_notes',
        structure: ['Overview'],
      },
      source: { type: 'transcript', transcriptId: TRANSCRIPT_ID },
    };

    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .send(inlineBody)
        .expect(401);
    });

    it('accepts an UNSAVED template body, creating no template row and no note row', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(202);

      // Nothing was saved. This is the whole point of accepting an inline body:
      // you should not have to save a template you have not decided you want in
      // order to find out whether you want it.
      expect(prismaMock.noteTemplate.create).not.toHaveBeenCalled();
      expect(prismaMock.note.create).not.toHaveBeenCalled();

      expect(response.body.data).toMatchObject({
        generationId: 'gen-1',
        kind: 'preview',
        status: 'pending',
        templateId: null,
        templateName: 'Unsaved draft',
        providerId: 'openai',
        model: 'gpt-4o',
      });
      expect(response.body.data.expiresAt).toBeTruthy();
    });

    it('creates a generation with `noteId: null` and an `expiresAt`, so it is invisible and disposable', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(202);

      const created = prismaMock.noteGeneration.create.mock.calls[0][0].data;

      // `noteId: null` IS the definition of a preview (spec §4.4): a note list
      // reads `notes`, and this row is attached to nothing in it.
      expect(created.noteId).toBeNull();
      expect(created.kind).toBe('preview');
      expect(created.templateId).toBeNull();
      expect(created.expiresAt).toBeInstanceOf(Date);
      expect((created.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('enqueues THE SAME `note.generate` job, carrying the unsaved body and the billed user', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(202);

      const job = prismaMock.job.create.mock.calls[0][0].data;

      // One generation mechanism, two entry points — not a second pipeline.
      expect(job.type).toBe('note.generate');
      expect(job.payload).toMatchObject({
        generationId: 'gen-1',
        userId: user.id,
        template: {
          instructions: 'Write meeting notes, but shorter.',
          outputFormat: 'meeting_notes',
          structure: ['Overview'],
        },
      });

      // ⚠ NO DEDUP KEY. Two previews are two pieces of work: the user changed
      // the instructions and pressed the button again. Deduplicating would hand
      // back the first job and show them their OLD template generating.
      expect(job.dedupKey ?? null).toBeNull();
    });

    it('previews a SAVED template by id, carrying NO snapshot — the job reads the row', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);
      prismaMock.noteTemplate.findUnique.mockResolvedValue(builtInRow());

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send({
          templateId: BUILT_IN_ID,
          source: { type: 'transcript', transcriptId: TRANSCRIPT_ID },
        })
        .expect(202);

      expect(prismaMock.noteGeneration.create.mock.calls[0][0].data.templateId).toBe(BUILT_IN_ID);
      // The saved path is the real note's path, byte for byte — there is no
      // snapshot to disagree with the row.
      expect(prismaMock.job.create.mock.calls[0][0].data.payload).not.toHaveProperty('template');
    });

    it('refuses both `templateId` and `template` at once', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send({ ...inlineBody, templateId: BUILT_IN_ID })
        .expect(400);

      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('is 404 for a transcript the caller cannot read, and creates nothing', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);
      prismaMock.transcript.findUnique.mockResolvedValue({
        id: TRANSCRIPT_ID,
        ownerId: 'somebody-else',
        deletedAt: null,
        currentVersion: 3,
      });
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(404);

      // A preview must never become a way to read a transcript by generating a
      // note from it.
      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('is 404 for another user\'s saved template', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);
      prismaMock.noteTemplate.findUnique.mockResolvedValue(
        templateRow({ id: STRANGER_TEMPLATE_ID, ownerId: 'somebody-else' }),
      );

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send({
          templateId: STRANGER_TEMPLATE_ID,
          source: { type: 'transcript', transcriptId: TRANSCRIPT_ID },
        })
        .expect(404);

      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('is 409 when the caller has no API key — a preview spends their own money', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);
      prismaMock.userAiCredential.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(409);

      expect(response.body.message).toMatch(/key/i);
      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('is 409 when the deployment has not enabled AI', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);
      prismaMock.systemSettings.findUnique.mockResolvedValue({
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS,
        version: 1,
        updatedAt: new Date(),
        updatedByUser: null,
      });

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send(inlineBody)
        .expect(409);

      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('is 400 for a model this deployment does not permit, naming the ones it does', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send({ ...inlineBody, model: 'gpt-9-imaginary' })
        .expect(400);

      expect(response.body.message).toContain('gpt-4o');
      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('refuses an oversized inline body WITH THE SIZE IN THE MESSAGE, exactly as a save would', async () => {
      const user = await createMockTestUser(context);

      readyToPreview(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(user.accessToken))
        .send({
          ...inlineBody,
          template: {
            ...inlineBody.template,
            instructions: 'a'.repeat(MAX_INSTRUCTIONS_CHARS + 5),
          },
        })
        .expect(400);

      expect(response.body.message).toContain(MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US'));
      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
    });

    it('lets a Viewer preview — the permissions are seeded to all three roles', async () => {
      const viewer = await createMockViewerUser(context);

      readyToPreview(viewer.id);

      await request(context.app.getHttpServer())
        .post(`${TEMPLATES}/preview`)
        .set(authHeader(viewer.accessToken))
        .send(inlineBody)
        .expect(202);
    });
  });
});
