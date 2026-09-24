import request from 'supertest';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { NOTE_NOT_FOUND_MESSAGE } from '../../src/notes/access/note-access.service';
import { NOTE_CONFLICT_REASONS } from '../../src/notes/dto/note.dto';
import { NoteSourceService } from '../../src/notes/generation/note-source.service';
import {
  NOTE_GENERATE_JOB_TYPE,
  NOTE_PURGE_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
} from '../../src/notes/job-types';
import { encodeCursor } from '../../src/notes/notes.service';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// The notes API, over the wire (issue #53, epic #45)
// =============================================================================
//
// Ten routes as a client meets them, through everything `AppModule` wires — the
// guards, the Zod pipe, the response envelope and the exception filter. Only
// `PrismaService` and `NoteSourceService` are stand-ins (the latter so creating
// a note does not have to materialize a real transcript to exercise the wire
// contract this file is about).
//
// -----------------------------------------------------------------------------
// THE FOUR CONTRACTS THIS FILE EXISTS FOR
// -----------------------------------------------------------------------------
//
//   1. `POST /api/notes` WITH NO API KEY IS A 409 THAT CREATES NO NOTE, and
//      carries a `details.reason` the UI can branch on. A `draft` note nobody
//      can generate is worse than no note at all.
//   2. A STALE `baseVersion` IS A 409 THAT NAMES `currentVersion`. Two tabs is
//      the ordinary case; silently discarding the other tab's paragraph is the
//      failure this exists to rule out, and a client that cannot see what it is
//      about to overwrite cannot offer the user the choice.
//   3. A RESTORE APPENDS. History is never rewritten and v1 stays retrievable.
//   4. ANOTHER USER'S NOTE IS 404 ON EVERY ROUTE — read, patch, version,
//      restore, delete — in the same words every time. Two differently-worded
//      404s would reintroduce exactly the oracle the status code removes.
//
// Cursor paging over a list mutated mid-pagination, and what `note.purge`
// actually deletes, are asserted against REAL PostgreSQL in
// `notes-pagination.db.spec.ts` and `note-purge.db.spec.ts` — a keyset that
// neither skips nor repeats is a statement about a query planner, not about a
// mock.
// =============================================================================

const NOTES = '/api/notes';

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_NOTE_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT_ID = '44444444-4444-4444-8444-444444444444';
const GENERATION_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '66666666-6666-4666-8666-666666666666';

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

const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: TEMPLATE_ID,
  ownerId: null,
  name: 'Concise Meeting Notes',
  description: 'A short, scannable summary.',
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

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  ownerId: 'owner-1',
  title: 'Kestrel weekly',
  body: '# Kestrel weekly\n\nWe ship on Friday.',
  status: 'ready',
  currentVersion: 2,
  provider: 'openai',
  model: 'gpt-4o',
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

const versionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'version-1',
  noteId: NOTE_ID,
  version: 1,
  kind: 'ai_generated',
  body: '# Kestrel weekly\n\nThe AI original.',
  summary: null,
  authorId: null,
  author: null,
  generationId: GENERATION_ID,
  restoredFromVersion: null,
  clientBatchId: null,
  bodyFormat: 'markdown',
  createdAt: new Date('2026-09-14T00:30:00.000Z'),
  ...overrides,
});

describe('Notes API (#53)', () => {
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

    // A saved key, so the ordinary path is "configured".
    prismaMock.userAiCredential.findUnique.mockResolvedValue({ id: 'cred-1' });
    prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow());
    prismaMock.note.findMany.mockResolvedValue([]);
    prismaMock.note.count.mockResolvedValue(0);
    prismaMock.noteVersion.findMany.mockResolvedValue([]);
    prismaMock.job.create.mockResolvedValue({ id: JOB_ID });
    prismaMock.noteGeneration.create.mockResolvedValue({ id: GENERATION_ID });
    prismaMock.noteGeneration.update.mockResolvedValue({ id: GENERATION_ID });
  });

  /** A transcript this caller owns, for `TranscriptAccessService`. */
  function ownedTranscript(userId: string): void {
    prismaMock.transcript.findUnique.mockResolvedValue({
      id: TRANSCRIPT_ID,
      ownerId: userId,
      deletedAt: null,
      currentVersion: 3,
    });
  }

  /**
   * A note this caller owns, kept in a mutable cell so a write path's own
   * re-read sees what it just wrote — which is what makes the version-claim
   * assertions below mean anything.
   */
  function ownedNote(userId: string, overrides: Record<string, unknown> = {}) {
    const state = { current: noteRow({ ownerId: userId, ...overrides }) };

    prismaMock.note.findUnique.mockImplementation(async () => state.current);
    prismaMock.note.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.currentVersion !== undefined && where.currentVersion !== state.current.currentVersion) {
        return { count: 0 };
      }

      state.current = { ...state.current, ...data };

      return { count: 1 };
    });
    prismaMock.note.update.mockImplementation(async ({ data }: any) => {
      state.current = { ...state.current, ...data };

      return state.current;
    });
    prismaMock.noteVersion.create.mockImplementation(async ({ data }: any) => ({
      ...versionRow(),
      ...data,
    }));

    return state;
  }

  // ==========================================================================
  // POST /api/notes
  // ==========================================================================

  describe('POST /api/notes', () => {
    const body = {
      templateId: TEMPLATE_ID,
      source: { type: 'transcript', transcriptId: TRANSCRIPT_ID },
    };

    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).post(NOTES).send(body).expect(401);
    });

    it('creates the note AND queues its generation in one call', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);
      prismaMock.note.create.mockResolvedValue(noteRow({ ownerId: user.id, status: 'draft', currentVersion: 0, body: '' }));
      prismaMock.note.update.mockResolvedValue(
        noteRow({ ownerId: user.id, status: 'draft', currentVersion: 0, body: '', currentGenerationId: GENERATION_ID }),
      );

      const response = await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(201);

      expect(response.body.data.note.status).toBe('draft');
      expect(response.body.data.note.currentVersion).toBe(0);
      expect(response.body.data.generationId).toBe(GENERATION_ID);
      expect(response.body.data.jobId).toBe(JOB_ID);

      // The job is `note.generate`, subject the NOTE, payload naming the
      // generation — and `skipDedup`, so a second deliberate run is not
      // collapsed onto the first.
      const job = prismaMock.job.create.mock.calls[0][0].data;

      expect(job.type).toBe(NOTE_GENERATE_JOB_TYPE);
      expect(job.subjectType).toBe(NOTE_SUBJECT_TYPE);
      expect(job.payload.generationId).toBe(GENERATION_ID);
      expect(job.dedupKey).toBeNull();
    });

    it('titles the note after its template when the caller does not', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);
      prismaMock.note.create.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.note.update.mockResolvedValue(noteRow({ ownerId: user.id }));

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(201);

      expect(prismaMock.note.create.mock.calls[0][0].data.title).toBe('Concise Meeting Notes');
    });

    it('creates a note from a template the caller has HIDDEN (issue #310) — hiding is a listing preference, not access control', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);
      prismaMock.note.create.mockResolvedValue(noteRow({ ownerId: user.id }));
      prismaMock.note.update.mockResolvedValue(noteRow({ ownerId: user.id }));
      // If `NoteTemplateAccessService`/`NotesService.create` ever consulted
      // `user_hidden_note_templates`, this row would say "hidden, refuse it" —
      // and this test would then fail on the 201 below rather than on an
      // assertion the reader has to go looking for.
      prismaMock.userHiddenNoteTemplate.findUnique.mockResolvedValue({
        userId: user.id,
        templateId: TEMPLATE_ID,
      });

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(201);

      expect(prismaMock.note.create).toHaveBeenCalled();
      // The create path never reads `user_hidden_note_templates` at all — the
      // table exists to narrow what a PICKER lists, never what a create/
      // regenerate/preview call honours.
      expect(prismaMock.userHiddenNoteTemplate.findUnique).not.toHaveBeenCalled();
    });

    it('is 409 with a branchable reason — and CREATES NO NOTE — when the caller has no API key', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);
      prismaMock.userAiCredential.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.AI_KEY_MISSING);
      expect(response.body.message).toMatch(/key/i);

      // The deployment is fine; the CALLER is not configured. Nothing is
      // created — a draft note nobody can generate is worse than no note.
      expect(prismaMock.note.create).not.toHaveBeenCalled();
      expect(prismaMock.noteGeneration.create).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('is 409 with a DIFFERENT reason when the deployment has not enabled AI', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);
      prismaMock.systemSettings.findUnique.mockResolvedValue({
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS,
        version: 1,
        updatedAt: new Date(),
        updatedByUser: null,
      });

      const response = await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(409);

      // Two different fixes, two different people to talk to — a UI that
      // cannot tell them apart shows the wrong sentence.
      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.AI_NOT_CONFIGURED);
      expect(prismaMock.note.create).not.toHaveBeenCalled();
    });

    it('is 404 for a source transcript the caller cannot read', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue({
        id: TRANSCRIPT_ID,
        ownerId: 'somebody-else',
        deletedAt: null,
      });
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(404);

      expect(prismaMock.note.create).not.toHaveBeenCalled();
    });

    it('refuses a client-supplied body — the first version is the AI\'s by construction', async () => {
      const user = await createMockTestUser(context);

      ownedTranscript(user.id);

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send({ ...body, body: 'I wrote this myself' })
        .expect(400);

      expect(prismaMock.note.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // GET /api/notes
  // ==========================================================================

  describe('GET /api/notes', () => {
    it('scopes the query to the caller and hides soft-deleted rows', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = prismaMock.note.findMany.mock.calls[0][0].where;

      expect(where.ownerId).toBe(user.id);
      expect(where.deletedAt).toBeNull();
    });

    // ========================================================================
    // `total` — issue #190, epic #162
    // ========================================================================
    //
    // The count exists so a 300-row card feed can say how big it is. Its whole
    // value is that it answers a question about the FILTERS rather than about
    // the page, so the tests that matter are the two where deriving it from the
    // page would look right: a full page with more behind it, and a cursored
    // request.

    it('answers `total` alongside the page', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([noteRow({ ownerId: user.id })]);
      prismaMock.note.count.mockResolvedValue(42);

      const response = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.total).toBe(42);
      expect(response.body.data.items).toHaveLength(1);
    });

    // ========================================================================
    // `originTranscript` is DETAIL ONLY — issue #309
    // ========================================================================

    it('omits `originTranscript` from list rows and never resolves it', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([
        noteRow({ ownerId: user.id, sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID }),
      ]);
      prismaMock.note.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect('originTranscript' in response.body.data.items[0]).toBe(false);
      // Robust proxy for "the origin resolver never ran": a list row that
      // named a transcript source would trigger `NoteOriginService.resolve`'s
      // own `transcript.findFirst` if `listShape` ever stopped omitting the
      // field, so its absence here is the N+1 this test exists to catch.
      expect(prismaMock.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('counts over the FILTERS, never over the keyset-bounded page', async () => {
      // ⚠ THE ASSERTION THIS FILE EXISTS TO MAKE about `total`. A count over
      // the page predicate would shrink as the client pages, so a feed showing
      // "42 notes" would watch the number fall to 22 for pressing Load more.
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([noteRow({ ownerId: user.id })]);
      prismaMock.note.count.mockResolvedValue(42);

      // Built with the service's own encoder rather than by hand: a cursor
      // this endpoint cannot decode restarts the list from the top, which is
      // correct behaviour and would make this test silently assert nothing.
      const cursor = encodeCursor({ updatedAt: new Date(2026, 0, 1), id: 'note-9' });

      await request(context.app.getHttpServer())
        .get(`${NOTES}?cursor=${cursor}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const countWhere = prismaMock.note.count.mock.calls[0][0].where;
      const pageWhere = prismaMock.note.findMany.mock.calls[0][0].where;

      // The page carries the keyset clause; the count does not.
      expect(pageWhere.AND).toBeDefined();
      expect(countWhere.AND).toBeUndefined();
      // Both are still scoped to the same caller and the same filters.
      expect(countWhere.ownerId).toBe(user.id);
      expect(countWhere.deletedAt).toBeNull();
    });

    it('counts under the SAME filters the page is read with', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([]);
      prismaMock.note.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(`${NOTES}?status=failed`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.note.count.mock.calls[0][0].where.status).toBe('failed');
    });

    it('reads the count and the page in ONE transaction', async () => {
      // Two separate round trips could describe two different states of the
      // table — "20 of 19", which is nonsense on screen and unreproducible in a
      // bug report.
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([]);
      prismaMock.note.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.$transaction).toHaveBeenCalled();
    });

    // ========================================================================
    // `sourceName` — issue #192, epic #162
    // ========================================================================

    it('denormalises `sourceName` onto every row', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([
        noteRow({ ownerId: user.id, sourceType: 'transcript', sourceTranscriptId: 't1' }),
      ]);
      prismaMock.note.count.mockResolvedValue(1);
      prismaMock.transcript.findMany.mockResolvedValue([{ id: 't1', title: 'Q3 planning' }]);

      const response = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0].sourceName).toBe('Q3 planning');
    });

    it('answers `sourceName: null` for a source the caller may not read', async () => {
      // ⚠ NOT an error and NOT an omitted field. A transcript shared with this
      // user and later unshared leaves the note pointing at it forever; the
      // scoped predicate returns no row, and the client renders the category
      // noun. No title leaks.
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([
        noteRow({ ownerId: user.id, sourceType: 'transcript', sourceTranscriptId: 't1' }),
      ]);
      prismaMock.note.count.mockResolvedValue(1);
      prismaMock.transcript.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0]).toHaveProperty('sourceName', null);
    });

    it('resolves a whole page with ONE source query, not one per row', async () => {
      // The acceptance criterion of #192 on the server side: moving an N+1 from
      // the client to the API would have been no fix at all.
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) =>
          noteRow({
            ownerId: user.id,
            id: `note-${i}`,
            sourceType: 'transcript',
            sourceTranscriptId: `t${i}`,
          }),
        ),
      );
      prismaMock.note.count.mockResolvedValue(20);
      prismaMock.transcript.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.transcript.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.transcript.findMany.mock.calls[0][0].where.id.in).toHaveLength(20);
    });

    it('orders by (updatedAt, id) and pages by KEYSET, never offset', async () => {
      const user = await createMockTestUser(context);

      const rows = Array.from({ length: 21 }, (_, index) =>
        noteRow({ ownerId: user.id, id: `note-${index}`, updatedAt: new Date(2026, 0, 1, 0, index) }),
      );

      prismaMock.note.findMany.mockResolvedValue(rows);

      const first = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      const call = prismaMock.note.findMany.mock.calls[0][0];

      expect(call.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
      // ⚠ NO `skip`. An offset over a list that reorders itself under the
      // reader skips rows and repeats others, silently.
      expect(call.skip).toBeUndefined();
      expect(call.take).toBe(21);
      expect(first.body.data.items).toHaveLength(20);
      expect(first.body.data.nextCursor).toEqual(expect.any(String));

      prismaMock.note.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get(`${NOTES}?cursor=${encodeURIComponent(first.body.data.nextCursor)}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const second = prismaMock.note.findMany.mock.calls[1][0].where;

      expect(second.AND[0].OR).toEqual([
        { updatedAt: { lt: expect.any(Date) } },
        { updatedAt: expect.any(Date), id: { lt: expect.any(String) } },
      ]);
    });

    it('filters by source transcript — what a transcript page asks for (#59)', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(`${NOTES}?sourceTranscriptId=${TRANSCRIPT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.note.findMany.mock.calls[0][0].where.sourceTranscriptId).toBe(
        TRANSCRIPT_ID,
      );
    });

    it('filters by status, source kind and template', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(`${NOTES}?status=ready&sourceType=document&templateId=${TEMPLATE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = prismaMock.note.findMany.mock.calls[0][0].where;

      expect(where.status).toBe('ready');
      expect(where.sourceType).toBe('document');
      expect(where.templateId).toBe(TEMPLATE_ID);
    });

    it('never reads `note_generations`, so a preview can never appear in the list', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      // A preview generation has `note_id: NULL` and creates no note at all, so
      // this list structurally cannot see one. `notes-pagination.db.spec.ts`
      // inserts a real preview row and asserts the same thing end to end.
      expect(prismaMock.noteGeneration.findMany).not.toHaveBeenCalled();
    });

    it('carries an excerpt rather than the whole body', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([
        noteRow({ ownerId: user.id, body: 'x'.repeat(1000) }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(NOTES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0]).not.toHaveProperty('body');
      expect(response.body.data.items[0].excerpt.length).toBeLessThan(300);
    });
  });

  // ==========================================================================
  // GET /api/notes/summary
  // ==========================================================================

  describe('GET /api/notes/summary', () => {
    it('answers three lists and four counts in one round trip', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([noteRow({ ownerId: user.id })]);
      prismaMock.note.count.mockResolvedValue(3);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/summary`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('inProgress');
      expect(response.body.data).toHaveProperty('recent');
      expect(response.body.data).toHaveProperty('failed');
      expect(response.body.data.counts.total).toBe(3);
    });

    it('is not shadowed by `GET /api/notes/:id`', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([]);

      // A 400 here would mean `ParseUUIDPipe` claimed the literal path.
      await request(context.app.getHttpServer())
        .get(`${NOTES}/summary`)
        .set(authHeader(user.accessToken))
        .expect(200);
    });

    it('omits `originTranscript` from summary rows and never resolves it', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findMany.mockResolvedValue([
        noteRow({ ownerId: user.id, sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID }),
      ]);
      prismaMock.note.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/summary`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const allRows = [
        ...response.body.data.inProgress,
        ...response.body.data.recent,
        ...response.body.data.failed,
      ];

      expect(allRows.length).toBeGreaterThan(0);
      allRows.forEach((row: Record<string, unknown>) => {
        expect('originTranscript' in row).toBe(false);
      });
      expect(prismaMock.transcript.findFirst).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // GET /api/notes/:id
  // ==========================================================================

  describe('GET /api/notes/:id', () => {
    it('carries a weak ETag at the note\'s current version', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.headers.etag).toBe('W/"v2"');
      expect(response.body.data.currentVersion).toBe(2);
    });

    it('answers 304 WITH NO BODY when `If-None-Match` matches', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .set('If-None-Match', 'W/"v2"')
        .expect(304);

      // RFC 9110 requires a 304 to carry no content. The envelope interceptor
      // skips the `{ data, meta }` wrapper entirely at this status.
      expect(response.text).toBeFalsy();
      expect(response.body).toEqual({});
    });

    it('reads back a generated note as `ready`, with its `ai_generated` version current', async () => {
      const user = await createMockTestUser(context);

      // The state `NoteGenerationService.commit` leaves behind — that half is
      // asserted against the real write path in `note-generation.integration
      // .spec.ts`; this is the same state as a CLIENT meets it.
      ownedNote(user.id, {
        status: 'ready',
        currentVersion: 1,
        body: '# Kestrel weekly\n\nThe AI original.',
      });
      prismaMock.noteVersion.findMany.mockResolvedValue([versionRow({ version: 1 })]);
      prismaMock.noteVersion.findUnique.mockResolvedValue(versionRow({ version: 1 }));

      const detail = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(detail.body.data.status).toBe('ready');
      expect(detail.body.data.currentVersion).toBe(1);
      expect(detail.body.data.provider).toBe('openai');
      expect(detail.body.data.model).toBe('gpt-4o');

      const versions = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/versions`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(versions.body.data.currentVersion).toBe(1);
      expect(versions.body.data.items[0]).toMatchObject({
        version: 1,
        kind: 'ai_generated',
        // `null` MEANS THE AI.
        author: null,
      });

      // ⚠ §4.1'S INVARIANT, OVER THE WIRE: `notes.body` is the version at
      // `currentVersion`, which is what lets a list render an excerpt with one
      // row read and no join.
      const current = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/versions/1`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(current.body.data.body).toBe(detail.body.data.body);
      expect(current.body.data.isCurrent).toBe(true);
      // The VERSION's own format (#337), fixed when it was written.
      expect(current.body.data.bodyFormat).toBe('markdown');
    });

    it('still answers 200 when the version moved on', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .set('If-None-Match', 'W/"v1"')
        .expect(200);
    });

    // ========================================================================
    // `originTranscript` — issue #309
    // ========================================================================

    it('carries `originTranscript` for a transcript-sourced note', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, { sourceType: 'transcript', sourceTranscriptId: TRANSCRIPT_ID });
      prismaMock.transcript.findFirst.mockResolvedValue({
        id: TRANSCRIPT_ID,
        title: 'Kestrel weekly',
        durationMs: 120_000,
        status: 'ready',
        playbackStatus: 'ready',
      });

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.originTranscript).toEqual({
        id: TRANSCRIPT_ID,
        title: 'Kestrel weekly',
        durationMs: 120_000,
        status: 'ready',
        playbackStatus: 'ready',
        via: 'direct',
        hops: 0,
      });
    });

    it('answers `originTranscript: null` for a document-sourced note', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, {
        sourceType: 'document',
        sourceTranscriptId: null,
        sourceNoteId: null,
        sourceObjectId: 'object-1',
      });

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.originTranscript).toBeNull();
      expect(prismaMock.transcript.findFirst).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PATCH /api/notes/:id
  // ==========================================================================

  describe('PATCH /api/notes/:id', () => {
    it('appends a version and bumps `currentVersion` on a current `baseVersion`', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ body: 'Rewritten by a human.', baseVersion: 2, summary: 'Fixed the date' })
        .expect(200);

      expect(response.body.data.currentVersion).toBe(3);
      expect(response.body.data.body).toBe('Rewritten by a human.');

      const version = prismaMock.noteVersion.create.mock.calls[0][0].data;

      expect(version).toMatchObject({
        version: 3,
        kind: 'edit',
        body: 'Rewritten by a human.',
        summary: 'Fixed the date',
        // ⚠ A REAL AUTHOR. `null` means the AI, so a human edit recorded with a
        // null author would claim the model wrote it.
        authorId: user.id,
      });
    });

    it('is 409 NAMING `currentVersion` on a stale `baseVersion`, and writes nothing', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ body: 'The other tab\'s paragraph, about to be lost', baseVersion: 1 })
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.STALE_BASE_VERSION);
      expect(response.body.details.currentVersion).toBe(2);
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    });

    it('renames without a version — a title is metadata, not content', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ title: 'Kestrel weekly — final' })
        .expect(200);

      expect(response.body.data.title).toBe('Kestrel weekly — final');
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    });

    it('refuses a body with no `baseVersion` at the door', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ body: 'No idea what I am overwriting' })
        .expect(400);

      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    });

    it('is 409 while the note is generating — the stream is the only writer', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, { status: 'generating' });

      const response = await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ body: 'Racing the model', baseVersion: 2 })
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.GENERATING);
    });

    it('replays an identical `clientBatchId` instead of creating a second version', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteVersion.findUnique.mockResolvedValue(versionRow({ version: 3, kind: 'edit' }));

      await request(context.app.getHttpServer())
        .patch(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .send({ body: 'Sent twice', baseVersion: 2, clientBatchId: 'batch-1' })
        .expect(200);

      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Versions and restore
  // ==========================================================================

  describe('versions', () => {
    it('lists newest first, and `author: null` MEANS THE AI', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteVersion.findMany.mockResolvedValue([
        versionRow({ version: 2, kind: 'edit', authorId: user.id, author: { id: user.id, displayName: 'Ana', providerDisplayName: null, email: user.email } }),
        versionRow({ version: 1 }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/versions`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.noteVersion.findMany.mock.calls[0][0].orderBy).toEqual({
        version: 'desc',
      });
      expect(response.body.data.items[0].author.name).toBe('Ana');
      expect(response.body.data.items[1].author).toBeNull();
      expect(response.body.data.items[1].kind).toBe('ai_generated');
    });

    it('reads one version in full, as a stored snapshot', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteVersion.findUnique.mockResolvedValue(versionRow({ version: 1 }));

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}/versions/1`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.body).toBe('# Kestrel weekly\n\nThe AI original.');
      expect(response.body.data.isCurrent).toBe(false);
    });

    it('APPENDS a restore version, leaving the history it restored from intact', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.noteVersion.findUnique.mockResolvedValue(versionRow({ version: 1 }));

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/versions/1/restore`)
        .set(authHeader(user.accessToken))
        .send({ baseVersion: 2 })
        .expect(201);

      expect(response.body.data.currentVersion).toBe(3);
      expect(response.body.data.body).toBe('# Kestrel weekly\n\nThe AI original.');

      const appended = prismaMock.noteVersion.create.mock.calls[0][0].data;

      expect(appended).toMatchObject({
        version: 3,
        kind: 'restore',
        restoredFromVersion: 1,
      });

      // ⚠ HISTORY IS NEVER REWRITTEN. Nothing deletes or updates a version row.
      expect(prismaMock.noteVersion.delete).not.toHaveBeenCalled();
      expect(prismaMock.noteVersion.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.noteVersion.update).not.toHaveBeenCalled();
    });

    it('is 409 on a restore with a stale `baseVersion`', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/versions/1/restore`)
        .set(authHeader(user.accessToken))
        .send({ baseVersion: 1 })
        .expect(409);

      expect(response.body.details.currentVersion).toBe(2);
      expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /api/notes/:id/regenerate
  // ==========================================================================

  describe('POST /api/notes/:id/regenerate', () => {
    it('queues a fresh job and KEEPS the prior body as a version', async () => {
      const user = await createMockTestUser(context);

      const state = ownedNote(user.id);

      ownedTranscript(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/regenerate`)
        .set(authHeader(user.accessToken))
        .send({})
        .expect(201);

      expect(response.body.data.jobId).toBe(JOB_ID);
      expect(prismaMock.job.create.mock.calls[0][0].data.type).toBe(NOTE_GENERATE_JOB_TYPE);
      expect(prismaMock.noteGeneration.create.mock.calls[0][0].data.kind).toBe('regenerate');

      // ⚠ NOTHING TOUCHES THE BODY OR THE VERSION COUNTER. The previous body is
      // already version 2 and stays version 2; a successful run appends 3.
      expect(state.current.body).toBe('# Kestrel weekly\n\nWe ship on Friday.');
      expect(state.current.currentVersion).toBe(2);
      expect(prismaMock.noteVersion.deleteMany).not.toHaveBeenCalled();
    });

    it('is 409 while a generation is already in flight', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, { status: 'generating' });
      ownedTranscript(user.id);

      const response = await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/regenerate`)
        .set(authHeader(user.accessToken))
        .send({})
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.GENERATING);
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('re-authorises the source rather than trusting the row', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.transcript.findUnique.mockResolvedValue({
        id: TRANSCRIPT_ID,
        ownerId: 'somebody-else',
        deletedAt: null,
      });
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);

      // A share revoked between the note's creation and this request.
      await request(context.app.getHttpServer())
        .post(`${NOTES}/${NOTE_ID}/regenerate`)
        .set(authHeader(user.accessToken))
        .send({})
        .expect(404);

      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE /api/notes/:id
  // ==========================================================================

  describe('DELETE /api/notes/:id', () => {
    it('soft-deletes to `deleting` and queues `note.purge`', async () => {
      const user = await createMockTestUser(context);

      const state = ownedNote(user.id);

      prismaMock.note.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .delete(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(state.current.status).toBe('deleting');
      expect(state.current.deletedAt).toBeInstanceOf(Date);

      const job = prismaMock.job.create.mock.calls[0][0].data;

      expect(job.type).toBe(NOTE_PURGE_JOB_TYPE);
      expect(job.subjectId).toBe(NOTE_ID);
      expect(job.payload).toEqual({ noteId: NOTE_ID });
    });

    it('is idempotent for a note already on its way out', async () => {
      const user = await createMockTestUser(context);

      // ⚠ `deletedAt: null` WITH `status: 'deleting'` — the narrow window
      // between the two writes of a delete. Once `deletedAt` is stamped the note
      // is gone from every read surface, including this one, and a second
      // DELETE answers the same 404 a stranger gets (asserted in the 404 sweep
      // below). Asking for something to be gone that is already going is
      // success either way; it is never a 409.
      ownedNote(user.id, { status: 'deleting' });

      await request(context.app.getHttpServer())
        .delete(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('answers 404 once the note is soft-deleted — it is gone from every read surface', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, { status: 'deleting', deletedAt: new Date() });

      await request(context.app.getHttpServer())
        .delete(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('is 409 while the note is generating', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id, { status: 'generating' });

      const response = await request(context.app.getHttpServer())
        .delete(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.GENERATING);
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('is 409 naming the notes generated FROM this one — `source_note_id` is Restrict', async () => {
      const user = await createMockTestUser(context);

      ownedNote(user.id);
      prismaMock.note.findMany.mockResolvedValue([
        { id: OTHER_NOTE_ID, title: 'Follow-up email', deletedAt: null },
      ]);

      const response = await request(context.app.getHttpServer())
        .delete(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONFLICT_REASONS.DERIVED_NOTES_EXIST);
      expect(response.body.details.notes[0].title).toBe('Follow-up email');
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // ⚠ THE 404 SWEEP — every route, the same words
  // ==========================================================================

  describe('another user\'s note', () => {
    beforeEach(() => {
      prismaMock.note.findUnique.mockResolvedValue(noteRow({ ownerId: 'somebody-else' }));
      prismaMock.noteVersion.findUnique.mockResolvedValue(versionRow());
    });

    const routes: Array<[string, (server: any, token: string) => request.Test]> = [
      ['read', (server, token) => request(server).get(`${NOTES}/${NOTE_ID}`).set(authHeader(token))],
      [
        'patch',
        (server, token) =>
          request(server)
            .patch(`${NOTES}/${NOTE_ID}`)
            .set(authHeader(token))
            .send({ body: 'mine now', baseVersion: 2 }),
      ],
      [
        'version list',
        (server, token) => request(server).get(`${NOTES}/${NOTE_ID}/versions`).set(authHeader(token)),
      ],
      [
        'one version',
        (server, token) => request(server).get(`${NOTES}/${NOTE_ID}/versions/1`).set(authHeader(token)),
      ],
      [
        'restore',
        (server, token) =>
          request(server)
            .post(`${NOTES}/${NOTE_ID}/versions/1/restore`)
            .set(authHeader(token))
            .send({ baseVersion: 2 }),
      ],
      [
        'regenerate',
        (server, token) => request(server).post(`${NOTES}/${NOTE_ID}/regenerate`).set(authHeader(token)).send({}),
      ],
      ['delete', (server, token) => request(server).delete(`${NOTES}/${NOTE_ID}`).set(authHeader(token))],
    ];

    it.each(routes)('answers 404 — never 403 — on %s', async (_name, call) => {
      const user = await createMockTestUser(context);

      const response = await call(context.app.getHttpServer(), user.accessToken).expect(404);

      // ⚠ THE SAME WORDS EVERY TIME. Two differently-worded 404s would tell an
      // attacker precisely what a 403 would have.
      expect(response.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });

    it('answers a missing note and an unowned one IDENTICALLY', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValueOnce(null);
      const missing = await request(context.app.getHttpServer())
        .get(`${NOTES}/${OTHER_NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      prismaMock.note.findUnique.mockResolvedValueOnce(noteRow({ ownerId: 'somebody-else' }));
      const unowned = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(missing.body.message).toBe(unowned.body.message);
    });

    it('answers 404 for a SOFT-DELETED note the caller does own', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue(
        noteRow({ ownerId: user.id, deletedAt: new Date(), status: 'deleting' }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`${NOTES}/${NOTE_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    });
  });
});
