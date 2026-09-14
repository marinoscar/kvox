import request from 'supertest';

import { NOTE_GENERATION_NOT_FOUND_MESSAGE } from '../../src/notes/access/note-generation-access.service';
import { NOTE_STREAM_TUNING } from '../../src/notes/generation/note-generation-stream.service';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// The generation stream, over the wire (issue #52, epic #45)
// =============================================================================
//
// The two SSE routes as a client meets them, through everything `AppModule`
// wires — the guards, the exception filter, and the `TransformInterceptor`'s
// `@Sse()` bypass (without which every heartbeat comment would arrive as an
// enveloped data frame). Only `PrismaService` is a stand-in, and only so a
// generation's progress can be scripted poll by poll.
//
// `NOTE_STREAM_TUNING` is overridden to millisecond intervals — the token
// values only, never the logic — so the suite does not spend a real 250 ms per
// poll or a real eleven minutes proving the duration cap exists.
//
// -----------------------------------------------------------------------------
// THE THREE ASSERTIONS THIS FILE EXISTS FOR
// -----------------------------------------------------------------------------
//
//   1. CONCATENATION. Every delta joined, in arrival order, is the final buffer
//      EXACTLY — from the start, from a mid-generation attach, and across a
//      `Last-Event-ID` reconnect. A stream that dropped or repeated a fragment
//      would still look plausible on screen.
//   2. ONE CODE PATH FOR LATE AND EARLY. A client attaching after completion is
//      not a special case; it gets the whole buffer and an immediate `done`.
//   3. 404, NEVER 403, for a generation that is not the caller's — asserted for
//      both routes, because they resolve ownership by different means.
// =============================================================================

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const PREVIEW_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '44444444-4444-4444-8444-444444444444';

const streamForNote = (id = NOTE_ID) => `/api/notes/${id}/stream`;
const streamForGeneration = (id = GENERATION_ID) => `/api/note-generations/${id}/stream`;

// -----------------------------------------------------------------------------
// A tiny SSE reader. Deliberately hand-written and independent of
// `apps/web/src/services/sse.ts`: a test that parsed with the same code the
// client uses could not catch a framing bug they shared.
// -----------------------------------------------------------------------------

interface Frame {
  event: string;
  id: string | null;
  data: Record<string, unknown>;
}

function parseSse(body: string): { frames: Frame[]; comments: string[] } {
  const frames: Frame[] = [];
  const comments: string[] = [];

  for (const block of body.split('\n\n')) {
    let event = 'message';
    let id: string | null = null;
    let data = '';

    for (const line of block.split('\n')) {
      if (line === '') continue;

      if (line.startsWith(':')) {
        comments.push(line.slice(1).trim());
        continue;
      }

      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
      else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
    }

    if (data !== '') frames.push({ event, id, data: JSON.parse(data) });
  }

  return { frames, comments };
}

const deltasOf = (frames: Frame[]): string[] =>
  frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.delta as string);

/** A `note_generations` row as the POLL's narrow `select` returns it. */
const pollRow = (overrides: Record<string, unknown> = {}) => ({
  status: 'streaming',
  content: '',
  errorClass: null,
  errorDetail: null,
  note: { currentVersion: 0 },
  ...overrides,
});

/** A row as the ACCESS check's `select` returns it (it asks for `job`). */
const accessRow = (overrides: Record<string, unknown> = {}) => ({
  id: GENERATION_ID,
  noteId: NOTE_ID,
  note: { ownerId: 'owner-1', deletedAt: null },
  job: null,
  ...overrides,
});

/**
 * Script `noteGeneration.findUnique` for both of its callers.
 *
 * The access check and the poll read the same table with different `select`s;
 * the access one is the only one that asks for `job`, which is what tells them
 * apart here. The last polled row REPEATS, so a script may end non-terminal and
 * let the duration cap be what ends the stream.
 */
function scriptGeneration(access: unknown, polls: (unknown | null)[]): void {
  let index = 0;

  prismaMock.noteGeneration.findUnique.mockImplementation(
    async ({ select }: { select?: Record<string, unknown> }) => {
      if (select?.job !== undefined) return access;

      const value = polls[Math.min(index, polls.length - 1)];

      index += 1;

      return value;
    },
  );
}

describe('Note generation stream (#52)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: NOTE_STREAM_TUNING,
          // Milliseconds, not the shipped quarter-second/25s/11min — the
          // behaviour under test is unchanged, only how long it takes to see.
          useValue: { pollIntervalMs: 3, heartbeatIntervalMs: 10, durationCapMs: 250 },
        },
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
  });

  // ==========================================================================
  // GET /api/notes/:id/stream
  // ==========================================================================

  describe('GET /api/notes/:id/stream', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(streamForNote()).expect(401);
    });

    it('delivers ordered deltas whose concatenation is the final body exactly', async () => {
      const user = await createMockTestUser(context);
      const body = '# Weekly sync\n\nWe ship on Friday.\n\n- Ana confirms the date.';

      prismaMock.note.findUnique.mockResolvedValue({
        id: NOTE_ID,
        ownerId: user.id,
        deletedAt: null,
        currentGenerationId: GENERATION_ID,
      });

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ content: body.slice(0, 14) }),
        pollRow({ content: body.slice(0, 35) }),
        pollRow({ content: body }),
        pollRow({ status: 'succeeded', content: body, note: { currentVersion: 1 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForNote())
        .set(authHeader(user.accessToken))
        .expect(200)
        .expect('Content-Type', /text\/event-stream/);

      const { frames } = parseSse(response.text);

      expect(deltasOf(frames).join('')).toBe(body);

      const done = frames.at(-1);

      expect(done?.event).toBe('done');
      expect(done?.data).toEqual({
        status: 'succeeded',
        offset: body.length,
        currentVersion: 1,
      });

      // Every frame's id IS the offset it ends at, and the sequence only grows.
      const ids = frames.map((frame) => Number(frame.id));

      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(ids.at(-1)).toBe(body.length);
    });

    it('gives a mid-generation attach the backlog and then live deltas, with no seam', async () => {
      const user = await createMockTestUser(context);
      const body = 'Backlog written before anyone attached. And the rest, live.';
      const backlog = 'Backlog written before anyone attached.';

      prismaMock.note.findUnique.mockResolvedValue({
        id: NOTE_ID,
        ownerId: user.id,
        deletedAt: null,
        currentGenerationId: GENERATION_ID,
      });

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        // The connection opens against a buffer that already has text in it.
        pollRow({ content: backlog }),
        pollRow({ content: body }),
        pollRow({ status: 'succeeded', content: body, note: { currentVersion: 2 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForNote())
        .set(authHeader(user.accessToken))
        .expect(200);

      const deltas = deltasOf(parseSse(response.text).frames);

      // The join is the assertion: the backlog frame ends exactly where the
      // first live frame begins — no gap, and not one character twice.
      expect(deltas[0]).toBe(backlog);
      expect(deltas.join('')).toBe(body);
    });

    it('answers 404 for a note that is not the caller’s', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue({
        id: NOTE_ID,
        ownerId: 'somebody-else',
        deletedAt: null,
        currentGenerationId: GENERATION_ID,
      });

      const response = await request(context.app.getHttpServer())
        .get(streamForNote())
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_GENERATION_NOT_FOUND_MESSAGE);
      // It never got as far as reading a generation row.
      expect(prismaMock.noteGeneration.findUnique).not.toHaveBeenCalled();
    });

    it('answers the SAME 404 for a note that has never generated anything', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue({
        id: NOTE_ID,
        ownerId: user.id,
        deletedAt: null,
        currentGenerationId: null,
      });

      const response = await request(context.app.getHttpServer())
        .get(streamForNote())
        .set(authHeader(user.accessToken))
        .expect(404);

      // Byte-identical to the refusal above — two differently-worded 404s would
      // reintroduce exactly the oracle the status code was chosen to remove.
      expect(response.body.message).toBe(NOTE_GENERATION_NOT_FOUND_MESSAGE);
    });

    it('answers 404 for a soft-deleted note', async () => {
      const user = await createMockTestUser(context);

      prismaMock.note.findUnique.mockResolvedValue({
        id: NOTE_ID,
        ownerId: user.id,
        deletedAt: new Date(),
        currentGenerationId: GENERATION_ID,
      });

      await request(context.app.getHttpServer())
        .get(streamForNote())
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  // ==========================================================================
  // GET /api/note-generations/:id/stream
  // ==========================================================================

  describe('GET /api/note-generations/:id/stream', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(streamForGeneration()).expect(401);
    });

    it('hands a late attach the whole buffer and an immediate done', async () => {
      const user = await createMockTestUser(context);
      const body = 'This generation finished before the page was ever opened.';

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ status: 'succeeded', content: body, note: { currentVersion: 7 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .expect(200);

      const { frames } = parseSse(response.text);

      expect(frames.map((frame) => frame.event)).toEqual(['delta', 'done']);
      expect(frames[0].data.delta).toBe(body);
      expect(frames[1].data).toEqual({
        status: 'succeeded',
        offset: body.length,
        currentVersion: 7,
      });
    });

    it('resumes from Last-Event-ID: no repeated text, no lost text', async () => {
      const user = await createMockTestUser(context);
      const body = 'The first connection saw this much. The reconnect sees the rest.';
      const seen = 'The first connection saw this much.'.length;

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ content: body }),
        pollRow({ status: 'succeeded', content: body, note: { currentVersion: 1 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .set('Last-Event-ID', String(seen))
        .expect(200);

      const deltas = deltasOf(parseSse(response.text).frames);

      expect(deltas.join('')).toBe(body.slice(seen));
      expect(deltas.join('')).not.toContain('first connection');
    });

    it('accepts ?lastEventId= for a client that could not set the header', async () => {
      const user = await createMockTestUser(context);
      const body = 'aaaaaaaaaaBBBBBBBBBB';

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ status: 'succeeded', content: body, note: { currentVersion: 1 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`${streamForGeneration()}?lastEventId=10`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(deltasOf(parseSse(response.text).frames).join('')).toBe('BBBBBBBBBB');
    });

    it('emits error carrying the recorded reason, then closes', async () => {
      const user = await createMockTestUser(context);

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ content: 'half a sen' }),
        pollRow({
          status: 'failed',
          content: 'half a sen',
          errorClass: 'auth',
          errorDetail: 'Your OpenAI key was rejected. Update it in Settings.',
        }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .expect(200);

      const { frames } = parseSse(response.text);

      expect(frames.map((frame) => frame.event)).toEqual(['delta', 'error']);
      expect(frames[1].data).toEqual({
        status: 'failed',
        offset: 'half a sen'.length,
        errorClass: 'auth',
        reason: 'Your OpenAI key was rejected. Update it in Settings.',
      });
    });

    it('closes on the duration cap when a job never settles, with heartbeats meanwhile', async () => {
      const user = await createMockTestUser(context);

      // `pending`, forever: no text, no terminal status, nothing to emit. The
      // cap is the only thing that can end this connection.
      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ status: 'pending', content: '' }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .expect(200);

      const { frames, comments } = parseSse(response.text);

      expect(frames.map((frame) => frame.event)).toEqual(['error']);
      expect(frames[0].data).toMatchObject({ status: 'failed', errorClass: 'timeout' });

      // The heartbeat is what keeps an intermediary from reaping the connection
      // during exactly this kind of silence.
      expect(comments[0]).toBe('connected');
      expect(comments.filter((comment) => comment === 'heartbeat').length).toBeGreaterThan(0);
    });

    it('closes with gone when the row disappears mid-connection', async () => {
      const user = await createMockTestUser(context);

      scriptGeneration(accessRow({ note: { ownerId: user.id, deletedAt: null } }), [
        pollRow({ content: 'a preview being swept' }),
        null,
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .expect(200);

      const { frames } = parseSse(response.text);

      expect(frames.at(-1)?.event).toBe('error');
      expect(frames.at(-1)?.data).toMatchObject({ errorClass: 'gone' });
    });

    it('streams a PREVIEW, whose requester lives in the job payload', async () => {
      const user = await createMockTestUser(context);
      const body = 'A preview of an unsaved template.';

      scriptGeneration(
        accessRow({
          id: PREVIEW_ID,
          noteId: null,
          note: null,
          job: { payload: { generationId: PREVIEW_ID, userId: user.id } },
        }),
        [pollRow({ status: 'succeeded', content: body, note: null })],
      );

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration(PREVIEW_ID))
        .set(authHeader(user.accessToken))
        .expect(200);

      const { frames } = parseSse(response.text);

      expect(frames[0].data.delta).toBe(body);
      // A preview has no note, so there is no version to name — `null` is a
      // statement, not a missing value.
      expect(frames[1].data).toMatchObject({ status: 'succeeded', currentVersion: null });
    });

    it('answers 404 for another user’s generation', async () => {
      const user = await createMockTestUser(context);

      scriptGeneration(accessRow({ note: { ownerId: 'somebody-else', deletedAt: null } }), [
        pollRow({ status: 'succeeded', content: 'secret', note: { currentVersion: 1 } }),
      ]);

      const response = await request(context.app.getHttpServer())
        .get(streamForGeneration())
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(NOTE_GENERATION_NOT_FOUND_MESSAGE);
    });

    it('answers 404 for another user’s PREVIEW, which is gated on the payload', async () => {
      const user = await createMockTestUser(context);

      scriptGeneration(
        accessRow({
          id: PREVIEW_ID,
          noteId: null,
          note: null,
          job: { payload: { generationId: PREVIEW_ID, userId: 'somebody-else' } },
        }),
        [pollRow({ status: 'succeeded', content: 'secret' })],
      );

      await request(context.app.getHttpServer())
        .get(streamForGeneration(PREVIEW_ID))
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('fails CLOSED for a preview whose requester can no longer be established', async () => {
      const user = await createMockTestUser(context);

      // The `jobs` row aged out of the purge window and `SetNull` cleared the
      // link, so there is nothing left that names who asked for this preview.
      scriptGeneration(
        accessRow({ id: PREVIEW_ID, noteId: null, note: null, job: null }),
        [pollRow({ status: 'succeeded', content: 'secret' })],
      );

      await request(context.app.getHttpServer())
        .get(streamForGeneration(PREVIEW_ID))
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('answers 404 for a generation that does not exist', async () => {
      const user = await createMockTestUser(context);

      prismaMock.noteGeneration.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(streamForGeneration(MISSING_ID))
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });
});
